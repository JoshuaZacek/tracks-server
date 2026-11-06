import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { LiveStatus } from '../modules/journeys/schemas.ts';
import { DEFAULT_PREFS } from '../modules/devices/schemas.ts';
import {
  baselineOf,
  planAlerts,
  planLeaveNow,
  planMorningSummary,
  planStopAlarm,
  stopAlarmArrival,
  templateUnmatchedText,
  type AlertState,
} from './alerts.ts';

type LiveStatusOut = z.input<typeof LiveStatus>;

const J = {
  id: 'j1',
  fromName: "King's Cross",
  toName: 'York',
  scheduledDeparture: '2026-11-03T17:00:00+00:00',
  scheduledArrival: '2026-11-03T19:00:00+00:00',
};
const at = (hhmm: string) => new Date(`2026-11-03T${hhmm}:00Z`);
const t = (hhmm: string) => `2026-11-03T${hhmm}:00+00:00`;

interface Opts {
  state?: LiveStatusOut['state'];
  delay?: number | null;
  arrDelay?: number | null;
  platform?: string | null;
  confirmed?: boolean;
  hidden?: boolean;
  cancelled?: boolean;
  actualDeparture?: string | null;
  expectedArrival?: string | null;
  actualArrival?: string | null;
  message?: string | null;
}

function status(o: Opts = {}): LiveStatusOut {
  const delay = o.delay ?? null;
  const stop = (crs: string, scheduled: string, extra: object = {}) => ({
    crs,
    name: crs,
    scheduled,
    expected: null,
    actual: null,
    passed: false,
    isCancelled: false,
    delayMinutes: null,
    platform: null,
    ...extra,
  });
  return {
    state: o.state ?? 'live',
    checkedAt: t('16:40'),
    nextPollSeconds: null,
    stale: false,
    message: o.message ?? null,
    service: {
      rid: 'r',
      scheduledDeparture: J.scheduledDeparture,
      expectedDeparture: delay === null ? null : t(`17:${String(delay).padStart(2, '0')}`),
      actualDeparture: o.actualDeparture ?? null,
      delayMinutes: delay,
      platform: o.platform ? { number: o.platform, source: 'live', confirmed: o.confirmed ?? false, hidden: o.hidden ?? false } : null,
      isCancelled: o.cancelled ?? false,
      cancelReason: null,
      delayReason: null,
    },
    progress: {
      stops: [
        stop('KGX', J.scheduledDeparture),
        stop('PBO', t('17:45')),
        stop('YRK', J.scheduledArrival, {
          expected: o.expectedArrival ?? null,
          actual: o.actualArrival ?? null,
          delayMinutes: o.arrDelay ?? null,
          platform: { number: '4', source: 'live', confirmed: true, hidden: false },
        }),
      ],
      lastPassedIndex: -1,
      nextIndex: 0,
      arrived: o.state === 'arrived',
    },
    position: null,
  };
}

const quiet: AlertState = { platform: null, delay: 0, cancelled: false, departed: false, approaching: false, arrived: false };
const plan = (told: AlertState | null, s: LiveStatusOut, now = at('16:40'), prefs = DEFAULT_PREFS) => planAlerts(told, s, J, prefs, now);
const bodies = (r: ReturnType<typeof plan>) => r.alerts.map((a) => `${a.kind}: ${a.body}`);

describe('planAlerts', () => {
  it('sets a baseline without alerting when nothing has been told yet', () => {
    const r = plan(null, status({ delay: 20, platform: '7' }));
    expect(r.alerts).toEqual([]);
    expect(r.next).toEqual({ ...quiet, platform: '7', delay: 20 });
  });

  it('announces the platform, then a change of platform', () => {
    const first = plan(quiet, status({ platform: '7', confirmed: true }));
    expect(bodies(first)).toEqual(['platform: Departs from platform 7.']);
    expect(first.alerts[0]).toMatchObject({ title: "17:00 King's Cross to York", collapseId: 'j1:platform', dedupeKey: 'platform:->7' });

    const change = plan(first.next, status({ platform: '9', confirmed: true }));
    expect(bodies(change)).toEqual(['platform: Platform change: now platform 9 (was 7).']);
    expect(change.alerts[0]!.timeSensitive).toBe(true);
    expect(plan(change.next, status({ platform: '9', confirmed: true })).alerts).toEqual([]);
  });

  it('marks an unconfirmed platform as predicted; a confirmed one the station hides is just confirmed', () => {
    expect(bodies(plan(quiet, status({ platform: '2' })))).toEqual(['platform: Departs from platform 2 (predicted).']);
    expect(bodies(plan(quiet, status({ platform: '2', confirmed: true, hidden: true })))).toEqual(['platform: Departs from platform 2.']);
  });

  it('alerts on reaching the delay threshold, on 5+ minute moves, and on recovery, not on small drift', () => {
    let told = quiet;
    const step = (delay: number) => {
      const r = plan(told, status({ delay }));
      told = r.next;
      return bodies(r);
    };
    expect(step(3)).toEqual([]);
    expect(step(5)).toEqual(["delay: Delayed by 5 min: now expected to leave King's Cross at 17:05."]);
    expect(step(8)).toEqual([]);
    expect(step(10)).toEqual(["delay: Delayed by 10 min: now expected to leave King's Cross at 17:10."]);
    expect(step(2)).toEqual(['delay: Now 2 min late: expected to leave at 17:02.']);
    expect(step(0)).toEqual([]);
  });

  it('respects the threshold and the delays preference', () => {
    expect(plan(quiet, status({ delay: 7 }), at('16:40'), { ...DEFAULT_PREFS, delayThresholdMinutes: 10 }).alerts).toEqual([]);
    const off = plan(quiet, status({ delay: 15 }), at('16:40'), { ...DEFAULT_PREFS, delays: false });
    expect(off.alerts).toEqual([]);
    expect(off.next.delay).toBe(15); // still recorded, so turning it back on doesn't replay it
  });

  it('reports departure with how late it is, then arrival delay changes and the approach', () => {
    const departed = status({ state: 'departed', delay: 4, actualDeparture: t('17:04'), arrDelay: 4, expectedArrival: t('19:04') });
    const r = plan({ ...quiet, platform: '7' }, departed, at('17:05'));
    expect(bodies(r)).toEqual(["departed: Left King's Cross at 17:04, 4 min late. Due at York at 19:04."]);

    const later = plan(r.next, status({ state: 'departed', delay: 4, actualDeparture: t('17:04'), arrDelay: 12, expectedArrival: t('19:12') }), at('18:00'));
    expect(bodies(later)).toEqual(['delay: Running 12 min late: now due at York at 19:12.']);

    const near = plan(later.next, status({ state: 'departed', delay: 4, actualDeparture: t('17:04'), arrDelay: 12, expectedArrival: t('19:12') }), at('19:03'));
    expect(bodies(near)).toEqual(['approaching: Arriving at York at 19:12, platform 4.']);
    expect(plan(near.next, status({ state: 'departed', arrDelay: 12, expectedArrival: t('19:12') }), at('19:05')).alerts).toEqual([]);

    const arrived = plan(near.next, status({ state: 'arrived', arrDelay: 13, actualArrival: t('19:13') }), at('19:14'));
    expect(bodies(arrived)).toEqual(['arrived: Arrived at York at 19:13, 13 min late.']);
  });

  it('does not announce a departure or arrival that is long past (e.g. after an outage)', () => {
    const departed = status({ state: 'departed', delay: 0, actualDeparture: t('17:00') });
    const r = plan(quiet, departed, at('17:45'));
    expect(r.alerts).toEqual([]);
    expect(r.next.departed).toBe(true);
    expect(plan(quiet, status({ state: 'arrived', actualArrival: t('19:00') }), at('20:00')).alerts).toEqual([]);
  });

  it('does not announce a departure that was only inferred from later reports (no departure time)', () => {
    const r = plan(quiet, status({ state: 'departed', delay: null, actualDeparture: null }), at('17:05'));
    expect(r.alerts.map((a) => a.kind)).not.toContain('departed');
    expect(r.next.departed).toBe(true);
  });

  it('alerts once on cancellation, with nothing else', () => {
    const r = plan(quiet, status({ state: 'cancelled', cancelled: true, platform: '7', delay: 30 }));
    expect(bodies(r)).toEqual(['cancelled: This train has been cancelled.']);
    expect(r.alerts[0]!.timeSensitive).toBe(true);
    expect(plan(r.next, status({ state: 'cancelled', cancelled: true })).alerts).toEqual([]);
  });

  it('alerts when the destination is dropped after departure', () => {
    const s = status({ state: 'departed', cancelled: true, actualDeparture: t('17:00'), message: 'No longer calling at York' });
    expect(bodies(plan({ ...quiet, departed: true }, s, at('17:30')))).toEqual(['cancelled: No longer calling at York.']);
  });

  it('baselines what the user could see when saving', () => {
    expect(baselineOf(null)).toEqual(quiet);
    expect(baselineOf(status({ state: 'departed', arrDelay: 6, delay: 2 }))).toMatchObject({ departed: true, delay: 6 });
  });
});

describe('planStopAlarm', () => {
  const running = (expectedArrival: string | null, o: Opts = {}) => status({ state: 'departed', actualDeparture: t('17:00'), expectedArrival, ...o });
  const alarm = (told: AlertState, s: LiveStatusOut, now = at('17:30'), enabled = true) => planStopAlarm(told, s, J, enabled, now);
  const watching = { ...quiet, departed: true, alarmArrival: t('19:00') };

  it('records the current arrival without a push when first watched (alarm turned on, or a state from before the alarm)', () => {
    const r = alarm({ ...quiet, departed: true }, running(t('19:07')));
    expect(r.push).toBeNull();
    expect(r.next.alarmArrival).toBe(t('19:07'));
    // No estimate yet: the scheduled arrival.
    expect(alarm(quiet, status()).next.alarmArrival).toBe(J.scheduledArrival);
  });

  it('pushes only when the arrival moves by 2 minutes or more from what the app has, so drift adds up', () => {
    let told: AlertState = watching;
    const step = (expected: string, now = at('17:30')) => {
      const r = alarm(told, running(expected), now);
      told = r.next;
      return r.push;
    };
    expect(step(t('19:01'))).toBeNull();
    expect(told.alarmArrival).toBe(t('19:00')); // a small move isn't recorded: the next is measured from 19:00
    expect(step(t('19:02'))).toEqual({ dedupeKey: `stop_alarm:${t('19:00')}>${t('19:02')}`, expectedArrival: t('19:02'), cancelled: false });
    expect(step(t('19:02'))).toBeNull(); // saved state: no repeat
    expect(step(t('19:03'))).toBeNull();
    expect(step(t('19:04'))).toMatchObject({ expectedArrival: t('19:04') });
    expect(step(t('19:01'))).toMatchObject({ expectedArrival: t('19:01') }); // earlier counts too
  });

  it('uses the actual arrival when there is one, like the alerts', () => {
    expect(alarm(watching, running(null, { actualArrival: t('19:05') })).push).toMatchObject({ expectedArrival: t('19:05') });
  });

  it('pushes a cancellation once, then the new time if the train is reinstated', () => {
    const cancelled = alarm(watching, status({ state: 'cancelled', cancelled: true }), at('16:40'));
    expect(cancelled.push).toEqual({ dedupeKey: `stop_alarm:${t('19:00')}>cancelled`, expectedArrival: null, cancelled: true });
    expect(cancelled.next.alarmArrival).toBeNull();
    expect(alarm(cancelled.next, status({ state: 'cancelled', cancelled: true }), at('16:41')).push).toBeNull();

    // Reinstated at the old time: the app cancelled its alarm, so even an unchanged time is news.
    expect(alarm(cancelled.next, status({ expectedArrival: t('19:00') }), at('16:45')).push).toEqual({
      dedupeKey: `stop_alarm:cancelled>${t('19:00')}`,
      expectedArrival: t('19:00'),
      cancelled: false,
    });
  });

  it('treats my destination dropped from the route as a cancellation', () => {
    const s = running(t('19:00'), { cancelled: true, message: 'No longer calling at York' });
    expect(stopAlarmArrival(s, J)).toBeNull();
    expect(alarm(watching, s).push).toMatchObject({ expectedArrival: null, cancelled: true });
  });

  it('stays quiet once arrived, for times already past, and for an alarm that already went off', () => {
    expect(alarm(watching, status({ state: 'arrived', actualArrival: t('19:06') }), at('19:06')).push).toBeNull();
    // The estimate lags the train: nothing to alarm for, and the app's time is kept for comparison.
    const late = alarm(watching, running(t('19:05')), at('19:08'));
    expect(late.push).toBeNull();
    expect(late.next.alarmArrival).toBe(t('19:00'));
    expect(alarm(watching, running(null, { cancelled: true }), at('19:01')).push).toBeNull();
  });

  it('forgets the arrival while the alarm is off, so turning it on starts from a new baseline', () => {
    const off = alarm(watching, running(t('19:10')), at('17:30'), false);
    expect(off.push).toBeNull();
    expect(off.next).not.toHaveProperty('alarmArrival');
    const on = alarm(off.next, running(t('19:10')));
    expect(on.push).toBeNull();
    expect(on.next.alarmArrival).toBe(t('19:10'));
  });

  it('is carried through planAlerts untouched', () => {
    expect(plan(watching, running(t('19:20')), at('17:30')).next.alarmArrival).toBe(t('19:00'));
  });
});

describe('planMorningSummary', () => {
  const summary = (told: AlertState, s: LiveStatusOut | null, now: Date, summaryTime: string | null = '16:30', enabled = true) =>
    planMorningSummary(told, s, J, summaryTime, enabled, now);
  const body = (r: ReturnType<typeof summary>) => r.alert?.body ?? null;

  it('waits for the summary time, then sends once', () => {
    expect(summary(quiet, status(), at('16:29'))).toEqual({ alert: null, next: quiet });
    const r = summary(quiet, status({ delay: 0, platform: '4' }), at('16:30'));
    expect(r.alert).toEqual({
      kind: 'morning_summary',
      dedupeKey: 'morning_summary',
      title: "17:00 King's Cross to York",
      body: 'Your 17:00 to York is on time · platform 4',
      collapseId: null,
      timeSensitive: false,
    });
    expect(r.next).toEqual({ ...quiet, morningSummary: true });
    expect(summary(r.next, status(), at('16:31')).alert).toBeNull();
  });

  it('says how late or that it is cancelled', () => {
    expect(body(summary(quiet, status({ delay: 6 }), at('16:30')))).toBe('Your 17:00 to York is 6 min late, expected 17:06');
    expect(body(summary(quiet, status({ state: 'cancelled', cancelled: true }), at('16:30')))).toBe('Your 17:00 to York is cancelled');
    expect(body(summary(quiet, null, at('16:30')))).toBe('Your 17:00 to York has no live updates yet');
  });

  it('is skipped (for good) over 30 minutes late, after departure, or when set for after the departure', () => {
    expect(summary(quiet, status(), at('17:01'), '16:30')).toEqual({ alert: null, next: { ...quiet, morningSummary: true } });
    expect(summary(quiet, status({ state: 'departed' }), at('16:45')).alert).toBeNull();
    expect(summary(quiet, status(), at('17:05'), '17:00').alert).toBeNull();
    expect(summary(quiet, status(), at('16:59'), '16:30').alert).not.toBeNull();
  });

  it('needs a summary time and the preference', () => {
    expect(summary(quiet, status(), at('16:30'), null)).toEqual({ alert: null, next: quiet });
    expect(summary(quiet, status(), at('16:30'), '16:30', false)).toEqual({ alert: null, next: quiet });
  });
});

describe('planLeaveNow', () => {
  const leave = (told: AlertState, s: LiveStatusOut | null, now: Date, travel: number | null = 20, enabled = true) =>
    planLeaveNow(told, s, J, travel, enabled, now);

  it('fires travel time + 2 minutes before departure, once, time-sensitive', () => {
    expect(leave(quiet, status({ delay: 0 }), at('16:37')).alert).toBeNull();
    const r = leave(quiet, status({ delay: 0, platform: '4' }), at('16:38'));
    expect(r.alert).toMatchObject({
      kind: 'leave_now',
      dedupeKey: 'leave_now',
      body: 'Leave now for your 17:00 to York, on time · platform 4',
      timeSensitive: true,
    });
    expect(r.next).toEqual({ ...quiet, leaveNow: true });
    expect(leave(r.next, status(), at('16:39')).alert).toBeNull();
  });

  it('moves later while the train runs late', () => {
    expect(leave(quiet, status({ delay: 12 }), at('16:38')).alert).toBeNull();
    expect(leave(quiet, status({ delay: 12 }), at('16:50')).alert?.body).toBe('Leave now for your 17:00 to York, 12 min late, expected 17:12');
  });

  it('says so when the train is cancelled by then', () => {
    expect(leave(quiet, status({ state: 'cancelled', cancelled: true }), at('16:38')).alert?.body).toBe('Your 17:00 is cancelled. No need to leave yet.');
  });

  it('works from the timetable without live data', () => {
    expect(leave(quiet, null, at('16:38')).alert?.body).toBe('Leave now for your 17:00 to York');
  });

  it('is not sent once departed, over 10 minutes late, without a travel time or with the preference off', () => {
    expect(leave(quiet, status({ state: 'departed', actualDeparture: t('16:59') }), at('16:58'))).toEqual({ alert: null, next: { ...quiet, leaveNow: true } });
    expect(leave(quiet, status(), at('16:49'))).toEqual({ alert: null, next: { ...quiet, leaveNow: true } });
    expect(leave(quiet, status(), at('16:48')).alert).not.toBeNull();
    expect(leave(quiet, status(), at('16:50'), null)).toEqual({ alert: null, next: quiet });
    expect(leave(quiet, status(), at('16:50'), 20, false)).toEqual({ alert: null, next: quiet });
  });

  it('is carried through planAlerts and planStopAlarm untouched', () => {
    const told = { ...quiet, morningSummary: true, leaveNow: true };
    const next = plan(told, status({ delay: 0 })).next;
    expect(next).toMatchObject({ morningSummary: true, leaveNow: true });
    expect(planStopAlarm(next, status(), J, false, at('16:40')).next).toMatchObject({ morningSummary: true, leaveNow: true });
  });
});

describe('templateUnmatchedText', () => {
  it('names the time, stations and weekday', () => {
    expect(templateUnmatchedText('07:42', 'London Bridge', 'Brighton', '2026-11-03')).toBe(
      "Couldn't find your 07:42 London Bridge → Brighton on Tuesday. Check your regular journey.",
    );
  });
});
