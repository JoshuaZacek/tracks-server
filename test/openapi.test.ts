import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildOpenApiDocument } from '../src/http/openapi.ts';
import { routes } from '../src/routes.ts';
import * as devices from '../src/modules/devices/schemas.ts';
import * as journeys from '../src/modules/journeys/schemas.ts';
import * as templates from '../src/modules/journey-templates/schemas.ts';
import * as stations from '../src/modules/stations/schemas.ts';
import * as trains from '../src/modules/trains/schemas.ts';
import * as trips from '../src/modules/trips/schemas.ts';
import * as common from '../src/http/schemas.ts';
import * as system from '../src/modules/system/routes.ts';

type JsonSchema = { type?: string | string[]; anyOf?: JsonSchema[]; $ref?: string; properties?: Record<string, JsonSchema>; required?: string[] };

const doc = buildOpenApiDocument(routes);
const components = doc.components!.schemas as Record<string, JsonSchema>;

/** Every exported zod object schema with an OpenAPI component name. */
const named = [devices, journeys, templates, stations, trains, trips, common, system]
  .flatMap((m) => Object.values(m))
  .filter((s): s is z.ZodObject => s instanceof z.ZodObject && typeof s.meta()?.id === 'string');

const allowsNull = (s: JsonSchema): boolean =>
  (Array.isArray(s.type) ? s.type.includes('null') : s.type === 'null') || (s.anyOf ?? []).some(allowsNull);

describe('OpenAPI document', () => {
  it('names every exported schema as a component', () => {
    expect(named.length).toBeGreaterThan(20);
    for (const schema of named) expect(components, schema.meta()!.id as string).toHaveProperty(schema.meta()!.id as string);
  });

  // The iOS app's Codable models come from this document: a field that is nullable in zod but not in
  // OpenAPI (or optional vs required) would crash decoding at runtime instead of failing a test here.
  it.each(named.map((s) => [s.meta()!.id as string, s] as const))('%s matches its zod schema (nullability and required)', (id, schema) => {
    const component = components[id]!;
    for (const [key, field] of Object.entries(schema.shape)) {
      const prop = component.properties?.[key];
      expect(prop, `${id}.${key} missing`).toBeDefined();
      expect(allowsNull(prop!), `${id}.${key} nullability`).toBe(field.safeParse(null).success);
      const optional = field.safeParse(undefined).success;
      expect((component.required ?? []).includes(key), `${id}.${key} required`).toBe(!optional);
    }
  });

  it('has the Sprint 3 schemas: divides and loading on the live status, loading on the summary, station messages on the journey', () => {
    for (const id of ['TrainDivision', 'DivisionPortion', 'TrainLoading', 'CoachLoad', 'LoadingLevel', 'StationMessage']) expect(components).toHaveProperty(id);
    const ref = (s: JsonSchema | undefined): string[] => [s?.$ref ?? '', ...(s?.anyOf ?? []).flatMap(ref)].filter(Boolean);
    expect(ref(components.LiveStatus!.properties!.divides)).toContain('#/components/schemas/TrainDivision');
    expect(ref(components.LiveStatus!.properties!.loading)).toContain('#/components/schemas/TrainLoading');
    expect(ref(components.LiveSummary!.properties!.loading)).toContain('#/components/schemas/TrainLoading');
    expect(components.Journey!.required).toContain('stationMessages');
    expect(components.JourneyPrefs!.properties).toHaveProperty('divides');
    expect(components.JourneyPrefsUpdate!.properties).toHaveProperty('divides');
    expect(components.NotificationPrefs!.properties).toHaveProperty('divides');
  });

  it('has an operationId on every operation, and they are unique', () => {
    const ids = Object.values(doc.paths!).flatMap((p) => Object.values(p as Record<string, { operationId?: string }>).map((op) => op.operationId));
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('requires bearer auth everywhere except health, readiness, status and registration', () => {
    const open = new Set(['health', 'ready', 'getStatus', 'registerDevice']);
    for (const route of routes) expect(route.auth, route.operationId).toBe(!open.has(route.operationId));
  });
});
