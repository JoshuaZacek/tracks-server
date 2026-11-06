import { sql } from 'kysely';
import type { z } from 'zod';
import type { Db } from '../db/client.ts';
import type { ApnsEnvironment, JourneyRow, LiveActivityRow, NotificationPrefs, PushOutcome } from '../db/types.ts';
import { operatorName } from '../domain/operators.ts';
import { feedHealthy, feedState } from '../live/feed.ts';
import { canonicalJson } from '../live/updater.ts';
import type { Logger } from '../logger.ts';
import { DEFAULT_PREFS } from '../modules/devices/schemas.ts';
import type { LiveStatus } from '../modules/journeys/schemas.ts';
import type { CallingPoint } from '../modules/trains/schemas.ts';
import {
  baselineOf,
  planAlerts,
  planLeaveNow,
  planMorningSummary,
  planStopAlarm,
  type Alert,
  type AlertState,
  type JourneyFacts,
  type StopAlarmPush,
} from './alerts.ts';
import type { PushRequest, PushResult, PushSender } from './apns.ts';
import {
  ENDING_STATES,
  isMaterialChange,
  liveActivityContent,
  sameContent,
  startPayload,
  updatePayload,
  type LiveActivityAttributes,
  type LiveActivityContent,
} from './liveActivity.ts';

/**
 * Turns journey status changes into APNs alerts, Live Activity updates and
 * background pushes for the app's stop alarm.
 *
 * It runs in the worker beside the Darwin consumer, but never holds it up:
 * changed journey ids go into a set, and one loop works through them (re-reading
 * each journey, so a burst of updates to the same train becomes one push).
 * Without APNs credentials (`sender` null) it does everything except the
 * sending, and records each push in push_log as "disabled": a dry run.
 */

type LiveStatusOut = z.input<typeof LiveStatus>;
type CallingPointOut = z.input<typeof CallingPoint>;

export interface NotifierOptions {
  db: Db;
  log: Logger;
  sender: PushSender | null;
  bundleId: string;
  /** Darwin is configured: alerts then wait for a healthy feed. */
  darwinEnabled: boolean;
  now?: () => Date;
}

/** Apple budgets Live Activity updates; at most one per journey this often (the tick sends what was held back). */
export const LIVE_ACTIVITY_MIN_INTERVAL_MS = 15_000;
/** Push-to-start this long before scheduled departure. */
export const AUTO_START_BEFORE_MIN = 30;
/** "Approaching" is a time rule on an estimate: only trust it if Darwin said something about the train this recently. */
export const FRESH_RUN_MS = 15 * 60_000;
/** The consumer counts as caught up (not replaying the past) within this many seconds of real time. */
export const CAUGHT_UP_LAG_S = 60;
/** A template_unmatched alert not sent within this long (the worker was down) is dropped. */
const TEMPLATE_ALERT_MAX_AGE_MS = 12 * 3600_000;
const CONCURRENCY = 16;
const PUSH_LOG_DAYS = 7;

type JourneyForPush = JourneyRow & {
  apns_token: string | null;
  apns_env: ApnsEnvironment;
  push_to_start_token: string | null;
  device_prefs: NotificationPrefs;
  /** The template's morning summary time (null without a template or a summary). */
  summary_time: string | null;
};

/** Runs `fn` over `items`, at most `limit` at a time. */
async function eachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]!);
  }));
}

const effectivePrefs = (j: JourneyForPush): NotificationPrefs => ({ ...DEFAULT_PREFS, ...j.device_prefs, ...(j.prefs as Partial<NotificationPrefs>) });
/** The stop alarm is set per journey only (no device default): off unless turned on. */
const stopAlarmOn = (j: JourneyRow) => j.prefs.stopAlarm === true;

function factsOf(j: JourneyRow): JourneyFacts {
  const calls = j.calling_points as CallingPointOut[];
  return {
    id: j.id,
    fromName: calls[j.from_index]!.name,
    toName: calls[j.to_index]!.name,
    scheduledDeparture: calls[j.from_index]!.scheduledDeparture!,
    scheduledArrival: calls[j.to_index]!.scheduledArrival!,
  };
}

export function contentOf(j: JourneyRow): LiveActivityContent {
  const calls = j.calling_points as CallingPointOut[];
  const f = factsOf(j);
  return liveActivityContent(
    {
      scheduledDeparture: f.scheduledDeparture,
      scheduledArrival: f.scheduledArrival,
      bookedPlatform: j.booked_platform,
      bookedArrivalPlatform: calls[j.to_index]!.bookedPlatform,
    },
    j.status as LiveStatusOut | null,
  );
}

export function attributesOf(j: JourneyRow): LiveActivityAttributes {
  const calls = j.calling_points as CallingPointOut[];
  const from = calls[j.from_index]!;
  const to = calls[j.to_index]!;
  return {
    journeyId: j.id,
    headcode: j.headcode,
    operatorName: operatorName(j.toc || null),
    fromCrs: from.crs,
    fromName: from.name,
    toCrs: to.crs,
    toName: to.name,
  };
}

export function alertPayload(journeyId: string, alert: Alert) {
  return {
    aps: {
      alert: { title: alert.title, body: alert.body },
      sound: 'default',
      'thread-id': journeyId,
      'interruption-level': alert.timeSensitive ? 'time-sensitive' : 'active',
    },
    journeyId,
    kind: alert.kind,
  };
}

/**
 * "No train matched your regular journey on <date>". About a template, not a journey: it
 * opens Regular journeys in the app. The materialiser records it (pending) in push_log,
 * and the notifier's tick sends it, so the API can raise one too.
 */
export function templateAlertPayload(templateId: string, date: string, body: string) {
  return {
    aps: {
      alert: { title: 'Regular journey', body },
      sound: 'default',
      'thread-id': templateId,
      'interruption-level': 'active',
    },
    kind: 'template_unmatched',
    templateId,
    date,
  };
}

/** Wakes the app in the background (no alert or sound) to move or cancel its stop alarm. */
export function stopAlarmPayload(journeyId: string, push: StopAlarmPush) {
  return {
    aps: { 'content-available': 1 },
    journeyId,
    kind: 'stop_alarm',
    expectedArrival: push.expectedArrival,
    cancelled: push.cancelled,
  };
}

export function createNotifier(opts: NotifierOptions) {
  const { db, log, sender, bundleId } = opts;
  const now = opts.now ?? (() => new Date());
  const activityTopic = `${bundleId}.push-type.liveactivity`;

  /**
   * Live data is flowing and current (or there is none to wait for). While the
   * Darwin feed is down, statuses are frozen at the last update; while the
   * consumer is catching up after a restart, they replay the past minute by
   * minute. Either way alerts would be wrong or stale, so alerts and
   * push-to-start wait. The journeys skipped meanwhile are kept in `held` and
   * looked at again once live data is current, so alerts are worked out from
   * the latest status (and the age limits drop ones that are no longer news).
   */
  async function liveDataHealthy() {
    if (!opts.darwinEnabled) return true;
    const feed = await feedState(db);
    return feedHealthy(feed, now().getTime()) && feed!.lagSeconds <= CAUGHT_UP_LAG_S;
  }

  const pending = new Set<string>();
  const held = new Set<string>();
  let tickDue = false;
  let running: Promise<void> | null = null;

  /** Sends (or, in a dry run, doesn't) and records the result in push_log. */
  async function deliver(logId: string, request: Omit<PushRequest, 'token' | 'env'>, token: string | null, env: ApnsEnvironment) {
    let outcome: PushOutcome;
    let result: PushResult | null = null;
    if (!token) outcome = 'no_token';
    else if (!sender) outcome = 'disabled';
    else {
      result = await sender.send({ ...request, token, env });
      outcome = result.ok ? 'sent' : result.unregistered ? 'unregistered' : 'failed';
      if (!result.ok) log.warn({ status: result.status, reason: result.reason, kind: request.pushType }, 'APNs push not accepted');
    }
    await db
      .updateTable('push_log')
      .set({ outcome, http_status: result?.status || null, reason: result?.reason ?? null, apns_id: result?.apnsId ?? null })
      .where('id', '=', logId)
      .execute();
    return { outcome, result };
  }

  async function logPush(journeyId: string, channel: 'alert' | 'live_activity' | 'background', kind: string, dedupeKey: string | null, payload: object) {
    const row = await db
      .insertInto('push_log')
      .values({ journey_id: journeyId, channel, kind, dedupe_key: dedupeKey, payload: JSON.stringify(payload) })
      .onConflict((oc) => oc.columns(['journey_id', 'dedupe_key']).where('dedupe_key', 'is not', null).doNothing())
      .returning('id')
      .executeTakeFirst();
    return row?.id ?? null;
  }

  async function processAlerts(j: JourneyForPush, runFresh: boolean) {
    const status = j.status as LiveStatusOut | null;
    const told = j.alert_state as AlertState | null;
    if (!status && !told) return;
    const facts = factsOf(j);
    const prefs = effectivePrefs(j);
    const at = now();
    const alerts: Alert[] = [];
    let alarm: StopAlarmPush | null = null;
    let next = told ?? baselineOf(null);
    if (status) {
      const planned = planAlerts(told, status, facts, prefs, at, { estimatesFresh: runFresh || !opts.darwinEnabled });
      alerts.push(...planned.alerts);
      ({ push: alarm, next } = planStopAlarm(planned.next, status, facts, stopAlarmOn(j), at));
    }
    if (!j.archived_at) {
      // Time rules for regular journeys and travel times (the tick brings these journeys round when due).
      const summary = planMorningSummary(next, status, facts, j.summary_time, prefs.morningSummary, at);
      const leave = planLeaveNow(summary.next, status, facts, j.travel_minutes, prefs.leaveNow, at);
      next = leave.next;
      for (const alert of [summary.alert, leave.alert]) if (alert) alerts.push(alert);
    }
    if (canonicalJson(next) !== canonicalJson(told)) {
      await db.updateTable('journeys').set({ alert_state: JSON.stringify(next) }).where('id', '=', j.id).execute();
    }
    if (j.archived_at) return;
    for (const alert of alerts) {
      const payload = alertPayload(j.id, alert);
      const logId = await logPush(j.id, 'alert', alert.kind, alert.dedupeKey, payload);
      if (!logId) continue; // already sent
      const expiration = Math.floor(now().getTime() / 1000) + 3600;
      const { outcome } = await deliver(
        logId,
        { pushType: 'alert', topic: bundleId, priority: 10, payload, expiration, ...(alert.collapseId ? { collapseId: alert.collapseId } : {}) },
        j.apns_token,
        j.apns_env,
      );
      await forgetDeadToken(j, outcome);
      log.info({ journey: j.id, kind: alert.kind, outcome }, 'Alert');
    }
    if (alarm) {
      const payload = stopAlarmPayload(j.id, alarm);
      const logId = await logPush(j.id, 'background', 'stop_alarm', alarm.dedupeKey, payload);
      if (!logId) return; // already sent
      // Apple requires priority 5 for background pushes, and iOS may hold or drop
      // them; the app then keeps the alarm it already has (and "approaching" still fires).
      const expiration = Math.floor(now().getTime() / 1000) + 3600;
      const { outcome } = await deliver(logId, { pushType: 'background', topic: bundleId, priority: 5, payload, expiration }, j.apns_token, j.apns_env);
      await forgetDeadToken(j, outcome);
      log.info({ journey: j.id, expectedArrival: alarm.expectedArrival, outcome }, 'Stop alarm push');
    }
  }

  async function forgetDeadToken(j: JourneyForPush, outcome: PushOutcome) {
    if (outcome !== 'unregistered') return;
    await db.updateTable('devices').set({ apns_token: null }).where('id', '=', j.device_id).where('apns_token', '=', j.apns_token).execute();
    j.apns_token = null;
  }

  async function processLiveActivity(j: JourneyForPush, la: LiveActivityRow | undefined) {
    if (!la || la.ended_at) return;
    const content = contentOf(j);
    const sent = la.sent_content as LiveActivityContent | null;
    const ending = ENDING_STATES.includes(content.state);
    if (!ending && sameContent(sent, content)) return;
    const at = now();
    if (la.last_pushed_at && at.getTime() - la.last_pushed_at.getTime() < LIVE_ACTIVITY_MIN_INTERVAL_MS) return;

    const payload = updatePayload(content, at);
    const logId = (await logPush(j.id, 'live_activity', ending ? 'end' : 'update', null, payload))!;
    const { outcome, result } = await deliver(
      logId,
      { pushType: 'liveactivity', topic: activityTopic, priority: ending || isMaterialChange(sent, content) ? 10 : 5, payload },
      la.push_token,
      j.apns_env,
    );
    const retry = result?.retryable ?? false;
    await db
      .updateTable('live_activities')
      .set({
        last_pushed_at: at,
        // Held back for a retry: keep the old content so the tick tries again.
        ...(retry ? {} : { sent_content: JSON.stringify(content) }),
        ...((ending && !retry) || outcome === 'unregistered' ? { ended_at: at } : {}),
      })
      .where('journey_id', '=', j.id)
      .where('push_token', '=', la.push_token)
      .execute();
    log.info({ journey: j.id, state: content.state, outcome }, ending ? 'Live Activity end' : 'Live Activity update');
  }

  async function loadJourneys(ids: string[]): Promise<JourneyForPush[]> {
    if (!ids.length) return [];
    return (await db
      .selectFrom('journeys')
      .innerJoin('devices', 'devices.id', 'journeys.device_id')
      .selectAll('journeys')
      .leftJoin('journey_templates', 'journey_templates.id', 'journeys.template_id')
      .select(['devices.apns_token', 'devices.apns_env', 'devices.push_to_start_token', 'devices.prefs as device_prefs', 'journey_templates.summary_time'])
      .where('journeys.id', 'in', ids)
      .execute()) as JourneyForPush[];
  }

  /** Darwin runs that had a message within FRESH_RUN_MS. */
  async function freshRuns(rids: string[]) {
    if (!rids.length) return new Set<string>();
    const rows = await db
      .selectFrom('darwin_services')
      .select('rid')
      .where('rid', 'in', rids)
      .where('updated_at', '>', new Date(now().getTime() - FRESH_RUN_MS))
      .execute();
    return new Set(rows.map((r) => r.rid));
  }

  async function processJourneys(requested: string[]) {
    const alertsOn = await liveDataHealthy();
    let ids = requested;
    if (alertsOn && held.size) {
      ids = [...new Set([...requested, ...held])];
      held.clear();
    } else if (!alertsOn) {
      for (const id of requested) held.add(id);
    }
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const [journeys, activities] = await Promise.all([
        loadJourneys(chunk),
        db.selectFrom('live_activities').selectAll().where('journey_id', 'in', chunk).execute(),
      ]);
      const byJourney = new Map(activities.map((a) => [a.journey_id, a]));
      const fresh = alertsOn ? await freshRuns(journeys.flatMap((j) => (j.rid ? [j.rid] : []))) : new Set<string>();
      await eachLimit(journeys, CONCURRENCY, async (j) => {
        try {
          if (alertsOn) await processAlerts(j, j.rid !== null && fresh.has(j.rid));
          await processLiveActivity(j, byJourney.get(j.id));
        } catch (err) {
          log.error({ err, journey: j.id }, 'Push failed');
        }
      });
    }
  }

  /** Push-to-start: a Live Activity appears by itself shortly before departure. */
  async function autoStart() {
    const at = now();
    const candidates = (await db
      .selectFrom('journeys')
      .innerJoin('devices', 'devices.id', 'journeys.device_id')
      .leftJoin('live_activities', 'live_activities.journey_id', 'journeys.id')
      .selectAll('journeys')
      .select(['devices.apns_token', 'devices.apns_env', 'devices.push_to_start_token', 'devices.prefs as device_prefs'])
      .select(sql<string | null>`NULL`.as('summary_time'))
      .where('devices.push_to_start_token', 'is not', null)
      .where('journeys.archived_at', 'is', null)
      .where('journeys.state', 'in', ['scheduled', 'live'])
      .where('journeys.scheduled_departure', '<=', new Date(at.getTime() + AUTO_START_BEFORE_MIN * 60_000))
      .where('journeys.scheduled_departure', '>', new Date(at.getTime() - 10 * 60_000))
      .where('live_activities.journey_id', 'is', null)
      .where(({ not, exists, selectFrom }) =>
        not(exists(selectFrom('push_log').select('id').whereRef('push_log.journey_id', '=', 'journeys.id').where('push_log.dedupe_key', '=', 'la_start'))),
      )
      .execute()) as JourneyForPush[];

    await eachLimit(candidates, CONCURRENCY, async (j) => {
      if (!effectivePrefs(j).liveActivity) return;
      const content = contentOf(j);
      const f = factsOf(j);
      const leaves = (content.expectedDeparture ?? content.scheduledDeparture).slice(11, 16);
      const platform = content.platform ? `, platform ${content.platform.number}` : '';
      const alert = { title: `${f.scheduledDeparture.slice(11, 16)} ${f.fromName} to ${f.toName}`, body: `Leaves at ${leaves}${platform}.` };
      const payload = startPayload(attributesOf(j), content, alert, at);
      const logId = await logPush(j.id, 'live_activity', 'start', 'la_start', payload);
      if (!logId) return;
      const { outcome, result } = await deliver(
        logId,
        { pushType: 'liveactivity', topic: activityTopic, priority: 10, payload },
        j.push_to_start_token,
        j.apns_env,
      );
      if (outcome === 'unregistered') {
        await db.updateTable('devices').set({ push_to_start_token: null }).where('id', '=', j.device_id).execute();
      } else if (result?.retryable) {
        await db.deleteFrom('push_log').where('id', '=', logId).execute(); // try again next tick
      }
      log.info({ journey: j.id, outcome }, 'Live Activity push-to-start');
    });
  }

  /** Sends the template_unmatched alerts the materialiser recorded (pending) in push_log. */
  async function sendTemplateAlerts() {
    const rows = await db
      .selectFrom('push_log')
      .innerJoin('journey_templates', 'journey_templates.id', 'push_log.template_id')
      .innerJoin('devices', 'devices.id', 'journey_templates.device_id')
      .select(['push_log.id', 'push_log.payload', 'push_log.template_id', 'devices.id as device_id', 'devices.apns_token', 'devices.apns_env'])
      .where('push_log.journey_id', 'is', null)
      .where('push_log.channel', '=', 'alert')
      .where('push_log.outcome', '=', 'pending')
      .where('push_log.created_at', '>', new Date(now().getTime() - TEMPLATE_ALERT_MAX_AGE_MS))
      .orderBy('push_log.id')
      .execute();
    for (const r of rows) {
      const expiration = Math.floor(now().getTime() / 1000) + 3600;
      const payload = r.payload as object;
      const { outcome } = await deliver(r.id, { pushType: 'alert', topic: bundleId, priority: 10, payload, expiration }, r.apns_token, r.apns_env);
      if (outcome === 'unregistered') {
        await db.updateTable('devices').set({ apns_token: null }).where('id', '=', r.device_id).where('apns_token', '=', r.apns_token).execute();
      }
      log.info({ template: r.template_id, outcome }, 'Regular journey alert');
    }
  }

  /**
   * Time-driven work: the "approaching" alert, the morning summary and leave-now
   * alerts once due, Live Activity updates held back by the rate limit or a
   * failed push, push-to-start, and regular-journey alerts. The stop alarm needs
   * nothing here: its pushes follow changes in the arrival estimate, which come
   * through journeysChanged (or `held`, picked up once live data is healthy).
   */
  async function runTick() {
    const at = now();
    // Leave-now candidates by the scheduled time, with a margin for an expected departure earlier than that.
    const { rows } = await sql<{ id: string }>`
      SELECT id FROM journeys
      WHERE archived_at IS NULL AND state = 'departed' AND coalesce((alert_state->>'approaching')::boolean, false) = false
      UNION
      SELECT journey_id FROM live_activities WHERE ended_at IS NULL
      UNION
      SELECT j.id FROM journeys j LEFT JOIN journey_templates t ON t.id = j.template_id
      WHERE j.archived_at IS NULL AND j.state IN ('scheduled', 'live', 'cancelled')
        AND j.scheduled_departure > ${new Date(at.getTime() - 6 * 3600_000)} AND j.scheduled_departure < ${new Date(at.getTime() + 24 * 3600_000)}
        AND (
          (t.summary_time IS NOT NULL AND coalesce((j.alert_state->>'morningSummary')::boolean, false) = false
            AND ((j.date::text || ' ' || t.summary_time)::timestamp AT TIME ZONE 'Europe/London') <= ${at})
          OR (j.travel_minutes IS NOT NULL AND coalesce((j.alert_state->>'leaveNow')::boolean, false) = false
            AND j.scheduled_departure - make_interval(mins => j.travel_minutes + 12) <= ${at})
        )`.execute(db);
    await processJourneys(rows.map((r) => r.id));
    if (await liveDataHealthy()) await autoStart();
    await sendTemplateAlerts();
  }

  async function drain() {
    while (pending.size || tickDue) {
      const ids = [...pending];
      pending.clear();
      try {
        await processJourneys(ids);
      } catch (err) {
        log.error({ err }, 'Push processing failed');
      }
      if (tickDue) {
        tickDue = false;
        try {
          await runTick();
        } catch (err) {
          log.error({ err }, 'Push tick failed');
        }
      }
    }
  }

  const kick = () => {
    running ??= drain().finally(() => {
      running = null;
      if (pending.size || tickDue) kick();
    });
  };

  return {
    /** Journeys whose status changed; returns at once (the work happens in the background). */
    journeysChanged(ids: string[]) {
      for (const id of ids) pending.add(id);
      if (ids.length) kick();
    },
    /** Called by the worker's clock tick. */
    tick() {
      tickDue = true;
      kick();
    },
    /** Resolves when everything queued so far has been handled. */
    async idle() {
      while (running) await running;
    },
    async prune() {
      await sql`DELETE FROM push_log WHERE created_at < now() - make_interval(days => ${PUSH_LOG_DAYS})`.execute(db);
    },
    async close() {
      await this.idle();
      await sender?.close();
    },
  };
}

export type Notifier = ReturnType<typeof createNotifier>;
