import { describe, expect, it } from 'vitest';
import type { DarwinLocation } from '../darwin/parse.ts';
import { callingPointsLive, computeJourneyStatus, departureLive, pollSeconds, type ComputeContext, type DarwinRunData, type JourneyInput } from './compute.ts';

const CRS: Record<string, string> = { KNGX: 'KGX', FNPK: 'FPK', PBRO: 'PBO', YORK: 'YRK', EDINBUR: 'EDB' };
const NAMES: Record<string, string> = { KGX: 'London Kings Cross', FPK: 'Finsbury Park', PBO: 'Peterborough', YRK: 'York', EDB: 'Edinburgh' };
const COORDS: Record<string, [number, number]> = { KGX: [51.53, -0.12], FPK: [51.56, -0.11], PBO: [52.57, -0.25], YRK: [53.96, -1.09] };

const ctx = (now: string, over: Partial<ComputeContext> = {}): ComputeContext => ({
  now: new Date(now),
  darwinEnabled: true,
  feedHealthy: true,
  crsOf: (t) => CRS[t] ?? null,
  nameOf: (t) => (CRS[t] ? NAMES[CRS[t]!]! : t === 'HLWYSJ' ? 'Holloway South Jn' : t),
  station: (crs) => (NAMES[crs] ? { name: NAMES[crs]!, lat: COORDS[crs]?.[0] ?? null, lon: COORDS[crs]?.[1] ?? null } : null),
  ...over,
});

const cp = (crs: string, arr: string | null, dep: string | null, day = '2026-11-03') => ({
  crs,
  name: NAMES[crs]!,
  lat: null,
  lon: null,
  scheduledArrival: arr && `${day}T${arr}:00+00:00`,
  scheduledDeparture: dep && `${day}T${dep}:00+00:00`,
  bookedPlatform: null,
  live: null,
});

/** 1S25 KGX 17:00 → PBO → YRK 19:00 → EDB; my journey is KGX → YRK. */
const journey: JourneyInput = {
  runDate: '2026-11-03',
  callingPoints: [cp('KGX', null, '17:00'), cp('PBO', '17:45', '17:47'), cp('YRK', '19:00', '19:03'), cp('EDB', '21:30', null)],
  fromIndex: 0,
  toIndex: 2,
};

const planned: DarwinLocation[] = [
  { tpl: 'KNGX', ptd: '17:00', wtd: '17:00' },
  { tpl: 'FNPK', wtp: '17:04' },
  { tpl: 'HLWYSJ', wtp: '17:07' },
  { tpl: 'PBRO', pta: '17:45', ptd: '17:47', wta: '17:45', wtd: '17:47' },
  { tpl: 'YORK', pta: '19:00', ptd: '19:03', wta: '19:00', wtd: '19:03' },
  { tpl: 'EDINBUR', pta: '21:30', wta: '21:30' },
];

/** Darwin data: the planned run with per-location overrides. */
function darwin(over: Record<string, Partial<DarwinLocation>> = {}, service: Partial<DarwinRunData['service']> = {}): DarwinRunData {
  return {
    service: { rid: '202611031234567', uid: 'A00001', ssd: '2026-11-03', toc: 'GR', trainId: '1S25', cancelReason: null, lateReason: null, deactivated: false, ...service },
    locations: planned.map((l) => ({ ...l, ...over[l.tpl] })),
  };
}

describe('computeJourneyStatus', () => {
  it('is scheduled with no Darwin data, and not_found 30 min after departure while the feed is healthy', () => {
    expect(computeJourneyStatus(journey, null, ctx('2026-11-03T12:00:00Z')).state).toBe('scheduled');
    expect(computeJourneyStatus(journey, null, ctx('2026-11-03T17:31:00Z')).state).toBe('not_found');
    expect(computeJourneyStatus(journey, null, ctx('2026-11-03T17:31:00Z', { feedHealthy: false })).state).toBe('scheduled');
    expect(computeJourneyStatus(journey, null, ctx('2026-11-03T17:31:00Z', { darwinEnabled: false })).state).toBe('scheduled');
  });

  it('is live before departure: expected time, delay and a confirmed platform', () => {
    const s = computeJourneyStatus(
      journey,
      darwin({ KNGX: { dep: { et: '17:05' }, plat: { number: '7', confirmed: true, suppressed: false } }, YORK: { arr: { et: '19:04' } } }),
      ctx('2026-11-03T16:40:00Z'),
    );
    expect(s.state).toBe('live');
    expect(s.service).toMatchObject({
      rid: '202611031234567',
      scheduledDeparture: '2026-11-03T17:00:00+00:00',
      expectedDeparture: '2026-11-03T17:05:00+00:00',
      actualDeparture: null,
      delayMinutes: 5,
      platform: { number: '7', source: 'live', confirmed: true },
      isCancelled: false,
    });
    expect(s.progress!.stops.map((x) => x.crs)).toEqual(['KGX', 'PBO', 'YRK']);
    expect(s.progress!.stops[2]).toMatchObject({ scheduled: '2026-11-03T19:00:00+00:00', expected: '2026-11-03T19:04:00+00:00', delayMinutes: 4 });
    expect(s.progress).toMatchObject({ lastPassedIndex: -1, nextIndex: 0, arrived: false });
    expect(s.position).toBeNull();
  });

  it('never shows a platform Darwin suppresses', () => {
    const s = computeJourneyStatus(journey, darwin({ KNGX: { plat: { number: '7', confirmed: false, suppressed: true } } }), ctx('2026-11-03T16:40:00Z'));
    expect(s.service!.platform).toBeNull();
  });

  it('is departed with position anchors between a passing point and the next one', () => {
    const s = computeJourneyStatus(
      journey,
      darwin({
        KNGX: { dep: { at: '17:02' } },
        FNPK: { pass: { at: '17:06' } },
        HLWYSJ: { pass: { et: '17:09' } },
        PBRO: { arr: { et: '17:48' }, dep: { et: '17:49' } },
      }),
      ctx('2026-11-03T17:07:00Z'),
    );
    expect(s.state).toBe('departed');
    expect(s.service).toMatchObject({ actualDeparture: '2026-11-03T17:02:00+00:00', expectedDeparture: null, delayMinutes: 2 });
    expect(s.progress).toMatchObject({ lastPassedIndex: 0, nextIndex: 1, arrived: false });
    expect(s.position).toEqual({
      source: 'darwin',
      last: { tiploc: 'FNPK', crs: 'FPK', name: 'Finsbury Park', lat: 51.56, lon: -0.11, time: '2026-11-03T17:06:00+00:00', event: 'pass' },
      next: { tiploc: 'HLWYSJ', crs: null, name: 'Holloway South Jn', lat: null, lon: null, expectedTime: '2026-11-03T17:09:00+00:00' },
      legFrom: 'KGX',
      legTo: 'PBO',
    });
  });

  it('is arrived once the destination has an actual time', () => {
    const s = computeJourneyStatus(
      journey,
      darwin({ KNGX: { dep: { at: '17:00' } }, PBRO: { arr: { at: '17:45' }, dep: { at: '17:47' } }, YORK: { arr: { at: '19:04' } } }),
      ctx('2026-11-03T19:05:00Z'),
    );
    expect(s.state).toBe('arrived');
    expect(s.progress).toMatchObject({ lastPassedIndex: 2, nextIndex: null, arrived: true });
    expect(s.progress!.stops[2]).toMatchObject({ actual: '2026-11-03T19:04:00+00:00', passed: true, delayMinutes: 4 });
    expect(s.position).toBeNull();
  });

  it('is arrived when Darwin deactivates the run after the expected arrival without reporting it', () => {
    const data = darwin({ KNGX: { dep: { at: '17:00' } } }, { deactivated: true });
    expect(computeJourneyStatus(journey, data, ctx('2026-11-03T18:00:00Z')).state).toBe('departed');
    expect(computeJourneyStatus(journey, data, ctx('2026-11-03T19:10:00Z')).state).toBe('arrived');
  });

  it('is cancelled when cancelled at my boarding station, or at my destination before departure', () => {
    expect(computeJourneyStatus(journey, darwin({ KNGX: { can: true } }), ctx('2026-11-03T16:00:00Z')).state).toBe('cancelled');
    const s = computeJourneyStatus(journey, darwin({ YORK: { can: true } }), ctx('2026-11-03T16:00:00Z'));
    expect(s).toMatchObject({ state: 'cancelled', message: 'Cancelled', service: { isCancelled: true } });
    // Already on the move: it is still departed, but won't reach York.
    const short = computeJourneyStatus(journey, darwin({ KNGX: { dep: { at: '17:00' } }, YORK: { can: true } }), ctx('2026-11-03T17:30:00Z'));
    expect(short).toMatchObject({ state: 'departed', message: 'No longer calling at York', service: { isCancelled: true } });
  });

  it('resolves times past midnight against the run date', () => {
    const late: JourneyInput = {
      runDate: '2026-11-03',
      callingPoints: [cp('KGX', null, '23:50'), cp('PBO', '00:35', '00:37', '2026-11-04'), cp('YRK', '01:50', null, '2026-11-04')],
      fromIndex: 0,
      toIndex: 2,
    };
    const data: DarwinRunData = {
      service: darwin().service,
      locations: [
        { tpl: 'KNGX', ptd: '23:50', wtd: '23:50', dep: { at: '23:58' } },
        { tpl: 'PBRO', pta: '00:35', ptd: '00:37', wta: '00:35', wtd: '00:37', arr: { et: '00:43' } },
        { tpl: 'YORK', pta: '01:50', wta: '01:50', arr: { et: '01:57' } },
      ],
    };
    const s = computeJourneyStatus(late, data, ctx('2026-11-04T00:05:00Z'));
    expect(s.state).toBe('departed');
    expect(s.service).toMatchObject({ actualDeparture: '2026-11-03T23:58:00+00:00', delayMinutes: 8 });
    expect(s.progress!.stops[2]).toMatchObject({ expected: '2026-11-04T01:57:00+00:00', delayMinutes: 7 });
  });
});

describe('pollSeconds', () => {
  const dep = new Date('2026-11-03T17:00:00Z');
  const arr = new Date('2026-11-03T19:00:00Z');
  it.each([
    ['scheduled, 5 h out (wake at the 3 h live window)', 'scheduled', '2026-11-03T12:00:00Z', 3600],
    ['scheduled, 3 h 10 min out', 'scheduled', '2026-11-03T13:50:00Z', 600],
    ['scheduled, within 3 h', 'scheduled', '2026-11-03T15:00:00Z', 120],
    ['scheduled, after arrival', 'scheduled', '2026-11-03T19:01:00Z', null],
    ['live, 20 min out', 'live', '2026-11-03T16:40:00Z', 30],
    ['live, 2 h out', 'live', '2026-11-03T15:00:00Z', 60],
    ['departed', 'departed', '2026-11-03T17:30:00Z', 30],
    ['arrived', 'arrived', '2026-11-03T19:05:00Z', null],
    ['cancelled, before departure', 'cancelled', '2026-11-03T16:00:00Z', 300],
    ['not_found', 'not_found', '2026-11-03T18:00:00Z', null],
  ] as const)('%s', (_label, state, now, expected) => {
    expect(pollSeconds(state, dep, arr, new Date(now))).toBe(expected);
  });
});

describe('departureLive and callingPointsLive', () => {
  const data = darwin({
    KNGX: { dep: { et: '17:04' }, plat: { number: '8', confirmed: false, suppressed: false } },
    PBRO: { arr: { et: '17:50' }, dep: { et: '17:51' } },
  });
  const crsOf = (t: string) => CRS[t] ?? null;

  it('gives a departure board overlay for one station', () => {
    expect(departureLive(data, 'KGX', '2026-11-03T17:00:00+00:00', '2026-11-03', crsOf)).toEqual({
      expectedDeparture: '2026-11-03T17:04:00+00:00',
      actualDeparture: null,
      delayMinutes: 4,
      platform: { number: '8', source: 'live', confirmed: false },
      isCancelled: false,
    });
    expect(departureLive(null, 'KGX', '2026-11-03T17:00:00+00:00', '2026-11-03', crsOf)).toBeNull();
  });

  it('gives live data per calling point', () => {
    const live = callingPointsLive(data, journey.callingPoints, '2026-11-03', crsOf);
    expect(live[1]).toEqual({
      expectedArrival: '2026-11-03T17:50:00+00:00',
      expectedDeparture: '2026-11-03T17:51:00+00:00',
      actualArrival: null,
      actualDeparture: null,
      platform: null,
      isCancelled: false,
    });
    expect(live).toHaveLength(4);
  });
});
