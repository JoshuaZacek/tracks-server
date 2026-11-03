import { sql, type Kysely } from 'kysely';

/** Foundation: key/value metadata and app installs (devices). */
export async function up(db: Kysely<unknown>) {
  await db.schema
    .createTable('meta')
    .addColumn('key', 'text', (c) => c.primaryKey())
    .addColumn('value', 'text')
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable('devices')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('token_hash', 'text', (c) => c.notNull().unique())
    .addColumn('apns_token', 'text')
    .addColumn('apns_env', 'text', (c) => c.notNull().defaultTo('production').check(sql`apns_env IN ('sandbox', 'production')`))
    .addColumn('push_to_start_token', 'text')
    .addColumn('app_version', 'text', (c) => c.notNull())
    .addColumn('locale', 'text')
    .addColumn('prefs', 'jsonb', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('last_seen_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
}

export async function down(db: Kysely<unknown>) {
  await db.schema.dropTable('devices').execute();
  await db.schema.dropTable('meta').execute();
}
