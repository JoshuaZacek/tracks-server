export interface RoutePoint {
  lat: number;
  lon: number;
  leg: number;
  f: number;
}
import type { Timing } from '../ingest/schedule/parse.ts';

/**
 * The stations a train passes without stopping, as points along each leg
 * between its calling points, so the map follows the railway instead of a
 * straight line. Each point's `f` is how far along its leg the train is when it
 * passes, by working times: the same measure positions use, so a train placed
 * at fraction f sits on this line.
 *
 * Legs are numbered by their starting calling point, counting the public calls
 * whose TIPLOC has a CRS (exactly the train's `callingPoints`).
 */
export function routePoints(
  timings: Timing[],
  crsOf: (tiploc: string) => string | null,
  coordsOf: (crs: string) => { lat: number; lon: number } | null,
): RoutePoint[] {
  const time = (t: Timing, prefer: 'arr' | 'dep' | 'pass') => {
    const [, arr, dep, pass] = t;
    return prefer === 'arr' ? (arr ?? pass ?? dep) : prefer === 'dep' ? (dep ?? pass ?? arr) : (pass ?? dep ?? arr);
  };
  const calls = timings.flatMap((t, i) => (t[4] === 1 && crsOf(t[0]) ? [i] : []));
  const points: RoutePoint[] = [];

  for (let leg = 0; leg < calls.length - 1; leg++) {
    const a = calls[leg]!;
    const b = calls[leg + 1]!;
    const from = timings[a]!;
    const to = timings[b]!;
    const start = time(from, 'dep');
    const end = time(to, 'arr');
    if (start === null || end === null || end <= start) continue;
    const ends = new Set([crsOf(from[0]), crsOf(to[0])]);
    let previous: string | null = null;
    for (let j = a + 1; j < b; j++) {
      const point = timings[j]!;
      const crs = crsOf(point[0]);
      // Not a station, the leg's own stations (secondary TIPLOCs), or the same station again.
      if (!crs || ends.has(crs) || crs === previous) continue;
      const coords = coordsOf(crs);
      const wt = time(point, 'pass');
      if (!coords || wt === null) continue;
      points.push({ lat: coords.lat, lon: coords.lon, leg, f: Math.min(0.999, Math.max(0.001, (wt - start) / (end - start))) });
      previous = crs;
    }
  }
  return points;
}
