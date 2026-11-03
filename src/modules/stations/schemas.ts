import { z } from 'zod';
import { Crs, DateTime, IsoDate, Operator, TrainUid, orNull, queryInt } from '../../http/schemas.ts';

export const Station = z
  .object({
    crs: Crs,
    name: z.string().meta({ example: 'London Kings Cross' }),
    lat: z.number().nullable().meta({ description: 'WGS84 latitude; null until Knowledgebase has located the station' }),
    lon: z.number().nullable(),
  })
  .meta({ id: 'Station' });

export const NearbyStation = Station.extend({
  distanceMeters: z.number().int().nonnegative(),
}).meta({ id: 'NearbyStation' });

/** Platform as shown to passengers. `confirmed` comes from Darwin; booked platforms are never confirmed. */
export const Platform = z
  .object({
    number: z.string().meta({ example: '4' }),
    source: z.enum(['booked', 'live']).meta({ description: 'booked: from the timetable; live: from Darwin' }),
    confirmed: z.boolean(),
  })
  .meta({ id: 'Platform' });

/** Small live overlay on timetable data, present for runs Darwin knows about. */
export const LiveDepartureInfo = z
  .object({
    expectedDeparture: DateTime.nullable(),
    actualDeparture: DateTime.nullable(),
    delayMinutes: z.number().int().nullable(),
    platform: orNull(Platform),
    isCancelled: z.boolean(),
  })
  .meta({ id: 'LiveDepartureInfo' });

/** Arrival at the `to` station of a departures search. */
export const DepartureArrival = z.object({ station: Station, scheduledArrival: DateTime }).meta({ id: 'DepartureArrival' });

export const Departure = z
  .object({
    trainUid: TrainUid,
    runDate: IsoDate.meta({ description: 'Date the train started its run (the day before `date` for after-midnight calls)' }),
    headcode: z.string().meta({ example: '1S32' }),
    operator: Operator,
    scheduledDeparture: DateTime,
    bookedPlatform: z.string().nullable(),
    destination: Station,
    arrival: orNull(DepartureArrival),
    live: orNull(LiveDepartureInfo),
  })
  .meta({ id: 'Departure' });

export const DeparturesResponse = z
  .object({
    date: IsoDate,
    from: Station,
    to: orNull(Station),
    departures: z.array(Departure),
    nextCursor: z.string().nullable().meta({ description: 'Pass as `cursor` to get the next page; null when there are no more' }),
  })
  .meta({ id: 'DeparturesResponse' });

export const StationSearchQuery = z.object({
  q: z.string().trim().min(1).max(60).meta({ description: 'Name or CRS code', example: 'york' }),
  limit: queryInt(1, 50, 15),
});

export const NearbyQuery = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
  limit: queryInt(1, 20, 5),
});

export const CrsParams = z.object({ crs: Crs });

export const DeparturesQuery = z.object({
  date: IsoDate,
  to: Crs.optional().meta({ description: 'Only trains that call here afterwards' }),
  after: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Must be HH:MM')
    .optional()
    .meta({ description: 'Earliest departure (HH:MM, UK local)', example: '17:00' }),
  cursor: z.string().max(200).optional(),
  limit: queryInt(1, 100, 40),
});

export const StationList = z.object({ stations: z.array(Station) }).meta({ id: 'StationList' });
export const NearbyStationList = z.object({ stations: z.array(NearbyStation) }).meta({ id: 'NearbyStationList' });
