import type { Request, RequestHandler, Response, Router } from 'express';
import type { OpenAPIRegistry, RouteConfig } from '@asteasolutions/zod-to-openapi';
import type { z } from 'zod';
import type { AppDeps } from '../app.ts';
import type { AuthedDevice } from './middleware/auth.ts';
import { ApiError } from './errors.ts';
import { ErrorResponse } from './schemas.ts';

/**
 * One definition per endpoint drives three things: the Express route, input
 * and output validation, and the OpenAPI document the iOS client is generated
 * from. Paths use OpenAPI syntax (`/v1/stations/{crs}`).
 */

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
type AnyObject = z.ZodObject;

export interface RouteContext<P, Q, B, A extends boolean> {
  params: P;
  query: Q;
  body: B;
  /** The calling app install; set on routes with `auth: true`. */
  device: A extends true ? AuthedDevice : null;
  deps: AppDeps;
  req: Request;
  res: Response;
  /** Override the success status (e.g. 200 instead of 201 when nothing was created). */
  setStatus(status: number): void;
}

export interface RouteSpec<
  P extends AnyObject = AnyObject,
  Q extends AnyObject = AnyObject,
  B extends z.ZodType = z.ZodType,
  R extends z.ZodType = z.ZodType,
  A extends boolean = boolean,
> {
  method: Method;
  path: string;
  operationId: string;
  summary: string;
  description?: string;
  tags: string[];
  auth: A;
  /** Named rate limiter to apply in addition to the global one. */
  rateLimit?: 'registration';
  request?: { params?: P; query?: Q; body?: B };
  response: { status: 200 | 201 | 204; description: string; schema?: R };
  /** Error statuses worth documenting besides the defaults (400, 401 on authed routes, 429, 500). */
  errors?: number[];
  handler(ctx: RouteContext<z.output<P>, z.output<Q>, z.output<B>, A>): Promise<z.input<R> | undefined> | z.input<R> | undefined;
}

/** Identity function that pins the generic types, so handlers are checked against their schemas. */
export function defineRoute<P extends AnyObject, Q extends AnyObject, B extends z.ZodType, R extends z.ZodType, A extends boolean>(
  spec: RouteSpec<P, Q, B, R, A>,
): RouteSpec<P, Q, B, R, A> {
  return spec;
}

// Handlers are stored type-erased; defineRoute already checked them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRoute = RouteSpec<any, any, any, any, any>;

const toExpressPath = (path: string) => path.replace(/\{(\w+)\}/g, ':$1');

function parseInput(where: 'params' | 'query' | 'body', schema: z.ZodType | undefined, value: unknown) {
  if (!schema) return undefined;
  const result = schema.safeParse(value ?? {});
  if (result.success) return result.data;
  throw ApiError.validation(
    result.error.issues.map((i) => ({ in: where, path: i.path.join('.') || where, message: i.message })),
    where === 'body' ? 'The request body is not valid' : `The request ${where === 'params' ? 'path' : 'query'} is not valid`,
  );
}

export interface MountOptions {
  deps: AppDeps;
  authenticate: (req: Request) => Promise<AuthedDevice>;
  limiters: Record<NonNullable<AnyRoute['rateLimit']>, RequestHandler>;
}

export function mountRoutes(router: Router, routes: readonly AnyRoute[], { deps, authenticate, limiters }: MountOptions) {
  for (const route of routes) {
    const middleware = route.rateLimit ? [limiters[route.rateLimit]] : [];
    router[route.method](toExpressPath(route.path), ...middleware, async (req: Request, res: Response) => {
      const device = route.auth ? await authenticate(req) : null;
      const params = parseInput('params', route.request?.params, req.params);
      const query = parseInput('query', route.request?.query, req.query);
      const body = parseInput('body', route.request?.body, req.body);

      let status: number = route.response.status;
      const result = await route.handler({ params, query, body, device, deps, req, res, setStatus: (s) => (status = s) });
      // A handler that streams or sends a file (e.g. with caching headers) has already responded.
      if (res.headersSent) return;

      if (status === 204 || !route.response.schema) {
        res.status(status).end();
        return;
      }
      // The response schema doubles as an allow-list: unknown fields are stripped, and a
      // response that breaks the contract is a server bug, never sent to the app.
      const out = route.response.schema.safeParse(result);
      if (!out.success) {
        deps.log.error({ route: route.operationId, issues: out.error.issues }, 'Response does not match its schema');
        throw new ApiError(500, 'internal', 'Internal error');
      }
      res.status(status).json(out.data);
    });
  }
}

const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: 'The request is not valid (`validation_failed`, `invalid_json`)',
  401: 'Missing or unknown device token (`unauthorized`)',
  404: 'Not found',
  429: 'Too many requests (`rate_limited`)',
  500: 'Unexpected server error (`internal`)',
  501: 'Not implemented yet (`not_implemented`)',
  503: 'A data source is not ready (`schedule_not_loaded`, `service_unavailable`)',
};

export function registerOpenApi(registry: OpenAPIRegistry, routes: readonly AnyRoute[]) {
  for (const route of routes) {
    const errorStatuses = new Set([400, 429, 500, ...(route.auth ? [401] : []), ...(route.errors ?? [])]);
    const responses: RouteConfig['responses'] = {
      [route.response.status]: route.response.schema
        ? { description: route.response.description, content: { 'application/json': { schema: route.response.schema } } }
        : { description: route.response.description },
    };
    for (const status of [...errorStatuses].sort()) {
      responses[status] = { description: ERROR_DESCRIPTIONS[status] ?? 'Error', content: { 'application/json': { schema: ErrorResponse } } };
    }
    registry.registerPath({
      method: route.method,
      path: route.path,
      operationId: route.operationId,
      summary: route.summary,
      description: route.description,
      tags: route.tags,
      security: route.auth ? [{ bearerAuth: [] }] : [],
      request: {
        params: route.request?.params,
        query: route.request?.query,
        body: route.request?.body ? { required: true, content: { 'application/json': { schema: route.request.body } } } : undefined,
      },
      responses,
    });
  }
}
