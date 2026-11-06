import { addDays, dayIndex, hhmmToMinutes, ukToday, ukWallClock } from '../../time.ts';

/**
 * Which dates a regular journey (template) needs a journey for, and which
 * timetabled departure to use. Pure, so the rules are unit-tested on their own;
 * the database work is in ./service.ts.
 */

/** How far from the template's time a departure may be and still count as "the same train". */
export const MATCH_WINDOW_MIN = 30;

/** ISO weekdays (1 = Monday … 7 = Sunday) -> bitmask (bit 0 = Monday … bit 6 = Sunday). */
export const daysToMask = (days: readonly number[]) => days.reduce((mask, d) => mask | (1 << (d - 1)), 0);

/** Bitmask -> ISO weekdays, sorted. */
export const maskToDays = (mask: number) => [1, 2, 3, 4, 5, 6, 7].filter((d) => mask & (1 << (d - 1)));

export const runsOn = (mask: number, date: string) => (mask & (1 << (dayIndex(date) - 1))) !== 0;

export interface TemplateTiming {
  /** Bitmask of weekdays. */
  days: number;
  /** "HH:MM", UK local. */
  departTime: string;
  /** The latest date a journey was made for (or counted as made). */
  lastCreatedDate: string | null;
}

/**
 * The dates to make a journey for now: today and tomorrow (UK), on the template's
 * weekdays, after the last one made, and for today only while its time is still ahead.
 */
export function datesToCreate(t: TemplateTiming, now: Date): string[] {
  const today = ukToday(now);
  return [today, addDays(today, 1)].filter(
    (date) =>
      runsOn(t.days, date) &&
      (t.lastCreatedDate === null || date > t.lastCreatedDate) &&
      (date !== today || ukWallClock(date, hhmmToMinutes(t.departTime)).getTime() > now.getTime()),
  );
}

export interface Candidate {
  trainUid: string;
  /** ISO, UK offset. */
  scheduledDeparture: string;
}

/**
 * The departure nearest the template's time on `date`, within MATCH_WINDOW_MIN
 * either side. The train last matched wins when it still runs in that window
 * (a small retiming keeps the same train); ties go to the earlier train.
 */
export function pickDeparture<C extends Candidate>(candidates: readonly C[], date: string, departTime: string, preferUid: string | null): C | null {
  const target = ukWallClock(date, hhmmToMinutes(departTime)).getTime();
  const gap = (c: C) => Math.abs(Date.parse(c.scheduledDeparture) - target);
  const inWindow = candidates.filter((c) => gap(c) <= MATCH_WINDOW_MIN * 60_000);
  const preferred = preferUid ? inWindow.find((c) => c.trainUid === preferUid) : undefined;
  if (preferred) return preferred;
  let best: C | null = null;
  for (const c of inWindow) {
    if (!best || gap(c) < gap(best) || (gap(c) === gap(best) && Date.parse(c.scheduledDeparture) < Date.parse(best.scheduledDeparture))) best = c;
  }
  return best;
}

/** Where a departures search for the window starts: MATCH_WINDOW_MIN before the template's time ("HH:MM", not before midnight). */
export function searchFrom(departTime: string): string {
  const m = Math.max(0, hhmmToMinutes(departTime) - MATCH_WINDOW_MIN);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * What to do when no train matched `date`: the first time, keep the date open
 * so the next run tries it again; the second time (the problem is already for
 * this date), give it up and move on to later dates.
 */
export const giveUpOn = (problemDate: string | null, date: string) => problemDate === date;
