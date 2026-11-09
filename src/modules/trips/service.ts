import type { z } from 'zod';
import { darwinEnabled, type AppDeps } from '../../app.ts';
import type { Db } from '../../db/client.ts';
import type { DeviceRow, JourneyRow } from '../../db/types.ts';
import { needsAlternatives } from '../../live/connection.ts';
import { loadShares } from '../shares/links.ts';
import { ApiError } from '../../http/errors.ts';
import { toUkIso } from '../../time.ts';
import { connectionAfter, loadStationMessages, readContext, saveDepsOf, saveJourney, toJourney } from '../journeys/service.ts';
import { findAlternatives } from './alternatives.ts';
import { checkChain, dissolveTrip, tidyTrips } from './legs.ts';
import type { ReplaceLegRequest, Trip } from './schemas.ts';

type TripOut = z.input<typeof Trip>;

const tripNotFound = () => ApiError.notFound('trip_not_found', 'No such trip');

async function findOwnedTrip(db: Db, device: DeviceRow, id: string) {
  const trip = await db.selectFrom('trips').selectAll().where('id', '=', id).where('device_id', '=', device.id).executeTakeFirst();
  if (!trip) throw tripNotFound();
  return trip;
}

const legsOf = (db: Db, tripId: string) => db.selectFrom('journeys').selectAll().where('trip_id', '=', tripId).orderBy('leg').execute();

/** Connection statuses as they stand: what the user sees when linking, so not news (trips.alert_state). */
function baselineOf(legs: JourneyRow[]) {
  const state: Record<string, string> = {};
  for (const leg of legs.slice(0, -1)) {
    const c = connectionAfter(leg, legs, null);
    if (c) state[String(leg.leg)] = c.status;
  }
  return JSON.stringify(state);
}

export async function createTrip(deps: AppDeps, device: DeviceRow, journeyIds: string[]): Promise<TripOut> {
  if (new Set(journeyIds).size !== journeyIds.length) {
    throw ApiError.validation([{ in: 'body', path: 'journeyIds', message: 'A journey can only be in a trip once' }]);
  }
  const tripId = await deps.db.transaction().execute(async (trx) => {
    const rows = await trx.selectFrom('journeys').selectAll().where('device_id', '=', device.id).where('id', 'in', journeyIds).forUpdate().execute();
    if (rows.length !== journeyIds.length) throw ApiError.notFound('journey_not_found', 'No such journey');
    const legs = journeyIds.map((id) => rows.find((r) => r.id === id)!);
    checkChain(legs);

    const trip = await trx.insertInto('trips').values({ device_id: device.id }).returning('id').executeTakeFirstOrThrow();
    for (const [i, leg] of legs.entries()) {
      await trx.updateTable('journeys').set({ trip_id: trip.id, leg: i + 1 }).where('id', '=', leg.id).execute();
    }
    // Journeys moved out of other trips: those may be left too short.
    await tidyTrips(trx, legs.map((l) => l.trip_id));
    const linked = await legsOf(trx, trip.id);
    await trx.updateTable('trips').set({ alert_state: baselineOf(linked) }).where('id', '=', trip.id).execute();
    return trip.id;
  });
  return getTrip(deps, device, tripId);
}

export async function getTrip(deps: AppDeps, device: DeviceRow, id: string): Promise<TripOut> {
  const trip = await findOwnedTrip(deps.db, device, id);
  const legs = await legsOf(deps.db, trip.id);
  const rc = await readContext(deps);
  const trips = new Map([[trip.id, legs]]);
  const live = darwinEnabled(deps) ? deps.lookups : undefined;
  const connections = [];
  for (const leg of legs.slice(0, -1)) {
    const c = connectionAfter(leg, legs, rc);
    if (!c) continue;
    const next = legs.find((l) => l.leg === leg.leg! + 1)!;
    connections.push({ ...c, alternatives: needsAlternatives(c) ? await findAlternatives(deps.db, live, c, next) : [] });
  }
  const [messages, shares] = await Promise.all([loadStationMessages(deps.db, legs), loadShares(deps.db, legs, rc.now)]);
  return { id: trip.id, legs: legs.map((l) => toJourney(l, rc, trips, messages, shares)), connections, createdAt: toUkIso(trip.created_at) };
}

/**
 * "Switch to this train": saves a journey on another train between the same
 * stations as the leg, with the leg's prefs and travel time, and swaps it in. The
 * old journey is deleted. Only the leg before is checked (the new train must
 * leave after that one is due); a later leg it no longer connects with shows as
 * missed, with its own alternatives.
 */
export async function replaceLeg(deps: AppDeps, device: DeviceRow, id: string, legNo: number, body: z.output<typeof ReplaceLegRequest>) {
  const trip = await findOwnedTrip(deps.db, device, id);
  const legs = await legsOf(deps.db, trip.id);
  const old = legs.find((l) => l.leg === legNo);
  if (!old) throw ApiError.notFound('journey_not_found', `Trip has no leg ${legNo}`);

  const { journey, created } = await saveJourney(
    saveDepsOf(deps),
    device.id,
    { trainUid: body.trainUid, runDate: body.runDate, fromCrs: old.from_crs, toCrs: old.to_crs },
    { prefs: old.prefs, travelMinutes: old.travel_minutes },
  );
  if (journey.id === old.id) return getTrip(deps, device, trip.id);

  const fresh = await deps.db.selectFrom('journeys').selectAll().where('id', '=', journey.id).executeTakeFirstOrThrow();
  const before = legs.find((l) => l.leg === legNo - 1);
  try {
    if (before) checkChain([before, fresh]);
  } catch (err) {
    // Don't leave behind a journey the user never asked for on its own.
    if (created) await deps.db.deleteFrom('journeys').where('id', '=', fresh.id).execute();
    throw err;
  }

  await deps.db.transaction().execute(async (trx) => {
    await trx.deleteFrom('journeys').where('id', '=', old.id).execute();
    await trx.updateTable('journeys').set({ trip_id: trip.id, leg: legNo }).where('id', '=', fresh.id).execute();
    await tidyTrips(trx, [fresh.trip_id]);
    await trx.updateTable('trips').set({ alert_state: baselineOf(await legsOf(trx, trip.id)) }).where('id', '=', trip.id).execute();
  });
  return getTrip(deps, device, trip.id);
}

export async function deleteTrip(deps: AppDeps, device: DeviceRow, id: string) {
  const trip = await findOwnedTrip(deps.db, device, id);
  await deps.db.transaction().execute((trx) => dissolveTrip(trx, trip.id));
}
