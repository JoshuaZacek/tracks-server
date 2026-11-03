import type { Request } from 'express';
import { rateLimit, type Options } from 'express-rate-limit';
import { ApiError } from '../errors.ts';

/**
 * In-memory limits: fine for the single API process the plan deploys. If the
 * API is ever scaled out, move these to a shared store (Postgres or Redis).
 *
 * Limits are per client IP (IPv6 grouped by /56). Many users can share one
 * public IP (train and station Wi-Fi, carrier CGNAT, offices), so they are set
 * well above what one person needs; they stop floods, not individuals. The real
 * abuse control for registration is App Attest (later).
 */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function common(skipLoopback: boolean): Partial<Options> {
  return {
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    // Local development and test runs can't lock themselves out.
    skip: (req: Request) => skipLoopback && LOOPBACK.has(req.ip ?? ''),
    handler: (_req, _res, next) => next(new ApiError(429, 'rate_limited', 'Too many requests; slow down')),
  };
}

/** Every request, per client IP. */
export const createGlobalLimiter = (opts: { skipLoopback: boolean }) =>
  rateLimit({ ...common(opts.skipLoopback), windowMs: 60_000, limit: 600 });

/** Device registration, per client IP: real installs register once, but a train full of people may share one IP. */
export const createRegistrationLimiter = (opts: { skipLoopback: boolean }) =>
  rateLimit({ ...common(opts.skipLoopback), windowMs: 10 * 60_000, limit: 120 });
