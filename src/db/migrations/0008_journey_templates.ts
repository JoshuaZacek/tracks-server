import { sql, type Kysely } from 'kysely';

/**
 * Regular journeys (Sprint 1).
 * - journey_templates: a trip a device makes on certain weekdays. The worker
 *   creates a journey from it for today and tomorrow, matching the timetabled
 *   train by stations and time (`train_uid` is only a hint: UIDs change with
 *   the timetable). `last_created_date` makes that idempotent, so a journey the
 *   user deleted is not made again; `problem_date` is the date no train matched.
 * - journeys.template_id: the template a journey was made from (kept when the
 *   template goes: set to null). journeys.travel_minutes: time to get to the
 *   station, for the "leave now" alert.
 * - push_log rows can be about a template instead of a journey (the
 *   template_unmatched alert), deduplicated per template like journey alerts.
 */
export async function up(db: Kysely<unknown>) {
  await db.schema
    .createTable('journey_templates')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('device_id', 'uuid', (c) => c.notNull().references('devices.id').onDelete('cascade'))
    .addColumn('train_uid', 'text')
    .addColumn('from_crs', 'text', (c) => c.notNull())
    .addColumn('to_crs', 'text', (c) => c.notNull())
    .addColumn('depart_time', 'text', (c) => c.notNull().check(sql`depart_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`))
    .addColumn('days', 'smallint', (c) => c.notNull().check(sql`days BETWEEN 1 AND 127`))
    .addColumn('travel_minutes', 'integer', (c) => c.check(sql`travel_minutes BETWEEN 0 AND 240`))
    .addColumn('summary_time', 'text', (c) => c.check(sql`summary_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`))
    .addColumn('prefs', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('last_created_date', 'date')
    .addColumn('problem_date', 'date')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex('journey_templates_device_idx').on('journey_templates').column('device_id').execute();

  await db.schema
    .alterTable('journeys')
    .addColumn('template_id', 'uuid', (c) => c.references('journey_templates.id').onDelete('set null'))
    .addColumn('travel_minutes', 'integer', (c) => c.check(sql`travel_minutes BETWEEN 0 AND 240`))
    .execute();
  await sql`CREATE INDEX journeys_template_idx ON journeys (template_id) WHERE template_id IS NOT NULL`.execute(db);

  await sql`ALTER TABLE push_log ALTER COLUMN journey_id DROP NOT NULL`.execute(db);
  await db.schema
    .alterTable('push_log')
    .addColumn('template_id', 'uuid', (c) => c.references('journey_templates.id').onDelete('cascade'))
    .execute();
  await sql`ALTER TABLE push_log ADD CONSTRAINT push_log_subject_check CHECK (journey_id IS NOT NULL OR template_id IS NOT NULL)`.execute(db);
  await sql`CREATE UNIQUE INDEX push_log_template_dedupe_idx ON push_log (template_id, dedupe_key) WHERE template_id IS NOT NULL AND dedupe_key IS NOT NULL`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>) {
  await sql`DELETE FROM push_log WHERE journey_id IS NULL`.execute(db);
  await sql`DROP INDEX push_log_template_dedupe_idx`.execute(db);
  await sql`ALTER TABLE push_log DROP CONSTRAINT push_log_subject_check`.execute(db);
  await db.schema.alterTable('push_log').dropColumn('template_id').execute();
  await sql`ALTER TABLE push_log ALTER COLUMN journey_id SET NOT NULL`.execute(db);
  await db.schema.alterTable('journeys').dropColumn('template_id').dropColumn('travel_minutes').execute();
  await db.schema.dropTable('journey_templates').execute();
}
