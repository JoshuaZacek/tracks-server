import type { Kysely } from 'kysely';
import type { Database, JourneyRow } from '../../db/types.ts';
import { ApiError } from '../../http/errors.ts';

/**
 * Keeping trips whole. Kept apart from service.ts so the journeys service can
 * tidy up after a delete without importing the trips service (which imports it).
 */

/** Each leg leaves from where the one before arrives. */
export const stationsChain = (legs: readonly Pick<JourneyRow, 'from_crs' | 'to_crs'>[]) =>
  legs.every((leg, i) => i === 0 || legs[i - 1]!.to_crs === leg.from_crs);

/**
 * For a new trip: stations chain, and each leg leaves no earlier than the one
 * before is due (so a change with less than the minimum change time is allowed,
 * and shows as at_risk).
 */
export function checkChain(legs: readonly JourneyRow[]) {
  for (let i = 1; i < legs.length; i++) {
    const prev = legs[i - 1]!;
    const leg = legs[i]!;
    if (prev.to_crs !== leg.from_crs) {
      throw new ApiError(422, 'not_connected', `Leg ${i + 1} leaves from ${leg.from_crs}, but leg ${i} arrives at ${prev.to_crs}`);
    }
    if (leg.scheduled_departure < prev.scheduled_arrival) {
      throw new ApiError(422, 'not_connected', `Leg ${i + 1} leaves ${leg.from_crs} before leg ${i} is due there`);
    }
  }
}

/** Unlinks a trip's journeys (they stay, each on its own) and deletes it. */
export async function dissolveTrip(db: Kysely<Database>, tripId: string) {
  await db.updateTable('journeys').set({ trip_id: null, leg: null }).where('trip_id', '=', tripId).execute();
  await db.deleteFrom('trips').where('id', '=', tripId).execute();
}

/**
 * After legs left these trips (deleted, or moved to another trip): a trip with
 * fewer than two legs, or whose stations no longer chain, is dissolved; the rest
 * are numbered 1, 2, … again, forgetting the connection alerts told (the next
 * look records a fresh baseline). (trip_id, leg) is checked at commit, so this
 * belongs in a transaction when it renumbers.
 */
export async function tidyTrips(db: Kysely<Database>, tripIds: readonly (string | null)[]) {
  for (const tripId of new Set(tripIds)) {
    if (!tripId) continue;
    const legs = await db.selectFrom('journeys').select(['id', 'leg', 'from_crs', 'to_crs']).where('trip_id', '=', tripId).orderBy('leg').execute();
    if (legs.length < 2 || !stationsChain(legs)) {
      await dissolveTrip(db, tripId);
      continue;
    }
    if (legs.every((l, i) => l.leg === i + 1)) continue;
    for (const [i, l] of legs.entries()) await db.updateTable('journeys').set({ leg: i + 1 }).where('id', '=', l.id).execute();
    await db.updateTable('trips').set({ alert_state: '{}' }).where('id', '=', tripId).execute();
  }
}
