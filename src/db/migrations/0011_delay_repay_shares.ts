import { sql, type Kysely } from 'kysely';

/**
 * Delay Repay and sharing a journey (Sprint 4).
 * - journeys gain what the user said about a Delay Repay claim: the ticket price
 *   and type (for the estimate) and when they marked it claimed. Whether a
 *   journey can be claimed for is worked out from its live status when read.
 * - journey_shares: public links to a journey's live status. The token is
 *   random (128 bits, base64url) and stored as is: it only reads a cut-down
 *   status. A link lasts until 6 h after the scheduled arrival (expires_at) or
 *   until revoked; it goes with the journey.
 */
export async function up(db: Kysely<unknown>) {
  await db.schema
    .alterTable('journeys')
    .addColumn('claim_ticket_pence', 'integer', (c) => c.check(sql`claim_ticket_pence >= 0`))
    .addColumn('claim_ticket_type', 'text', (c) => c.check(sql`claim_ticket_type IN ('single', 'return')`))
    .addColumn('claimed_at', 'timestamptz')
    .execute();

  await db.schema
    .createTable('journey_shares')
    .addColumn('token', 'text', (c) => c.primaryKey())
    .addColumn('journey_id', 'uuid', (c) => c.notNull().references('journeys.id').onDelete('cascade'))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
    .addColumn('revoked_at', 'timestamptz')
    .execute();
  await db.schema.createIndex('journey_shares_journey_idx').on('journey_shares').column('journey_id').execute();
}

export async function down(db: Kysely<unknown>) {
  await db.schema.dropTable('journey_shares').execute();
  await db.schema.alterTable('journeys').dropColumn('claim_ticket_pence').dropColumn('claim_ticket_type').dropColumn('claimed_at').execute();
}
