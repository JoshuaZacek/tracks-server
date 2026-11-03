import { sql } from 'kysely';
import { z } from 'zod';
import { getMeta, META } from '../../db/meta.ts';
import { META_KEYS } from '../../ingest/schedule/import.ts';
import { scheduleLoaded } from '../reference.ts';
import { darwinEnabled } from '../../app.ts';
import { apnsConfigured } from '../../config/env.ts';
import { readFeedState } from '../../darwin/store.ts';
import { feedHealthy } from '../../live/feed.ts';
import { PlacesDataset, sendPlaces } from './places.ts';
import { ApiError } from '../../http/errors.ts';
import { defineRoute, type AnyRoute } from '../../http/route.ts';
import { DateTime } from '../../http/schemas.ts';
import { toUkIso } from '../../time.ts';
import { version } from '../../version.ts';

/** The worker writes a heartbeat every 30 s; older than this counts as down. */
const WORKER_STALE_MS = 2 * 60_000;

const Health = z.object({ status: z.literal('ok') }).meta({ id: 'Health' });

const Readiness = z
  .object({
    status: z.literal('ok'),
    checks: z.object({ database: z.literal('ok'), schedule: z.literal('ok') }),
  })
  .meta({ id: 'Readiness' });

export const ServerStatus = z
  .object({
    healthy: z.boolean().meta({
      description:
        'Everything that live tracking needs is working: timetable loaded, worker running and, when Darwin is enabled, the feed ' +
        'flowing. Point monitoring at this; `worker.healthy` only says the process is alive.',
    }),
    version: z.string(),
    serverTime: DateTime,
    schedule: z.object({
      loaded: z.boolean(),
      importedAt: DateTime.nullable().meta({ description: 'When this server imported the timetable' }),
      generatedAt: DateTime.nullable().meta({ description: 'When Network Rail generated the extract' }),
    }),
    stations: z.object({ total: z.number().int(), withCoordinates: z.number().int() }),
    darwin: z.object({
      enabled: z.boolean(),
      healthy: z.boolean().meta({ description: 'A message (heartbeats included) arrived in the last 5 minutes' }),
      lastMessageAt: DateTime.nullable(),
      lagSeconds: z.number().nullable().meta({ description: 'How far behind real time the last processed message was' }),
      gapAt: DateTime.nullable().meta({ description: 'When messages were last missed (worker downtime past retention), within the last day' }),
    }),
    trust: z.object({ enabled: z.boolean(), lastMessageAt: DateTime.nullable() }),
    push: z.object({
      enabled: z.boolean().meta({ description: 'APNs credentials configured; otherwise pushes are only logged (dry run)' }),
      sentLastHour: z.number().int(),
      failedLastHour: z.number().int().meta({ description: 'Rejected by APNs or not delivered (dead tokens excluded)' }),
    }),
    worker: z.object({ lastHeartbeatAt: DateTime.nullable(), healthy: z.boolean() }),
  })
  .meta({ id: 'ServerStatus' });

export const systemRoutes: AnyRoute[] = [
  defineRoute({
    method: 'get',
    path: '/health',
    operationId: 'health',
    summary: 'Liveness: the process is up',
    tags: ['System'],
    auth: false,
    response: { status: 200, description: 'Alive', schema: Health },
    handler: () => ({ status: 'ok' as const }),
  }),
  defineRoute({
    method: 'get',
    path: '/ready',
    operationId: 'ready',
    summary: 'Readiness: dependencies reachable',
    description: 'Database reachable and a timetable imported; otherwise 503.',
    tags: ['System'],
    auth: false,
    response: { status: 200, description: 'Ready', schema: Readiness },
    errors: [503],
    async handler({ deps }) {
      try {
        await sql`SELECT 1`.execute(deps.db);
      } catch {
        throw new ApiError(503, 'service_unavailable', 'Database unreachable');
      }
      if (!(await scheduleLoaded(deps.db))) throw new ApiError(503, 'schedule_not_loaded', 'The timetable has not been imported yet');
      return { status: 'ok' as const, checks: { database: 'ok' as const, schedule: 'ok' as const } };
    },
  }),
  defineRoute({
    method: 'get',
    path: '/v1/status',
    operationId: 'getStatus',
    summary: 'Data freshness and background worker health',
    description: 'TRUST figures are filled in if that feed is added (Phase 6).',
    tags: ['System'],
    auth: false,
    response: { status: 200, description: 'Status', schema: ServerStatus },
    async handler({ deps }) {
      const [heartbeat, importedAt, generatedAt, counts, feed, pushes] = await Promise.all([
        getMeta(deps.db, META.workerHeartbeat),
        getMeta(deps.db, META_KEYS.importedAt),
        getMeta(deps.db, META_KEYS.timestamp),
        sql<{ total: number; with_coordinates: number }>`
          SELECT count(*)::int AS total, count(lat)::int AS with_coordinates FROM stations WHERE in_schedule`.execute(deps.db),
        readFeedState(deps.db),
        sql<{ sent: number; failed: number }>`
          SELECT count(*) FILTER (WHERE outcome = 'sent')::int AS sent, count(*) FILTER (WHERE outcome = 'failed')::int AS failed
          FROM push_log WHERE created_at > now() - interval '1 hour'`.execute(deps.db),
      ]);
      const heartbeatAt = heartbeat ? new Date(heartbeat) : null;
      const iso = (v: string | null) => (v ? toUkIso(new Date(v)) : null);
      const workerHealthy = heartbeatAt !== null && Date.now() - heartbeatAt.getTime() < WORKER_STALE_MS;
      const darwinOk = !darwinEnabled(deps) || feedHealthy(feed);
      return {
        healthy: importedAt !== null && workerHealthy && darwinOk,
        version,
        serverTime: toUkIso(new Date()),
        schedule: { loaded: importedAt !== null, importedAt: iso(importedAt), generatedAt: iso(generatedAt) },
        stations: { total: counts.rows[0]!.total, withCoordinates: counts.rows[0]!.with_coordinates },
        darwin: {
          enabled: darwinEnabled(deps),
          healthy: feedHealthy(feed),
          lastMessageAt: feed ? iso(feed.lastMessageAt) : null,
          lagSeconds: feed?.lagSeconds ?? null,
          gapAt: feed?.gapAt ? iso(feed.gapAt) : null,
        },
        trust: { enabled: false, lastMessageAt: null },
        push: { enabled: apnsConfigured(deps.config), sentLastHour: pushes.rows[0]!.sent, failedLastHour: pushes.rows[0]!.failed },
        worker: {
          lastHeartbeatAt: heartbeatAt ? toUkIso(heartbeatAt) : null,
          healthy: workerHealthy,
        },
      };
    },
  }),
  defineRoute({
    method: 'get',
    path: '/v1/reference/places',
    operationId: 'getPlaces',
    summary: 'Place names for on-device nearest-town labels',
    description:
      'OS Open Names cities, towns, villages and suburbs. Download once and revalidate with `If-None-Match`. ' +
      'Each place is [name, lat×1e5, lon×1e5, typeIndex, (south, west, north, east)×1e5 for cities and towns]. ' +
      'Attribution: "Contains OS data © Crown copyright and database right".',
    tags: ['Reference'],
    auth: true,
    response: { status: 200, description: 'The place dataset (gzip-encoded when accepted; 304 when the ETag matches)', schema: PlacesDataset },
    handler: ({ req, res }) => {
      sendPlaces(req, res);
      return undefined;
    },
  }),
];
