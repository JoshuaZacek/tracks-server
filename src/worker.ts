import { loadConfig } from './config/env.ts';
import { createDb } from './db/client.ts';
import { META, setMeta } from './db/meta.ts';
import { startDailyRefresh } from './ingest/refresh.ts';
import { createLogger } from './logger.ts';
import pg from 'pg';

/**
 * Background process: in later phases it runs the daily refresh, the Darwin and
 * TRUST consumers, the journey updater and the push sender. Only one may run:
 * a Postgres advisory lock held on a dedicated connection enforces that, and a
 * second worker waits until the first one exits (e.g. during a redeploy).
 */
const WORKER_LOCK_ID = 727_001; // arbitrary, fixed for this app
const HEARTBEAT_MS = 30_000;
const LOCK_RETRY_MS = 5_000;

const config = loadConfig();
const log = createLogger(config, 'worker');
const db = createDb(config.databaseUrl, { max: 5, applicationName: 'tracks-worker' });
const lockClient = new pg.Client({ connectionString: config.databaseUrl, application_name: 'tracks-worker-lock' });

let stopping = false;
let heartbeat: NodeJS.Timeout | undefined;
let stopRefresh: (() => void) | undefined;

async function acquireLock() {
  await lockClient.connect();
  for (;;) {
    const { rows } = await lockClient.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [WORKER_LOCK_ID]);
    if (rows[0]?.locked) return true;
    if (stopping) return false;
    log.info('Another worker holds the lock; waiting');
    await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
  }
}

async function beat() {
  try {
    await setMeta(db, META.workerHeartbeat, new Date().toISOString());
  } catch (err) {
    log.error({ err }, 'Heartbeat failed');
  }
}

async function main() {
  if (!(await acquireLock())) return;
  log.info('Worker started');
  await beat();
  heartbeat = setInterval(() => void beat(), HEARTBEAT_MS);
  stopRefresh = startDailyRefresh(db, config, log);
  // Phase 4+: start the Darwin consumer, journey updater and push sender here.
}

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'Shutting down');
  clearInterval(heartbeat);
  stopRefresh?.();
  await lockClient.end().catch(() => {}); // closing the session releases the advisory lock
  await db.destroy();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((err) => {
  log.fatal({ err }, 'Worker failed');
  process.exit(1);
});
