import { sql, type Kysely } from 'kysely';

/**
 * stations.calls: public calls in the imported timetable, a measure of how
 * busy a station is. Station search breaks ties with it so London Kings Cross
 * comes before Kings Nympton. Set by each timetable import; filled here from
 * the timetable already loaded, if any.
 */
export async function up(db: Kysely<unknown>) {
  await db.schema.alterTable('stations').addColumn('calls', 'integer', (c) => c.notNull().defaultTo(0)).execute();
  const { rows } = await sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'schedule' AND tablename = 'schedule_locations'`.execute(db);
  if (rows[0]?.n) {
    await sql`
      UPDATE stations s SET calls = c.n
      FROM (SELECT crs, count(*)::int AS n FROM schedule.schedule_locations WHERE crs IS NOT NULL GROUP BY crs) c
      WHERE s.crs = c.crs`.execute(db);
  }
}

export async function down(db: Kysely<unknown>) {
  await db.schema.alterTable('stations').dropColumn('calls').execute();
}
