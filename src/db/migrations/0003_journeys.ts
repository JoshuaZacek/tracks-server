import { sql, type Kysely } from 'kysely';

/**
 * Journeys a device has saved. The train's calling pattern and route are
 * snapshotted when saved, so later timetable imports don't change a saved trip.
 * `rid`, `state` and `status` are filled in by live tracking (Phase 4).
 */
export async function up(db: Kysely<unknown>) {
  await db.schema
    .createTable('journeys')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('device_id', 'uuid', (c) => c.notNull().references('devices.id').onDelete('cascade'))
    .addColumn('train_uid', 'text', (c) => c.notNull())
    .addColumn('run_date', 'date', (c) => c.notNull())
    .addColumn('date', 'date', (c) => c.notNull())
    .addColumn('from_crs', 'text', (c) => c.notNull())
    .addColumn('to_crs', 'text', (c) => c.notNull())
    .addColumn('from_index', 'smallint', (c) => c.notNull())
    .addColumn('to_index', 'smallint', (c) => c.notNull())
    .addColumn('headcode', 'text', (c) => c.notNull())
    .addColumn('toc', 'text', (c) => c.notNull())
    .addColumn('scheduled_departure', 'timestamptz', (c) => c.notNull())
    .addColumn('scheduled_arrival', 'timestamptz', (c) => c.notNull())
    .addColumn('booked_platform', 'text')
    .addColumn('calling_points', 'jsonb', (c) => c.notNull())
    .addColumn('route', 'jsonb', (c) => c.notNull())
    .addColumn('prefs', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('rid', 'text')
    .addColumn('state', 'text', (c) =>
      c.notNull().defaultTo('scheduled').check(sql`state IN ('scheduled', 'live', 'departed', 'arrived', 'cancelled', 'not_found')`),
    )
    .addColumn('status', 'jsonb')
    .addColumn('status_updated_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('archived_at', 'timestamptz')
    .addUniqueConstraint('journeys_device_trip_key', ['device_id', 'train_uid', 'run_date', 'from_crs', 'to_crs'])
    .execute();

  await db.schema.createIndex('journeys_device_departure_idx').on('journeys').columns(['device_id', 'scheduled_departure']).execute();
  // Live tracking looks journeys up by Darwin run id, but only while they can still change.
  await sql`CREATE INDEX journeys_active_rid_idx ON journeys (rid) WHERE state NOT IN ('arrived', 'cancelled', 'not_found')`.execute(db);
  await sql`CREATE INDEX journeys_active_train_idx ON journeys (train_uid, run_date) WHERE state NOT IN ('arrived', 'cancelled', 'not_found')`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>) {
  await db.schema.dropTable('journeys').execute();
}
