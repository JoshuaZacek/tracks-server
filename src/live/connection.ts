import type { z } from 'zod';
import type { Connection, ConnectionStatus, LiveStatus } from '../modules/journeys/schemas.ts';
import type { Platform, Station } from '../modules/stations/schemas.ts';

/**
 * "Will I make it?": the change from one leg of a trip to the next. Pure, so
 * the rules are unit-tested on their own (connection.test.ts).
 *
 * margin = next leg's departure − this leg's arrival − the minimum change time,
 * each time the best known: actual, else expected, else scheduled. Times are
 * full ISO instants, so a change across midnight needs nothing special.
 *
 * Minimum change time: Knowledgebase's station XML (StationV4.0) has no
 * interchange time (its <Interchange> element is about bikes, taxis and the
 * like; see docs/samples/kb-station-YRK.xml), so it is DEFAULT_MIN_CHANGE_MIN
 * everywhere for now.
 */

type LiveStatusOut = z.input<typeof LiveStatus>;
type PlatformOut = z.input<typeof Platform>;
type StationOut = z.input<typeof Station>;
export type ConnectionOut = z.input<typeof Connection>;
export type ConnectionStatusValue = z.infer<typeof ConnectionStatus>;

export const DEFAULT_MIN_CHANGE_MIN = 5;
/** Under this many minutes to spare (after the minimum change time) is `tight`. */
export const TIGHT_SPARE_MIN = 3;

/** What a leg contributes to a connection: its stored live status and its timetable at either end. */
export interface LegView {
  status: LiveStatusOut | null;
  /** ISO, UK offset: at my boarding station and my destination. */
  scheduledDeparture: string;
  scheduledArrival: string;
  bookedDeparturePlatform: string | null;
  bookedArrivalPlatform: string | null;
}

const hhmm = (iso: string) => iso.slice(11, 16);
const minutes = (ms: number) => Math.floor(ms / 60_000);
const booked = (number: string | null): PlatformOut | null => (number ? { number, source: 'booked', confirmed: false, hidden: false } : null);

/** This leg no longer gets me to the change station. */
const arrivalCancelled = (s: LiveStatusOut | null) => !!s && (s.state === 'cancelled' || (s.progress?.stops.at(-1)?.isCancelled ?? false));
/** The next leg no longer leaves the change station. */
const departureCancelled = (s: LiveStatusOut | null) => !!s && (s.state === 'cancelled' || (s.progress?.stops[0]?.isCancelled ?? false));

/** When and where a leg gets to its destination. */
export function arrivalOf(leg: LegView) {
  const dest = leg.status?.progress?.stops.at(-1);
  return { at: dest?.actual ?? dest?.expected ?? leg.scheduledArrival, platform: dest?.platform ?? booked(leg.bookedArrivalPlatform) };
}

/** When and where a leg leaves its boarding station. */
export function departureOf(leg: LegView) {
  const service = leg.status?.service;
  return {
    at: service?.actualDeparture ?? service?.expectedDeparture ?? leg.scheduledDeparture,
    platform: service?.platform ?? booked(leg.bookedDeparturePlatform),
  };
}

export function computeConnection(
  leg: number,
  station: StationOut,
  from: LegView,
  to: LegView,
  minimumChangeMinutes = DEFAULT_MIN_CHANGE_MIN,
): ConnectionOut {
  const arrival = arrivalOf(from);
  const departure = departureOf(to);
  const gap = minutes(Date.parse(departure.at) - Date.parse(arrival.at));
  const scheduledGap = minutes(Date.parse(to.scheduledDeparture) - Date.parse(from.scheduledArrival));
  const fromCancelled = arrivalCancelled(from.status);
  const toCancelled = departureCancelled(to.status);
  const cancelled = fromCancelled || toCancelled;
  const margin = gap - minimumChangeMinutes;
  const next = `the ${hhmm(to.scheduledDeparture)}`;

  let status: ConnectionStatusValue;
  let message: string;
  if (toCancelled) {
    status = 'missed';
    message = `${capitalise(next)} is cancelled`;
  } else if (fromCancelled) {
    status = 'missed';
    message = `This train no longer gets to ${station.name}`;
  } else if (gap < 0) {
    status = 'missed';
    message = `${capitalise(next)} leaves before you arrive`;
  } else if (margin < 0) {
    status = 'at_risk';
    message = `Only ${gap} min to change (${minimumChangeMinutes} needed)`;
  } else {
    status = margin < TIGHT_SPARE_MIN ? 'tight' : 'ok';
    message = `${gap} min to change`;
  }

  return {
    leg,
    station,
    status,
    message,
    arrival: arrival.at,
    arrivalPlatform: arrival.platform,
    departure: departure.at,
    departurePlatform: departure.platform,
    minimumChangeMinutes,
    marginMinutes: cancelled ? null : margin,
    scheduledMarginMinutes: scheduledGap - minimumChangeMinutes,
    cancelled,
  };
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Nothing left to warn about: I've arrived at the change station and the next
 * train has left it (I'm on it, or I know I missed it).
 */
export const connectionSettled = (from: LegView, to: LegView) =>
  from.status?.state === 'arrived' && (to.status?.state === 'departed' || to.status?.state === 'arrived');

/** Alternatives are worth looking up for these. */
export const needsAlternatives = (c: Pick<ConnectionOut, 'status'>) => c.status === 'at_risk' || c.status === 'missed';
