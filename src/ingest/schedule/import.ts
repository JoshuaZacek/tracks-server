import fs from 'node:fs';
import { once } from 'node:events';
import readline from 'node:readline';
import { finished } from 'node:stream/promises';
import zlib from 'node:zlib';
import pg from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import { OLD_SCHEMA, SCHEDULE_SCHEMA, STAGING_SCHEMA, scheduleIndexesSql, scheduleTablesSql } from './ddl.ts';
import { parseScheduleRecord, parseTiplocRecord, recordType, titleCase } from './parse.ts';
import { deriveCrs, type TiplocRecord } from './tiplocCrs.ts';

export const META_KEYS = {
  importedAt: 'schedule_imported_at',
  timestamp: 'schedule_timestamp',
  sequence: 'schedule_sequence',
  coverage: 'schedule_tiploc_coverage',
} as const;

export interface ImportSummary {
  schedules: number;
  passengerSchedules: number;
  calls: number;
  unmappedCalls: number;
  stations: number;
  seconds: number;
}

type Log = (msg: string) => void;

/** One value in COPY text format. */
function copyValue(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return '\\N';
  if (typeof v === 'boolean') return v ? 't' : 'f';
  if (typeof v === 'number') return String(v);
  return v.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}
const copyRow = (values: (string | number | boolean | null | undefined)[]) => values.map(copyValue).join('\t') + '\n';

/** A COPY ... FROM STDIN stream with batching and backpressure. */
function copyWriter(client: pg.Client, sql: string) {
  const stream = client.query(copyFrom(sql));
  let buffer = '';
  return {
    async write(row: string) {
      buffer += row;
      if (buffer.length < 1 << 16) return;
      const chunk = buffer;
      buffer = '';
      if (!stream.write(chunk)) await once(stream, 'drain');
    },
    async end() {
      if (buffer) stream.write(buffer);
      stream.end();
      await finished(stream);
    },
  };
}

function openLines(file: string) {
  const raw = fs.createReadStream(file);
  const input = file.endsWith('.gz') ? raw.pipe(zlib.createGunzip()) : raw;
  return readline.createInterface({ input, crlfDelay: Infinity });
}

/**
 * Loads an NWR Schedule extract (.json.gz, or plain .ndjson for tests) into a
 * fresh `schedule_staging` schema with COPY, indexes it, then swaps it in as
 * `schedule` and refreshes the station list, all in one transaction. The API
 * keeps serving the previous timetable until the swap.
 */
export async function importSchedule(databaseUrl: string, file: string, log: Log = console.log): Promise<ImportSummary> {
  const started = Date.now();
  log(`Importing schedule from ${file}`);
  const connect = async (name: string) => {
    const c = new pg.Client({ connectionString: databaseUrl, application_name: `tracks-import-${name}` });
    await c.connect();
    return c;
  };
  const control = await connect('control');
  const scheduleClient = await connect('schedules');
  const locationClient = await connect('locations');

  try {
    await control.query(`DROP SCHEMA IF EXISTS ${STAGING_SCHEMA} CASCADE`);
    await control.query(scheduleTablesSql(STAGING_SCHEMA));

    const schedules = copyWriter(
      scheduleClient,
      `COPY ${STAGING_SCHEMA}.schedules (id, train_uid, stp, stp_rank, start_date, end_date, days_runs, is_passenger, headcode, toc, origin_crs, dest_crs, dest_tiploc, timings) FROM STDIN`,
    );
    const locations = copyWriter(
      locationClient,
      `COPY ${STAGING_SCHEMA}.schedule_locations (schedule_id, seq, tiploc, crs, public_arr, public_dep, platform) FROM STDIN`,
    );

    const tiplocs: TiplocRecord[] = [];
    let crsOf = new Map<string, string | null>();
    let tiplocsDone = false;
    // TiplocV1 records all come before the first schedule, so CRS codes can be resolved then.
    const finishTiplocs = async () => {
      if (tiplocsDone) return;
      tiplocsDone = true;
      deriveCrs(tiplocs);
      const byTiploc = new Map(tiplocs.map((t) => [t.tiploc, t]));
      const writer = copyWriter(control, `COPY ${STAGING_SCHEMA}.tiplocs (tiploc, crs, crs_source, nlc, stanox, name) FROM STDIN`);
      for (const t of byTiploc.values()) await writer.write(copyRow([t.tiploc, t.crs, t.crsSource, t.nlc, t.stanox, t.name]));
      await writer.end();
      crsOf = new Map(tiplocs.map((t) => [t.tiploc, t.crs]));
    };

    let header: { timestamp?: number; Metadata?: { sequence?: number } } | null = null;
    let id = 0;
    let passengerSchedules = 0;
    let calls = 0;
    let unmappedCalls = 0;

    for await (const line of openLines(file)) {
      const type = recordType(line);
      if (type === 'TiplocV1') {
        tiplocs.push(parseTiplocRecord(JSON.parse(line).TiplocV1));
      } else if (type === 'JsonScheduleV1') {
        await finishTiplocs();
        const s = parseScheduleRecord(JSON.parse(line).JsonScheduleV1);
        if (!s) continue;
        const mapped = s.calls.map((c) => ({ ...c, crs: crsOf.get(c.tiploc) ?? null }));
        const first = mapped.find((c) => c.crs);
        const last = mapped.findLast((c) => c.crs);
        id++;
        await schedules.write(
          copyRow([
            id,
            s.trainUid,
            s.stp,
            s.stpRank,
            s.startDate,
            s.endDate,
            s.daysRuns,
            s.isPassenger,
            s.headcode,
            s.toc,
            first?.crs,
            last?.crs,
            mapped.at(-1)?.tiploc,
            mapped.length ? JSON.stringify(s.timings) : null,
          ]),
        );
        for (const [seq, c] of mapped.entries()) {
          await locations.write(copyRow([id, seq, c.tiploc, c.crs, c.arr, c.dep, c.platform]));
          if (!c.crs) unmappedCalls++;
        }
        if (mapped.length) passengerSchedules++;
        calls += mapped.length;
        if (id % 100_000 === 0) log(`  ${id.toLocaleString()} schedules...`);
      } else if (type === 'JsonTimetableV1') {
        header = JSON.parse(line).JsonTimetableV1;
      }
    }
    await finishTiplocs();
    await schedules.end();
    await locations.end();
    log(`  ${id.toLocaleString()} schedules, ${passengerSchedules.toLocaleString()} passenger with public calls, ${calls.toLocaleString()} calls`);

    log('  building indexes...');
    await control.query(scheduleIndexesSql(STAGING_SCHEMA));

    // Every CRS with passenger calls gets a station row. Knowledgebase fills in the real name and
    // coordinates later; until then the name comes from the schedule's own TIPLOC record.
    const { rows: called } = await control.query<{ crs: string }>(
      `SELECT DISTINCT crs FROM ${STAGING_SCHEMA}.schedule_locations WHERE crs IS NOT NULL`,
    );
    const nameOf = new Map<string, string>();
    for (const t of tiplocs) if (t.crsSource === 'schedule' && t.crs) nameOf.set(t.crs, titleCase(t.name));
    const codes = called.map((r) => r.crs);
    const names = codes.map((c) => nameOf.get(c) ?? c);

    log('  swapping in the new timetable...');
    await control.query('BEGIN');
    try {
      await control.query(`DROP SCHEMA IF EXISTS ${OLD_SCHEMA} CASCADE`);
      await control.query(`ALTER SCHEMA ${SCHEDULE_SCHEMA} RENAME TO ${OLD_SCHEMA}`);
      await control.query(`ALTER SCHEMA ${STAGING_SCHEMA} RENAME TO ${SCHEDULE_SCHEMA}`);
      await control.query('UPDATE stations SET in_schedule = false WHERE in_schedule');
      await control.query(
        `INSERT INTO stations (crs, name, in_schedule)
         SELECT crs, name, true FROM unnest($1::text[], $2::text[]) AS s(crs, name)
         ON CONFLICT (crs) DO UPDATE SET in_schedule = true,
           name = CASE WHEN stations.kb_status = 'ok' THEN stations.name ELSE excluded.name END`,
        [codes, names],
      );
      const meta: [string, string][] = [
        [META_KEYS.importedAt, new Date().toISOString()],
        [META_KEYS.coverage, JSON.stringify({ calls, unmappedCalls })],
      ];
      if (header?.timestamp) meta.push([META_KEYS.timestamp, new Date(header.timestamp * 1000).toISOString()]);
      if (header?.Metadata?.sequence) meta.push([META_KEYS.sequence, String(header.Metadata.sequence)]);
      for (const [key, value] of meta) {
        await control.query(
          `INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
          [key, value],
        );
      }
      await control.query('COMMIT');
    } catch (err) {
      await control.query('ROLLBACK');
      throw err;
    }
    // Waits for any query still reading the old copy.
    await control.query(`DROP SCHEMA IF EXISTS ${OLD_SCHEMA} CASCADE`);

    const summary: ImportSummary = {
      schedules: id,
      passengerSchedules,
      calls,
      unmappedCalls,
      stations: codes.length,
      seconds: Math.round((Date.now() - started) / 1000),
    };
    const pct = calls ? ((100 * unmappedCalls) / calls).toFixed(2) : '0';
    log(`  ${codes.length} stations; ${unmappedCalls.toLocaleString()} calls (${pct}%) at TIPLOCs with no CRS`);
    log(`Schedule import finished in ${summary.seconds}s`);
    return summary;
  } catch (err) {
    await control.query(`DROP SCHEMA IF EXISTS ${STAGING_SCHEMA} CASCADE`).catch(() => {});
    throw err;
  } finally {
    await Promise.all([control.end(), scheduleClient.end(), locationClient.end()].map((p) => p.catch(() => {})));
  }
}
