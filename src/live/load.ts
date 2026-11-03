import { sql } from 'kysely';
import type { Db } from '../db/client.ts';
import type { DarwinLocation } from '../darwin/parse.ts';
import type { DarwinRunData, DarwinService } from './compute.ts';

interface ServiceRow {
  rid: string;
  uid: string;
  ssd: string;
  toc: string | null;
  train_id: string | null;
  cancel_reason: string | null;
  late_reason: string | null;
  deactivated: boolean;
}

const toService = (r: ServiceRow): DarwinService => ({
  rid: r.rid,
  uid: r.uid,
  ssd: r.ssd,
  toc: r.toc,
  trainId: r.train_id,
  cancelReason: r.cancel_reason,
  lateReason: r.late_reason,
  deactivated: r.deactivated,
});

async function withLocations(db: Db, services: ServiceRow[]) {
  const out = new Map<string, DarwinRunData>();
  if (!services.length) return out;
  const { rows } = await sql<{ rid: string; loc: DarwinLocation }>`
    SELECT rid, loc FROM darwin_locations WHERE rid = ANY(${services.map((s) => s.rid)}::text[])`.execute(db);
  for (const s of services) out.set(s.rid, { service: toService(s), locations: [] });
  for (const r of rows) out.get(r.rid)?.locations.push(r.loc);
  return out;
}

/** Darwin runs by rid. */
export async function loadByRid(db: Db, rids: string[]): Promise<Map<string, DarwinRunData>> {
  if (!rids.length) return new Map();
  const { rows } = await sql<ServiceRow>`SELECT * FROM darwin_services WHERE rid = ANY(${rids}::text[])`.execute(db);
  return withLocations(db, rows);
}

/** Darwin runs by timetable identity, keyed `uid|ssd`. If Darwin has two runs for one (rare), the latest updated wins. */
export async function loadByTrain(db: Db, trains: { uid: string; ssd: string }[]): Promise<Map<string, DarwinRunData>> {
  const out = new Map<string, DarwinRunData>();
  if (!trains.length) return out;
  const { rows } = await sql<ServiceRow>`
    SELECT DISTINCT ON (d.uid, d.ssd) d.* FROM darwin_services d
    JOIN unnest(${trains.map((t) => t.uid)}::text[], ${trains.map((t) => t.ssd)}::date[]) AS t(uid, ssd) ON d.uid = t.uid AND d.ssd = t.ssd
    ORDER BY d.uid, d.ssd, d.updated_at DESC`.execute(db);
  for (const run of (await withLocations(db, rows)).values()) out.set(`${run.service.uid}|${run.service.ssd}`, run);
  return out;
}
