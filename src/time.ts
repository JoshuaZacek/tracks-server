/**
 * Instants as ISO 8601 in UK local time with offset and no fractional seconds,
 * e.g. 2026-11-03T17:30:00+00:00 or 2026-07-01T08:05:00+01:00.
 */
const ukParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export function toUkIso(date: Date): string {
  const p = Object.fromEntries(ukParts.formatToParts(date).map((x) => [x.type, x.value]));
  const local = `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
  // Offset = UK wall clock minus UTC, in whole minutes.
  const wallMs = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
  const offsetMin = Math.round((wallMs - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
  const sign = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  return `${local}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** UK offset from UTC, in minutes, at an instant. */
function ukOffsetMinutes(at: Date): number {
  const p = Object.fromEntries(ukParts.formatToParts(at).map((x) => [x.type, x.value]));
  const wallMs = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
  return Math.round((wallMs - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/**
 * The instant at `minutes` after midnight (UK wall clock) on `date`. Minutes may
 * exceed 1440 for calls after midnight. Timetable times are wall-clock times, so
 * on the night the clocks change the offset is taken at that wall time; in the
 * repeated autumn hour the first (BST) occurrence wins.
 */
export function ukWallClock(date: string, minutes: number): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const asUtc = Date.UTC(y, m - 1, d, 0, minutes);
  // The offsets in force a few hours either side cover both sides of any clock change.
  const offsets = [...new Set([-3, 3].map((h) => ukOffsetMinutes(new Date(asUtc + h * 3_600_000))))];
  const consistent = offsets.map((o) => asUtc - o * 60_000).filter((t, i) => ukOffsetMinutes(new Date(t)) === offsets[i]);
  // Repeated hour: two consistent instants, take the earlier. Skipped hour (spring): none, so use the
  // offset from before the change, which lands an hour later on the clock, as the railway does.
  return new Date(consistent.length ? Math.min(...consistent) : asUtc - offsets[0]! * 60_000);
}

/** ISO date-time (UK offset) for `minutes` after midnight on `date`. */
export const ukIsoAt = (date: string, minutes: number) => toUkIso(ukWallClock(date, minutes));

/** Today's date in the UK. */
export const ukToday = (now = new Date()) => toUkIso(now).slice(0, 10);

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 1 = Monday … 7 = Sunday: the position in a schedule's `days_runs`. */
export const dayIndex = (date: string) => ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;

/** "HH:MM" -> minutes after midnight. */
export const hhmmToMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
