import { sql } from 'kysely';
import type { z } from 'zod';
import { darwinEnabled, type AppDeps } from '../../app.ts';
import type { FeedState } from '../../darwin/store.ts';
import { pollSeconds } from '../../live/compute.ts';
import { feedHealthy, feedState } from '../../live/feed.ts';
import { updateJourneys } from '../../live/updater.ts';
import { baselineOf } from '../../push/alerts.ts';
import type { DeviceRow, JourneyRow } from '../../db/types.ts';
import { operatorName } from '../../domain/operators.ts';
import { ApiError } from '../../http/errors.ts';
import { toUkIso } from '../../time.ts';
import type { CallingPoint, RoutePoint } from '../trains/schemas.ts';
import { getTrain } from '../trains/service.ts';
import type { CreateJourneyRequest, Journey, JourneyList, JourneyListItem, JourneyPrefsUpdate, LiveStatus, LiveSummary } from './schemas.ts';

type CallingPointOut = z.input<typeof CallingPoint>;
type LiveStatusOut = z.input<typeof LiveStatus>;

/** States in which the train is under way (or about to be): never "past", even when running late. */
const RUNNING = ['live', 'departed'] as const;
/** Bounds for nextPollSeconds. */
const MIN_POLL_S = 15;
const MAX_POLL_S = 3600;

const clampPoll = (seconds: number) => Math.min(MAX_POLL_S, Math.max(MIN_POLL_S, Math.ceil(seconds)));

/** What reading a status needs besides the row: the time, and whether live data is flowing. */
export interface ReadContext {
  now: Date;
  darwinEnabled: boolean;
  feed: FeedState | null;
}

async function readContext(deps: AppDeps): Promise<ReadContext> {
  const enabled = darwinEnabled(deps);
  return { now: deps.now(), darwinEnabled: enabled, feed: enabled ? await feedState(deps.db) : null };
}

/**
 * The journey's live status: the one live tracking stored (Phase 4), else the
 * timetable view. `nextPollSeconds` and `stale` depend on when it is read, so
 * they are worked out here rather than stored.
 */
export function liveStatusOf(row: JourneyRow, rc: ReadContext): LiveStatusOut {
  const stored = row.status as LiveStatusOut | null;
  const base: LiveStatusOut = stored ?? {
    state: row.state,
    checkedAt: toUkIso(row.status_updated_at ?? rc.now),
    nextPollSeconds: null,
    stale: false,
    message: null,
    service: null,
    progress: null,
    position: null,
  };
  const stale = rc.darwinEnabled && !feedHealthy(rc.feed, rc.now.getTime()) && ['scheduled', 'live', 'departed'].includes(base.state);
  return {
    ...base,
    nextPollSeconds: pollSeconds(base.state, row.scheduled_departure, row.scheduled_arrival, rc.now),
    stale,
    message: stale && !base.message ? 'Live updates are paused; showing the last information received' : base.message,
  };
}

function liveSummaryOf(row: JourneyRow, rc: ReadContext): z.input<typeof LiveSummary> {
  const status = liveStatusOf(row, rc);
  const destination = status.progress?.stops.at(-1);
  return {
    state: status.state,
    expectedDeparture: status.service?.expectedDeparture ?? null,
    actualDeparture: status.service?.actualDeparture ?? null,
    expectedArrival: destination?.expected ?? null,
    actualArrival: destination?.actual ?? null,
    delayMinutes: status.service?.delayMinutes ?? null,
    platform: status.service?.platform ?? null,
    isCancelled: status.service?.isCancelled ?? status.state === 'cancelled',
    stale: status.stale,
    checkedAt: row.status ? status.checkedAt : null,
  };
}

function baseOf(row: JourneyRow) {
  const calls = row.calling_points as CallingPointOut[];
  const station = (c: CallingPointOut) => ({ crs: c.crs, name: c.name, lat: c.lat, lon: c.lon });
  return {
    id: row.id,
    trainUid: row.train_uid,
    runDate: row.run_date,
    date: row.date,
    headcode: row.headcode,
    operator: { code: row.toc, name: operatorName(row.toc || null) },
    from: station(calls[row.from_index]!),
    to: station(calls[row.to_index]!),
    scheduledDeparture: toUkIso(row.scheduled_departure),
    scheduledArrival: toUkIso(row.scheduled_arrival),
    bookedPlatform: row.booked_platform,
    prefs: row.prefs,
    createdAt: toUkIso(row.created_at),
    archivedAt: row.archived_at ? toUkIso(row.archived_at) : null,
  };
}

export function toJourney(row: JourneyRow, rc: ReadContext): z.input<typeof Journey> {
  return {
    ...baseOf(row),
    callingPoints: row.calling_points as CallingPointOut[],
    fromIndex: row.from_index,
    toIndex: row.to_index,
    route: row.route as z.input<typeof RoutePoint>[],
    live: liveStatusOf(row, rc),
  };
}

const toListItem = (row: JourneyRow, rc: ReadContext): z.input<typeof JourneyListItem> => ({ ...baseOf(row), live: liveSummaryOf(row, rc) });

/**
 * A journey is past once it has arrived, or once its scheduled arrival has gone
 * by while the train isn't running (a late train stays upcoming until it
 * arrives), or when the user archived it.
 */
const isPast = (now: Date) => sql<boolean>`(
  archived_at IS NOT NULL OR state = 'arrived'
  OR (scheduled_arrival < ${now} AND state NOT IN (${sql.join(RUNNING.map((s) => sql.lit(s)))}))
)`;

export async function listJourneys(deps: AppDeps, device: DeviceRow, scope: 'upcoming' | 'past', limit: number): Promise<z.input<typeof JourneyList>> {
  const rc = await readContext(deps);
  const now = rc.now;
  let query = deps.db.selectFrom('journeys').selectAll().where('device_id', '=', device.id);
  query =
    scope === 'past'
      ? query.where(isPast(now)).orderBy('scheduled_departure', 'desc')
      : query.where(sql<boolean>`NOT ${isPast(now)}`).orderBy('scheduled_departure', 'asc');
  const rows = await query.orderBy('id').limit(limit).execute();

  // The list changes on its own when an upcoming journey's live status is due to
  // update, or when one becomes past at its scheduled arrival.
  let soonest: number | null = null;
  if (scope === 'upcoming') {
    for (const row of rows) {
      const status = liveStatusOf(row, rc);
      const candidates = [status.nextPollSeconds];
      if (!(RUNNING as readonly string[]).includes(row.state)) candidates.push((row.scheduled_arrival.getTime() - now.getTime()) / 1000);
      for (const c of candidates) if (c !== null && c > 0) soonest = soonest === null ? c : Math.min(soonest, c);
    }
  }
  return { journeys: rows.map((r) => toListItem(r, rc)), nextPollSeconds: soonest === null ? null : clampPoll(soonest) };
}

async function findOwned(deps: AppDeps, device: DeviceRow, id: string): Promise<JourneyRow> {
  const row = await deps.db.selectFrom('journeys').selectAll().where('id', '=', id).where('device_id', '=', device.id).executeTakeFirst();
  // Someone else's journey looks exactly like a missing one.
  if (!row) throw ApiError.notFound('journey_not_found', 'No such journey');
  return row;
}

export async function getJourney(deps: AppDeps, device: DeviceRow, id: string) {
  const row = await findOwned(deps, device, id);
  return toJourney(row, await readContext(deps));
}

export async function getJourneyLive(deps: AppDeps, device: DeviceRow, id: string) {
  const row = await findOwned(deps, device, id);
  return liveStatusOf(row, await readContext(deps));
}

const notOnRoute = (message: string) => new ApiError(422, 'station_not_on_route', message);

/**
 * Saves a journey on a timetabled train. Works for any run date the current
 * timetable covers, past ones included (they land straight in `past`); runs it
 * doesn't cover are 404 `train_not_running`. Saving the same trip again returns
 * the existing journey (un-archiving it) instead of a duplicate.
 */
export async function createJourney(deps: AppDeps, device: DeviceRow, body: z.output<typeof CreateJourneyRequest>) {
  if (body.toCrs && body.toCrs === body.fromCrs) {
    throw ApiError.validation([{ in: 'body', path: 'toCrs', message: 'Must differ from fromCrs' }]);
  }
  const train = await getTrain(deps.db, body.trainUid, body.runDate);
  const calls = train.callingPoints;
  const fromIndex = calls.findIndex((c) => c.crs === body.fromCrs && c.scheduledDeparture !== null);
  if (fromIndex < 0) throw notOnRoute(`${train.headcode} does not pick up passengers at ${body.fromCrs}`);
  const toIndex = body.toCrs
    ? calls.findIndex((c, i) => i > fromIndex && c.crs === body.toCrs && c.scheduledArrival !== null)
    : calls.length - 1;
  if (toIndex <= fromIndex) throw notOnRoute(`${train.headcode} does not call at ${body.toCrs} after ${body.fromCrs}`);

  const from = calls[fromIndex]!;
  const to = calls[toIndex]!;
  const row = await deps.db
    .insertInto('journeys')
    .values({
      device_id: device.id,
      train_uid: train.trainUid,
      run_date: train.runDate,
      date: from.scheduledDeparture!.slice(0, 10), // UK local date of the ISO time
      from_crs: from.crs,
      to_crs: to.crs,
      from_index: fromIndex,
      to_index: toIndex,
      headcode: train.headcode,
      toc: train.operator.code,
      scheduled_departure: new Date(from.scheduledDeparture!),
      scheduled_arrival: new Date(to.scheduledArrival!),
      booked_platform: from.bookedPlatform,
      calling_points: JSON.stringify(calls),
      route: JSON.stringify(train.route),
      alert_state: JSON.stringify(baselineOf(null)),
    })
    .onConflict((oc) => oc.constraint('journeys_device_trip_key').doUpdateSet({ archived_at: null }))
    .returningAll()
    // xmax is 0 for a freshly inserted row and set when ON CONFLICT updated an existing one.
    .returning(sql<boolean>`(xmax = 0)`.as('inserted'))
    .executeTakeFirstOrThrow();
  const { inserted, ...saved } = row;
  const rc = await readContext(deps);
  let journey = saved;
  // With live data, a new journey shows its live status straight away rather than at the next update.
  if (inserted && rc.darwinEnabled) {
    const [change] = await updateJourneys(
      { db: deps.db, lookups: deps.lookups, now: deps.now, darwinEnabled: true, feedHealthy: () => feedHealthy(rc.feed, rc.now.getTime()) },
      [saved],
    );
    if (change) {
      // Alerts are for what changes after saving, not for what the user can already see.
      journey = await deps.db
        .updateTable('journeys')
        .set({ alert_state: JSON.stringify(baselineOf(change.status)) })
        .where('id', '=', saved.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    }
  }
  return { journey: toJourney(journey, rc), created: inserted };
}

export async function updateJourney(
  deps: AppDeps,
  device: DeviceRow,
  id: string,
  body: { prefs?: z.output<typeof JourneyPrefsUpdate>; archived?: boolean },
) {
  const row = await findOwned(deps, device, id);
  const changes: { prefs?: string; archived_at?: Date | null } = {};
  if (body.prefs) {
    const prefs: Record<string, boolean | number> = { ...row.prefs };
    for (const [key, value] of Object.entries(body.prefs)) {
      if (value === null) delete prefs[key];
      else if (value !== undefined) prefs[key] = value;
    }
    changes.prefs = JSON.stringify(prefs);
  }
  if (body.archived !== undefined) changes.archived_at = body.archived ? (row.archived_at ?? deps.now()) : null;
  const rc = await readContext(deps);
  if (!Object.keys(changes).length) return toJourney(row, rc);
  const updated = await deps.db.updateTable('journeys').set(changes).where('id', '=', row.id).returningAll().executeTakeFirstOrThrow();
  return toJourney(updated, rc);
}

export async function deleteJourney(deps: AppDeps, device: DeviceRow, id: string) {
  const result = await deps.db.deleteFrom('journeys').where('id', '=', id).where('device_id', '=', device.id).executeTakeFirst();
  if (!result.numDeletedRows) throw ApiError.notFound('journey_not_found', 'No such journey');
}

/** The app started a Live Activity for this journey (or iOS rotated its token): push updates to it. */
export async function registerLiveActivity(deps: AppDeps, device: DeviceRow, id: string, pushToken: string) {
  const row = await findOwned(deps, device, id);
  const token = pushToken.toLowerCase();
  await deps.db
    .insertInto('live_activities')
    .values({ journey_id: row.id, push_token: token })
    .onConflict((oc) =>
      oc.column('journey_id').doUpdateSet({
        push_token: token,
        updated_at: deps.now(),
        ended_at: null,
        // A new activity: send it the current content at the next chance. The same one with a new token keeps its state.
        sent_content: sql`CASE WHEN live_activities.ended_at IS NULL THEN live_activities.sent_content END`,
        last_pushed_at: sql`CASE WHEN live_activities.ended_at IS NULL THEN live_activities.last_pushed_at END`,
      }),
    )
    .execute();
}

/** The user ended the activity: stop pushing to it (and don't start it again). */
export async function endLiveActivity(deps: AppDeps, device: DeviceRow, id: string) {
  const row = await findOwned(deps, device, id);
  await deps.db.updateTable('live_activities').set({ ended_at: deps.now() }).where('journey_id', '=', row.id).where('ended_at', 'is', null).execute();
}
