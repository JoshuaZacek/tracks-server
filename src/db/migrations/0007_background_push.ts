import { sql, type Kysely } from 'kysely';

/**
 * push_log.channel gains 'background': silent (content-available) pushes that
 * wake the app, e.g. to move the stop alarm when the expected arrival changes.
 */
export async function up(db: Kysely<unknown>) {
  await sql`ALTER TABLE push_log DROP CONSTRAINT push_log_channel_check`.execute(db);
  await sql`ALTER TABLE push_log ADD CONSTRAINT push_log_channel_check CHECK (channel IN ('alert', 'live_activity', 'background'))`.execute(db);
}

export async function down(db: Kysely<unknown>) {
  await sql`DELETE FROM push_log WHERE channel = 'background'`.execute(db);
  await sql`ALTER TABLE push_log DROP CONSTRAINT push_log_channel_check`.execute(db);
  await sql`ALTER TABLE push_log ADD CONSTRAINT push_log_channel_check CHECK (channel IN ('alert', 'live_activity'))`.execute(db);
}
