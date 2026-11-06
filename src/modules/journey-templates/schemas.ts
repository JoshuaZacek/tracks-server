import { z } from 'zod';
import { Crs, DateTime, IsoDate, TrainUid, Uuid } from '../../http/schemas.ts';
import { JourneyPrefs, JourneyPrefsUpdate, TravelMinutes } from '../journeys/schemas.ts';
import { Station } from '../stations/schemas.ts';

const Hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Must be HH:MM');
const DepartTime = Hhmm.meta({ description: 'Departure from the boarding station (HH:MM, UK local)', example: '07:42' });
const SummaryTime = Hhmm.meta({ description: 'When to send the morning summary on the day (HH:MM, UK local)', example: '06:45' });
const Weekday = z.number().int().min(1).max(7);
const Days = z
  .array(Weekday)
  .min(1)
  .max(7)
  .meta({ description: 'ISO weekdays: 1 = Monday … 7 = Sunday', example: [1, 2, 3, 4, 5] });

export const JourneyTemplate = z
  .object({
    id: Uuid,
    from: Station,
    to: Station,
    departTime: DepartTime,
    days: z.array(Weekday).meta({ description: 'ISO weekdays (1 = Monday … 7 = Sunday), sorted, unique, at least one' }),
    trainUid: TrainUid.nullable().meta({ description: 'The train last matched: a hint only, since UIDs change with the timetable' }),
    travelMinutes: TravelMinutes.nullable(),
    summaryTime: SummaryTime.nullable().meta({ description: 'When to send the morning summary (HH:MM); null = no summary' }),
    prefs: JourneyPrefs,
    problem: z
      .object({ date: IsoDate, message: z.string() })
      .nullable()
      .meta({ description: 'No train matched on `date` (e.g. after a timetable change); cleared at the next match' }),
    nextJourney: z
      .object({ id: Uuid, date: IsoDate, scheduledDeparture: DateTime })
      .nullable()
      .meta({ description: 'The soonest upcoming journey made from it' }),
    createdAt: DateTime,
  })
  .meta({ id: 'JourneyTemplate' });

export const JourneyTemplateList = z.object({ templates: z.array(JourneyTemplate) }).meta({ id: 'JourneyTemplateList' });

export const CreateJourneyTemplateRequest = z
  .object({
    fromCrs: Crs,
    toCrs: Crs,
    departTime: DepartTime,
    days: Days,
    trainUid: TrainUid.nullable().optional(),
    travelMinutes: TravelMinutes.nullable().optional(),
    summaryTime: SummaryTime.nullable().optional(),
    prefs: JourneyPrefs.optional(),
    journeyId: Uuid.optional().meta({
      description:
        "A journey of this device to repeat: it is linked to the template, its date counts as made, and its trainUid, travelMinutes and prefs are the defaults for fields left out",
    }),
  })
  .meta({ id: 'CreateJourneyTemplateRequest' });

export const UpdateJourneyTemplateRequest = z
  .object({
    departTime: DepartTime.optional(),
    days: Days.optional(),
    travelMinutes: TravelMinutes.nullable().optional(),
    summaryTime: SummaryTime.nullable().optional(),
    prefs: JourneyPrefsUpdate.optional(),
  })
  .meta({ id: 'UpdateJourneyTemplateRequest' });

export const JourneyTemplateParams = z.object({ id: Uuid });
