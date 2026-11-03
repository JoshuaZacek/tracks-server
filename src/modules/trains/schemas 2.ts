import { z } from 'zod';
import { Crs, DateTime, IsoDate, Operator, TrainUid, orNull } from '../../http/schemas.ts';
import { Platform } from '../stations/schemas.ts';

/** Live data for one calling point, from Darwin (Phase 4). */
export const CallingPointLive = z
  .object({
    expectedArrival: DateTime.nullable(),
    expectedDeparture: DateTime.nullable(),
    actualArrival: DateTime.nullable(),
    actualDeparture: DateTime.nullable(),
    platform: orNull(Platform),
    isCancelled: z.boolean(),
  })
  .meta({ id: 'CallingPointLive' });

export const CallingPoint = z
  .object({
    crs: Crs,
    name: z.string(),
    lat: z.number().nullable(),
    lon: z.number().nullable(),
    scheduledArrival: DateTime.nullable().meta({ description: 'Null at the origin' }),
    scheduledDeparture: DateTime.nullable().meta({ description: 'Null at the final stop' }),
    bookedPlatform: z.string().nullable(),
    live: orNull(CallingPointLive),
  })
  .meta({ id: 'CallingPoint' });

/**
 * A station the train passes without stopping, so the map can follow the
 * railway: on the leg that starts at callingPoints[leg], `f` (0..1) of the way
 * along by timetabled time.
 */
export const RoutePoint = z
  .object({
    lat: z.number(),
    lon: z.number(),
    leg: z.number().int().nonnegative(),
    f: z.number().min(0).max(1),
  })
  .meta({ id: 'RoutePoint' });

export const TrainDetails = z
  .object({
    trainUid: TrainUid,
    runDate: IsoDate,
    headcode: z.string(),
    operator: Operator,
    callingPoints: z.array(CallingPoint),
    route: z.array(RoutePoint),
  })
  .meta({ id: 'TrainDetails' });

export const TrainParams = z.object({ uid: TrainUid, runDate: IsoDate });
