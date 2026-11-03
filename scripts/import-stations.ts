/**
 * Fetches station names and coordinates from Knowledgebase for every station in
 * the schedule not fetched in the last week (~15 minutes the first time).
 *   npm run import:stations
 */
import { sql } from 'kysely';
import { loadConfig } from '../src/config/env.ts';
import { createDb } from '../src/db/client.ts';
import { refreshStations } from '../src/ingest/stations.ts';

const config = loadConfig();
const db = createDb(config.databaseUrl, { max: 4 });
await refreshStations(db, config);
const { rows } = await sql<{ total: number; ok: number; missing: number; coords: number }>`
  SELECT count(*)::int AS total, count(*) FILTER (WHERE kb_status = 'ok')::int AS ok,
         count(*) FILTER (WHERE kb_status = 'not_found')::int AS missing, count(lat)::int AS coords
  FROM stations WHERE in_schedule`.execute(db);
console.log('Stations in schedule:', rows[0]);
await db.destroy();
