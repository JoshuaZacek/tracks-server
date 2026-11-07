import type { z } from 'zod';
import type { DarwinLocation } from '../darwin/parse.ts';
import type { AssociationTimes, FormationCoach, JourneyState } from '../db/types.ts';
import type { LiveDepartureInfo, Platform } from '../modules/stations/schemas.ts';
import type { CallingPoint, CallingPointLive } from '../modules/trains/schemas.ts';
import type { LiveStatus, ProgressStop, TrainPosition } from '../modules/journeys/schemas.ts';
import { toUkIso, ukIsoAt } from '../time.ts';
import { divides } from './division.ts';
import { loading } from './loading.ts';
import { DarwinRun, hasActual, minutesOnRun, type Resolved } from './run.ts';

export { minutesOnRun };

/**
 * Live status from Darwin data. Pure: everything it needs is passed in, so it
 * is unit-tested without a database or the feed. Times are resolved by
 * DarwinRun (run.ts).
 */

export interface DarwinService {
  rid: string;
  uid: string;
  ssd: string;
  toc: string | null;
  trainId: string | null;
  cancelReason: string | null;
  lateReason: string | null;
  deactivated: boolean;
}

/** A train dividing from this run: a VV association with this run as `main`. */
export interface DarwinAssociation {
  tiploc: string;
  /** This run's planned times at the tiploc (to tell apart a location the run visits twice). */
  mainTimes: AssociationTimes;
  assocRid: string;
  cancelled: boolean;
  /** The portion's run (it starts at the tiploc); empty when Darwin has nothing for it. */
  assocLocations: DarwinLocation[];
}

export interface DarwinRunData {
  service: DarwinService;
  locations: DarwinLocation[];
  /** Divisions of this run (VV, this run as main). Loaded for journeys only. */
  associations?: DarwinAssociation[];
  /** Formations of this run and its portions, by fid, coaches front to rear. Loaded for journeys only. */
  formations?: Record<string, FormationCoach[]>;
}

export interface Lookup {
  crsOf: (tiploc: string) => string | null;
  nameOf: (tiploc: string) => string;
  station: (crs: string) => { name: string; lat: number | null; lon: number | null } | null;
  /** Reason text for a Darwin late/cancel reason code; null until reference data is available. */
  reasonText?: (code: string, kind: 'late' | 'cancel') => string | null;
}

type CallingPointOut = z.input<typeof CallingPoint>;
type LiveStatusOut = z.input<typeof LiveStatus>;
type PlatformOut = z.input<typeof Platform>;

/**
 * Darwin's live platform. A platform the station keeps off its own boards (platsup/cisPlatsup, e.g.
 * Euston until boarding) is still given, marked hidden: leaving it out made clients fall back to the
 * timetabled platform, which can be wrong.
 */
const platformOf = (loc: DarwinLocation | undefined): PlatformOut | null =>
  loc?.plat ? { number: loc.plat.number, source: 'live', confirmed: loc.plat.confirmed, hidden: loc.plat.suppressed } : null;

const iso = (runDate: string, minutes: number | null) => (minutes === null ? null : ukIsoAt(runDate, Math.floor(minutes)));

// ---- journeys ----------------------------------------------------------------------

export interface JourneyInput {
  runDate: string;
  callingPoints: CallingPointOut[];
  fromIndex: number;
  toIndex: number;
}

export interface ComputeContext extends Lookup {
  now: Date;
  /** Darwin is configured for this server. */
  darwinEnabled: boolean;
  /** The feed has delivered something (heartbeats included) recently. */
  feedHealthy: boolean;
}

/** How long after departure a run with no Darwin data at all counts as not found. */
const NOT_FOUND_AFTER_MIN = 30;

/** When the app should ask again while it is open, by state. Null: nothing more will change. */
export function pollSeconds(state: JourneyState, departure: Date, arrival: Date, now: Date): number | null {
  const untilDeparture = (departure.getTime() - now.getTime()) / 1000;
  const clamp = (s: number) => Math.min(3600, Math.max(60, Math.ceil(s)));
  switch (state) {
    case 'scheduled':
      if (now > arrival) return null;
      return untilDeparture > 3 * 3600 ? clamp(untilDeparture - 3 * 3600) : untilDeparture > 0 ? 120 : 60;
    case 'live':
      return untilDeparture <= 30 * 60 ? 30 : 60;
    case 'departed':
      return 30;
    case 'cancelled':
      return untilDeparture > 0 ? 300 : null;
    default:
      return null;
  }
}

function emptyStatus(state: JourneyState, ctx: ComputeContext, message: string | null): LiveStatusOut {
  return {
    state,
    checkedAt: toUkIso(ctx.now),
    nextPollSeconds: null,
    stale: false,
    message,
    service: null,
    progress: null,
    position: null,
    divides: null,
    loading: null,
  };
}

/**
 * The live status of a saved journey from its timetable snapshot and the
 * Darwin run (null when Darwin has nothing for it yet).
 */
export function computeJourneyStatus(j: JourneyInput, darwin: DarwinRunData | null, ctx: ComputeContext): LiveStatusOut {
  const cps = j.callingPoints;
  const board = cps[j.fromIndex]!;
  const departureMin = minutesOnRun(board.scheduledDeparture!, j.runDate);

  if (!darwin || !darwin.locations.length) {
    const departure = new Date(board.scheduledDeparture!);
    const overdue = ctx.now.getTime() > departure.getTime() + NOT_FOUND_AFTER_MIN * 60_000;
    if (ctx.darwinEnabled && ctx.feedHealthy && overdue) return emptyStatus('not_found', ctx, 'No live information was found for this train');
    return emptyStatus('scheduled', ctx, null);
  }

  const run = new DarwinRun(darwin.locations, departureMin, ctx.crsOf);
  const reason = (code: string | null, kind: 'late' | 'cancel') => (code ? (ctx.reasonText?.(code, kind) ?? null) : null);

  // The furthest point Darwin has reported the train at. A stop Darwin has nothing for (its
  // messages fell in a feed gap longer than Kafka keeps them) counts as passed once the train
  // has been reported somewhere planned after it; its own times stay unknown.
  const reported = run.lastActual >= 0 ? run.locations[run.lastActual]! : null;
  const reportedBeyond = (scheduledMin: number) => reported !== null && reported.at > scheduledMin;

  const stops: (z.input<typeof ProgressStop> & { r: Resolved | null; scheduledMin: number })[] = [];
  for (let i = j.fromIndex; i <= j.toIndex; i++) {
    const cp = cps[i]!;
    const isBoard = i === j.fromIndex;
    const scheduledIso = isBoard ? cp.scheduledDeparture! : (cp.scheduledArrival ?? cp.scheduledDeparture)!;
    const scheduledMin = minutesOnRun(scheduledIso, j.runDate);
    const r = run.match(cp.crs, cp.scheduledArrival?.slice(11, 16) ?? null, cp.scheduledDeparture?.slice(11, 16) ?? null, scheduledMin);
    const t = r ? (isBoard ? r.dep : r.arr.planned !== null || r.arr.expected !== null || r.arr.actual !== null ? r.arr : r.dep) : null;
    const actual = t?.actual ?? null;
    const expected = actual === null ? (t?.expected ?? null) : null;
    const best = actual ?? expected;
    const passed = r
      ? isBoard
        ? r.dep.actual !== null || r.index < run.lastActual
        : hasActual(r) || r.index < run.lastActual
      : reportedBeyond(scheduledMin);
    stops.push({
      r,
      scheduledMin,
      crs: cp.crs,
      name: cp.name,
      scheduled: scheduledIso,
      expected: iso(j.runDate, expected),
      actual: iso(j.runDate, actual),
      passed,
      isCancelled: r?.loc.can ?? false,
      delayMinutes: best === null ? null : Math.round(best - scheduledMin),
      platform: platformOf(r?.loc),
    });
  }

  const first = stops[0]!;
  const last = stops.at(-1)!;
  const departed = first.passed;
  const destPassedTime = last.r ? (last.r.arr.actual ?? last.r.dep.actual ?? last.r.pass.actual) : null;
  // Darwin deactivates a run after it finishes; past the expected arrival, that means it got there.
  const destDue = last.r ? (last.r.arr.expected ?? last.r.arr.planned ?? last.scheduledMin) : last.scheduledMin;
  const nowMin = minutesOnRun(toUkIso(ctx.now), j.runDate);
  const arrived = last.passed || (darwin.service.deactivated && departed && nowMin > destDue + 5);
  const cancelled = first.isCancelled || (last.isCancelled && !departed);

  const state: JourneyState = cancelled ? 'cancelled' : arrived ? 'arrived' : departed ? 'departed' : 'live';
  let lastPassedIndex = -1;
  stops.forEach((s, i) => {
    if (s.passed) lastPassedIndex = i;
  });
  if (arrived) lastPassedIndex = stops.length - 1;
  const nextIndex = arrived ? null : stops.findIndex((s, i) => i > lastPassedIndex && !s.isCancelled);

  const service = {
    rid: darwin.service.rid,
    scheduledDeparture: board.scheduledDeparture!,
    expectedDeparture: first.expected,
    actualDeparture: first.actual,
    delayMinutes: first.delayMinutes,
    platform: first.platform,
    isCancelled: first.isCancelled || last.isCancelled,
    cancelReason: reason(darwin.service.cancelReason, 'cancel'),
    delayReason: reason(darwin.service.lateReason, 'late'),
  };

  return {
    state,
    checkedAt: toUkIso(ctx.now),
    nextPollSeconds: null,
    stale: false,
    message: state === 'cancelled' ? 'Cancelled' : last.isCancelled && departed && !arrived ? `No longer calling at ${last.name}` : null,
    service,
    progress: {
      stops: stops.map(({ r: _r, scheduledMin: _m, ...s }) => (arrived && s === last ? { ...s, passed: true } : s)),
      lastPassedIndex,
      nextIndex: nextIndex === null || nextIndex < 0 ? null : nextIndex,
      arrived,
    },
    position: departed && !arrived && destPassedTime === null ? positionOf(run, stops, j.runDate, ctx) : null,
    divides:
      state === 'cancelled' || state === 'arrived'
        ? null
        : divides({
            runDate: j.runDate,
            run,
            board: first,
            dest: { r: last.r, scheduledMin: last.scheduledMin, crs: last.crs, name: last.name },
            associations: darwin.associations ?? [],
            formations: darwin.formations ?? {},
            crsOf: ctx.crsOf,
            nameOf: ctx.nameOf,
          }),
    loading: loading(first.r?.loc, darwin.formations ?? {}),
  };
}

/**
 * Two anchors for the app to move the train between: the latest location with
 * an actual time (a station or a passing point) and the next location after it,
 * at its expected (else planned) time.
 */
function positionOf(
  run: DarwinRun,
  stops: { r: Resolved | null; crs: string; scheduledMin: number }[],
  runDate: string,
  ctx: ComputeContext,
): z.input<typeof TrainPosition> | null {
  // My part of the run; where Darwin lacks my boarding or destination call (a feed gap), by planned time.
  const from = stops[0]!.r?.index ?? run.locations.find((r) => r.at >= stops[0]!.scheduledMin)?.index;
  const to = stops.at(-1)!.r?.index ?? run.locations.findLast((r) => r.at <= stops.at(-1)!.scheduledMin)?.index;
  if (from === undefined || to === undefined) return null;
  const window = run.locations.filter((r) => r.index >= from && r.index <= to);
  const reported = window.filter(hasActual).at(-1);
  if (!reported) return null;
  const next = window.find((r) => r.index > reported.index && !r.loc.can);

  const event = reported.dep.actual !== null ? 'departure' : reported.pass.actual !== null ? 'pass' : 'arrival';
  const time = (reported.dep.actual ?? reported.pass.actual ?? reported.arr.actual)!;
  const place = (r: Resolved) => {
    // Junctions and sidings can carry pseudo CRS codes (e.g. XHO for Holme Jn.): only real stations get one here.
    const s = r.crs ? ctx.station(r.crs) : null;
    return { tiploc: r.loc.tpl, crs: s ? r.crs : null, name: ctx.nameOf(r.loc.tpl), lat: s?.lat ?? null, lon: s?.lon ?? null };
  };
  const nextTime = next
    ? (next.arr.expected ?? next.pass.expected ?? next.dep.expected ?? next.arr.planned ?? next.pass.planned ?? next.dep.planned ?? next.at)
    : null;

  // The leg: the last calling point at or before the report, and the one after it.
  let leg = 0;
  stops.forEach((s, i) => {
    if (s.r && s.r.index <= reported.index && i < stops.length - 1) leg = i;
  });
  return {
    source: 'darwin',
    last: { ...place(reported), time: ukIsoAt(runDate, Math.floor(time)), event },
    next: next && nextTime !== null ? { ...place(next), expectedTime: ukIsoAt(runDate, Math.floor(nextTime)) } : null,
    legFrom: stops[leg]!.crs,
    legTo: stops[leg + 1]!.crs,
  };
}

// ---- departures and trains -----------------------------------------------------------

/** The live overlay for one departure in a station's list. */
export function departureLive(
  darwin: DarwinRunData | null,
  crs: string,
  scheduledDepartureIso: string,
  runDate: string,
  crsOf: (tpl: string) => string | null,
): z.input<typeof LiveDepartureInfo> | null {
  if (!darwin?.locations.length) return null;
  const ref = minutesOnRun(scheduledDepartureIso, runDate);
  const r = new DarwinRun(darwin.locations, ref, crsOf).match(crs, null, scheduledDepartureIso.slice(11, 16), ref);
  if (!r) return null;
  const best = r.dep.actual ?? r.dep.expected;
  return {
    expectedDeparture: r.dep.actual === null ? iso(runDate, r.dep.expected) : null,
    actualDeparture: iso(runDate, r.dep.actual),
    delayMinutes: best === null ? null : Math.round(best - ref),
    platform: platformOf(r.loc),
    isCancelled: r.loc.can ?? false,
  };
}

/** Live data for each calling point of a train. */
export function callingPointsLive(
  darwin: DarwinRunData | null,
  callingPoints: CallingPointOut[],
  runDate: string,
  crsOf: (tpl: string) => string | null,
): (z.input<typeof CallingPointLive> | null)[] {
  if (!darwin?.locations.length) return callingPoints.map(() => null);
  const firstDep = callingPoints.find((c) => c.scheduledDeparture)?.scheduledDeparture;
  const run = new DarwinRun(darwin.locations, firstDep ? minutesOnRun(firstDep, runDate) : 0, crsOf);
  return callingPoints.map((cp) => {
    const ref = minutesOnRun((cp.scheduledDeparture ?? cp.scheduledArrival)!, runDate);
    const r = run.match(cp.crs, cp.scheduledArrival?.slice(11, 16) ?? null, cp.scheduledDeparture?.slice(11, 16) ?? null, ref);
    if (!r) return null;
    return {
      expectedArrival: r.arr.actual === null ? iso(runDate, r.arr.expected) : null,
      expectedDeparture: r.dep.actual === null ? iso(runDate, r.dep.expected) : null,
      actualArrival: iso(runDate, r.arr.actual),
      actualDeparture: iso(runDate, r.dep.actual),
      platform: platformOf(r.loc),
      isCancelled: r.loc.can ?? false,
    };
  });
}
