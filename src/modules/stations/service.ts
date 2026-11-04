import { sql } from 'kysely';
import type { z } from 'zod';
import type { Db } from '../../db/client.ts';
import { departureLive } from '../../live/compute.ts';
import { loadByTrain } from '../../live/load.ts';
import type { Lookups } from '../../live/lookups.ts';
import { operatorName } from '../../domain/operators.ts';
import { ApiError } from '../../http/errors.ts';
import { titleCase } from '../../ingest/schedule/parse.ts';
import { addDays, hhmmToMinutes, ukIsoAt } from '../../time.ts';
import { requireSchedule, runsAndWins } from '../reference.ts';
import type { Departure, DeparturesResponse, NearbyStation, Station } from './schemas.ts';
import { rankStations } from './search.ts';

type StationOut = z.input<typeof Station>;

// ---- stations ------------------------------------------------------------------

export async function getStation(db: Db, crs: string): Promise<StationOut> {
  const row = await db.selectFrom('stations').select(['crs', 'name', 'lat', 'lon']).where('crs', '=', crs).executeTakeFirst();
  if (!row) throw ApiError.notFound('station_not_found', `Unknown station ${crs}`);
  return row;
}

/** Ranked by rankStations (./search.ts): exact CRS, name prefix, all words in any order, then typos. */
export async function searchStations(db: Db, q: string, limit: number): Promise<StationOut[]> {
  const { rows } = await sql<StationOut & { ok: boolean }>`
    SELECT crs, name, lat, lon, (kb_status = 'ok') IS TRUE AS ok FROM stations WHERE in_schedule`.execute(db);
  return rankStations(rows, q, limit).map(({ ok: _ok, ...s }) => s);
}

/** Great-circle distance; ~2,600 stations, so a full scan is cheap. */
export async function nearbyStations(db: Db, lat: number, lon: number, limit: number): Promise<z.input<typeof NearbyStation>[]> {
  const { rows } = await sql<StationOut & { distance: number }>`
    SELECT crs, name, lat, lon,
      2 * 6371008.8 * asin(sqrt(
        power(sin(radians(lat - ${lat}) / 2), 2) +
        cos(radians(${lat})) * cos(radians(lat)) * power(sin(radians(lon - ${lon}) / 2), 2)
      )) AS distance
    FROM stations
    WHERE in_schedule AND lat IS NOT NULL AND lon IS NOT NULL
    ORDER BY distance
    LIMIT ${limit}`.execute(db);
  return rows.map(({ distance, ...s }) => ({ ...s, distanceMeters: Math.round(distance) }));
}

// ---- departures ----------------------------------------------------------------

interface Cursor {
  /** Departure, in minutes after midnight of the searched date. */
  k: number;
  u: string;
  r: string;
}

const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');

function decodeCursor(raw: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
    if (Number.isInteger(c.k) && typeof c.u === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c.r)) return c;
  } catch {
    // fall through
  }
  throw ApiError.validation([{ in: 'query', path: 'cursor', message: 'Invalid cursor' }]);
}

interface DepartureRow {
  train_uid: string;
  headcode: string | null;
  toc: string | null;
  dep_raw: number;
  platform: string | null;
  dest_crs: string | null;
  dest_name: string | null;
  dest_lat: number | null;
  dest_lon: number | null;
  dest_tiploc_name: string | null;
  arr_raw: number | null;
}

export interface DeparturesQuery {
  date: string;
  from: string;
  to?: string;
  after?: string;
  cursor?: string;
  limit: number;
}

/**
 * Passenger departures from `from` on `date` (the date I leave that station). A
 * train that started the day before and calls here after midnight counts, so two
 * run dates are searched: `date` (calls before 24:00) and the day before (calls
 * from 24:00 on, in that day's clock). Ordered by departure, then train UID and
 * run date, which is also what the cursor encodes.
 */
export async function findDepartures(db: Db, q: DeparturesQuery, live?: Lookups): Promise<z.input<typeof DeparturesResponse>> {
  await requireSchedule(db);
  const from = await getStation(db, q.from);
  const to = q.to ? await getStation(db, q.to) : null;
  if (to && to.crs === from.crs) {
    throw ApiError.validation([{ in: 'query', path: 'to', message: 'Must differ from the departure station' }]);
  }
  const cursor = q.cursor ? decodeCursor(q.cursor) : null;
  const after = cursor ? cursor.k : q.after ? hhmmToMinutes(q.after) : 0;

  const runs = [
    { run: q.date, offset: 0 },
    { run: addDays(q.date, -1), offset: 1440 },
  ];
  const found: (z.input<typeof Departure> & { key: Cursor })[] = [];
  for (const { run, offset } of runs) {
    // Strictly after the cursor's (departure, train UID, run date).
    const pastCursor = cursor
      ? cursor.r < run
        ? sql`(o.public_dep - ${offset} > ${cursor.k} OR (o.public_dep - ${offset} = ${cursor.k} AND s.train_uid COLLATE "C" >= ${cursor.u}))`
        : sql`(o.public_dep - ${offset} > ${cursor.k} OR (o.public_dep - ${offset} = ${cursor.k} AND s.train_uid COLLATE "C" > ${cursor.u}))`
      : sql`true`;
    const { rows } = await sql<DepartureRow>`
      SELECT s.train_uid, s.headcode, s.toc, o.public_dep AS dep_raw, o.platform,
             s.dest_crs, ds.name AS dest_name, ds.lat AS dest_lat, ds.lon AS dest_lon, dt.name AS dest_tiploc_name,
             ${to ? sql`a.public_arr` : sql`NULL::integer`} AS arr_raw
      FROM schedule.schedule_locations o
      JOIN schedule.schedules s ON s.id = o.schedule_id
      LEFT JOIN stations ds ON ds.crs = s.dest_crs
      LEFT JOIN schedule.tiplocs dt ON dt.tiploc = s.dest_tiploc
      ${
        to
          ? sql`JOIN LATERAL (
                  SELECT x.public_arr FROM schedule.schedule_locations x
                  WHERE x.schedule_id = o.schedule_id AND x.seq > o.seq AND x.crs = ${to.crs} AND x.public_arr IS NOT NULL
                  ORDER BY x.seq LIMIT 1
                ) a ON true`
          : sql``
      }
      WHERE o.crs = ${from.crs}
        AND o.public_dep BETWEEN ${offset + after} AND ${offset + 1439}
        AND s.is_passenger AND s.dest_crs IS NOT NULL
        AND ${pastCursor}
        AND ${runsAndWins('s', run)}
      ORDER BY o.public_dep, s.train_uid COLLATE "C"
      LIMIT ${q.limit + 1}`.execute(db);

    const seen = new Set<string>();
    for (const r of rows) {
      // A train calling twice (e.g. a loop) shows once.
      if (seen.has(r.train_uid)) continue;
      seen.add(r.train_uid);
      found.push({
        key: { k: r.dep_raw - offset, u: r.train_uid, r: run },
        trainUid: r.train_uid,
        runDate: run,
        headcode: r.headcode ?? '',
        operator: { code: r.toc ?? '', name: operatorName(r.toc) },
        scheduledDeparture: ukIsoAt(run, r.dep_raw),
        bookedPlatform: r.platform,
        destination: {
          crs: r.dest_crs!,
          name: r.dest_name ?? (r.dest_tiploc_name ? titleCase(r.dest_tiploc_name) : r.dest_crs!),
          lat: r.dest_lat,
          lon: r.dest_lon,
        },
        arrival: to && r.arr_raw !== null ? { station: to, scheduledArrival: ukIsoAt(run, r.arr_raw) } : null,
        // Filled in below from Darwin when it has the run.
        live: null,
      });
    }
  }

  // Byte order, matching COLLATE "C" above, so pages never skip or repeat a train.
  const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  found.sort((a, b) => a.key.k - b.key.k || cmp(a.key.u, b.key.u) || cmp(a.key.r, b.key.r));
  const page = found.slice(0, q.limit);
  const last = page.at(-1);
  if (live && page.length) {
    // Darwin overlay: only runs Darwin knows about (roughly today and tomorrow) get one.
    const lookups = await live.ready();
    const runs = await loadByTrain(db, page.map((d) => ({ uid: d.trainUid, ssd: d.runDate })));
    for (const d of page) {
      d.live = departureLive(runs.get(`${d.trainUid}|${d.runDate}`) ?? null, from.crs, d.scheduledDeparture, d.runDate, lookups.crsOf);
    }
  }
  return {
    date: q.date,
    from,
    to,
    departures: page.map(({ key: _key, ...d }) => d),
    nextCursor: found.length > q.limit && last ? encodeCursor(last.key) : null,
  };
}
