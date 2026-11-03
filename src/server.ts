import { createApp } from './app.ts';
import { loadConfig } from './config/env.ts';
import { createDb } from './db/client.ts';
import { createLogger } from './logger.ts';

const config = loadConfig();
const log = createLogger(config, 'api');
const db = createDb(config.databaseUrl, { applicationName: 'tracks-api' });
const app = createApp({ config, db, log, now: () => new Date() });

const server = app.listen(config.port, (err?: Error) => {
  if (err) {
    log.fatal({ err }, 'Could not start the API');
    process.exit(1);
  }
  log.info(`API listening on http://localhost:${config.port}`);
});

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'Shutting down');
  // Stop accepting connections, let in-flight requests finish, then close the pool.
  const timer = setTimeout(() => {
    log.warn('Forcing exit after 10 s');
    process.exit(1);
  }, 10_000);
  timer.unref();
  server.close(async () => {
    await db.destroy();
    process.exit(0);
  });
  server.closeIdleConnections();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
