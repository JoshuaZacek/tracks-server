import { sql } from 'kysely';
import request from 'supertest';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config/env.ts';
import { createDb, type Db } from '../src/db/client.ts';
import { createLogger } from '../src/logger.ts';
import { Lookups } from '../src/live/lookups.ts';
import { resetFeedCache } from '../src/live/feed.ts';
import { resetScheduleCache } from '../src/modules/reference.ts';

export function createTestContext(opts: { now?: () => Date; darwin?: boolean; production?: boolean } = {}) {
  const config = loadConfig();
  // Production applies rate limits to loopback clients too (tests are on 127.0.0.1).
  if (opts.production) config.isProduction = true;
  // Darwin "configured" without real credentials: the API only reads what tests write.
  if (opts.darwin) config.rdm.darwin.bootstrap = 'test.invalid:9092';
  const db = createDb(config.databaseUrl, { max: 2 });
  const lookups = new Lookups(db);
  const app = createApp({ config, db, log: createLogger(config, 'test'), now: opts.now ?? (() => new Date()), lookups });
  return { config, db, app, lookups, api: () => request(app) };
}

export async function resetData(db: Db) {
  await sql`TRUNCATE devices, journeys, meta, darwin_services, darwin_locations, darwin_associations, darwin_formations, darwin_station_messages RESTART IDENTITY CASCADE`.execute(db);
  resetScheduleCache();
  resetFeedCache();
}

/** Registers a device and returns its bearer header. */
export async function registerDevice(api: () => request.Agent | ReturnType<typeof request>) {
  const res = await (api() as ReturnType<typeof request>).post('/v1/devices').send({ appVersion: '1.0 (1)', locale: 'en_GB' }).expect(201);
  return { deviceId: res.body.deviceId as string, token: res.body.token as string, auth: { Authorization: `Bearer ${res.body.token}` } };
}
