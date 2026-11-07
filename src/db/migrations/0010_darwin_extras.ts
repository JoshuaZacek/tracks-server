import { sql, type Kysely } from 'kysely';

/**
 * More from the Darwin feed (Sprint 3). See docs/darwin-notes.md.
 * - darwin_associations: trains that divide (VV) or join (JJ) at a location.
 *   `main_rid` is the train running through; `assoc_rid` is the portion that
 *   starts there (VV) or ends there (JJ). Next-working (NP) and linked (LK)
 *   associations aren't kept. A deleted association is removed; a cancelled
 *   one is kept with `cancelled`. Pruned with the runs (by main_rid's date).
 * - darwin_formations: a run's coaches (scheduleFormations), front to rear, per
 *   formation id. Locations name the formation that applies there (`fid`).
 * - darwin_station_messages: station messages (OW), keyed by Darwin's id, with
 *   the stations they are shown at. A message is replaced by each update.
 * Service and coach loading are kept on the location itself (darwin_locations.loc).
 */
export async function up(db: Kysely<unknown>) {
  await db.schema
    .createTable('darwin_associations')
    .addColumn('main_rid', 'text', (c) => c.notNull())
    .addColumn('assoc_rid', 'text', (c) => c.notNull())
    .addColumn('tiploc', 'text', (c) => c.notNull())
    .addColumn('category', 'text', (c) => c.notNull().check(sql`category IN ('VV', 'JJ')`))
    // The main train's planned times at the tiploc (wta, wtd, pta, ptd) and the portion's.
    .addColumn('main_times', 'jsonb', (c) => c.notNull())
    .addColumn('assoc_times', 'jsonb', (c) => c.notNull())
    .addColumn('cancelled', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('darwin_associations_pkey', ['main_rid', 'assoc_rid', 'tiploc', 'category'])
    .execute();
  await db.schema.createIndex('darwin_associations_assoc_idx').on('darwin_associations').column('assoc_rid').execute();

  await db.schema
    .createTable('darwin_formations')
    .addColumn('fid', 'text', (c) => c.primaryKey())
    .addColumn('rid', 'text', (c) => c.notNull())
    .addColumn('coaches', 'jsonb', (c) => c.notNull())
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex('darwin_formations_rid_idx').on('darwin_formations').column('rid').execute();

  await db.schema
    .createTable('darwin_station_messages')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('category', 'text', (c) => c.notNull())
    .addColumn('severity', 'smallint', (c) => c.notNull())
    .addColumn('suppress', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('message', 'text', (c) => c.notNull())
    .addColumn('url', 'text')
    .addColumn('crs', sql`text[]`, (c) => c.notNull())
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await sql`CREATE INDEX darwin_station_messages_crs_idx ON darwin_station_messages USING gin (crs)`.execute(db);
}

export async function down(db: Kysely<unknown>) {
  await db.schema.dropTable('darwin_station_messages').execute();
  await db.schema.dropTable('darwin_formations').execute();
  await db.schema.dropTable('darwin_associations').execute();
}
