import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Config } from './config/env.ts';
import type { Db } from './db/client.ts';
import type { Logger } from './logger.ts';
import type { Lookups } from './live/lookups.ts';
import { createAuthenticator } from './http/middleware/auth.ts';
import { createErrorHandler, notFoundHandler } from './http/middleware/errorHandler.ts';
import { createGlobalLimiter, createRegistrationLimiter, createSharedLimiter } from './http/middleware/rateLimit.ts';
import { mountSharePages } from './modules/shares/pages.ts';
import { buildOpenApiDocument } from './http/openapi.ts';
import { mountRoutes } from './http/route.ts';
import { routes } from './routes.ts';

export interface AppDeps {
  config: Config;
  db: Db;
  log: Logger;
  /** The current time; injectable so time-dependent behaviour can be tested. */
  now: () => Date;
  /** TIPLOC and station lookups for live data. */
  lookups: Lookups;
}

/** Whether this server consumes Darwin (live data); without it, journeys show timetable data. */
export const darwinEnabled = (deps: Pick<AppDeps, 'config'>) => Boolean(deps.config.rdm.darwin.bootstrap);

export function createApp(deps: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', deps.config.trustProxy);
  app.set('query parser', 'simple');

  app.use(helmet());
  app.use(
    pinoHttp({
      logger: deps.log,
      autoLogging: { ignore: (req) => req.url === '/health' },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    }),
  );
  const limits = { skipLoopback: !deps.config.isProduction };
  app.use(createGlobalLimiter(limits));
  app.use(express.json({ limit: '32kb' }));

  const openapi = buildOpenApiDocument(routes);
  app.get('/v1/openapi.json', (_req, res) => {
    res.json(openapi);
  });

  // One limiter for the share JSON and page, so a viewer's page and its polling count together.
  const shared = createSharedLimiter(limits);
  const router = express.Router();
  mountRoutes(router, routes, {
    deps,
    authenticate: createAuthenticator(deps.db),
    limiters: { registration: createRegistrationLimiter(limits), shared },
  });
  mountSharePages(router, deps, shared);
  app.use(router);

  app.use(notFoundHandler);
  app.use(createErrorHandler(deps.log));
  return app;
}
