import type { DarwinLocation, Forecast } from '../darwin/parse.ts';

/**
 * A Darwin run's locations with their times resolved. Pure.
 *
 * Darwin times are clock-only ("HH:MM", "HH:MM:SS") in UK local time. They are
 * resolved to minutes after midnight of the run date: planned times to the
 * occurrence nearest a reference time from the timetable, and estimates and
 * actuals to the occurrence nearest their own planned time. That copes with
 * trains running past midnight and with lateness either side of it.
 */

export const clockMinutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** The occurrence of a clock time (minutes after midnight) nearest `ref`, in minutes after midnight of the run date. */
export function nearest(clock: number, ref: number) {
  let best = clock;
  for (const c of [clock - 1440, clock + 1440, clock + 2880]) if (Math.abs(c - ref) < Math.abs(best - ref)) best = c;
  return best;
}

/** Minutes after midnight of `runDate` for an ISO date-time from this API (UK local wall clock in the string). */
export function minutesOnRun(iso: string, runDate: string) {
  const days = Math.round((Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) - Date.parse(`${runDate}T00:00:00Z`)) / 86_400_000);
  return days * 1440 + clockMinutes(iso.slice(11, 16));
}

export interface ResolvedTime {
  planned: number | null;
  expected: number | null;
  actual: number | null;
  delayed: boolean;
}

export interface Resolved {
  loc: DarwinLocation;
  crs: string | null;
  index: number;
  /** Order key: planned time (minutes after midnight of the run date). */
  at: number;
  arr: ResolvedTime;
  dep: ResolvedTime;
  pass: ResolvedTime;
}

export const hasActual = (r: Resolved) => r.arr.actual !== null || r.dep.actual !== null || r.pass.actual !== null;

/** A Darwin run's locations, times resolved and in running order. */
export class DarwinRun {
  readonly locations: Resolved[];
  /** Index of the last location with any actual time (-1 if none). */
  readonly lastActual: number;

  constructor(locations: DarwinLocation[], ref: number, crsOf: (tpl: string) => string | null) {
    const resolveTime = (plannedClock: string | undefined, f: Forecast | null | undefined, anchor: number): ResolvedTime => {
      const planned = plannedClock ? nearest(clockMinutes(plannedClock), anchor) : null;
      const base = planned ?? anchor;
      return {
        planned,
        expected: f?.et ? nearest(clockMinutes(f.et), base) : null,
        actual: f?.at ? nearest(clockMinutes(f.at), base) : null,
        delayed: f?.delayed ?? false,
      };
    };
    const resolved = locations.map((loc) => {
      const clock = loc.wta ?? loc.wtp ?? loc.wtd ?? loc.pta ?? loc.ptd;
      const at = clock ? nearest(clockMinutes(clock), ref) : ref;
      return {
        loc,
        crs: crsOf(loc.tpl),
        index: 0,
        at,
        arr: resolveTime(loc.pta ?? loc.wta, loc.arr, at),
        dep: resolveTime(loc.ptd ?? loc.wtd, loc.dep, at),
        pass: resolveTime(loc.wtp, loc.pass, at),
      };
    });
    // Seconds in working times ("HH:MM:30") order arrivals before departures within a minute.
    const fine = (r: Resolved) => r.loc.wta ?? r.loc.wtp ?? r.loc.wtd ?? '';
    resolved.sort((a, b) => a.at - b.at || fine(a).localeCompare(fine(b)));
    resolved.forEach((r, i) => (r.index = i));
    this.locations = resolved;
    this.lastActual = resolved.reduce((last, r) => (hasActual(r) ? r.index : last), -1);
  }

  /** The location for a station call: same CRS and the same public times, else the nearest planned time. */
  match(crs: string, arrClock: string | null, depClock: string | null, ref: number): Resolved | null {
    const candidates = this.locations.filter((r) => r.crs === crs);
    const exact = candidates.find((r) => (depClock && r.loc.ptd === depClock) || (arrClock && r.loc.pta === arrClock));
    if (exact) return exact;
    let best: Resolved | null = null;
    for (const r of candidates) if (Math.abs(r.at - ref) <= 60 && (!best || Math.abs(r.at - ref) < Math.abs(best.at - ref))) best = r;
    return best;
  }

  /** Whether the train has left (or passed) this location: an actual time there or anywhere later. */
  leftFrom(r: Resolved) {
    return r.dep.actual !== null || r.pass.actual !== null || r.index < this.lastActual;
  }
}
