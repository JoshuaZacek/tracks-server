import { describe, expect, it } from 'vitest';
import type { DarwinLocation } from '../darwin/parse.ts';
import { computeJourneyStatus, type ComputeContext, type DarwinRunData, type JourneyInput } from '../live/compute.ts';
import { DELAY_REPAY_RULES, DR15_BANDS, DR30_BANDS, claimOf, eligibility, estimatePence, journeyOutcome } from './delayRepay.ts';
import { operatorName } from './operators.ts';

describe('the operator rules table', () => {
  it('has the gov.uk bands: 25 / 50 / 100 % of a single, 100 % of a return from 2 hours', () => {
    expect(DR15_BANDS).toEqual([
      { minMinutes: 15, maxMinutes: 29, singlePercent: 25, returnPercent: 12.5 },
      { minMinutes: 30, maxMinutes: 59, singlePercent: 50, returnPercent: 25 },
      { minMinutes: 60, maxMinutes: 119, singlePercent: 100, returnPercent: 50 },
      { minMinutes: 120, maxMinutes: null, singlePercent: 100, returnPercent: 100 },
    ]);
    expect(DR30_BANDS).toEqual(DR15_BANDS.slice(1));
  });

  it('puts the 13 DR15 operators (gov.uk, Feb 2026) on Delay Repay 15, LNER and CrossCountry on 30', () => {
    const dr15 = ['TL', 'GN', 'SN', 'GX', 'EM', 'LM', 'SE', 'LE', 'VT', 'CC', 'AW', 'CH', 'GW', 'NT', 'SW', 'IL', 'TP'];
    for (const toc of dr15) expect(DELAY_REPAY_RULES[toc]?.scheme, toc).toBe('DR15');
    for (const toc of ['GR', 'XC']) expect(DELAY_REPAY_RULES[toc]?.scheme, toc).toBe('DR30');
  });

  it('gives every operator an https claim URL and a known name, and says when it was checked', () => {
    for (const [toc, rule] of Object.entries(DELAY_REPAY_RULES)) {
      expect(new URL(rule.claimUrl).protocol, toc).toBe('https:');
      expect(operatorName(toc), toc).not.toBe(toc);
      expect(rule.checkedOn === null || /^\d{4}-\d{2}-\d{2}$/.test(rule.checkedOn), toc).toBe(true);
    }
  });

  it("leaves out operators with their own schemes or that aren't National Rail", () => {
    for (const toc of ['HX', 'ME', 'XR', 'ES', 'TW', 'NY', 'WR']) expect(DELAY_REPAY_RULES[toc], toc).toBeUndefined();
  });
});

describe('eligibility', () => {
  it('finds the band for a delay under Delay Repay 15', () => {
    expect(eligibility(14, false, 'SW')).toBeNull();
    expect(eligibility(15, false, 'SW')).toMatchObject({ scheme: 'DR15', delayMinutes: 15, cancelled: false, band: { minMinutes: 15, singlePercent: 25 } });
    expect(eligibility(29, false, 'SW')!.band!.minMinutes).toBe(15);
    expect(eligibility(30, false, 'SW')!.band!.minMinutes).toBe(30);
    expect(eligibility(119, false, 'SW')!.band!.singlePercent).toBe(100);
    expect(eligibility(240, false, 'SW')!.band).toEqual({ minMinutes: 120, maxMinutes: null, singlePercent: 100, returnPercent: 100 });
  });

  it('starts at 30 minutes under Delay Repay 30', () => {
    expect(eligibility(29, false, 'GR')).toBeNull();
    expect(eligibility(30, false, 'GR')).toMatchObject({ scheme: 'DR30', minimumMinutes: 30, band: { minMinutes: 30, singlePercent: 50 } });
  });

  it('counts a cancellation whatever the delay, with no band (it depends on the train taken instead)', () => {
    expect(eligibility(null, true, 'GR')).toMatchObject({ cancelled: true, delayMinutes: null, band: null });
    expect(eligibility(3, true, 'SW')).toMatchObject({ cancelled: true, band: null });
  });

  it("is nothing for an early or on-time train, an unknown delay, or an operator without rules", () => {
    expect(eligibility(-2, false, 'SW')).toBeNull();
    expect(eligibility(null, false, 'SW')).toBeNull();
    expect(eligibility(45, false, 'HX')).toBeNull();
    expect(eligibility(45, false, '')).toBeNull();
  });

  it('carries the claim URL and operator', () => {
    const e = eligibility(45, false, 'GW')!;
    expect(e.toc).toBe('GW');
    expect(e.claimUrl).toBe(DELAY_REPAY_RULES.GW!.claimUrl);
  });
});

describe('estimatePence', () => {
  const band = DR15_BANDS[1]!; // 30–59: 50 % of a single, 25 % of a return
  it('is the band percentage of the fare, rounded down to the penny', () => {
    expect(estimatePence(band, 1999, 'single')).toBe(999);
    expect(estimatePence(band, 4000, 'return')).toBe(1000);
    expect(estimatePence(DR15_BANDS[3]!, 4000, 'return')).toBe(4000);
  });
  it('is null without a band, a price or a ticket type', () => {
    expect(estimatePence(null, 4000, 'single')).toBeNull();
    expect(estimatePence(band, null, 'single')).toBeNull();
    expect(estimatePence(band, 4000, null)).toBeNull();
  });
});

// ---- from a live status: replayed through compute.ts -----------------------------------

const CRS: Record<string, string> = { KNGX: 'KGX', PBRO: 'PBO', YORK: 'YRK', EDINBUR: 'EDB' };
const NAMES: Record<string, string> = { KGX: 'London Kings Cross', PBO: 'Peterborough', YRK: 'York', EDB: 'Edinburgh' };
const ctx = (now: string): ComputeContext => ({
  now: new Date(now),
  darwinEnabled: true,
  feedHealthy: true,
  crsOf: (t) => CRS[t] ?? null,
  nameOf: (t) => NAMES[CRS[t] ?? ''] ?? t,
  station: (crs) => (NAMES[crs] ? { name: NAMES[crs]!, lat: null, lon: null } : null),
});
const cp = (crs: string, arr: string | null, dep: string | null) => ({
  crs,
  name: NAMES[crs]!,
  lat: null,
  lon: null,
  scheduledArrival: arr && `2026-11-03T${arr}:00+00:00`,
  scheduledDeparture: dep && `2026-11-03T${dep}:00+00:00`,
  bookedPlatform: null,
  live: null,
});
/** 1S25 KGX 17:00 → PBO → YRK 19:00 → EDB (LNER); my journey is KGX → YRK. */
const journey: JourneyInput = {
  runDate: '2026-11-03',
  callingPoints: [cp('KGX', null, '17:00'), cp('PBO', '17:45', '17:47'), cp('YRK', '19:00', '19:03'), cp('EDB', '21:30', null)],
  fromIndex: 0,
  toIndex: 2,
};
const planned: DarwinLocation[] = [
  { tpl: 'KNGX', ptd: '17:00', wtd: '17:00' },
  { tpl: 'PBRO', pta: '17:45', ptd: '17:47', wta: '17:45', wtd: '17:47' },
  { tpl: 'YORK', pta: '19:00', ptd: '19:03', wta: '19:00', wtd: '19:03' },
  { tpl: 'EDINBUR', pta: '21:30', wta: '21:30' },
];
const darwin = (over: Record<string, Partial<DarwinLocation>>): DarwinRunData => ({
  service: { rid: '202611031234567', uid: 'A00001', ssd: '2026-11-03', toc: 'GR', trainId: '1S25', cancelReason: null, lateReason: null, deactivated: false },
  locations: planned.map((l) => ({ ...l, ...over[l.tpl] })),
});
const facts = { toc: 'GR', scheduledArrival: '2026-11-03T19:00:00+00:00' };

describe('journeyOutcome and claimOf (a late journey replayed through compute.ts)', () => {
  const late = darwin({ KNGX: { dep: { at: '17:31' } }, PBRO: { arr: { at: '18:15' }, dep: { at: '18:17' } }, YORK: { arr: { at: '19:34' } } });

  it('gives a claim card once a 34-minute late LNER train has arrived', () => {
    const now = '2026-11-03T19:40:00Z';
    const s = computeJourneyStatus(journey, late, ctx(now));
    expect(s.state).toBe('arrived');
    expect(journeyOutcome(s, facts.scheduledArrival, new Date(now))).toEqual({ delayMinutes: 34, cancelled: false, actualArrival: '2026-11-03T19:34:00+00:00' });
    expect(claimOf(s, facts, new Date(now))).toMatchObject({
      toc: 'GR',
      scheme: 'DR30',
      delayMinutes: 34,
      cancelled: false,
      band: { minMinutes: 30, singlePercent: 50 },
      actualArrival: '2026-11-03T19:34:00+00:00',
    });
  });

  it('has nothing to claim while the train is still on its way, even running late', () => {
    const now = '2026-11-03T18:20:00Z';
    const s = computeJourneyStatus(journey, darwin({ KNGX: { dep: { at: '17:31' } }, YORK: { arr: { et: '19:34' } } }), ctx(now));
    expect(s.state).toBe('departed');
    expect(journeyOutcome(s, facts.scheduledArrival, new Date(now))).toBeNull();
    expect(claimOf(s, facts, new Date(now))).toBeNull();
  });

  it('has nothing to claim for a train under the threshold', () => {
    const now = '2026-11-03T19:40:00Z';
    const s = computeJourneyStatus(journey, darwin({ KNGX: { dep: { at: '17:12' } }, YORK: { arr: { at: '19:20' } } }), ctx(now));
    expect(journeyOutcome(s, facts.scheduledArrival, new Date(now))).toMatchObject({ delayMinutes: 20 });
    expect(claimOf(s, facts, new Date(now))).toBeNull();
    // The same 20 minutes on a Delay Repay 15 operator would qualify.
    expect(claimOf(s, { ...facts, toc: 'SW' }, new Date(now))).toMatchObject({ band: { minMinutes: 15 } });
  });

  it('counts a cancellation once the scheduled arrival has gone by', () => {
    const cancelled = darwin({ KNGX: { can: true }, PBRO: { can: true }, YORK: { can: true }, EDINBUR: { can: true } });
    const before = computeJourneyStatus(journey, cancelled, ctx('2026-11-03T16:40:00Z'));
    expect(before.state).toBe('cancelled');
    expect(claimOf(before, facts, new Date('2026-11-03T18:00:00Z'))).toBeNull();
    expect(claimOf(before, facts, new Date('2026-11-03T19:00:00Z'))).toMatchObject({ cancelled: true, band: null, delayMinutes: null, actualArrival: null });
  });

  it('counts my destination dropped from the route after leaving as a cancellation', () => {
    const now = '2026-11-03T19:05:00Z';
    const s = computeJourneyStatus(journey, darwin({ KNGX: { dep: { at: '17:00' } }, PBRO: { arr: { at: '17:45' } }, YORK: { can: true } }), ctx(now));
    expect(s.state).toBe('departed');
    expect(s.message).toBe('No longer calling at York');
    expect(claimOf(s, facts, new Date(now))).toMatchObject({ cancelled: true, band: null });
  });

  it('is nothing for a journey without live data', () => {
    expect(journeyOutcome(null, facts.scheduledArrival, new Date('2026-11-04T00:00:00Z'))).toBeNull();
    expect(claimOf(null, facts, new Date('2026-11-04T00:00:00Z'))).toBeNull();
  });
});
