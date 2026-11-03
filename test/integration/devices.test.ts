import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, registerDevice, resetData } from '../helpers.ts';

const { db, api } = createTestContext();
beforeEach(() => resetData(db));
afterAll(() => db.destroy());

describe('devices and auth', () => {
  it('registers a device and returns a token once, storing only its hash', async () => {
    const { deviceId, token } = await registerDevice(api);
    expect(token).toMatch(/^trk_[A-Za-z0-9_-]{43}$/);
    const row = await db.selectFrom('devices').selectAll().where('id', '=', deviceId).executeTakeFirstOrThrow();
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it('GET /v1/devices/me returns the device with default preferences', async () => {
    const { deviceId, auth } = await registerDevice(api);
    const res = await api().get('/v1/devices/me').set(auth).expect(200);
    expect(res.body).toMatchObject({
      deviceId,
      apnsTokenRegistered: false,
      apnsEnvironment: 'production',
      pushToStartTokenRegistered: false,
      appVersion: '1.0 (1)',
      locale: 'en_GB',
      prefs: { delays: true, platforms: true, cancellations: true, departure: true, arrival: true, delayThresholdMinutes: 5 },
    });
    expect(res.body.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(res.body).not.toHaveProperty('token_hash');
  });

  it('PATCH /v1/devices/me updates tokens and merges preferences', async () => {
    const { auth } = await registerDevice(api);
    const apnsToken = 'AB'.repeat(32);
    const res = await api()
      .patch('/v1/devices/me')
      .set(auth)
      .send({ apnsToken, apnsEnvironment: 'sandbox', prefs: { delays: false, delayThresholdMinutes: 10 } })
      .expect(200);
    expect(res.body).toMatchObject({ apnsTokenRegistered: true, apnsEnvironment: 'sandbox' });
    expect(res.body.prefs).toMatchObject({ delays: false, delayThresholdMinutes: 10, platforms: true });

    const row = await db.selectFrom('devices').select('apns_token').executeTakeFirstOrThrow();
    expect(row.apns_token).toBe(apnsToken.toLowerCase());

    const cleared = await api().patch('/v1/devices/me').set(auth).send({ apnsToken: null }).expect(200);
    expect(cleared.body.apnsTokenRegistered).toBe(false);
  });

  it('rejects invalid bodies with field-level details', async () => {
    const { auth } = await registerDevice(api);
    const res = await api().patch('/v1/devices/me').set(auth).send({ apnsToken: 'not-hex', prefs: { delayThresholdMinutes: 0 } }).expect(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(['apnsToken', 'prefs.delayThresholdMinutes']);
  });

  it('rejects malformed JSON', async () => {
    const res = await api().post('/v1/devices').set('Content-Type', 'application/json').send('{"appVersion":').expect(400);
    expect(res.body.error.code).toBe('invalid_json');
  });

  it('DELETE /v1/devices/me removes the device and invalidates the token', async () => {
    const { auth } = await registerDevice(api);
    await api().delete('/v1/devices/me').set(auth).expect(204);
    const res = await api().get('/v1/devices/me').set(auth).expect(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it.each([
    ['no header', {}],
    ['wrong scheme', { Authorization: 'Basic abc' }],
    ['malformed token', { Authorization: 'Bearer nope' }],
    ['unknown token', { Authorization: `Bearer trk_${'A'.repeat(43)}` }],
  ])('rejects requests with %s', async (_label, headers) => {
    const res = await api().get('/v1/journeys').set(headers).expect(401);
    expect(res.body.error.code).toBe('unauthorized');
  });
});

describe('endpoints from later phases', () => {
  it('validate input before reporting not_implemented', async () => {
    const { auth } = await registerDevice(api);
    const bad = await api().put('/v1/journeys/not-a-uuid/live-activity').set(auth).send({ pushToken: 'ab'.repeat(32) }).expect(400);
    expect(bad.body.error.code).toBe('validation_failed');

    const res = await api().put('/v1/journeys/7f1c2a52-8a43-4b8e-9d0a-3c1f9e2b6d11/live-activity').set(auth).send({ pushToken: 'ab'.repeat(32) }).expect(501);
    expect(res.body.error).toEqual({ code: 'not_implemented', message: 'Not implemented yet (Phase 5: push)' });
  });
});
