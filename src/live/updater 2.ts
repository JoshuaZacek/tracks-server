import { sql } from 'kysely';
import type { z } from 'zod';
import type { Db } from '../db/client.ts';
import type { JourneyRow, JourneyState } from '../db/types.ts';
import type { LiveStatus } from '../modules/journeys/schemas.ts';
import type { CallingPoint } from '../modules/trains/schemas.ts';
import { computeJourneyStatus, type DarwinRunData } from './compute.ts';
import { loadByRid, loadByTrain } from './load.ts';
import type { Lookups } from './lookups.ts';

type LiveStatusOut = z.input<typeof LiveStatus>;

/** States after which nothing more can happen to a journey. */
export const FINAL_STATES: JourneyState[] = ['arrived', 'not_found'];

export interface UpdaterDeps {
  db: Db;
  lookups: Lookups;
  now: () => Date;
  darwinEnabled: boolean;
  feedHealthy: () => boolean;
}

export interface JourneyChange {
  journey: JourneyRow;
  previous: LiveStatusOut | null;
  status: LiveStatusOut;
}

/** JSON with object keys sorted: jsonb reorders keys, so plain JSON.stringify would see every stored status as changed. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
  );
}

/** What matters for "has it changed": everything except when it was computed and the read-time fields. */
const signature = (s: LiveStatusOut | null) => (s ? canonicalJson({ ...s, checkedAt: null, nextPollSeconds: null, stale: null }) : '');

/**
 * Recomputes the live status of `journeys` from the stored Darwin data and
 * writes the ones that changed. Returns the changes (Phase 5 turns them into
 * notifications).
 */
export async function updateJourneys(deps: UpdaterDeps, journeys: JourneyRow[]): Promise<JourneyChange[]> {
  if (!journeys.length) return [];
  const lookups = await deps.lookups.ready();
  const byRid = await loadByRid(deps.db, [...new Set(journeys.flatMap((j) => (j.rid ? [j.rid] : [])))]);
  const byTrain = await loadByTrain(
    deps.db,
    journeys.filter((j) => !j.rid).map((j) => ({ uid: j.train_uid, ssd: j.run_date })),
  );
  const now = deps.now();
  const ctx = { ...lookupsOf(lookups), now, darwinEnabled: deps.darwinEnabled, feedHealthy: deps.feedHealthy() };

  const changes: JourneyChange[] = [];
  for (const j of journeys) {
    const darwin: DarwinRunData | null = (j.rid ? byRid.get(j.rid) : byTrain.get(`${j.train_uid}|${j.run_date}`)) ?? null;
    const status = computeJourneyStatus(
      { runDate: j.run_date, callingPoints: j.calling_points as z.input<typeof CallingPoint>[], fromIndex: j.from_index, toIndex: j.to_index },
      darwin,
      ctx,
    );
    const previous = (j.status as LiveStatusOut | null) ?? null;
    const rid = darwin?.service.rid ?? j.rid;
    if (signature(status) === signature(previous) && rid === j.rid && status.state === j.state) continue;
    const updated = await deps.db
      .updateTable('journeys')
      .set({ state: status.state, status: JSON.stringify(status), status_updated_at: now, rid })
      .where('id', '=', j.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    changes.push({ journey: updated, previous, status });
  }
  return changes;
}

export const lookupsOf = (l: Lookups) => ({ crsOf: l.crsOf, nameOf: l.nameOf, station: l.station });

const trackable = (db: Db) =>
  db
    .selectFrom('journeys')
    .selectAll()
    .where('archived_at', 'is', null)
    .where('state', 'not in', FINAL_STATES);

/** Journeys on runs a Darwin batch touched: by rid, or by uid + start date while they have no rid yet. */
export async function journeysForRuns(db: Db, touched: { rids: string[]; trains: { uid: string; ssd: string }[] }) {
  if (!touched.rids.length && !touched.trains.length) return [];
  return trackable(db)
    .where((eb) =>
      eb.or([
        eb('rid', '=', eb.fn.any(eb.val(touched.rids))),
        eb.and([
          eb('rid', 'is', null),
          sql<boolean>`(train_uid, run_date) IN (SELECT * FROM unnest(${touched.trains.map((t) => t.uid)}::text[], ${touched.trains.map((t) => t.ssd)}::date[]))`,
        ]),
      ]),
    )
    .execute();
}

/**
 * Journeys whose status can change with time alone (entering the live window,
 * going not_found, arriving by deactivation): not finished, departing within
 * 3 hours and not more than a day ago.
 */
export async function journeysDueForTick(db: Db, now: Date) {
  return trackable(db)
    .where('scheduled_departure', '<', new Date(now.getTime() + 3 * 3600_000))
    .where('scheduled_arrival', '>', new Date(now.getTime() - 24 * 3600_000))
    .execute();
}
