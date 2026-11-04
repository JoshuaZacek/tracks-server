import { sql } from 'kysely';
import type { Db } from '../db/client.ts';
import { getMeta, setMeta } from '../db/meta.ts';
import type { DarwinLocation, ParsedMessage, ServiceUpdate } from './parse.ts';

export const DARWIN_FEED_META = 'darwin_feed';

/** What /v1/status and staleness checks read about the feed. */
export interface FeedState {
  /** When the worker last received anything from Darwin, heartbeats included (ISO). */
  lastMessageAt: string;
  /** Kafka timestamp of the last message vs when it was processed, in seconds. */
  lagSeconds: number;
  /** Set when messages were missed (sequence gap or retention overrun); cleared after a day. */
  gapAt: string | null;
}

export async function readFeedState(db: Db): Promise<FeedState | null> {
  const raw = await getMeta(db, DARWIN_FEED_META);
  return raw ? (JSON.parse(raw) as FeedState) : null;
}

/**
 * Messages accumulated between flushes. Several updates to the same run or
 * location within a batch collapse into one write.
 */
export class DarwinBatch {
  readonly services = new Map<string, { base: ServiceUpdate; schedule?: ServiceUpdate; ts?: ServiceUpdate }>();
  readonly locations = new Map<string, { rid: string; key: string; loc: DarwinLocation }>();
  readonly deactivated = new Set<string>();
  messages = 0;
  lastKafkaTimestamp = 0;
  lastSequence: number | null = null;
  sequenceGaps = 0;

  add(p: ParsedMessage, kafkaTimestamp: number) {
    this.messages++;
    this.lastKafkaTimestamp = Math.max(this.lastKafkaTimestamp, kafkaTimestamp);
    if (p.sequence !== null) {
      if (this.lastSequence !== null && p.sequence > this.lastSequence + 1) this.sequenceGaps++;
      this.lastSequence = p.sequence;
    }
    for (const s of p.services) {
      const entry = this.services.get(s.rid) ?? { base: s };
      entry.base = { rid: s.rid, uid: s.uid, ssd: s.ssd };
      if ('toc' in s) entry.schedule = s;
      if ('lateReason' in s) entry.ts = s;
      this.services.set(s.rid, entry);
    }
    for (const l of p.locations) {
      const id = `${l.rid}|${l.key}`;
      const prev = this.locations.get(id);
      this.locations.set(id, { rid: l.rid, key: l.key, loc: prev ? mergeLocation(prev.loc, l.loc) : l.loc });
    }
    for (const rid of p.deactivated) this.deactivated.add(rid);
  }

  get empty() {
    return this.services.size === 0 && this.locations.size === 0 && this.deactivated.size === 0;
  }

  /** Runs touched by this batch: by rid, and by timetable identity (uid + start date) for journeys without a rid yet. */
  touched() {
    const rids = new Set([...this.services.keys(), ...[...this.locations.values()].map((l) => l.rid), ...this.deactivated]);
    const trains = [...this.services.values()].map((s) => ({ uid: s.base.uid, ssd: s.base.ssd, rid: s.base.rid }));
    return { rids: [...rids], trains };
  }
}

/**
 * A newer update to a location merged over what is known. A TS states a location's forecasts in full, so it
 * replaces them, platform included; a schedule replaces planned fields and keeps forecasts. Once the train has
 * actually left or reached the location, though, its platform is what happened: Darwin's report of the departure
 * can leave the platform out, or restate it without `conf`, and that must not turn the platform the train used back
 * into the timetabled one or unconfirm it. A different platform number still replaces it.
 */
export function mergeLocation(prev: DarwinLocation, next: DarwinLocation): DarwinLocation {
  const merged = { ...prev, ...next };
  const used = prev.plat;
  if (used && (merged.dep?.at || merged.arr?.at)) {
    if (!merged.plat) merged.plat = used;
    else if (merged.plat.number === used.number && used.confirmed) merged.plat = { ...merged.plat, confirmed: true };
  }
  return merged;
}

/**
 * Writes a batch in one transaction with set-based upserts. Locations merge
 * into what is stored by mergeLocation (read, merged here, written back).
 */
export async function flushBatch(db: Db, batch: DarwinBatch, crsOf: (tiploc: string) => string | null) {
  if (batch.empty) return;
  const all = [...batch.services.values()];
  const schedules = all.flatMap((s) => (s.schedule ? [s.schedule] : []));
  const statuses = all.flatMap((s) => (s.ts ? [s.ts] : []));
  const locations = [...batch.locations.values()];

  await db.transaction().execute(async (trx) => {
    if (all.length) {
      await sql`
        INSERT INTO darwin_services (rid, uid, ssd)
        SELECT * FROM unnest(${all.map((s) => s.base.rid)}::text[], ${all.map((s) => s.base.uid)}::text[], ${all.map((s) => s.base.ssd)}::date[])
        ON CONFLICT (rid) DO UPDATE SET updated_at = now()`.execute(trx);
    }
    if (schedules.length) {
      await sql`
        UPDATE darwin_services d SET toc = u.toc, train_id = u.train_id, cancel_reason = u.cancel_reason, updated_at = now()
        FROM unnest(${schedules.map((s) => s.rid)}::text[], ${schedules.map((s) => s.toc ?? null)}::text[],
                    ${schedules.map((s) => s.trainId ?? null)}::text[], ${schedules.map((s) => s.cancelReason ?? null)}::text[])
          AS u(rid, toc, train_id, cancel_reason)
        WHERE d.rid = u.rid`.execute(trx);
    }
    if (statuses.length) {
      await sql`
        UPDATE darwin_services d SET late_reason = u.late_reason, updated_at = now()
        FROM unnest(${statuses.map((s) => s.rid)}::text[], ${statuses.map((s) => s.lateReason ?? null)}::text[]) AS u(rid, late_reason)
        WHERE d.rid = u.rid`.execute(trx);
    }
    if (locations.length) {
      const { rows: stored } = await sql<{ rid: string; key: string; loc: DarwinLocation }>`
        SELECT d.rid, d.key, d.loc FROM darwin_locations d
        JOIN unnest(${locations.map((l) => l.rid)}::text[], ${locations.map((l) => l.key)}::text[]) AS u(rid, key) USING (rid, key)
        FOR UPDATE OF d`.execute(trx);
      const prev = new Map(stored.map((r) => [`${r.rid}|${r.key}`, r.loc]));
      const merged = locations.map((l) => {
        const before = prev.get(`${l.rid}|${l.key}`);
        return before ? mergeLocation(before, l.loc) : l.loc;
      });
      await sql`
        INSERT INTO darwin_locations (rid, key, tpl, crs, loc)
        SELECT * FROM unnest(${locations.map((l) => l.rid)}::text[], ${locations.map((l) => l.key)}::text[],
                             ${locations.map((l) => l.loc.tpl)}::text[], ${locations.map((l) => crsOf(l.loc.tpl))}::text[],
                             ${merged.map((loc) => JSON.stringify(loc))}::jsonb[])
        ON CONFLICT (rid, key) DO UPDATE SET loc = excluded.loc, crs = excluded.crs, updated_at = now()`.execute(trx);
    }
    if (batch.deactivated.size) {
      await sql`UPDATE darwin_services SET deactivated = true, updated_at = now() WHERE rid = ANY(${[...batch.deactivated]}::text[])`.execute(trx);
    }
  });
}

/** Records feed liveness and lag for /v1/status and staleness. */
export async function recordFeed(db: Db, state: FeedState) {
  await setMeta(db, DARWIN_FEED_META, JSON.stringify(state));
}

/** Drops runs that started more than `days` ago (RIDs begin with the run's date). */
export async function pruneDarwin(db: Db, today: string, days = 2) {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  const cutoff = d.toISOString().slice(0, 10).replace(/-/g, '');
  await sql`DELETE FROM darwin_locations WHERE left(rid, 8) < ${cutoff}`.execute(db);
  await sql`DELETE FROM darwin_services WHERE left(rid, 8) < ${cutoff}`.execute(db);
}
