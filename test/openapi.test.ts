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
import * as shares from '../src/modules/shares/schemas.ts';
import * as common from '../src/http/schemas.ts';
import * as system from '../src/modules/system/routes.ts';

type JsonSchema = { type?: string | string[]; anyOf?: JsonSchema[]; $ref?: string; properties?: Record<string, JsonSchema>; required?: string[] };

const doc = buildOpenApiDocument(routes);
const components = doc.components!.schemas as Record<string, JsonSchema>;

/** Every exported zod object schema with an OpenAPI component name. */
const named = [devices, journeys, templates, stations, trains, trips, shares, common, system]
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

  it('has the Sprint 4 schemas: a Delay Repay claim and a share on journeys, and the public shared journey', () => {
    for (const id of ['DelayRepayClaim', 'DelayRepayBand', 'JourneyShare', 'SharedJourney', 'ClaimUpdate']) expect(components).toHaveProperty(id);
    const ref = (s: JsonSchema | undefined): string[] => [s?.$ref ?? '', ...(s?.anyOf ?? []).flatMap(ref)].filter(Boolean);
    for (const id of ['Journey', 'JourneyListItem']) {
      expect(ref(components[id]!.properties!.claim)).toContain('#/components/schemas/DelayRepayClaim');
      expect(ref(components[id]!.properties!.share)).toContain('#/components/schemas/JourneyShare');
      expect(allowsNull(components[id]!.properties!.claim!)).toBe(true);
      expect(allowsNull(components[id]!.properties!.share!)).toBe(true);
    }
    expect(ref(components.DelayRepayClaim!.properties!.band)).toContain('#/components/schemas/DelayRepayBand');
    expect(components.UpdateJourneyRequest!.properties).toHaveProperty('claim');
    for (const id of ['JourneyPrefs', 'JourneyPrefsUpdate', 'NotificationPrefs']) expect(components[id]!.properties).toHaveProperty('delayRepay');
    // Nothing private in the public view.
    const shared = Object.keys(components.SharedJourney!.properties!);
    for (const key of ['id', 'prefs', 'deviceId', 'trainUid', 'claim', 'share', 'trip', 'templateId', 'travelMinutes']) expect(shared).not.toContain(key);
    const paths = doc.paths as Record<string, Record<string, unknown>>;
    expect(paths['/v1/journeys/{id}/share']).toHaveProperty('post');
    expect(paths['/v1/journeys/{id}/share']).toHaveProperty('delete');
    expect(paths['/v1/shared/{token}']).toHaveProperty('get');
  });

  it('has an operationId on every operation, and they are unique', () => {
    const ids = Object.values(doc.paths!).flatMap((p) => Object.values(p as Record<string, { operationId?: string }>).map((op) => op.operationId));
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('requires bearer auth everywhere except health, readiness, status, registration and shared journeys', () => {
    const open = new Set(['health', 'ready', 'getStatus', 'registerDevice', 'getSharedJourney']);
    for (const route of routes) expect(route.auth, route.operationId).toBe(!open.has(route.operationId));
  });
});
