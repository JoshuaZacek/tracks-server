import { assert, test } from 'vitest';
import type { Timing } from '../ingest/schedule/parse.ts';
import { routePoints } from './route.ts';

const s = (hhmm: string) => Number(hhmm.slice(0, 2)) * 3600 + Number(hhmm.slice(3, 5)) * 60;

// KGX (call) -> FNPK (station passed) -> HLWYSJ (junction) -> HITCHIN (passed) -> PBRO (call) -> GRANTHM (call)
const timings: Timing[] = [
  ['KNGX', null, s('20:03'), null, 1],
  ['FNPK', null, null, s('20:07'), 0],
  ['HLWYSJ', null, null, s('20:10'), 0],
  ['HITCHIN', null, null, s('20:24'), 0],
  ['HITCHN2', null, null, s('20:25'), 0], // a second TIPLOC for the same station
  ['PBRO', s('20:49'), s('20:50'), null, 1],
  ['XNOCRS', null, null, s('21:00'), 0],
  ['GRANTHM', s('21:10'), null, null, 1],
];
const CRS: Record<string, string> = { KNGX: 'KGX', FNPK: 'FPK', HITCHIN: 'HIT', HITCHN2: 'HIT', PBRO: 'PBO', GRANTHM: 'GRA' };
const COORDS: Record<string, { lat: number; lon: number }> = { FPK: { lat: 51.56, lon: -0.1 }, HIT: { lat: 51.95, lon: -0.26 } };

test('stations passed become points on their leg, by working time', () => {
  const route = routePoints(timings, (t) => CRS[t] ?? null, (c) => COORDS[c] ?? null);
  assert.deepStrictEqual(
    route.map((p) => [p.leg, Number(p.f.toFixed(3)), p.lat]),
    [
      [0, Number((4 / 46).toFixed(3)), 51.56], // Finsbury Park, 4 of 46 minutes
      [0, Number((21 / 46).toFixed(3)), 51.95], // Hitchin once, despite two TIPLOCs
    ],
  );
});

test('junctions, stations without coordinates and calling points are not route points', () => {
  const route = routePoints(timings, (t) => CRS[t] ?? null, () => null);
  assert.equal(route.length, 0);
});
