import { sql } from 'kysely';
import request from 'supertest';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config/env.ts';
import { createDb, type Db } from '../src/db/client.ts';
import { createLogger } from '../src/logger.ts';
import { resetScheduleCache } from '../src/modules/reference.ts';

export function createTestContext(opts: { now?: () => Date } = {}) {
  const config = loadConfig();
  const db = createDb(config.databaseUrl, { max: 2 });
  const app = createApp({ config, db, log: createLogger(config, 'test'), now: opts.now ?? (() => new Date()) });
  return { config, db, app, api: () => request(app) };
}

export async function resetData(db: Db) {
  await sql`TRUNCATE devices, journeys, meta RESTART IDENTITY CASCADE`.execute(db);
  resetScheduleCache();
}

/** Registers a device and returns its bearer header. */
export async function registerDevice(api: () => request.Agent | ReturnType<typeof request>) {
  const res = await (api() as ReturnType<typeof request>).post('/v1/devices').send({ appVersion: '1.0 (1)', locale: 'en_GB' }).expect(201);
  return { deviceId: res.body.deviceId as string, token: res.body.token as string, auth: { Authorization: `Bearer ${res.body.token}` } };
}
