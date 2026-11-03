import pg from 'pg';
import { createDb } from '../src/db/client.ts';
import { migrateToLatest } from '../src/db/migrate.ts';

/** Drops and recreates the test database, then applies every migration. */
export default async function setup() {
  const url = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/tracks_test');
  const name = url.pathname.slice(1);
  if (!/^[a-z0-9_]*test[a-z0-9_]*$/.test(name)) throw new Error(`Refusing to recreate "${name}": test database names must contain "test"`);

  const admin = new pg.Client({ connectionString: Object.assign(new URL(url), { pathname: '/postgres' }).toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();

  const db = createDb(url.toString(), { max: 1 });
  await migrateToLatest(db);
  await db.destroy();
}
