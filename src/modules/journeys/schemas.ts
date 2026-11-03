import { z } from 'zod';
import { Crs, DateTime, IsoDate, Operator, TrainUid, Uuid, orNull } from '../../http/schemas.ts';
import { Platform, Station } from '../stations/schemas.ts';
import { CallingPoint, RoutePoint } from '../trains/schemas.ts';

// ---- live status --------------------------------------------------------------

/**
 * - scheduled: Darwin doesn't have the run yet, or departure is far off
 * - live:      Darwin has the run; the train hasn't left my boarding station
 * - departed:  left my station; `progress` and `position` are set
 * - arrived:   reached my destination
 * - cancelled: cancelled at my boarding station or my destination
 * - not_found: departure time passed with no Darwin data for the run
 */
export const LiveState = z.enum(['scheduled', 'live', 'departed', 'arrived', 'cancelled', 'not_found']).meta({ id: 'LiveState' });

export const LiveService = z
  .object({
    rid: z.string().nullable().meta({ description: "Darwin's id for this run of the train" }),
    scheduledDeparture: DateTime,
    expectedDeparture: DateTime.nullable(),
    actualDeparture: DateTime.nullable(),
    delayMinutes: z.number().int().nullable().meta({ description: 'Minutes late (actual or expected vs scheduled); null when unknown' }),
    platform: orNull(Platform),
    isCancelled: z.boolean(),
    cancelReason: z.string().nullable(),
    delayReason: z.string().nullable(),
  })
  .meta({ id: 'LiveService' });

export const ProgressStop = z
  .object({
    crs: Crs,
    name: z.string(),
    scheduled: DateTime,
    expected: DateTime.nullable(),
    actual: DateTime.nullable(),
    passed: z.boolean(),
    isCancelled: z.boolean(),
    delayMinutes: z.number().int().nullable(),
    platform: orNull(Platform),
  })
  .meta({ id: 'ProgressStop' });

export const JourneyProgress = z
  .object({
    stops: z.array(ProgressStop).meta({ description: 'My boarding station first, my destination last' }),
    lastPassedIndex: z.number().int().meta({ description: 'Index of the last stop called at; -1 before departure' }),
    nextIndex: z.number().int().nullable().meta({ description: 'Next stop; null once arrived' }),
    arrived: z.boolean(),
  })
  .meta({ id: 'JourneyProgress' });

const PositionLocation = z.object({
  tiploc: z.string(),
  crs: Crs.nullable(),
  name: z.string(),
  lat: z.number().nullable(),
  lon: z.number().nullable(),
});

/** The latest actual report: where the train was, when, and what it did there. */
export const PositionReport = PositionLocation.extend({
  time: DateTime,
  event: z.enum(['arrival', 'departure', 'pass']),
}).meta({ id: 'PositionReport' });

/** The next location Darwin forecasts the train at. */
export const PositionNext = PositionLocation.extend({ expectedTime: DateTime }).meta({ id: 'PositionNext' });

/**
 * Where the train is, as two anchors. The app moves its marker along the route
 * from `last` (at `last.time`) to `next` (at `next.expectedTime`) and waits at
 * `next` until an update arrives. When the user is on board, the app's own GPS
 * takes over; that location never leaves the device.
 */
export const TrainPosition = z
  .object({
    source: z.enum(['darwin', 'trust']),
    last: PositionReport,
    next: orNull(PositionNext),
    legFrom: Crs.meta({ description: 'Calling point at the start of the current leg' }),
    legTo: Crs.meta({ description: 'Calling point at the end of the current leg' }),
  })
  .meta({ id: 'TrainPosition' });

export const LiveStatus = z
  .object({
    state: LiveState,
    checkedAt: DateTime.meta({ description: 'When the server last updated this status' }),
    nextPollSeconds: z.number().int().positive().nullable().meta({ description: 'When to refresh while the app is open; null = final' }),
    stale: z.boolean().meta({ description: 'True when the live feed has stopped and this is the last known data' }),
    message: z.string().nullable(),
    service: orNull(LiveService),
    progress: orNull(JourneyProgress),
    position: orNull(TrainPosition),
  })
  .meta({ id: 'LiveStatus' });

/** Enough to draw a journey card (including the progress bar) without fetching the full journey. */
export const LiveSummary = z
  .object({
    state: LiveState,
    expectedDeparture: DateTime.nullable(),
    actualDeparture: DateTime.nullable(),
    expectedArrival: DateTime.nullable().meta({ description: 'At my destination' }),
    actualArrival: DateTime.nullable().meta({ description: 'At my destination' }),
    delayMinutes: z.number().int().nullable(),
    platform: orNull(Platform).meta({ description: 'Live platform at my boarding station, when Darwin has one' }),
    isCancelled: z.boolean(),
    stale: z.boolean(),
    checkedAt: DateTime.nullable(),
  })
  .meta({ id: 'LiveSummary' });

// ---- journeys -------------------------------------------------------------------

/** Per-journey overrides of the device's notification preferences; omitted = use the device setting. */
export const JourneyPrefs = z
  .object({
    delays: z.boolean().optional(),
    platforms: z.boolean().optional(),
    cancellations: z.boolean().optional(),
    departure: z.boolean().optional(),
    arrival: z.boolean().optional(),
    delayThresholdMinutes: z.number().int().min(1).max(60).optional(),
  })
  .meta({ id: 'JourneyPrefs' });

const JourneyBase = z.object({
  id: Uuid,
  trainUid: TrainUid,
  runDate: IsoDate,
  date: IsoDate.meta({ description: 'The date I depart from my boarding station' }),
  headcode: z.string(),
  operator: Operator,
  from: Station,
  to: Station,
  scheduledDeparture: DateTime,
  scheduledArrival: DateTime,
  bookedPlatform: z.string().nullable().meta({ description: 'Timetabled platform at my boarding station' }),
  prefs: JourneyPrefs,
  createdAt: DateTime,
  archivedAt: DateTime.nullable(),
});

export const JourneyListItem = JourneyBase.extend({ live: LiveSummary }).meta({ id: 'JourneyListItem' });

export const Journey = JourneyBase.extend({
  callingPoints: z.array(CallingPoint).meta({ description: "The train's full public calling pattern, snapshotted when saved" }),
  fromIndex: z.number().int().nonnegative().meta({ description: 'Index into callingPoints where I board' }),
  toIndex: z.number().int().nonnegative().meta({ description: 'Index where I get off' }),
  route: z.array(RoutePoint),
  live: LiveStatus,
}).meta({ id: 'Journey' });

export const JourneyList = z
  .object({
    journeys: z.array(JourneyListItem),
    nextPollSeconds: z
      .number()
      .int()
      .positive()
      .nullable()
      .meta({ description: 'Soonest the list could change on its own (refresh then while open); null if only your own edits change it' }),
  })
  .meta({ id: 'JourneyList' });

export const CreateJourneyRequest = z
  .object({
    trainUid: TrainUid,
    runDate: IsoDate,
    fromCrs: Crs,
    toCrs: Crs.optional().meta({ description: "Where I get off; defaults to the train's final stop" }),
  })
  .meta({ id: 'CreateJourneyRequest' });

/** Per-journey overrides to change: a value sets the override, null removes it, omitted leaves it. */
export const JourneyPrefsUpdate = z
  .object({
    delays: z.boolean().nullable().optional(),
    platforms: z.boolean().nullable().optional(),
    cancellations: z.boolean().nullable().optional(),
    departure: z.boolean().nullable().optional(),
    arrival: z.boolean().nullable().optional(),
    delayThresholdMinutes: z.number().int().min(1).max(60).nullable().optional(),
  })
  .meta({ id: 'JourneyPrefsUpdate' });

export const UpdateJourneyRequest = z
  .object({
    prefs: JourneyPrefsUpdate.optional(),
    archived: z.boolean().optional().meta({ description: 'true moves the journey to past; false brings it back' }),
  })
  .meta({ id: 'UpdateJourneyRequest' });

export const RegisterLiveActivityRequest = z
  .object({
    pushToken: z.string().regex(/^[0-9a-fA-F]{32,200}$/, 'Must be the hex ActivityKit push token'),
  })
  .meta({ id: 'RegisterLiveActivityRequest' });

export const JourneyParams = z.object({ id: Uuid });

export const JourneyListQuery = z.object({
  scope: z.enum(['upcoming', 'past']).default('upcoming'),
  limit: z.coerce.number().int().min(1).max(500).default(100).meta({ description: 'Most recent first for `past`' }),
});
