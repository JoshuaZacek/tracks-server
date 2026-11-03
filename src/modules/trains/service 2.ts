import { sql } from 'kysely';
import type { z } from 'zod';
import type { Db } from '../../db/client.ts';
import { operatorName } from '../../domain/operators.ts';
import { routePoints } from '../../domain/route.ts';
import { callingPointsLive } from '../../live/compute.ts';
import { loadByTrain } from '../../live/load.ts';
import type { Lookups } from '../../live/lookups.ts';
import { ApiError } from '../../http/errors.ts';
import { titleCase, type Timing } from '../../ingest/schedule/parse.ts';
import { ukIsoAt } from '../../time.ts';
import { requireSchedule, runsAndWins } from '../reference.ts';
import type { TrainDetails } from './schemas.ts';

export interface WinningSchedule {
  id: number;
  headcode: string | null;
  toc: string | null;
  timings: string | null;
}

/** The schedule a train runs to on a date after STP overlays; null if cancelled or not a passenger train that day. */
export async function winningSchedule(db: Db, trainUid: string, runDate: string): Promise<WinningSchedule | null> {
  const { rows } = await sql<WinningSchedule & { is_passenger: boolean; stp: string }>`
    SELECT s.id, s.headcode, s.toc, s.timings, s.is_passenger, s.stp FROM schedule.schedules s
    WHERE s.train_uid = ${trainUid} AND ${runsAndWins('s', runDate)}
    ORDER BY s.stp_rank, s.id LIMIT 1`.execute(db);
  const s = rows[0];
  return s && s.stp !== 'C' && s.is_passenger ? { id: s.id, headcode: s.headcode, toc: s.toc, timings: s.timings } : null;
}

interface CallRow {
  crs: string;
  station_name: string | null;
  tiploc_name: string | null;
  lat: number | null;
  lon: number | null;
  public_arr: number | null;
  public_dep: number | null;
  platform: string | null;
}

export async function getTrain(db: Db, trainUid: string, runDate: string, live?: Lookups): Promise<z.input<typeof TrainDetails>> {
  await requireSchedule(db);
  const s = await winningSchedule(db, trainUid, runDate);
  if (!s) throw ApiError.notFound('train_not_running', `Train ${trainUid} does not run as a passenger train on ${runDate}`);

  const { rows } = await sql<CallRow>`
    SELECT l.crs, st.name AS station_name, t.name AS tiploc_name, st.lat, st.lon, l.public_arr, l.public_dep, l.platform
    FROM schedule.schedule_locations l
    LEFT JOIN stations st ON st.crs = l.crs
    LEFT JOIN schedule.tiplocs t ON t.tiploc = l.tiploc
    WHERE l.schedule_id = ${s.id} AND l.crs IS NOT NULL
    ORDER BY l.seq`.execute(db);

  const callingPoints = rows.map((r, i) => ({
    crs: r.crs,
    name: r.station_name ?? (r.tiploc_name ? titleCase(r.tiploc_name) : r.crs),
    lat: r.lat,
    lon: r.lon,
    scheduledArrival: i === 0 || r.public_arr === null ? null : ukIsoAt(runDate, r.public_arr),
    scheduledDeparture: i === rows.length - 1 || r.public_dep === null ? null : ukIsoAt(runDate, r.public_dep),
    bookedPlatform: r.platform,
    live: null as z.input<typeof TrainDetails>['callingPoints'][number]['live'],
  }));

  if (live) {
    const lookups = await live.ready();
    const run = (await loadByTrain(db, [{ uid: trainUid, ssd: runDate }])).get(`${trainUid}|${runDate}`) ?? null;
    callingPointsLive(run, callingPoints, runDate, lookups.crsOf).forEach((l, i) => (callingPoints[i]!.live = l));
  }

  return {
    trainUid,
    runDate,
    headcode: s.headcode ?? '',
    operator: { code: s.toc ?? '', name: operatorName(s.toc) },
    callingPoints,
    route: s.timings ? await routeFor(db, JSON.parse(s.timings) as Timing[]) : [],
  };
}

/** Stations passed between calls, placed along each leg, so the map follows the railway. */
async function routeFor(db: Db, timings: Timing[]) {
  const tiplocs = [...new Set(timings.map((t) => t[0]))];
  const { rows } = await sql<{ tiploc: string; crs: string | null; lat: number | null; lon: number | null }>`
    SELECT t.tiploc, t.crs, s.lat, s.lon FROM schedule.tiplocs t LEFT JOIN stations s ON s.crs = t.crs
    WHERE t.tiploc = ANY(${tiplocs})`.execute(db);
  const crs = new Map(rows.map((r) => [r.tiploc, r.crs]));
  const coords = new Map(rows.filter((r) => r.crs && r.lat !== null && r.lon !== null).map((r) => [r.crs!, { lat: r.lat!, lon: r.lon! }]));
  return routePoints(
    timings,
    (t) => crs.get(t) ?? null,
    (c) => coords.get(c) ?? null,
  );
}
