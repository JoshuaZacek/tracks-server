import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import type { Request } from 'express';
import type { Db } from '../../db/client.ts';
import type { DeviceRow } from '../../db/types.ts';
import { ApiError } from '../errors.ts';

/**
 * Anonymous per-install auth. POST /v1/devices hands out a random bearer token
 * once; only its SHA-256 is stored, so a database leak doesn't leak tokens.
 */
const TOKEN_PREFIX = 'trk_';
const TOKEN_PATTERN = /^trk_[A-Za-z0-9_-]{43}$/;
/** Write last_seen_at at most this often per device, so reads don't turn into writes. */
const LAST_SEEN_RESOLUTION_MS = 60 * 60 * 1000;

export type AuthedDevice = DeviceRow;

export function newDeviceToken() {
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export function createAuthenticator(db: Db) {
  return async function authenticate(req: Request): Promise<AuthedDevice> {
    const header = req.get('authorization') ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token || !TOKEN_PATTERN.test(token)) throw ApiError.unauthorized();

    const device = await db.selectFrom('devices').selectAll().where('token_hash', '=', hashToken(token)).executeTakeFirst();
    if (!device) throw ApiError.unauthorized();

    if (Date.now() - device.last_seen_at.getTime() > LAST_SEEN_RESOLUTION_MS) {
      await db.updateTable('devices').set({ last_seen_at: sql`now()` }).where('id', '=', device.id).execute();
    }
    return device;
  };
}
