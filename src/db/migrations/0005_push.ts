import { sql, type Kysely } from 'kysely';

/**
 * Push (Phase 5).
 * - journeys.alert_state: what the user has already been told about a journey
 *   (platform, delay, departed, …), so alerts fire on real changes only and a
 *   restart never repeats one. Null until the first status is seen.
 * - live_activities: the ActivityKit update token for a journey's Live
 *   Activity and the content last pushed to it. One per journey; `ended_at`
 *   keeps the row after it ends so the server doesn't start it again.
 * - push_log: every push (or would-be push when APNs isn't configured), kept
 *   for a week. A unique (journey, dedupe_key) stops one-off alerts repeating.
 */
export async function up(db: Kysely<unknown>) {
  await db.schema.alterTable('journeys').addColumn('alert_state', 'jsonb').execute();

  await db.schema
    .createTable('live_activities')
    .addColumn('journey_id', 'uuid', (c) => c.primaryKey().references('journeys.id').onDelete('cascade'))
    .addColumn('push_token', 'text', (c) => c.notNull())
    .addColumn('sent_content', 'jsonb')
    .addColumn('last_pushed_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('ended_at', 'timestamptz')
    .execute();

  await db.schema
    .createTable('push_log')
    .addColumn('id', 'bigserial', (c) => c.primaryKey())
    .addColumn('journey_id', 'uuid', (c) => c.notNull().references('journeys.id').onDelete('cascade'))
    .addColumn('channel', 'text', (c) => c.notNull().check(sql`channel IN ('alert', 'live_activity')`))
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('dedupe_key', 'text')
    .addColumn('payload', 'jsonb', (c) => c.notNull())
    .addColumn('outcome', 'text', (c) => c.notNull().defaultTo('pending'))
    .addColumn('http_status', 'smallint')
    .addColumn('reason', 'text')
    .addColumn('apns_id', 'text')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await sql`CREATE UNIQUE INDEX push_log_dedupe_idx ON push_log (journey_id, dedupe_key) WHERE dedupe_key IS NOT NULL`.execute(db);
  await db.schema.createIndex('push_log_created_idx').on('push_log').column('created_at').execute();
}

export async function down(db: Kysely<unknown>) {
  await db.schema.dropTable('push_log').execute();
  await db.schema.dropTable('live_activities').execute();
  await db.schema.alterTable('journeys').dropColumn('alert_state').execute();
}
