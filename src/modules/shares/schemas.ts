import { z } from 'zod';
import { DateTime, Operator, orNull } from '../../http/schemas.ts';
import { LiveState, ProgressStop, TrainPosition } from '../journeys/schemas.ts';
import { Platform, Station } from '../stations/schemas.ts';

/** A share token: 128 random bits in base64url. */
export const ShareToken = z.string().regex(/^[A-Za-z0-9_-]{22}$/);

/**
 * The cut-down live status anyone with a share link sees. Deliberately only
 * the train and my two stations: no journey, device, preference, trip or
 * claim data, and no Darwin or timetable ids.
 */
export const SharedJourney = z
  .object({
    headcode: z.string(),
    operator: Operator,
    from: Station,
    to: Station,
    scheduledDeparture: DateTime,
    scheduledArrival: DateTime,
    state: LiveState,
    message: z.string().nullable(),
    stale: z.boolean(),
    checkedAt: DateTime,
    nextPollSeconds: z.number().int().positive().nullable().meta({ description: 'When to ask again; null = final' }),
    expectedDeparture: DateTime.nullable(),
    actualDeparture: DateTime.nullable(),
    expectedArrival: DateTime.nullable().meta({ description: 'At the destination' }),
    actualArrival: DateTime.nullable(),
    delayMinutes: z.number().int().nullable(),
    platform: orNull(Platform).meta({ description: 'At the boarding station' }),
    isCancelled: z.boolean(),
    stops: z.array(ProgressStop).meta({ description: 'Boarding station first, destination last' }),
    position: orNull(TrainPosition),
    expiresAt: DateTime.meta({ description: 'When the link stops working' }),
  })
  .meta({ id: 'SharedJourney' });

export const SharedParams = z.object({ token: z.string().min(1).max(64) });
