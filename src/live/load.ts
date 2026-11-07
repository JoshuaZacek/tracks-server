import { sql } from 'kysely';
import type { Db } from '../db/client.ts';
import type { DarwinLocation } from '../darwin/parse.ts';
import type { AssociationTimes, FormationCoach } from '../db/types.ts';
import type { DarwinAssociation, DarwinRunData, DarwinService } from './compute.ts';

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

/** Loads with the run: its divisions and formations as well as its locations (journeys need them; boards don't). */
export interface LoadOptions {
  extras?: boolean;
}

async function withLocations(db: Db, services: ServiceRow[], opts: LoadOptions = {}) {
  const out = new Map<string, DarwinRunData>();
  if (!services.length) return out;
  const rids = services.map((s) => s.rid);
  const { rows } = await sql<{ rid: string; loc: DarwinLocation }>`
    SELECT rid, loc FROM darwin_locations WHERE rid = ANY(${rids}::text[])`.execute(db);
  for (const s of services) out.set(s.rid, { service: toService(s), locations: [] });
  for (const r of rows) out.get(r.rid)?.locations.push(r.loc);
  if (opts.extras) await addExtras(db, out);
  return out;
}

/**
 * Divisions (VV associations with the run as main, each with the portion's
 * locations) and the formations of the runs and their portions: three queries
 * for all the runs at once.
 */
async function addExtras(db: Db, runs: Map<string, DarwinRunData>) {
  const rids = [...runs.keys()];
  const { rows: assocs } = await sql<{ main_rid: string; assoc_rid: string; tiploc: string; main_times: AssociationTimes; cancelled: boolean }>`
    SELECT main_rid, assoc_rid, tiploc, main_times, cancelled FROM darwin_associations
    WHERE category = 'VV' AND main_rid = ANY(${rids}::text[])`.execute(db);
  const portionRids = [...new Set(assocs.map((a) => a.assoc_rid))];
  const [portionLocs, formations] = await Promise.all([
    portionRids.length
      ? sql<{ rid: string; loc: DarwinLocation }>`SELECT rid, loc FROM darwin_locations WHERE rid = ANY(${portionRids}::text[])`.execute(db)
      : { rows: [] },
    sql<{ fid: string; rid: string; coaches: FormationCoach[] }>`
      SELECT fid, rid, coaches FROM darwin_formations WHERE rid = ANY(${[...rids, ...portionRids]}::text[])`.execute(db),
  ]);
  const locsOf = new Map<string, DarwinLocation[]>();
  for (const r of portionLocs.rows) locsOf.set(r.rid, [...(locsOf.get(r.rid) ?? []), r.loc]);
  // The runs that each run's formations go with: itself, and those it divides from.
  const usersOf = new Map<string, Set<string>>(rids.map((rid) => [rid, new Set([rid])]));
  for (const a of assocs) usersOf.set(a.assoc_rid, (usersOf.get(a.assoc_rid) ?? new Set()).add(a.main_rid));
  for (const run of runs.values()) {
    run.associations = [];
    run.formations = {};
  }
  for (const a of assocs) {
    const association: DarwinAssociation = {
      tiploc: a.tiploc,
      mainTimes: a.main_times,
      assocRid: a.assoc_rid,
      cancelled: a.cancelled,
      assocLocations: locsOf.get(a.assoc_rid) ?? [],
    };
    runs.get(a.main_rid)!.associations!.push(association);
  }
  for (const f of formations.rows) for (const rid of usersOf.get(f.rid) ?? []) runs.get(rid)!.formations![f.fid] = f.coaches;
}

/** Darwin runs by rid. */
export async function loadByRid(db: Db, rids: string[], opts: LoadOptions = {}): Promise<Map<string, DarwinRunData>> {
  if (!rids.length) return new Map();
  const { rows } = await sql<ServiceRow>`SELECT * FROM darwin_services WHERE rid = ANY(${rids}::text[])`.execute(db);
  return withLocations(db, rows, opts);
}

/** Darwin runs by timetable identity, keyed `uid|ssd`. If Darwin has two runs for one (rare), the latest updated wins. */
export async function loadByTrain(db: Db, trains: { uid: string; ssd: string }[], opts: LoadOptions = {}): Promise<Map<string, DarwinRunData>> {
  const out = new Map<string, DarwinRunData>();
  if (!trains.length) return out;
  const { rows } = await sql<ServiceRow>`
    SELECT DISTINCT ON (d.uid, d.ssd) d.* FROM darwin_services d
    JOIN unnest(${trains.map((t) => t.uid)}::text[], ${trains.map((t) => t.ssd)}::date[]) AS t(uid, ssd) ON d.uid = t.uid AND d.ssd = t.ssd
    ORDER BY d.uid, d.ssd, d.updated_at DESC`.execute(db);
  for (const run of (await withLocations(db, rows, opts)).values()) out.set(`${run.service.uid}|${run.service.ssd}`, run);
  return out;
}
