import { sql, type Kysely } from 'kysely';
import { SCHEDULE_SCHEMA, scheduleIndexesSql, scheduleTablesSql } from '../../ingest/schedule/ddl.ts';

/**
 * Stations (a cache of Knowledgebase, kept across imports) and an empty
 * `schedule` schema so queries work before the first import; each import
 * replaces the schema wholesale.
 */
export async function up(db: Kysely<unknown>) {
  await db.schema
    .createTable('stations')
    .addColumn('crs', 'text', (c) => c.primaryKey())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('lat', 'double precision')
    .addColumn('lon', 'double precision')
    .addColumn('nlc', 'text')
    .addColumn('kb_status', 'text', (c) => c.check(sql`kb_status IN ('ok', 'not_found')`))
    .addColumn('fetched_at', 'timestamptz')
    .addColumn('in_schedule', 'boolean', (c) => c.notNull().defaultTo(false))
    .execute();

  await sql.raw(scheduleTablesSql(SCHEDULE_SCHEMA)).execute(db);
  await sql.raw(scheduleIndexesSql(SCHEDULE_SCHEMA)).execute(db);
}

export async function down(db: Kysely<unknown>) {
  await sql.raw(`DROP SCHEMA IF EXISTS ${SCHEDULE_SCHEMA} CASCADE`).execute(db);
  await db.schema.dropTable('stations').execute();
}
