import { z } from 'zod';
import { Crs, DateTime, HexToken, IsoDate, Operator, TrainUid, Uuid, orNull } from '../../http/schemas.ts';
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

// ---- more from Darwin (Sprint 3) ---------------------------------------------------

/** One part of a dividing train after the division. */
export const DivisionPortion = z
  .object({
    destCrs: Crs.nullable(),
    destName: z.string(),
    yours: z.boolean().meta({ description: 'This part calls at my destination' }),
    note: z.string().nullable().meta({ description: 'Which coaches, when Darwin\'s formation data says, e.g. "Front 4 coaches"', example: 'Front 4 coaches' }),
  })
  .meta({ id: 'DivisionPortion' });

/**
 * My train divides at a station between my boarding station and my destination.
 * Null when it doesn't, and once it has left the division station.
 */
export const TrainDivision = z
  .object({
    atCrs: Crs,
    atName: z.string(),
    at: DateTime.meta({ description: 'Scheduled arrival at the division station' }),
    portions: z.array(DivisionPortion).meta({ description: 'Mine first' }),
    message: z.string().meta({ example: 'This train divides at Horsham; only some coaches go to Barnham.' }),
  })
  .meta({ id: 'TrainDivision' });

export const LoadingLevel = z.enum(['quiet', 'moderate', 'busy', 'very_busy']).meta({ id: 'LoadingLevel' });

export const CoachLoad = z
  .object({
    number: z.string().meta({ example: 'A1' }),
    percentage: z.number().int().min(0).max(100),
    class: z.string().nullable().meta({ description: 'First, Standard…; null when unknown' }),
  })
  .meta({ id: 'CoachLoad' });

/**
 * How busy the train is expected to be leaving my boarding station (Darwin's
 * loading data). quiet < 30 %, moderate < 60 %, busy < 85 %, very_busy from 85 %.
 */
export const TrainLoading = z
  .object({
    percentage: z.number().int().min(0).max(100),
    level: LoadingLevel,
    coaches: z.array(CoachLoad).nullable().meta({ description: 'Front to rear, when Darwin has coach-level loading' }),
    quietestCoaches: z.array(z.string()).meta({ description: 'Up to two coach numbers, quietest first; empty without coach data' }),
  })
  .meta({ id: 'TrainLoading' });

/** A message National Rail shows at my boarding station or destination (Darwin OW). */
export const StationMessage = z
  .object({
    id: z.string(),
    stations: z.array(Crs).meta({ description: 'Which of my boarding station and destination it is shown at' }),
    category: z.string().meta({ example: 'Train' }),
    severity: z.enum(['normal', 'minor', 'major', 'severe']),
    text: z.string(),
    url: z.string().nullable(),
    updatedAt: DateTime,
  })
  .meta({ id: 'StationMessage' });

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
    divides: orNull(TrainDivision).default(null),
    loading: orNull(TrainLoading).default(null),
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
    loading: orNull(TrainLoading).default(null),
  })
  .meta({ id: 'LiveSummary' });

// ---- connections (trips) -------------------------------------------------------

/**
 * - ok:      at least 3 min to spare after the minimum change time
 * - tight:   makes the minimum change time, with under 3 min to spare
 * - at_risk: the next train leaves after I arrive, but with less than the minimum change time
 * - missed:  the next train leaves before I arrive, or either train is cancelled
 */
export const ConnectionStatus = z.enum(['ok', 'tight', 'at_risk', 'missed']).meta({ id: 'ConnectionStatus' });

/** The change from one leg of a trip to the next, from the best times known (actual, else expected, else scheduled). */
export const Connection = z
  .object({
    leg: z.number().int().min(1).meta({ description: 'The leg arriving at the change station (the next leg is leg + 1)' }),
    station: Station.meta({ description: 'Where I change trains' }),
    status: ConnectionStatus,
    message: z.string().meta({ description: 'Short summary, e.g. "8 min to change" or "The 17:55 is cancelled"', example: '8 min to change' }),
    arrival: DateTime.meta({ description: 'When this leg gets to the change station (actual, else expected, else scheduled)' }),
    arrivalPlatform: orNull(Platform),
    departure: DateTime.meta({ description: 'When the next leg leaves the change station (actual, else expected, else scheduled)' }),
    departurePlatform: orNull(Platform),
    minimumChangeMinutes: z.number().int().nonnegative(),
    marginMinutes: z
      .number()
      .int()
      .nullable()
      .meta({ description: 'Minutes to spare after the minimum change time (negative = short); null when either train is cancelled' }),
    scheduledMarginMinutes: z.number().int().meta({ description: 'The same by the timetable' }),
    cancelled: z.boolean().meta({ description: 'This leg no longer reaches the change station, or the next leg no longer leaves it' }),
  })
  .meta({ id: 'Connection' });

/** Which trip a journey belongs to; null for a journey on its own. */
export const TripLink = z
  .object({
    id: Uuid,
    leg: z.number().int().min(1).meta({ description: '1 for the first train' }),
    legs: z.number().int().min(2).meta({ description: 'Trains in the trip' }),
  })
  .meta({ id: 'TripLink' });

// ---- Delay Repay and sharing (Sprint 4) ------------------------------------------

export const TicketType = z.enum(['single', 'return']).meta({ id: 'TicketType' });

export const DelayRepayBand = z
  .object({
    minMinutes: z.number().int(),
    maxMinutes: z.number().int().nullable().meta({ description: 'Null for the top band' }),
    singlePercent: z.number().meta({ description: 'Of a single fare' }),
    returnPercent: z.number().meta({ description: 'Of a return fare, delayed one way' }),
  })
  .meta({ id: 'DelayRepayBand' });

/**
 * What this journey may be able to claim, once it is over: arrived late enough
 * for the operator's Delay Repay scheme, or cancelled (past its scheduled
 * arrival). Null otherwise, and for operators without rules.
 */
export const DelayRepayClaim = z
  .object({
    operator: Operator,
    scheme: z.enum(['DR15', 'DR30']).meta({ description: 'Delay Repay 15 (from 15 min) or 30 (from 30 min)' }),
    minimumDelayMinutes: z.number().int(),
    delayMinutes: z.number().int().nullable().meta({ description: 'Late at my destination; null when cancelled' }),
    cancelled: z.boolean(),
    band: orNull(DelayRepayBand).meta({ description: 'Null when cancelled: the claim depends on the train taken instead (or a refund)' }),
    actualArrival: DateTime.nullable().meta({ description: 'At my destination; null when cancelled' }),
    claimUrl: z.url().meta({ description: "The operator's claim form or Delay Repay page" }),
    ticketPricePence: z.number().int().nullable(),
    ticketType: orNull(TicketType),
    estimatePence: z.number().int().nullable().meta({ description: 'The band of the ticket price; null without a band, price or ticket type' }),
    claimed: z.boolean(),
    claimedAt: DateTime.nullable(),
  })
  .meta({ id: 'DelayRepayClaim' });

/** What the user says about a claim: a value sets it, null clears it, omitted leaves it. */
export const ClaimUpdate = z
  .object({
    ticketPricePence: z.number().int().min(0).max(10_000_000).nullable().optional(),
    ticketType: orNull(TicketType).optional(),
    claimed: z.boolean().optional().meta({ description: 'true marks it claimed (the app hides the card)' }),
  })
  .meta({ id: 'ClaimUpdate' });

/** A public link to this journey's live status, while it is shared. */
export const JourneyShare = z
  .object({
    url: z.url().meta({ example: 'https://tracks-api.joshuazacek.com/s/9vR2o1mNw0bXH6cQe8Jt1A' }),
    expiresAt: DateTime.meta({ description: '6 h after the scheduled arrival' }),
  })
  .meta({ id: 'JourneyShare' });

// ---- journeys -------------------------------------------------------------------

/** Time to get to the boarding station: the leave_now alert fires this long (plus 2 min) before departure. */
export const TravelMinutes = z.number().int().min(0).max(240).meta({ description: 'Minutes to get to the boarding station (for the leave_now alert)' });

/** Per-journey overrides of the device's notification preferences; omitted = use the device setting (stopAlarm has none: omitted = off). */
export const JourneyPrefs = z
  .object({
    delays: z.boolean().optional(),
    platforms: z.boolean().optional(),
    cancellations: z.boolean().optional(),
    departure: z.boolean().optional(),
    arrival: z.boolean().optional(),
    delayThresholdMinutes: z.number().int().min(1).max(60).optional(),
    liveActivity: z.boolean().optional(),
    stopAlarm: z
      .boolean()
      .optional()
      .meta({
        description:
          'Wake me before my stop: the app schedules an alarm before arrival at my destination, and the server sends a background push (kind stop_alarm) when that arrival moves by 2+ min or is cancelled. Journey-only; absent = off',
      }),
    morningSummary: z.boolean().optional(),
    leaveNow: z.boolean().optional(),
    connections: z.boolean().optional().meta({ description: 'Connection alerts for the change after this leg' }),
    divides: z.boolean().optional(),
    delayRepay: z.boolean().optional(),
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
  templateId: Uuid.nullable().meta({ description: 'The regular journey this was made from; null when saved by hand or no longer repeating' }),
  travelMinutes: TravelMinutes.nullable(),
  trip: orNull(TripLink).meta({ description: 'The trip (a journey with changes) this is a leg of; null when on its own' }),
  connection: orNull(Connection).meta({ description: 'The change from this leg to the next one of its trip; null for the last leg or no trip' }),
  claim: orNull(DelayRepayClaim).meta({ description: 'Delay Repay this journey may be able to claim; null until it is over, or when nothing can be' }),
  share: orNull(JourneyShare).meta({ description: 'The public link while the journey is shared' }),
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
  stationMessages: z.array(StationMessage).meta({ description: 'Messages at my boarding station and destination, most severe first' }),
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
    liveActivity: z.boolean().nullable().optional(),
    stopAlarm: z.boolean().nullable().optional(),
    morningSummary: z.boolean().nullable().optional(),
    leaveNow: z.boolean().nullable().optional(),
    connections: z.boolean().nullable().optional(),
    divides: z.boolean().nullable().optional(),
    delayRepay: z.boolean().nullable().optional(),
  })
  .meta({ id: 'JourneyPrefsUpdate' });

export const UpdateJourneyRequest = z
  .object({
    prefs: JourneyPrefsUpdate.optional(),
    archived: z.boolean().optional().meta({ description: 'true moves the journey to past; false brings it back' }),
    travelMinutes: TravelMinutes.nullable().optional().meta({ description: 'Minutes to get to the boarding station; null clears it' }),
    claim: ClaimUpdate.optional(),
  })
  .meta({ id: 'UpdateJourneyRequest' });

export const RegisterLiveActivityRequest = z
  .object({
    pushToken: HexToken.meta({ description: 'Hex ActivityKit push token (Activity.pushTokenUpdates)' }),
  })
  .meta({ id: 'RegisterLiveActivityRequest' });

export const JourneyParams = z.object({ id: Uuid });

export const JourneyListQuery = z.object({
  scope: z.enum(['upcoming', 'past']).default('upcoming'),
  limit: z.coerce.number().int().min(1).max(500).default(100).meta({ description: 'Most recent first for `past`' }),
});
