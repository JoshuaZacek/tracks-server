import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import type { AnyRoute } from './route.ts';
import { registerOpenApi } from './route.ts';
import { version } from '../version.ts';

/** Builds the OpenAPI 3.1 document from the route definitions (no database needed). */
export function buildOpenApiDocument(routes: readonly AnyRoute[]) {
  const registry = new OpenAPIRegistry();
  registry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    description: 'Device token from POST /v1/devices',
  });
  registerOpenApi(registry, routes);
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'tracks API',
      version,
      description:
        'Backend for the tracks iOS app. Times are ISO 8601 with the UK offset and no fractional seconds; ' +
        'dates are YYYY-MM-DD (UK); station codes are upper-case CRS. Errors use the `Error` envelope with a stable `code`.',
    },
    servers: [{ url: 'http://localhost:3000', description: 'Local development' }],
  });
}
