import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { LiveStatus } from '../modules/journeys/schemas.ts';
import { planConnectionAlert } from '../push/alerts.ts';
import { computeConnection, connectionSettled, type LegView } from './connection.ts';

type LiveStatusOut = z.input<typeof LiveStatus>;

const RDG = { crs: 'RDG', name: 'Reading', lat: 51.4588, lon: -0.9718 };
const t = (hhmm: string, day = '2026-11-03') => `${day}T${hhmm}:00+00:00`;

/** Leg 1: Paddington → Reading, due 17:30 on platform 9. */
const into = (o: { arrival?: string | null; actual?: string | null; state?: LiveStatusOut['state']; destCancelled?: boolean } = {}): LegView => ({
  status:
    o.arrival === undefined && o.state === undefined && !o.actual
      ? null
      : status(o.state ?? 'departed', {
          stops: [
            stop('PAD', t('17:00')),
            stop('RDG', t('17:30'), { expected: o.arrival ?? null, actual: o.actual ?? null, isCancelled: o.destCancelled ?? false, platform: livePlatform('10') }),
          ],
        }),
  scheduledDeparture: t('17:00'),
  scheduledArrival: t('17:30'),
  bookedDeparturePlatform: '1',
  bookedArrivalPlatform: '9',
});

/** Leg 2: Reading → Bristol, leaves 17:42 from platform 4. */
const onward = (
  o: { expected?: string | null; actual?: string | null; state?: LiveStatusOut['state']; cancelled?: boolean; scheduled?: string } = {},
): LegView => ({
  status:
    o.expected === undefined && o.state === undefined && !o.actual && !o.cancelled
      ? null
      : status(o.cancelled ? 'cancelled' : (o.state ?? 'live'), {
          service: {
            rid: 'r2',
            scheduledDeparture: o.scheduled ?? t('17:42'),
            expectedDeparture: o.expected ?? null,
            actualDeparture: o.actual ?? null,
            delayMinutes: null,
            platform: null,
            isCancelled: o.cancelled ?? false,
            cancelReason: null,
            delayReason: null,
          },
          stops: [stop('RDG', o.scheduled ?? t('17:42'), { isCancelled: o.cancelled ?? false }), stop('BRI', t('18:45'))],
        }),
  scheduledDeparture: o.scheduled ?? t('17:42'),
  scheduledArrival: t('18:45'),
  bookedDeparturePlatform: '4',
  bookedArrivalPlatform: null,
});

const livePlatform = (number: string) => ({ number, source: 'live' as const, confirmed: true, hidden: false });

function stop(crs: string, scheduled: string, extra: object = {}) {
  return { crs, name: crs, scheduled, expected: null, actual: null, passed: false, isCancelled: false, delayMinutes: null, platform: null, ...extra };
}

function status(state: LiveStatusOut['state'], o: { stops?: ReturnType<typeof stop>[]; service?: LiveStatusOut['service'] }): LiveStatusOut {
  return {
    state,
    checkedAt: t('17:00'),
    nextPollSeconds: null,
    stale: false,
    message: null,
    service: o.service ?? null,
    progress: o.stops ? { stops: o.stops, lastPassedIndex: 0, nextIndex: 1, arrived: state === 'arrived' } : null,
    position: null,
  };
}

const connect = (a: LegView, b: LegView) => computeConnection(1, RDG, a, b);

describe('computeConnection', () => {
  it('uses the timetable when there is no live data: 12 min to change is ok', () => {
    expect(connect(into(), onward())).toEqual({
      leg: 1,
      station: RDG,
      status: 'ok',
      message: '12 min to change',
      arrival: t('17:30'),
      arrivalPlatform: { number: '9', source: 'booked', confirmed: false, hidden: false },
      departure: t('17:42'),
      departurePlatform: { number: '4', source: 'booked', confirmed: false, hidden: false },
      minimumChangeMinutes: 5,
      marginMinutes: 7,
      scheduledMarginMinutes: 7,
      cancelled: false,
    });
  });

  it.each([
    ['17:33', 'ok', 4],
    ['17:34', 'ok', 3],
    ['17:35', 'tight', 2],
    ['17:37', 'tight', 0],
    ['17:38', 'at_risk', -1],
    ['17:42', 'at_risk', -5],
    ['17:43', 'missed', -6],
  ] as const)('arriving at %s for the 17:42 is %s (margin %i)', (arrival, expected, margin) => {
    const c = connect(into({ arrival: t(arrival) }), onward());
    expect(c.status).toBe(expected);
    expect(c.marginMinutes).toBe(margin);
    expect(c.scheduledMarginMinutes).toBe(7);
  });

  it('takes the live arrival platform and the next train running late into account', () => {
    const c = connect(into({ arrival: t('17:45') }), onward({ expected: t('17:52') }));
    expect(c).toMatchObject({ status: 'tight', marginMinutes: 2, message: '7 min to change', arrivalPlatform: { number: '10', source: 'live' } });
  });

  it('prefers actual times over expected', () => {
    const c = connect(into({ state: 'arrived', arrival: t('17:31'), actual: t('17:38') }), onward({ expected: t('17:42'), state: 'live' }));
    expect(c).toMatchObject({ arrival: t('17:38'), status: 'at_risk', message: 'Only 4 min to change (5 needed)' });
  });

  it('works across midnight', () => {
    const late = into({ arrival: t('23:58') });
    const next = onward({ scheduled: t('00:10', '2026-11-04') });
    expect(connect(late, next)).toMatchObject({ status: 'ok', marginMinutes: 7, message: '12 min to change', departure: t('00:10', '2026-11-04') });
    const later = connect(into({ arrival: t('00:12', '2026-11-04') }), next);
    expect(later).toMatchObject({ status: 'missed', marginMinutes: -7, message: 'The 00:10 leaves before you arrive' });
    // The timetabled change itself spans midnight.
    expect(later.scheduledMarginMinutes).toBe(6 * 60 + 40 - 5);
  });

  it('is missed when the next train is cancelled, however much time there is', () => {
    expect(connect(into(), onward({ cancelled: true }))).toMatchObject({
      status: 'missed',
      cancelled: true,
      marginMinutes: null,
      message: 'The 17:42 is cancelled',
    });
  });

  it('is missed when my train is cancelled or no longer calls at the change station', () => {
    expect(connect(into({ state: 'cancelled' }), onward())).toMatchObject({ status: 'missed', cancelled: true, message: 'This train no longer gets to Reading' });
    expect(connect(into({ arrival: t('17:30'), destCancelled: true }), onward())).toMatchObject({ status: 'missed', cancelled: true, marginMinutes: null });
  });

  it('is missed when the next train has already left and I have not arrived', () => {
    expect(connect(into({ arrival: t('17:50') }), onward({ state: 'departed', expected: t('17:42'), actual: t('17:43') }))).toMatchObject({
      status: 'missed',
      departure: t('17:43'),
    });
  });

  it('is settled once I have arrived and the next train has left', () => {
    expect(connectionSettled(into({ state: 'arrived', actual: t('17:31') }), onward({ state: 'departed', actual: t('17:42') }))).toBe(true);
    expect(connectionSettled(into({ arrival: t('17:50') }), onward({ state: 'departed', actual: t('17:42') }))).toBe(false);
    expect(connectionSettled(into({ state: 'arrived', actual: t('17:31') }), onward({ expected: t('17:42') }))).toBe(false);
  });
});

describe('planConnectionAlert', () => {
  const F = { tripId: 'trip1', nextScheduledDeparture: t('17:42'), nextToName: 'Bristol Temple Meads' };
  const on = { enabled: true, settled: false };
  const at = (arrival: string, b: LegView = onward()) => connect(into({ arrival: t(arrival) }), b);

  it('records a baseline the first time, without alerting', () => {
    expect(planConnectionAlert(undefined, at('17:40'), F, on)).toEqual({ alert: null, next: 'at_risk' });
  });

  it('alerts when the change becomes at risk', () => {
    const { alert, next } = planConnectionAlert('ok', at('17:39'), F, on);
    expect(next).toBe('at_risk');
    expect(alert).toEqual({
      kind: 'connection',
      dedupeKey: `connection:1:ok>at_risk@${t('17:39')}|${t('17:42')}`,
      title: 'Your change at Reading',
      body: 'Tight change: 3 min for the 17:42 to Bristol Temple Meads from platform 4 (5 needed).',
      collapseId: 'trip1:connection:1',
      timeSensitive: true,
    });
  });

  it('alerts when missed, with the next train that works', () => {
    const alternatives = [{ scheduledDeparture: t('18:12'), expectedDeparture: t('18:15'), scheduledArrival: t('19:20') }];
    const { alert } = planConnectionAlert('at_risk', at('17:50'), F, { ...on, alternatives });
    expect(alert?.body).toBe(
      "You'll miss the 17:42 to Bristol Temple Meads: you're due at 17:50 and it leaves at 17:42. Next train: the 18:12 (expected 18:15), arriving 19:20.",
    );
    const cancelled = planConnectionAlert('ok', connect(into(), onward({ cancelled: true })), F, on).alert;
    expect(cancelled?.body).toBe('The 17:42 to Bristol Temple Meads is cancelled.');
    const mine = planConnectionAlert('tight', connect(into({ state: 'cancelled' }), onward()), F, on).alert;
    expect(mine?.body).toBe('This train no longer gets to Reading.');
  });

  it("doesn't alert for ok and tight, or for wobbles once at risk has been told", () => {
    expect(planConnectionAlert('ok', at('17:36'), F, on)).toEqual({ alert: null, next: 'tight' });
    expect(planConnectionAlert('tight', at('17:30'), F, on)).toEqual({ alert: null, next: 'ok' });
    // at_risk told, now tight: stays at_risk, so going back to at_risk is not news.
    expect(planConnectionAlert('at_risk', at('17:36'), F, on)).toEqual({ alert: null, next: 'at_risk' });
    expect(planConnectionAlert('missed', at('17:40'), F, on)).toEqual({ alert: null, next: 'missed' });
  });

  it('says when it is back on', () => {
    const { alert, next } = planConnectionAlert('at_risk', at('17:30'), F, on);
    expect(next).toBe('ok');
    expect(alert).toMatchObject({ body: 'Back on: 12 min to change for the 17:42 to Bristol Temple Meads from platform 4.', timeSensitive: false });
  });

  it('keeps track but sends nothing when turned off or settled', () => {
    expect(planConnectionAlert('ok', at('17:50'), F, { enabled: false, settled: false })).toEqual({ alert: null, next: 'missed' });
    expect(planConnectionAlert('ok', at('17:50'), F, { enabled: true, settled: true })).toEqual({ alert: null, next: 'missed' });
  });
});
