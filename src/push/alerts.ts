import type { z } from 'zod';
import type { NotificationPrefs } from '../db/types.ts';
import type { LiveStatus } from '../modules/journeys/schemas.ts';
import type { ConnectionOut, ConnectionStatusValue } from '../live/connection.ts';
import { claimOf } from '../domain/delayRepay.ts';
import { operatorName } from '../domain/operators.ts';
import { bothMine } from '../live/division.ts';
import { dayIndex, hhmmToMinutes, ukWallClock } from '../time.ts';

/**
 * Which notifications a journey's latest status calls for. Pure, so the rules
 * are unit-tested on their own.
 *
 * Alerts are worked out against what the user has already been told (the
 * journey's AlertState), not against the previous status. So slow drift adds
 * up ("4 min late" then, minutes later, "9 min late"), nothing is repeated
 * after a restart, and a journey saved while already delayed doesn't alert for
 * what the user could already see when saving it.
 */

type LiveStatusOut = z.input<typeof LiveStatus>;

export interface AlertState {
  /** Boarding platform last told (or seen when saved). */
  platform: string | null;
  /** Delay in minutes last told: departure delay before leaving, arrival delay after. */
  delay: number;
  cancelled: boolean;
  departed: boolean;
  approaching: boolean;
  arrived: boolean;
  /**
   * Stop alarm: the destination arrival the app last scheduled its alarm from (pushed, or
   * current when the alarm was turned on); null once a cancellation was pushed. Absent while
   * the alarm is off, and in states saved before it existed: the next look records a baseline.
   */
  alarmArrival?: string | null;
  /** Morning summary sent, or no longer due (too late, or the train left). Absent = not yet. */
  morningSummary?: boolean;
  /** Leave-now alert sent, or no longer due. Absent = not yet. */
  leaveNow?: boolean;
  /** Divides alert sent. Absent = not yet. */
  divides?: boolean;
  /** Delay Repay looked at once the journey was over: alerted, or nothing to claim. Absent = not yet. */
  delayRepay?: boolean;
}

export type AlertKind =
  | 'platform'
  | 'delay'
  | 'cancelled'
  | 'departed'
  | 'approaching'
  | 'arrived'
  | 'morning_summary'
  | 'leave_now'
  | 'template_unmatched'
  | 'connection'
  | 'divides'
  | 'delay_repay';

export interface Alert {
  kind: AlertKind;
  /** Unique per journey: the same alert is never sent twice. */
  dedupeKey: string;
  title: string;
  body: string;
  /** Newer alerts with the same id replace older ones on the device (delay and platform updates). */
  collapseId: string | null;
  /** Breaks through Focus (needs the Time Sensitive Notifications capability in the app). */
  timeSensitive: boolean;
}

export interface JourneyFacts {
  id: string;
  fromName: string;
  toName: string;
  /** ISO, UK offset. */
  scheduledDeparture: string;
  scheduledArrival: string;
}

export type Prefs = NotificationPrefs;

/** Minutes an alert about something that already happened may be late and still worth sending. */
const DEPARTED_FRESH_MIN = 20;
const ARRIVED_FRESH_MIN = 30;
/** "Approaching" fires this long before the expected arrival. */
export const APPROACHING_MIN = 10;
/** Once over the threshold, a further change of this many minutes is worth another alert. */
const DELAY_STEP_MIN = 5;

const hhmm = (iso: string) => iso.slice(11, 16);
const minutesBetween = (a: Date, iso: string) => (Date.parse(iso) - a.getTime()) / 60_000;
const lateText = (d: number) => (d <= 0 ? 'on time' : `${d} min late`);
const withReason = (text: string, reason: string | null | undefined) => (reason ? `${text} ${reason}.` : text);

const destination = (s: LiveStatusOut) => s.progress?.stops.at(-1) ?? null;
const isDeparted = (s: LiveStatusOut) => s.state === 'departed' || s.state === 'arrived';
const isCancelled = (s: LiveStatusOut) => s.state === 'cancelled' || (s.service?.isCancelled ?? false);

/** The delay that matters now: leaving my station until the train has, then arriving at my destination. */
export function currentDelay(s: LiveStatusOut): number | null {
  if (isDeparted(s)) return destination(s)?.delayMinutes ?? s.service?.delayMinutes ?? null;
  return s.service?.delayMinutes ?? null;
}

/** What the user can already see when they save a journey: nothing about it is news. */
export function baselineOf(s: LiveStatusOut | null): AlertState {
  return {
    platform: s?.service?.platform?.number ?? null,
    delay: (s && currentDelay(s)) ?? 0,
    cancelled: s ? isCancelled(s) : false,
    departed: s ? isDeparted(s) : false,
    approaching: s?.state === 'arrived',
    arrived: s?.state === 'arrived',
  };
}

/** The destination's expected arrival (else scheduled) as ISO. */
function dueAt(s: LiveStatusOut, j: Pick<JourneyFacts, 'scheduledArrival'>) {
  const dest = destination(s);
  return dest?.actual ?? dest?.expected ?? j.scheduledArrival;
}

export function planAlerts(
  told: AlertState | null,
  s: LiveStatusOut,
  j: JourneyFacts,
  prefs: Prefs,
  now: Date,
  opts: { estimatesFresh?: boolean } = {},
): { alerts: Alert[]; next: AlertState } {
  if (!told) return { alerts: [], next: baselineOf(s) };
  const next = { ...told };
  const alerts: Alert[] = [];
  const title = `${hhmm(j.scheduledDeparture)} ${j.fromName} to ${j.toName}`;
  const add = (kind: AlertKind, enabled: boolean, dedupeKey: string, body: string, opts: { collapse?: boolean; timeSensitive?: boolean } = {}) => {
    if (!enabled) return;
    alerts.push({ kind, dedupeKey, title, body, collapseId: opts.collapse ? `${j.id}:${kind}` : null, timeSensitive: opts.timeSensitive ?? false });
  };
  const service = s.service;
  const dest = destination(s);

  // Cancelled: at my station, or my destination dropped from the route.
  if (isCancelled(s) && !told.cancelled) {
    next.cancelled = true;
    const text = s.state === 'cancelled' ? 'This train has been cancelled.' : `${s.message ?? `No longer calling at ${j.toName}`}.`;
    add('cancelled', prefs.cancellations, 'cancelled', withReason(text, service?.cancelReason), {
      timeSensitive: true,
    });
  }
  if (isCancelled(s) && s.state === 'cancelled') return { alerts, next };

  // Platform at my station, until the train leaves.
  const platform = service?.platform?.number ?? null;
  if (s.state === 'live' && platform !== null && platform !== told.platform) {
    next.platform = platform;
    // Confirmed or predicted, as the app shows it.
    const predicted = service?.platform?.confirmed ? '' : ' (predicted)';
    const body =
      told.platform === null
        ? `Departs from platform ${platform}${predicted}.`
        : `Platform change: now platform ${platform} (was ${told.platform})${predicted}.`;
    add('platform', prefs.platforms, `platform:${told.platform ?? '-'}>${platform}`, body, { collapse: true, timeSensitive: told.platform !== null });
  }

  // Departed.
  let departedNow = false;
  if (isDeparted(s) && !told.departed) {
    next.departed = true;
    departedNow = true;
    // Only with a reported departure: one inferred from later reports (a feed gap) has no time to tell.
    const at = service?.actualDeparture ?? null;
    const fresh = at !== null && -minutesBetween(now, at) <= DEPARTED_FRESH_MIN;
    const d = service?.delayMinutes ?? 0;
    if (s.state === 'departed' && fresh) {
      add('departed', prefs.departure, 'departed', `Left ${j.fromName} at ${hhmm(at!)}, ${lateText(d)}. Due at ${j.toName} at ${hhmm(dueAt(s, j))}.`);
    }
  }

  // Delay: crossing the threshold, moving by 5+ minutes while over it, or recovering.
  const delay = currentDelay(s);
  if (delay !== null && s.state !== 'arrived') {
    const threshold = prefs.delayThresholdMinutes;
    const last = told.delay;
    const worse = delay >= threshold && (last < threshold || Math.abs(delay - last) >= DELAY_STEP_MIN);
    const recovered = last >= threshold && delay < threshold;
    if (worse || recovered) {
      next.delay = delay;
      // The departure alert already says how late it is.
      if (!departedNow) {
        let body: string;
        if (isDeparted(s)) {
          const due = dest?.expected ? ` at ${hhmm(dest.expected)}` : '';
          body = recovered ? `Back on time: due at ${j.toName}${due}.` : `Running ${delay} min late: now due at ${j.toName}${due}.`;
        } else {
          const leaves = service?.expectedDeparture ? hhmm(service.expectedDeparture) : null;
          body = recovered
            ? delay <= 0
              ? `Back on time: leaving ${j.fromName} at ${hhmm(j.scheduledDeparture)}.`
              : `Now ${delay} min late${leaves ? `: expected to leave at ${leaves}` : ''}.`
            : `Delayed by ${delay} min${leaves ? `: now expected to leave ${j.fromName} at ${leaves}` : ''}.`;
        }
        add('delay', prefs.delays, `delay:${last}>${delay}`, recovered ? body : withReason(body, service?.delayReason), { collapse: true });
      }
    }
  }

  // Approaching my destination (a time rule, so the clock tick checks it too). It
  // rests on the expected arrival, so it waits until that estimate is recent.
  if (s.state === 'departed' && !told.approaching && (opts.estimatesFresh ?? true)) {
    const due = dueAt(s, j);
    if (minutesBetween(now, due) <= APPROACHING_MIN) {
      next.approaching = true;
      if (!departedNow) {
        const plat = dest?.platform?.number ? `, platform ${dest.platform.number}` : '';
        add('approaching', prefs.arrival, 'approaching', `Arriving at ${j.toName} at ${hhmm(due)}${plat}.`);
      }
    }
  }

  // Arrived.
  if (s.state === 'arrived' && !told.arrived) {
    next.arrived = true;
    next.approaching = true;
    next.departed = true;
    const at = dueAt(s, j);
    if (-minutesBetween(now, at) <= ARRIVED_FRESH_MIN) {
      const d = dest?.delayMinutes;
      add('arrived', prefs.arrival, 'arrived', `Arrived at ${j.toName} at ${hhmm(at)}${d === null || d === undefined ? '' : `, ${lateText(d)}`}.`);
    }
  }

  return { alerts, next };
}

// ---- stop alarm -------------------------------------------------------------------

/** A move in the expected arrival smaller than this isn't worth waking the app for. */
export const STOP_ALARM_STEP_MIN = 2;

export interface StopAlarmPush {
  /** Unique per journey: the same move is never pushed twice. */
  dedupeKey: string;
  /** ISO, UK offset; null when cancelled. */
  expectedArrival: string | null;
  cancelled: boolean;
}

/**
 * What the app's stop alarm is set from: the arrival at my destination (as the
 * alerts see it), or null when the train no longer gets me there. A journey with
 * no live status yet is due at its scheduled time.
 */
export function stopAlarmArrival(s: LiveStatusOut | null, j: Pick<JourneyFacts, 'scheduledArrival'>): string | null {
  if (!s) return j.scheduledArrival;
  return isCancelled(s) ? null : dueAt(s, j);
}

/**
 * Whether the app's stop alarm needs moving. The app schedules an AlarmKit alarm
 * before arrival and reschedules it from live data whenever it runs; in the
 * background only a push wakes it. So this pushes when the arrival moves by
 * STOP_ALARM_STEP_MIN or more from what the app last had (drift adds up, as for
 * delays), and when the train is cancelled so the alarm can be cancelled too.
 *
 * Takes the state after planAlerts (which carries alarmArrival through unchanged).
 * With the alarm off, the remembered arrival is dropped, so turning it on again
 * starts from a fresh baseline: the app sets the alarm itself when it's toggled.
 */
export function planStopAlarm(
  state: AlertState,
  s: LiveStatusOut,
  j: JourneyFacts,
  enabled: boolean,
  now: Date,
): { push: StopAlarmPush | null; next: AlertState } {
  const { alarmArrival: told, ...rest } = state;
  if (!enabled) return { push: null, next: rest };
  const next: AlertState = { ...rest, alarmArrival: told };
  // At my stop the alarm has done its job (or the user is off the train).
  if (s.state === 'arrived') return { push: null, next };
  const due = stopAlarmArrival(s, j);
  if (told === undefined) return { push: null, next: { ...rest, alarmArrival: due } };
  if (due === told) return { push: null, next };

  const key = `stop_alarm:${told ?? 'cancelled'}>${due ?? 'cancelled'}`;
  if (due === null) {
    next.alarmArrival = null;
    // An alarm that already went off has nothing left to cancel.
    if (minutesBetween(now, told!) <= 0) return { push: null, next };
    return { push: { dedupeKey: key, expectedArrival: null, cancelled: true }, next };
  }
  // A time already past can't be alarmed for; keep the old one, so a later estimate compares against what the app has.
  if (minutesBetween(now, due) <= 0) return { push: null, next };
  // Reinstated after a cancellation: the app has no alarm, so any time is news.
  if (told !== null && Math.abs(Date.parse(due) - Date.parse(told)) < STOP_ALARM_STEP_MIN * 60_000) return { push: null, next };
  next.alarmArrival = due;
  return { push: { dedupeKey: key, expectedArrival: due, cancelled: false }, next };
}

// ---- regular journeys: morning summary and leave now -------------------------------

/** A morning summary due longer ago than this (the worker was down) is no longer worth sending. */
export const MORNING_SUMMARY_LATE_MIN = 30;
/** Leave-now fires this long before the time it takes to get to the station, as a buffer. */
export const LEAVE_NOW_BUFFER_MIN = 2;
/** A leave-now alert due longer ago than this is no longer worth sending. */
export const LEAVE_NOW_LATE_MIN = 10;

export interface TimedPlan {
  alert: Alert | null;
  next: AlertState;
}

const titleOf = (j: JourneyFacts) => `${hhmm(j.scheduledDeparture)} ${j.fromName} to ${j.toName}`;
const timedAlert = (kind: AlertKind, j: JourneyFacts, body: string, timeSensitive: boolean): Alert => ({
  kind,
  dedupeKey: kind,
  title: titleOf(j),
  body,
  collapseId: null,
  timeSensitive,
});
const platformText = (s: LiveStatusOut | null) => (s?.service?.platform?.number ? ` · platform ${s.service.platform.number}` : '');
/** "on time" or "6 min late, expected 07:48". */
function runningText(s: LiveStatusOut) {
  const d = s.service?.delayMinutes ?? 0;
  const expected = s.service?.expectedDeparture;
  return d > 0 ? `${d} min late${expected ? `, expected ${hhmm(expected)}` : ''}` : 'on time';
}

/**
 * The morning summary of a regular journey: at the template's summaryTime on the
 * day of the journey, if that's before the scheduled departure and the train
 * hasn't left. Skipped (and not tried again) when over MORNING_SUMMARY_LATE_MIN
 * overdue. A time rule: the notifier's tick checks it.
 */
export function planMorningSummary(
  told: AlertState,
  s: LiveStatusOut | null,
  j: JourneyFacts,
  summaryTime: string | null,
  enabled: boolean,
  now: Date,
): TimedPlan {
  if (summaryTime === null || told.morningSummary || !enabled) return { alert: null, next: told };
  const at = ukWallClock(j.scheduledDeparture.slice(0, 10), hhmmToMinutes(summaryTime)).getTime();
  if (now.getTime() < at) return { alert: null, next: told };
  const done = { ...told, morningSummary: true };
  const overdue = now.getTime() - at > MORNING_SUMMARY_LATE_MIN * 60_000;
  if (at >= Date.parse(j.scheduledDeparture) || overdue || (s && isDeparted(s))) return { alert: null, next: done };

  const train = `Your ${hhmm(j.scheduledDeparture)} to ${j.toName}`;
  let body: string;
  if (s && isCancelled(s)) body = `${train} is cancelled`;
  else if (!s?.service) body = `${train} has no live updates yet`;
  else body = `${train} is ${runningText(s)}${platformText(s)}`;
  return { alert: timedAlert('morning_summary', j, body, false), next: done };
}

/**
 * Leave now: at the expected departure (else scheduled) minus travelMinutes minus
 * LEAVE_NOW_BUFFER_MIN, so it moves later while the train runs late. If the train
 * is cancelled by then, the same alert says so instead. Not sent once the train
 * has left or when over LEAVE_NOW_LATE_MIN overdue. A time rule: the tick checks it.
 */
export function planLeaveNow(
  told: AlertState,
  s: LiveStatusOut | null,
  j: JourneyFacts,
  travelMinutes: number | null,
  enabled: boolean,
  now: Date,
): TimedPlan {
  if (travelMinutes === null || told.leaveNow || !enabled) return { alert: null, next: told };
  const cancelled = s !== null && isCancelled(s);
  const departs = (!cancelled && s?.service?.expectedDeparture) || j.scheduledDeparture;
  const at = Date.parse(departs) - (travelMinutes + LEAVE_NOW_BUFFER_MIN) * 60_000;
  if (now.getTime() < at) return { alert: null, next: told };
  const done = { ...told, leaveNow: true };
  if ((s && isDeparted(s)) || now.getTime() - at > LEAVE_NOW_LATE_MIN * 60_000) return { alert: null, next: done };

  const body = cancelled
    ? `Your ${hhmm(j.scheduledDeparture)} is cancelled. No need to leave yet.`
    : `Leave now for your ${hhmm(j.scheduledDeparture)} to ${j.toName}${s?.service ? `, ${runningText(s)}` : ''}${platformText(s)}`;
  return { alert: timedAlert('leave_now', j, body, true), next: done };
}

/** The divides alert is sent from this long before departure. */
export const DIVIDES_BEFORE_MIN = 30;

/**
 * Dividing train: once, from DIVIDES_BEFORE_MIN before the departure (expected,
 * else scheduled) until the train leaves, when my train divides before my
 * destination and only one part (or no part Darwin can say) goes there. When
 * both parts call there it isn't news, so nothing is sent (and it stays due in
 * case that changes). Nothing is sent once the train has left. A time rule:
 * the tick checks it.
 */
export function planDivides(told: AlertState, s: LiveStatusOut | null, j: JourneyFacts, enabled: boolean, now: Date): TimedPlan {
  const d = s?.divides;
  if (told.divides || !s || !d) return { alert: null, next: told };
  // Once the train has left, it's too late to choose a coach: no longer due (so the tick stops bringing it round).
  if (isDeparted(s)) return { alert: null, next: { ...told, divides: true } };
  if (!enabled || isCancelled(s) || bothMine(d)) return { alert: null, next: told };
  const departs = s.service?.expectedDeparture ?? j.scheduledDeparture;
  if (now.getTime() < Date.parse(departs) - DIVIDES_BEFORE_MIN * 60_000) return { alert: null, next: told };
  return { alert: timedAlert('divides', j, d.message, false), next: { ...told, divides: true } };
}

/** A delay_repay alert this long after the journey ended (actual, else scheduled arrival) is no longer news. */
export const DELAY_REPAY_FRESH_MIN = 6 * 60;

const percentText = (p: number) => `${p}%`;

/**
 * Delay Repay: once the journey is over (arrived, or cancelled and past its
 * scheduled arrival), whether it can be claimed for (`claimOf`). If so, one
 * alert saying how much of the fare, from which operator. Either way it is
 * then settled, so the tick stops bringing it round. Not sent with the
 * preference off, or when the journey ended more than DELAY_REPAY_FRESH_MIN
 * ago (the worker was down): the claim card in the app is still there.
 */
export function planDelayRepay(told: AlertState, s: LiveStatusOut | null, j: JourneyFacts, toc: string, enabled: boolean, now: Date): TimedPlan {
  if (told.delayRepay) return { alert: null, next: told };
  const claim = claimOf(s, { toc, scheduledArrival: j.scheduledArrival }, now);
  const done = { ...told, delayRepay: true };
  if (!claim) return { alert: null, next: s?.state === 'arrived' ? done : told };
  const ended = Date.parse(claim.actualArrival ?? j.scheduledArrival);
  if (!enabled || now.getTime() - ended > DELAY_REPAY_FRESH_MIN * 60_000) return { alert: null, next: done };

  const from = `Delay Repay from ${operatorName(toc)}`;
  let body: string;
  if (claim.cancelled || !claim.band) {
    body = `This train was cancelled. You may be able to claim ${from} for how late you got to ${j.toName}, or a refund if you didn't travel.`;
  } else {
    const share = claim.band.maxMinutes === null ? `${percentText(claim.band.returnPercent)} of a return fare` : `${percentText(claim.band.singlePercent)} of a single fare`;
    body = `Arrived at ${j.toName} ${claim.delayMinutes} min late. You may be able to claim ${from}: ${share}.`;
  }
  return { alert: timedAlert('delay_repay', j, body, false), next: done };
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** The template_unmatched alert (and the template's `problem` message). */
export function templateUnmatchedText(departTime: string, fromName: string, toName: string, date: string) {
  return `Couldn't find your ${departTime} ${fromName} → ${toName} on ${WEEKDAYS[dayIndex(date) - 1]}. Check your regular journey.`;
}

// ---- connections (trips) ------------------------------------------------------------

/** A later train offered when a change is at risk or missed. */
export interface AlternativeFacts {
  scheduledDeparture: string;
  /** Expected (or actual) departure when Darwin has the run. */
  expectedDeparture: string | null;
  /** At the next leg's destination. */
  scheduledArrival: string | null;
}

export interface ConnectionFacts {
  tripId: string;
  /** The next leg: the train to change onto. */
  nextScheduledDeparture: string;
  nextToName: string;
}

const RANK: Record<ConnectionStatusValue, number> = { ok: 0, tight: 1, at_risk: 2, missed: 3 };
const isBad = (s: ConnectionStatusValue) => s === 'at_risk' || s === 'missed';

function alternativeText(alt: AlternativeFacts | undefined) {
  if (!alt) return '';
  const late = alt.expectedDeparture && alt.expectedDeparture !== alt.scheduledDeparture ? ` (expected ${hhmm(alt.expectedDeparture)})` : '';
  const arrives = alt.scheduledArrival ? `, arriving ${hhmm(alt.scheduledArrival)}` : '';
  return ` Next train: the ${hhmm(alt.scheduledDeparture)}${late}${arrives}.`;
}

/**
 * The connection alert for one change of a trip, against the status last told
 * (trips.alert_state). Sent when the change gets worse into at_risk or missed
 * (with the next train that works when missed), and when it is back to ok.
 *
 * Hysteresis keeps it quiet while estimates wobble: once at_risk or missed has
 * been told, a move to `tight` (or from missed to at_risk) is not news and the
 * told status stays, so only a real recovery to `ok`, or a further worsening,
 * alerts. A first look records a baseline (what the user saw when linking), and
 * nothing is sent once the change is settled (arrived, and the next train left).
 */
export function planConnectionAlert(
  told: ConnectionStatusValue | undefined,
  c: ConnectionOut,
  f: ConnectionFacts,
  opts: { enabled: boolean; settled: boolean; alternatives?: AlternativeFacts[] },
): { alert: Alert | null; next: ConnectionStatusValue } {
  const status = c.status;
  if (told === undefined || opts.settled) return { alert: null, next: status };
  if (!isBad(told) && !isBad(status)) return { alert: null, next: status };

  const worse = isBad(status) && RANK[status] > RANK[told];
  const recovered = isBad(told) && status === 'ok';
  if (!worse && !recovered) return { alert: null, next: told };

  const train = `the ${hhmm(f.nextScheduledDeparture)} to ${f.nextToName}`;
  const gap = Math.floor((Date.parse(c.departure) - Date.parse(c.arrival)) / 60_000);
  const platform = c.departurePlatform ? ` from platform ${c.departurePlatform.number}` : '';
  let body: string;
  if (recovered) body = `Back on: ${gap} min to change for ${train}${platform}.`;
  else if (status === 'at_risk') body = `Tight change: ${gap} min for ${train}${platform} (${c.minimumChangeMinutes} needed).`;
  else {
    const what = c.cancelled
      ? c.message.startsWith('This train')
        ? `${c.message}.`
        : `${capitalised(train)} is cancelled.`
      : `You'll miss ${train}: you're due at ${hhmm(c.arrival)} and it leaves at ${hhmm(c.departure)}.`;
    body = `${what}${alternativeText(opts.alternatives?.[0])}`;
  }
  if (!opts.enabled) return { alert: null, next: status };
  return {
    alert: {
      kind: 'connection',
      dedupeKey: `connection:${c.leg}:${told}>${status}@${c.arrival}|${c.departure}`,
      title: `Your change at ${c.station.name}`,
      body,
      collapseId: `${f.tripId}:connection:${c.leg}`,
      timeSensitive: !recovered,
    },
    next: status,
  };
}

const capitalised = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
