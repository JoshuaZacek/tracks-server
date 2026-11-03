/**
 * Turns NWR Schedule records (NTROD JsonTimetableV1, one JSON object per line)
 * into rows. Pure: no database, so it can be tested on its own.
 * Field notes: docs/rdm-notes.md ("NWR Schedule").
 */

/**
 * One timing point of a passenger schedule, stored as JSON on the schedule row:
 * [tiploc, working arrival, working departure, working pass, public call (1/0)],
 * times in seconds after midnight of the run date.
 */
export type Timing = [string, number | null, number | null, number | null, 0 | 1];

export const STP_RANK: Record<string, number> = { C: 0, N: 1, O: 2, P: 3 };
const PASSENGER_STATUS = new Set(['P', '1']);
const PASSENGER_CATEGORY = new Set(['OL', 'OU', 'OO', 'OW', 'XC', 'XD', 'XI', 'XR', 'XU', 'XX', 'XZ']);

/** "HHMM" or "HHMMH" (half minute) -> minutes after midnight. */
function parseMinutes(t: string | null | undefined): number | null {
  if (!t || t.length < 4) return null;
  return Number(t.slice(0, 2)) * 60 + Number(t.slice(2, 4));
}

/** Working times: "HHMM" or "HHMMH" -> seconds after midnight (H = half a minute). */
function parseSeconds(t: string | null | undefined): number | null {
  if (!t || t.length < 4) return null;
  return Number(t.slice(0, 2)) * 3600 + Number(t.slice(2, 4)) * 60 + (t[4] === 'H' ? 30 : 0);
}

/**
 * Turns a schedule's clock times into time after midnight of the run date,
 * adding a day each time the clock wraps. `day` is one day in the unit used.
 */
function dayClock(day = 1440) {
  let offset = 0;
  let last = -Infinity;
  return (raw: number | null) => {
    if (raw === null) return null;
    let abs = raw + offset;
    // Times only go forwards, give or take half-minute rounding; a big step back (6 h+) means midnight.
    if (abs < last - day / 4) {
      offset += day;
      abs += day;
    }
    last = Math.max(last, abs);
    return abs;
  };
}

export function titleCase(name: string) {
  return name.toLowerCase().replace(/(^|[\s\-(/&'])([a-z])/g, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

/** The record type of a line without parsing it: lines start with {"<Type>":. */
export const recordType = (line: string) => line.slice(2, line.indexOf('"', 2));

export interface ParsedCall {
  tiploc: string;
  /** Minutes after midnight of the run date. */
  arr: number | null;
  dep: number | null;
  platform: string | null;
}

export interface ParsedSchedule {
  trainUid: string;
  stp: string;
  stpRank: number;
  startDate: string;
  endDate: string;
  daysRuns: string;
  isPassenger: boolean;
  headcode: string | null;
  toc: string | null;
  /** Public calls (passenger schedules only). */
  calls: ParsedCall[];
  /** Every timing point (passenger schedules only). */
  timings: Timing[];
}

/* eslint-disable @typescript-eslint/no-explicit-any -- raw feed records */
export function parseScheduleRecord(s: any): ParsedSchedule | null {
  if (s.transaction_type && s.transaction_type !== 'Create') return null;
  const seg = s.schedule_segment ?? {};
  const isPassenger = PASSENGER_STATUS.has(s.train_status) && PASSENGER_CATEGORY.has(seg.CIF_train_category);

  // Public calls (minutes) and every timing point with its working times (seconds), both
  // relative to midnight of the run date. Every time goes through the clock so wraps are seen.
  const toAbs = dayClock();
  const toAbsSec = dayClock(86400);
  const calls: ParsedCall[] = [];
  const timings: Timing[] = [];
  for (const loc of (seg.schedule_location ?? []) as any[]) {
    toAbs(parseMinutes(loc.arrival));
    const arr = toAbs(parseMinutes(loc.public_arrival));
    toAbs(parseMinutes(loc.departure));
    const dep = toAbs(parseMinutes(loc.public_departure));
    toAbs(parseMinutes(loc.pass));
    const isCall = arr !== null || dep !== null;
    if (!isPassenger) continue;
    if (isCall) calls.push({ tiploc: loc.tiploc_code, arr, dep, platform: loc.platform || null });
    const wArr = toAbsSec(parseSeconds(loc.arrival));
    const wDep = toAbsSec(parseSeconds(loc.departure));
    const wPass = toAbsSec(parseSeconds(loc.pass));
    timings.push([loc.tiploc_code, wArr, wDep, wPass, isCall ? 1 : 0]);
  }
  return {
    trainUid: s.CIF_train_uid,
    stp: s.CIF_stp_indicator,
    stpRank: STP_RANK[s.CIF_stp_indicator] ?? 3,
    startDate: s.schedule_start_date,
    endDate: s.schedule_end_date,
    daysRuns: s.schedule_days_runs,
    isPassenger,
    headcode: seg.signalling_id?.trim() || null,
    toc: s.atoc_code || null,
    calls,
    timings,
  };
}

export function parseTiplocRecord(t: any) {
  return {
    tiploc: t.tiploc_code as string,
    crs: (t.crs_code || null) as string | null,
    crsSource: (t.crs_code ? 'schedule' : null) as 'schedule' | null,
    nlc: (t.nalco || null) as string | null,
    stanox: (t.stanox || null) as string | null,
    name: (t.tps_description || t.description || t.tiploc_code) as string,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
