import { setTimeout as sleep } from 'node:timers/promises';
import { sql } from 'kysely';
import { XMLParser } from 'fast-xml-parser';
import type { Config } from '../config/env.ts';
import type { Db } from '../db/client.ts';
import { rdmGet } from '../rdm/http.ts';

/**
 * Knowledgebase Stations only has a per-station endpoint (station-{CRS}.xml), so
 * this fetches every station with passenger calls in the schedule, slowly, and
 * caches the result in `stations`. Rows fetched in the last week are skipped.
 */
const MAX_AGE_DAYS = 7;
const CONCURRENCY = 3;
const MIN_GAP_MS = 400; // per worker: at most ~7 requests/second overall
const MAX_ATTEMPTS = 4;

const parser = new XMLParser({ removeNSPrefix: true, parseTagValue: false });

export interface KbStation {
  crs: string;
  name: string;
  lat: number | null;
  lon: number | null;
  nlc: string | null;
}

export function parseKbStation(xml: string): KbStation | null {
  const s = parser.parse(xml)?.['StationV4.0'];
  if (!s?.CrsCode) return null;
  const num = (v: unknown) => (v === undefined || v === '' ? null : Number(v));
  return {
    crs: String(s.CrsCode),
    name: String(s.Name),
    lat: num(s.Latitude),
    lon: num(s.Longitude),
    nlc: s.AlternativeIdentifiers?.NationalLocationCode ? String(s.AlternativeIdentifiers.NationalLocationCode) : null,
  };
}

type Log = (msg: string) => void;
let running = false;

export async function refreshStations(db: Db, config: Config, log: Log = console.log) {
  const { url, key } = config.rdm.kbStations;
  if (!url || !key) {
    log('Stations: KB_STATIONS_URL / KB_STATIONS_API_KEY not set, skipped');
    return;
  }
  if (running) return;
  running = true;
  try {
    const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 86_400_000);
    const todo = (
      await db
        .selectFrom('stations')
        .select('crs')
        .where('in_schedule', '=', true)
        .where((eb) => eb.or([eb('fetched_at', 'is', null), eb('fetched_at', '<', cutoff)]))
        .orderBy('crs')
        .execute()
    ).map((r) => r.crs);
    if (!todo.length) return;
    log(`Stations: fetching ${todo.length} from Knowledgebase`);

    const auth = { header: config.rdm.authHeader, key };
    let done = 0;
    let failed = 0;
    const worker = async () => {
      for (let crs = todo.shift(); crs; crs = todo.shift()) {
        const started = Date.now();
        const result = await fetchStation(url.replace(/\{crs\}/i, crs), auth, log);
        if (result === 'not_found') {
          await db.updateTable('stations').set({ kb_status: 'not_found', fetched_at: new Date() }).where('crs', '=', crs).execute();
        } else if (result) {
          await db
            .updateTable('stations')
            .set({ name: result.name, lat: result.lat, lon: result.lon, nlc: result.nlc, kb_status: 'ok', fetched_at: new Date() })
            .where('crs', '=', crs)
            .execute();
        } else failed++; // left unfetched; retried on the next run
        if (++done % 250 === 0) log(`  ${done} stations...`);
        await sleep(Math.max(0, MIN_GAP_MS - (Date.now() - started)));
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    log(`Stations: done (${done} fetched, ${failed} failed)`);
  } finally {
    running = false;
  }
  await borrowCoordinates(db, log);
}

/**
 * Some schedule CRS codes are extra codes for part of a bigger station (ABX
 * Abbey Wood Elizabeth line, ALE Liverpool South Parkway high level) and have no
 * Knowledgebase page. They take the coordinates of the Knowledgebase station
 * with the same first four NLC digits.
 */
async function borrowCoordinates(db: Db, log: Log) {
  const result = await sql`
    UPDATE stations AS s SET lat = kb.lat, lon = kb.lon
    FROM schedule.tiplocs t, stations kb
    WHERE s.kb_status = 'not_found' AND s.lat IS NULL
      AND t.crs = s.crs AND t.crs_source = 'schedule' AND t.nlc IS NOT NULL
      AND kb.kb_status = 'ok' AND kb.lat IS NOT NULL AND substr(kb.nlc, 1, 4) = substr(t.nlc, 1, 4)`.execute(db);
  if (result.numAffectedRows) log(`Stations: ${result.numAffectedRows} without a Knowledgebase page took coordinates from a sibling station`);
}

async function fetchStation(url: string, auth: { header: string; key: string }, log: Log): Promise<KbStation | 'not_found' | null> {
  const name = url.split('/').pop();
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await rdmGet(url, auth, 'application/xml');
      if (res.status === 200) return parseKbStation(res.body) ?? 'not_found';
      // A CRS with no Knowledgebase file comes back from the S3/CloudFront origin as a
      // 403 HTML error page (e.g. ABX, Abbey Wood Elizabeth line), not a 404.
      if (res.status === 404 || (res.status === 403 && res.headers['content-type']?.startsWith('text/html'))) return 'not_found';
      const retryAfter = Number(res.headers['retry-after']);
      const wait = retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt;
      log(`  ${name}: HTTP ${res.status}, retrying in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    } catch (err) {
      log(`  ${name}: ${(err as Error).message}, retrying`);
      await sleep(2000 * 2 ** attempt);
    }
  }
  return null;
}
