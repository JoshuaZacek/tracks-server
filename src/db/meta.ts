import { sql } from 'kysely';
import type { Db } from './client.ts';

export async function getMeta(db: Db, key: string): Promise<string | null> {
  const row = await db.selectFrom('meta').select('value').where('key', '=', key).executeTakeFirst();
  return row?.value ?? null;
}

export async function setMeta(db: Db, key: string, value: string) {
  await db
    .insertInto('meta')
    .values({ key, value })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value, updated_at: sql`now()` }))
    .execute();
}

export const META = {
  workerHeartbeat: 'worker_heartbeat_at',
} as const;
