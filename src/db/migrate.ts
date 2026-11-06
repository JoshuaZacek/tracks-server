import { Migrator, type Migration } from 'kysely/migration';
import type { Db } from './client.ts';
import * as m0001 from './migrations/0001_init.ts';
import * as m0002 from './migrations/0002_reference_data.ts';
import * as m0003 from './migrations/0003_journeys.ts';
import * as m0004 from './migrations/0004_darwin.ts';
import * as m0005 from './migrations/0005_push.ts';
import * as m0006 from './migrations/0006_station_calls.ts';
import * as m0007 from './migrations/0007_background_push.ts';
import * as m0008 from './migrations/0008_journey_templates.ts';
import * as m0009 from './migrations/0009_trips.ts';

/** Listed explicitly (not read from disk) so migrations are type-checked and bundled with the code. */
const migrations: Record<string, Migration> = {
  '0001_init': m0001,
  '0002_reference_data': m0002,
  '0003_journeys': m0003,
  '0004_darwin': m0004,
  '0005_push': m0005,
  '0006_station_calls': m0006,
  '0007_background_push': m0007,
  '0008_journey_templates': m0008,
  '0009_trips': m0009,
};

export async function migrateToLatest(db: Db) {
  const migrator = new Migrator({ db, provider: { getMigrations: async () => migrations } });
  const { error, results } = await migrator.migrateToLatest();
  if (error) throw error instanceof Error ? error : new Error(String(error));
  return (results ?? []).map((r) => ({ name: r.migrationName, status: r.status }));
}
