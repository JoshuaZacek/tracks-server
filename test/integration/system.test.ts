import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { META, setMeta } from '../../src/db/meta.ts';
import { createTestContext, resetData } from '../helpers.ts';

const { db, api } = createTestContext();
beforeEach(() => resetData(db));
afterAll(() => db.destroy());

const ISO_NO_FRACTION = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

describe('system endpoints', () => {
  it('GET /health', async () => {
    const res = await api().get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /ready is 503 until a timetable is imported', async () => {
    const res = await api().get('/ready').expect(503);
    expect(res.body.error.code).toBe('schedule_not_loaded');
  });

  it('GET /v1/status reports a missing worker as unhealthy', async () => {
    const res = await api().get('/v1/status').expect(200);
    expect(res.body.worker).toEqual({ lastHeartbeatAt: null, healthy: false });
    expect(res.body.healthy).toBe(false);
    expect(res.body.serverTime).toMatch(ISO_NO_FRACTION);
  });

  it('GET /v1/status reports a recent heartbeat as healthy', async () => {
    await setMeta(db, META.workerHeartbeat, new Date().toISOString());
    const res = await api().get('/v1/status').expect(200);
    expect(res.body.worker.healthy).toBe(true);
    expect(res.body.worker.lastHeartbeatAt).toMatch(ISO_NO_FRACTION);
  });

  it('GET /v1/openapi.json serves the document', async () => {
    const res = await api().get('/v1/openapi.json').expect(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(res.body.paths['/v1/journeys']).toBeDefined();
  });

  it('unknown routes return the error envelope', async () => {
    const res = await api().get('/v1/nope').expect(404);
    expect(res.body).toEqual({ error: { code: 'not_found', message: 'No route for GET /v1/nope' } });
  });
});
