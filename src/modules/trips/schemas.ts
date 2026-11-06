import { z } from 'zod';
import { DateTime, IsoDate, TrainUid, Uuid } from '../../http/schemas.ts';
import { Connection, Journey } from '../journeys/schemas.ts';
import { Departure } from '../stations/schemas.ts';

/** A connection with what to do if it doesn't work out. */
export const TripConnection = Connection.extend({
  alternatives: z
    .array(Departure)
    .meta({
      description:
        "When at_risk or missed: up to 3 later trains from the change station to the next leg's destination that I can still make " +
        '(by expected departure, not cancelled), soonest first; `arrival` is at that destination. Empty otherwise.',
    }),
}).meta({ id: 'TripConnection' });

export const Trip = z
  .object({
    id: Uuid,
    legs: z.array(Journey).meta({ description: 'In travelling order: leg 1 first' }),
    connections: z.array(TripConnection).meta({ description: 'One per change: connections[i] is from legs[i] to legs[i + 1]' }),
    createdAt: DateTime,
  })
  .meta({ id: 'Trip' });

export const CreateTripRequest = z
  .object({
    journeyIds: z
      .array(Uuid)
      .min(2)
      .max(6)
      .meta({
        description:
          'Journeys of this device in travelling order. Each must leave from where the one before arrives, after it is due there. ' +
          'A journey already in another trip moves to this one (a trip left with one leg goes).',
      }),
  })
  .meta({ id: 'CreateTripRequest' });

export const ReplaceLegRequest = z
  .object({
    trainUid: TrainUid,
    runDate: IsoDate,
  })
  .meta({ id: 'ReplaceLegRequest' });

export const TripParams = z.object({ id: Uuid });
export const TripLegParams = z.object({ id: Uuid, leg: z.coerce.number().int().min(1).max(6) });
