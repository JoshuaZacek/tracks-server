import { describe, expect, it } from 'vitest';
import type { DarwinLocation } from '../darwin/parse.ts';
import { computeJourneyStatus, type ComputeContext, type DarwinRunData, type JourneyInput } from './compute.ts';
import { loading, loadingLevel } from './loading.ts';

const at: DarwinLocation = { tpl: 'KNGX', ptd: '17:00', wtd: '17:00' };
const coaches = (...pcts: number[]) => pcts.map((percentage, i) => ({ number: `A${i + 1}`, percentage }));

describe('loading', () => {
  it('is null without loading data', () => {
    expect(loading(at, {})).toBeNull();
    expect(loading({ ...at, loading: null, coachLoading: null }, {})).toBeNull();
    expect(loading(undefined, {})).toBeNull();
  });

  it("uses the train's loading percentage, with no coaches", () => {
    expect(loading({ ...at, loading: 45 }, {})).toEqual({ percentage: 45, level: 'moderate', coaches: null, quietestCoaches: [] });
  });

  it('gives coaches front to rear with their class, the two quietest (ties front first), and the train figure when there is one', () => {
    const loc = { ...at, loading: 50, coachLoading: { fid: 'F1', coaches: coaches(60, 20, 35, 20, 90) } };
    const formations = { F1: [{ number: 'A1', class: 'First' }, { number: 'A2', class: 'Standard' }, { number: 'A3', class: null }] };
    expect(loading(loc, formations)).toEqual({
      percentage: 50,
      level: 'moderate',
      coaches: [
        { number: 'A1', percentage: 60, class: 'First' },
        { number: 'A2', percentage: 20, class: 'Standard' },
        { number: 'A3', percentage: 35, class: null },
        { number: 'A4', percentage: 20, class: null },
        { number: 'A5', percentage: 90, class: null },
      ],
      quietestCoaches: ['A2', 'A4'],
    });
  });

  it('falls back to the mean of the coaches (rounded)', () => {
    expect(loading({ ...at, coachLoading: { fid: 'F1', coaches: coaches(10, 20, 31) } }, {})).toMatchObject({ percentage: 20, level: 'quiet', quietestCoaches: ['A1', 'A2'] });
    expect(loading({ ...at, coachLoading: { fid: 'F1', coaches: coaches(80) } }, {})).toMatchObject({ percentage: 80, quietestCoaches: ['A1'] });
  });

  it.each([
    [0, 'quiet'],
    [29, 'quiet'],
    [30, 'moderate'],
    [59, 'moderate'],
    [60, 'busy'],
    [84, 'busy'],
    [85, 'very_busy'],
    [100, 'very_busy'],
  ] as const)('%i %% is %s', (pct, level) => {
    expect(loadingLevel(pct)).toBe(level);
  });

  it('is set on the live status from my boarding station only', () => {
    const j: JourneyInput = {
      runDate: '2026-11-03',
      callingPoints: [
        { crs: 'KGX', name: 'London Kings Cross', lat: null, lon: null, scheduledArrival: null, scheduledDeparture: '2026-11-03T17:00:00+00:00', bookedPlatform: null, live: null },
        { crs: 'YRK', name: 'York', lat: null, lon: null, scheduledArrival: '2026-11-03T19:00:00+00:00', scheduledDeparture: null, bookedPlatform: null, live: null },
      ],
      fromIndex: 0,
      toIndex: 1,
    };
    const data: DarwinRunData = {
      service: { rid: 'r', uid: 'A00001', ssd: '2026-11-03', toc: 'GR', trainId: '1S25', cancelReason: null, lateReason: null, deactivated: false },
      locations: [
        { ...at, loading: 88 },
        { tpl: 'YORK', pta: '19:00', wta: '19:00', loading: 12 },
      ],
    };
    const ctx: ComputeContext = {
      now: new Date('2026-11-03T16:30:00Z'),
      darwinEnabled: true,
      feedHealthy: true,
      crsOf: (t) => ({ KNGX: 'KGX', YORK: 'YRK' })[t] ?? null,
      nameOf: (t) => t,
      station: () => null,
    };
    expect(computeJourneyStatus(j, data, ctx).loading).toEqual({ percentage: 88, level: 'very_busy', coaches: null, quietestCoaches: [] });
    const none = computeJourneyStatus(j, null, ctx);
    expect(none).toMatchObject({ divides: null, loading: null });
  });
});
