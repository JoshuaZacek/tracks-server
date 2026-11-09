import type { z } from 'zod';
import type { Db } from '../../db/client.ts';
import type { JourneyRow, JourneyShareRow } from '../../db/types.ts';
import { toUkIso } from '../../time.ts';
import type { JourneyShare } from '../journeys/schemas.ts';

export const shareUrl = (publicUrl: string, token: string) => `${publicUrl}/s/${token}`;

/** The working (not revoked, not expired) share of each of these journeys, by journey id. */
export async function loadShares(db: Db, rows: readonly JourneyRow[], now: Date): Promise<Map<string, JourneyShareRow>> {
  const shares = new Map<string, JourneyShareRow>();
  if (!rows.length) return shares;
  const found = await db
    .selectFrom('journey_shares')
    .selectAll()
    .where('journey_id', 'in', rows.map((r) => r.id))
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', now)
    .orderBy('created_at')
    .execute();
  for (const s of found) shares.set(s.journey_id, s);
  return shares;
}

export const shareOut = (publicUrl: string, s: Pick<JourneyShareRow, 'token' | 'expires_at'>): z.input<typeof JourneyShare> => ({
  url: shareUrl(publicUrl, s.token),
  expiresAt: toUkIso(s.expires_at),
});
