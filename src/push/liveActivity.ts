import type { z } from 'zod';
import type { JourneyState } from '../db/types.ts';
import type { LiveStatus } from '../modules/journeys/schemas.ts';
import { divisionShortText } from '../live/division.ts';
import { canonicalJson } from '../live/updater.ts';

/**
 * Live Activity payloads, in the shape the iOS widget decodes
 * (`TrainActivityAttributes` and its ContentState). Pure.
 *
 * The widget animates progress itself between `legDepartedAt` and
 * `nextExpectedAt`, so the server only pushes when a time, the platform or the
 * state changes, never just to move the train along.
 */

type LiveStatusOut = z.input<typeof LiveStatus>;

export const ATTRIBUTES_TYPE = 'TrainActivityAttributes';

export interface LiveActivityAttributes {
  journeyId: string;
  headcode: string;
  operatorName: string;
  fromCrs: string;
  fromName: string;
  toCrs: string;
  toName: string;
}

export interface LiveActivityContent {
  state: JourneyState;
  scheduledDeparture: string;
  expectedDeparture: string | null;
  actualDeparture: string | null;
  /** At my destination. */
  scheduledArrival: string;
  expectedArrival: string | null;
  actualArrival: string | null;
  /** Departure delay until the train leaves my station, then arrival delay at my destination. */
  delayMinutes: number | null;
  /** My boarding platform until the train leaves (live, else timetabled), then my destination's. The app shows it as confirmed or predicted; hidden isn't shown. */
  platform: { number: string; confirmed: boolean; hidden: boolean } | null;
  isCancelled: boolean;
  message: string | null;
  /** The next stop on my journey once under way; null before departure and after arrival. */
  nextStopName: string | null;
  /** When the train left (or reached) the last stop passed; null until it leaves my station. */
  legDepartedAt: string | null;
  /** When it's expected at `nextStopName`. */
  nextExpectedAt: string | null;
  /**
   * "Divides at Horsham", or "Divides at Horsham · front 4 coaches" when Darwin says which coaches go to my
   * destination; null when the train doesn't divide before my destination, or has left the division station.
   */
  divides: string | null;
}

export interface JourneyForActivity {
  scheduledDeparture: string;
  scheduledArrival: string;
  bookedPlatform: string | null;
  bookedArrivalPlatform: string | null;
}

/** States after which the activity ends. */
export const ENDING_STATES: JourneyState[] = ['arrived', 'cancelled', 'not_found'];

export function liveActivityContent(j: JourneyForActivity, s: LiveStatusOut | null): LiveActivityContent {
  const state = s?.state ?? 'scheduled';
  const service = s?.service ?? null;
  const stops = s?.progress?.stops ?? [];
  const dest = stops.at(-1) ?? null;
  const underWay = state === 'departed' || state === 'arrived';

  let platform: LiveActivityContent['platform'];
  if (underWay) {
    platform = dest?.platform
      ? { number: dest.platform.number, confirmed: dest.platform.confirmed, hidden: dest.platform.hidden ?? false }
      : j.bookedArrivalPlatform
        ? { number: j.bookedArrivalPlatform, confirmed: false, hidden: false }
        : null;
  } else {
    platform = service?.platform
      ? { number: service.platform.number, confirmed: service.platform.confirmed, hidden: service.platform.hidden ?? false }
      : j.bookedPlatform
        ? { number: j.bookedPlatform, confirmed: false, hidden: false }
        : null;
  }

  let nextStopName: string | null = null;
  let legDepartedAt: string | null = null;
  let nextExpectedAt: string | null = null;
  const progress = s?.progress;
  if (state === 'departed' && progress && progress.nextIndex !== null) {
    const nextStop = stops[progress.nextIndex];
    const lastStop = progress.lastPassedIndex >= 0 ? stops[progress.lastPassedIndex] : undefined;
    if (nextStop) {
      nextStopName = nextStop.name;
      nextExpectedAt = nextStop.actual ?? nextStop.expected ?? nextStop.scheduled;
      legDepartedAt =
        progress.lastPassedIndex > 0 && lastStop
          ? (lastStop.actual ?? lastStop.expected ?? lastStop.scheduled)
          : (service?.actualDeparture ?? service?.expectedDeparture ?? stops[0]?.scheduled ?? null);
    }
  }

  return {
    state,
    scheduledDeparture: service?.scheduledDeparture ?? j.scheduledDeparture,
    expectedDeparture: service?.expectedDeparture ?? null,
    actualDeparture: service?.actualDeparture ?? null,
    scheduledArrival: j.scheduledArrival,
    expectedArrival: dest?.expected ?? null,
    actualArrival: dest?.actual ?? null,
    delayMinutes: underWay ? (dest?.delayMinutes ?? service?.delayMinutes ?? null) : (service?.delayMinutes ?? null),
    platform,
    isCancelled: service?.isCancelled ?? state === 'cancelled',
    message: s?.message ?? null,
    nextStopName,
    legDepartedAt,
    nextExpectedAt,
    divides: s?.divides ? divisionShortText(s.divides) : null,
  };
}

/** Content sent before `divides` existed counts as having none, so adding the field pushes nothing by itself. */
const normalised = (c: LiveActivityContent | null) => (c ? { ...c, divides: c.divides ?? null } : null);

export const sameContent = (a: LiveActivityContent | null, b: LiveActivityContent | null) =>
  canonicalJson(normalised(a)) === canonicalJson(normalised(b));

/**
 * Priority 10 (shown straight away, counts against Apple's budget for the
 * activity) for changes people care about; 5 (delivered when convenient, no
 * budget) for small time adjustments.
 */
export function isMaterialChange(before: LiveActivityContent | null, after: LiveActivityContent) {
  if (!before) return true;
  return (
    before.state !== after.state ||
    before.isCancelled !== after.isCancelled ||
    before.nextStopName !== after.nextStopName ||
    before.message !== after.message ||
    (before.divides ?? null) !== after.divides ||
    before.platform?.number !== after.platform?.number ||
    before.platform?.confirmed !== after.platform?.confirmed ||
    Math.abs((after.delayMinutes ?? 0) - (before.delayMinutes ?? 0)) >= 3
  );
}

const unix = (d: Date | string) => Math.floor((typeof d === 'string' ? Date.parse(d) : d.getTime()) / 1000);

/** When the widget should show the content as out of date if nothing new arrives: 20 min after the next thing due. */
export function staleDate(c: LiveActivityContent, now: Date) {
  const due = c.nextExpectedAt ?? c.expectedDeparture ?? c.scheduledDeparture;
  return Math.max(unix(now) + 20 * 60, unix(due) + 20 * 60);
}

/** How long an ended activity stays on the Lock Screen. */
function dismissalDate(c: LiveActivityContent, now: Date) {
  return unix(now) + (c.state === 'cancelled' ? 60 : 15) * 60;
}

export function updatePayload(c: LiveActivityContent, now: Date) {
  const ending = ENDING_STATES.includes(c.state);
  return {
    aps: {
      timestamp: unix(now),
      event: ending ? 'end' : 'update',
      'content-state': c,
      ...(ending ? { 'dismissal-date': dismissalDate(c, now) } : { 'stale-date': staleDate(c, now) }),
    },
  };
}

/** Push-to-start (iOS 17.2+): starts the activity on the device without the app running. */
export function startPayload(attributes: LiveActivityAttributes, c: LiveActivityContent, alert: { title: string; body: string }, now: Date) {
  return {
    aps: {
      timestamp: unix(now),
      event: 'start',
      'content-state': c,
      'attributes-type': ATTRIBUTES_TYPE,
      attributes,
      alert,
      'stale-date': staleDate(c, now),
    },
  };
}
