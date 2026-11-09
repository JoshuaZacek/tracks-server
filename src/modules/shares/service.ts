import { randomBytes } from 'node:crypto';
import type { z } from 'zod';
import type { AppDeps } from '../../app.ts';
import type { DeviceRow, JourneyRow } from '../../db/types.ts';
import { operatorName } from '../../domain/operators.ts';
import { ApiError } from '../../http/errors.ts';
import { toUkIso } from '../../time.ts';
import type { LiveStatus } from '../journeys/schemas.ts';
import { findOwned, liveStatusOf, readContext } from '../journeys/service.ts';
import type { CallingPoint } from '../trains/schemas.ts';
import { loadShares, shareOut } from './links.ts';
import { ShareToken, type SharedJourney } from './schemas.ts';

type CallingPointOut = z.input<typeof CallingPoint>;
type LiveStatusOut = z.input<typeof LiveStatus>;

/** A link works until this long after the scheduled arrival. */
export const SHARE_AFTER_ARRIVAL_MS = 6 * 3600_000;

const FOREIGN_KEY_VIOLATION = '23503';

export const newShareToken = () => randomBytes(16).toString('base64url');

/**
 * Shares a journey: the link already working for it, else a new one. A journey
 * that has finished (past its scheduled arrival + 6 h) has nothing left to share.
 */
export async function createShare(deps: AppDeps, device: DeviceRow, id: string) {
  const row = await findOwned(deps, device, id);
  const now = deps.now();
  const existing = (await loadShares(deps.db, [row], now)).get(row.id);
  if (existing) return { share: shareOut(deps.config.publicUrl, existing), created: false };
  const expires = new Date(row.scheduled_arrival.getTime() + SHARE_AFTER_ARRIVAL_MS);
  if (expires <= now) throw new ApiError(422, 'journey_over', 'This journey has finished, so there is nothing to share');
  try {
    const share = await deps.db
      .insertInto('journey_shares')
      .values({ token: newShareToken(), journey_id: row.id, expires_at: expires })
      .returningAll()
      .executeTakeFirstOrThrow();
    return { share: shareOut(deps.config.publicUrl, share), created: true };
  } catch (err) {
    // Deleted between finding it and sharing it (foreign key violation): as if it was never there.
    if ((err as { code?: string }).code === FOREIGN_KEY_VIOLATION) throw ApiError.notFound('journey_not_found', 'No such journey');
    throw err;
  }
}

/** Stops sharing: every link to the journey stops working. */
export async function revokeShares(deps: AppDeps, device: DeviceRow, id: string) {
  const row = await findOwned(deps, device, id);
  await deps.db.updateTable('journey_shares').set({ revoked_at: deps.now() }).where('journey_id', '=', row.id).where('revoked_at', 'is', null).execute();
}

const notShared = () => ApiError.notFound('share_not_found', 'This journey is not shared, or the link has expired');

/** The public view of a shared journey; 404 for an unknown, revoked or expired token. */
export async function getShared(deps: AppDeps, token: string): Promise<z.input<typeof SharedJourney>> {
  if (!ShareToken.safeParse(token).success) throw notShared();
  const now = deps.now();
  const found = await deps.db
    .selectFrom('journey_shares')
    .innerJoin('journeys', 'journeys.id', 'journey_shares.journey_id')
    .selectAll('journeys')
    .select(['journey_shares.expires_at as share_expires_at'])
    .where('journey_shares.token', '=', token)
    .where('journey_shares.revoked_at', 'is', null)
    .where('journey_shares.expires_at', '>', now)
    .executeTakeFirst();
  if (!found) throw notShared();
  const { share_expires_at, ...row } = found;
  return sharedView(row, liveStatusOf(row, await readContext(deps)), share_expires_at);
}

/** Only the train and my two stations, from the journey and its live status. */
export function sharedView(row: JourneyRow, status: LiveStatusOut, expiresAt: Date): z.input<typeof SharedJourney> {
  const calls = row.calling_points as CallingPointOut[];
  const station = (c: CallingPointOut) => ({ crs: c.crs, name: c.name, lat: c.lat, lon: c.lon });
  const dest = status.progress?.stops.at(-1);
  // Before live data, my stops from the timetable.
  const stops =
    status.progress?.stops ??
    calls.slice(row.from_index, row.to_index + 1).map((c, i) => ({
      crs: c.crs,
      name: c.name,
      scheduled: (i === 0 ? c.scheduledDeparture : (c.scheduledArrival ?? c.scheduledDeparture))!,
      expected: null,
      actual: null,
      passed: false,
      isCancelled: false,
      delayMinutes: null,
      platform: null,
    }));
  return {
    headcode: row.headcode,
    operator: { code: row.toc, name: operatorName(row.toc || null) },
    from: station(calls[row.from_index]!),
    to: station(calls[row.to_index]!),
    scheduledDeparture: toUkIso(row.scheduled_departure),
    scheduledArrival: toUkIso(row.scheduled_arrival),
    state: status.state,
    message: status.message,
    stale: status.stale,
    checkedAt: status.checkedAt,
    nextPollSeconds: status.nextPollSeconds,
    expectedDeparture: status.service?.expectedDeparture ?? null,
    actualDeparture: status.service?.actualDeparture ?? null,
    expectedArrival: dest?.expected ?? null,
    actualArrival: dest?.actual ?? null,
    delayMinutes: status.service?.delayMinutes ?? null,
    platform: status.service?.platform ?? null,
    isCancelled: status.service?.isCancelled ?? status.state === 'cancelled',
    stops,
    position: status.position,
    expiresAt: toUkIso(expiresAt),
  };
}
