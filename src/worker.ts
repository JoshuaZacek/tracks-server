import { readFileSync } from 'node:fs';
import { apnsConfigured, loadConfig } from './config/env.ts';
import { createDb } from './db/client.ts';
import { META, setMeta } from './db/meta.ts';
import { startDailyRefresh } from './ingest/refresh.ts';
import { startTracking } from './live/tracking.ts';
import { createLogger } from './logger.ts';
import { ApnsClient } from './push/apns.ts';
import { createNotifier } from './push/notifier.ts';
import pg from 'pg';

/**
 * Background process: the daily reference data refresh and live tracking (the
 * Darwin consumer, journey updater and push notifier). Only one may run:
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
let stopTracking: (() => Promise<void>) | undefined;

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
  stopTracking = await startTracking(db, config, log, createNotifier({
      db,
      log,
      sender: apnsSender(),
      bundleId: config.apns.bundleId,
      darwinEnabled: Boolean(config.rdm.darwin.bootstrap),
    }),);
}

/** The APNs client, or null for a dry run (pushes are worked out and logged but not sent). */
function apnsSender() {
  if (!apnsConfigured(config)) {
    log.warn('APNs not configured (APNS_*): push dry run, recorded in push_log only');
    return null;
  }
  const { keyId, teamId, keyPath, bundleId } = config.apns;
  log.info({ keyId, teamId, bundleId }, 'APNs enabled');
  return new ApnsClient({ keyId, teamId, key: readFileSync(keyPath, 'utf8') });
}

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'Shutting down');
  clearInterval(heartbeat);
  stopRefresh?.();
  // Flush and commit what the Darwin consumer has, so a restart resumes exactly there.
  await stopTracking?.().catch((err) => log.error({ err }, 'Stopping tracking failed'));
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
