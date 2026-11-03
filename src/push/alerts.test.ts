import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { LiveStatus } from '../modules/journeys/schemas.ts';
import { DEFAULT_PREFS } from '../modules/devices/schemas.ts';
import { baselineOf, planAlerts, type AlertState } from './alerts.ts';

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

  it('marks an unconfirmed platform as expected, and one the station hides as not yet announced', () => {
    expect(bodies(plan(quiet, status({ platform: '2' })))).toEqual(['platform: Departs from platform 2 (expected).']);
    expect(bodies(plan(quiet, status({ platform: '2', confirmed: true, hidden: true })))).toEqual([
      'platform: Departs from platform 2, not yet announced at the station.',
    ]);
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
