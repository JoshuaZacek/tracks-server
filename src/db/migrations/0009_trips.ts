import { sql, type Kysely } from 'kysely';

/**
 * Connections (Sprint 2).
 * - trips: journeys with changes. Each leg is a journey with trip_id and leg
 *   (1 for the first train); (trip_id, leg) is unique, checked at commit so legs
 *   can be renumbered in one transaction. A trip always has two or more legs:
 *   the code unlinks the rest when it would drop below that.
 * - trips.alert_state: the connection status last told per change, keyed by the
 *   arriving leg ("1": "ok"), so connection alerts never repeat after a restart.
 *   It lives on the trip, not the journey, because the notifier writes each
 *   journey's alert_state in full while handling that journey.
 */
export async function up(db: Kysely<unknown>) {
  await db.schema
    .createTable('trips')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('device_id', 'uuid', (c) => c.notNull().references('devices.id').onDelete('cascade'))
    .addColumn('alert_state', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex('trips_device_idx').on('trips').column('device_id').execute();

  await db.schema
    .alterTable('journeys')
    .addColumn('trip_id', 'uuid', (c) => c.references('trips.id').onDelete('set null'))
    .addColumn('leg', 'smallint', (c) => c.check(sql`leg >= 1`))
    .execute();
  await sql`ALTER TABLE journeys ADD CONSTRAINT journeys_trip_leg_key UNIQUE (trip_id, leg) DEFERRABLE INITIALLY DEFERRED`.execute(db);
}

export async function down(db: Kysely<unknown>) {
  await sql`ALTER TABLE journeys DROP CONSTRAINT journeys_trip_leg_key`.execute(db);
  await db.schema.alterTable('journeys').dropColumn('trip_id').dropColumn('leg').execute();
  await db.schema.dropTable('trips').execute();
}
