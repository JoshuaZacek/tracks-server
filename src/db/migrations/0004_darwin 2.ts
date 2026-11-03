import { sql, type Kysely } from 'kysely';

/**
 * Live Darwin state, built from the Push Port feed. One row per run (`rid`) and
 * one per location of the run, so an update rewrites only the locations it
 * touches (a whole-run JSON column would rewrite kilobytes per message).
 * RIDs start with the run's date (YYYYMMDD), which pruning uses.
 */
export async function up(db: Kysely<unknown>) {
  await db.schema
    .createTable('darwin_services')
    .addColumn('rid', 'text', (c) => c.primaryKey())
    .addColumn('uid', 'text', (c) => c.notNull())
    .addColumn('ssd', 'date', (c) => c.notNull())
    .addColumn('toc', 'text')
    .addColumn('train_id', 'text')
    .addColumn('cancel_reason', 'text')
    .addColumn('late_reason', 'text')
    .addColumn('deactivated', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex('darwin_services_uid_ssd_idx').on('darwin_services').columns(['uid', 'ssd']).execute();

  await db.schema
    .createTable('darwin_locations')
    .addColumn('rid', 'text', (c) => c.notNull())
    .addColumn('key', 'text', (c) => c.notNull()) // tiploc + planned working times: stable across messages
    .addColumn('tpl', 'text', (c) => c.notNull())
    .addColumn('crs', 'text')
    .addColumn('loc', 'jsonb', (c) => c.notNull())
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('darwin_locations_pkey', ['rid', 'key'])
    .execute();
  await db.schema.createIndex('darwin_locations_crs_idx').on('darwin_locations').columns(['crs', 'rid']).execute();
}

export async function down(db: Kysely<unknown>) {
  await db.schema.dropTable('darwin_locations').execute();
  await db.schema.dropTable('darwin_services').execute();
}
