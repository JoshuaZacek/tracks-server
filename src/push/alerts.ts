import type { z } from 'zod';
import type { NotificationPrefs } from '../db/types.ts';
import type { LiveStatus } from '../modules/journeys/schemas.ts';

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
}

export type AlertKind = 'platform' | 'delay' | 'cancelled' | 'departed' | 'approaching' | 'arrived';

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
function dueAt(s: LiveStatusOut, j: JourneyFacts) {
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
    const body =
      told.platform === null
        ? `Departs from platform ${platform}${service?.platform?.confirmed ? '' : ' (expected)'}.`
        : `Platform change: now platform ${platform} (was ${told.platform}).`;
    add('platform', prefs.platforms, `platform:${told.platform ?? '-'}>${platform}`, body, { collapse: true, timeSensitive: told.platform !== null });
  }

  // Departed.
  let departedNow = false;
  if (isDeparted(s) && !told.departed) {
    next.departed = true;
    departedNow = true;
    const at = service?.actualDeparture ?? service?.expectedDeparture ?? j.scheduledDeparture;
    const fresh = -minutesBetween(now, at) <= DEPARTED_FRESH_MIN;
    const d = service?.delayMinutes ?? 0;
    if (s.state === 'departed' && fresh) {
      add('departed', prefs.departure, 'departed', `Left ${j.fromName} at ${hhmm(at)}, ${lateText(d)}. Due at ${j.toName} at ${hhmm(dueAt(s, j))}.`);
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
