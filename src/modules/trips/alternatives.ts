import type { z } from 'zod';
import type { Db } from '../../db/client.ts';
import type { JourneyRow } from '../../db/types.ts';
import type { ConnectionOut } from '../../live/connection.ts';
import type { Lookups } from '../../live/lookups.ts';
import { toUkIso, addDays } from '../../time.ts';
import type { Departure } from '../stations/schemas.ts';
import { findDepartures } from '../stations/service.ts';

type DepartureOut = z.input<typeof Departure>;

export const MAX_ALTERNATIVES = 3;
/** Trains timetabled this long before my arrival are looked at too: they may be running late enough to catch. */
const LOOK_BACK_MIN = 30;
const PAGE = 40;

/**
 * Later trains from the change station to the next leg's destination that I
 * can still make: leaving (by expected time when Darwin has the run) at least
 * the minimum change time after I arrive, not cancelled, not already gone, and
 * not the train I'm changing onto. Soonest first; runs into the next day after
 * a late arrival. Empty when the timetable can't answer (not loaded yet).
 */
export async function findAlternatives(db: Db, live: Lookups | undefined, c: ConnectionOut, next: JourneyRow): Promise<DepartureOut[]> {
  const ready = Date.parse(c.arrival) + c.minimumChangeMinutes * 60_000;
  const arrivalDate = c.arrival.slice(0, 10);
  const from = toUkIso(new Date(Date.parse(c.arrival) - LOOK_BACK_MIN * 60_000));
  // Looking back must not go into the day before: the search is by date.
  const after = from.slice(0, 10) === arrivalDate ? from.slice(11, 16) : '00:00';

  const found: DepartureOut[] = [];
  const searches: { date: string; after?: string }[] = [{ date: arrivalDate, after }, { date: addDays(arrivalDate, 1) }];
  try {
    for (const search of searches) {
      let cursor: string | undefined;
      do {
        const page = await findDepartures(db, { ...search, from: c.station.crs, to: next.to_crs, limit: PAGE, cursor }, live);
        for (const d of page.departures) {
          if (d.trainUid === next.train_uid && d.runDate === next.run_date) continue;
          if (d.live?.isCancelled || d.live?.actualDeparture) continue;
          if (Date.parse(d.live?.expectedDeparture ?? d.scheduledDeparture) < ready) continue;
          found.push(d);
          if (found.length >= MAX_ALTERNATIVES) return found;
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
    }
  } catch {
    // No timetable yet, or a station it doesn't know: nothing to offer.
  }
  return found;
}
