/**
 * Loads an NWR Schedule extract into Postgres.
 *   npm run import:schedule [-- path/to/CIF_ALL_FULL_DAILY_toc-full.json.gz]
 * Defaults to DATA_DIR/CIF_ALL_FULL_DAILY_toc-full.json.gz.
 */
import fs from 'node:fs';
import { loadConfig } from '../src/config/env.ts';
import { importSchedule } from '../src/ingest/schedule/import.ts';

const config = loadConfig();
const file = process.argv[2] ?? config.scheduleFile;
if (!fs.existsSync(file)) {
  console.error(`Schedule file not found: ${file}`);
  process.exit(1);
}
await importSchedule(config.databaseUrl, file);
