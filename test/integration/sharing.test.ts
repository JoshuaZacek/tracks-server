import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseMessage } from '../../src/darwin/parse.ts';
import { DarwinBatch, flushBatch, recordFeed } from '../../src/darwin/store.ts';
import { importSchedule } from '../../src/ingest/schedule/import.ts';
import { resetFeedCache } from '../../src/live/feed.ts';
import { journeysForRuns, updateJourneys } from '../../src/live/updater.ts';
import { SHARED_LIMIT_PER_MINUTE } from '../../src/http/middleware/rateLimit.ts';
import { createTestContext, registerDevice, resetData } from '../helpers.ts';

const FIXTURE = fileURLToPath(new URL('../fixtures/schedule-mini.ndjson', import.meta.url));
const RID = '202611031234567';

let clock = new Date('2026-11-03T16:40:00Z');
const { db, api, config, lookups } = createTestContext({ now: () => clock, darwin: true });
let auth: { Authorization: string };
let deviceId: string;
let token: string;
let seq = 1;

const message = (uR: object) =>
  JSON.stringify({ bytes: JSON.stringify({ ts: clock.toISOString(), version: '18.0', uR }), properties: { PushPortSequence: { string: String(seq++) } } });

async function deliver(...uRs: object[]) {
  const batch = new DarwinBatch();
  for (const uR of uRs) batch.add(parseMessage(message(uR)), clock.getTime());
  await lookups.ready(0);
  await flushBatch(db, batch, lookups.crsOf);
  await updateJourneys({ db, lookups, now: () => clock, darwinEnabled: true, feedHealthy: () => true }, await journeysForRuns(db, batch.touched()));
}

const SCHEDULE = {
  schedule: {
    rid: RID, uid: 'A00001', ssd: '2026-11-03', toc: 'GR', trainId: '1S25',
    OR: { tpl: 'KNGX', ptd: '17:00', wtd: '17:00' },
    IP: [{ tpl: 'PBRO', pta: '17:45', ptd: '17:47', wta: '17:45', wtd: '17:47' }, { tpl: 'YORK', pta: '19:00', ptd: '19:03', wta: '19:00', wtd: '19:03' }],
    DT: { tpl: 'EDINBUR', pta: '21:30', wta: '21:30' },
  },
};
const TS = { TS: { rid: RID, uid: 'A00001', ssd: '2026-11-03', Location: { tpl: 'KNGX', ptd: '17:00', wtd: '17:00', dep: { et: '17:08' }, plat: { conf: 'true', '': '7' } } } };

const save = async () => (await api().post('/v1/journeys').set(auth).send({ trainUid: 'A00001', runDate: '2026-11-03', fromCrs: 'KGX', toCrs: 'YRK' }).expect(201)).body;
const share = (id: string) => api().post(`/v1/journeys/${id}/share`).set(auth);
const tokenOf = (url: string) => url.split('/s/')[1]!;

beforeAll(async () => {
  await importSchedule(config.databaseUrl, FIXTURE, () => {});
});
beforeEach(async () => {
  clock = new Date('2026-11-03T16:40:00Z');
  await resetData(db);
  await sql`INSERT INTO meta (key, value) VALUES ('schedule_imported_at', now()::text)`.execute(db);
  await recordFeed(db, { lastMessageAt: clock.toISOString(), lagSeconds: 0.3, gapAt: null });
  resetFeedCache();
  ({ auth, deviceId, token } = await registerDevice(api));
});
afterAll(() => db.destroy());

describe('sharing a journey', () => {
  it('makes a link (random 128-bit token) that lasts until 6 h after the scheduled arrival, and gives the same one again', async () => {
    const journey = await save();
    expect(journey.share).toBeNull();
    const first = (await share(journey.id).expect(201)).body;
    expect(first.url).toMatch(/^http:\/\/localhost:3000\/s\/[A-Za-z0-9_-]{22}$/);
    expect(first.expiresAt).toBe('2026-11-04T01:00:00+00:00');
    expect((await share(journey.id).expect(200)).body).toEqual(first);
    expect((await api().get(`/v1/journeys/${journey.id}`).set(auth).expect(200)).body.share).toEqual(first);
    const list = (await api().get('/v1/journeys').set(auth).expect(200)).body.journeys;
    expect(list[0].share).toEqual(first);
  });

  it('shows the train to anyone with the link, with no device, journey or preference data', async () => {
    const journey = await save();
    await api().patch(`/v1/journeys/${journey.id}`).set(auth).send({ prefs: { stopAlarm: true }, travelMinutes: 12 }).expect(200);
    await deliver(SCHEDULE, TS);
    const link = (await share(journey.id).expect(201)).body;
    const res = await api().get(`/v1/shared/${tokenOf(link.url)}`).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.body;
    expect(Object.keys(body).sort()).toEqual(
      [
        'actualArrival', 'actualDeparture', 'checkedAt', 'delayMinutes', 'expectedArrival', 'expectedDeparture', 'expiresAt', 'from',
        'headcode', 'isCancelled', 'message', 'nextPollSeconds', 'operator', 'platform', 'position', 'scheduledArrival',
        'scheduledDeparture', 'stale', 'state', 'stops', 'to',
      ].sort(),
    );
    expect(body).toMatchObject({
      headcode: '1S25',
      operator: { code: 'GR', name: 'LNER' },
      from: { crs: 'KGX', name: 'London Kings Cross' },
      to: { crs: 'YRK', name: 'York' },
      state: 'live',
      expectedDeparture: '2026-11-03T17:08:00+00:00',
      delayMinutes: 8,
      platform: { number: '7', confirmed: true },
      expiresAt: '2026-11-04T01:00:00+00:00',
    });
    expect(body.stops.map((s: { crs: string }) => s.crs)).toEqual(['KGX', 'PBO', 'YRK']);
    const text = JSON.stringify(body);
    for (const secret of [journey.id, deviceId, token, tokenOf(link.url), 'prefs', 'stopAlarm', 'travelMinutes', 'trainUid', 'A00001', RID]) {
      expect(text, secret).not.toContain(secret);
    }
  });

  it('shows the timetable before there is live data', async () => {
    const journey = await save();
    const link = (await share(journey.id).expect(201)).body;
    const body = (await api().get(`/v1/shared/${tokenOf(link.url)}`).expect(200)).body;
    expect(body).toMatchObject({ state: 'scheduled', delayMinutes: null, platform: null, position: null });
    expect(body.stops.map((s: { crs: string; scheduled: string }) => [s.crs, s.scheduled])).toEqual([
      ['KGX', '2026-11-03T17:00:00+00:00'],
      ['PBO', '2026-11-03T17:45:00+00:00'],
      ['YRK', '2026-11-03T19:00:00+00:00'],
    ]);
  });

  it('serves a small page that polls the JSON, with no inline script', async () => {
    const journey = await save();
    const link = (await share(journey.id).expect(201)).body;
    const res = await api().get(`/s/${tokenOf(link.url)}`).expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.text).toContain('London Kings Cross');
    expect(res.text).toContain('York');
    expect(res.text).toContain('<script src="/s/share.js" defer></script>');
    expect(res.text).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(res.text).not.toContain(journey.id);

    const js = await api().get('/s/share.js').expect(200);
    expect(js.headers['content-type']).toMatch(/javascript/);
    expect(js.text).toContain('/v1/shared/');
  });

  it('is gone (404) once revoked, and sharing again makes a new link', async () => {
    const journey = await save();
    const link = (await share(journey.id).expect(201)).body;
    await api().delete(`/v1/journeys/${journey.id}/share`).set(auth).expect(204);
    const gone = await api().get(`/v1/shared/${tokenOf(link.url)}`).expect(404);
    expect(gone.body.error.code).toBe('share_not_found');
    await api().get(`/s/${tokenOf(link.url)}`).expect(404).expect('content-type', /^text\/html/);
    expect((await api().get(`/v1/journeys/${journey.id}`).set(auth).expect(200)).body.share).toBeNull();
    // Stopping when nothing is shared is fine.
    await api().delete(`/v1/journeys/${journey.id}/share`).set(auth).expect(204);

    const again = (await share(journey.id).expect(201)).body;
    expect(again.url).not.toBe(link.url);
    await api().get(`/v1/shared/${tokenOf(again.url)}`).expect(200);
  });

  it('is gone (404) once expired, and a finished journey cannot be shared', async () => {
    const journey = await save();
    const link = (await share(journey.id).expect(201)).body;
    clock = new Date('2026-11-04T00:59:59Z');
    await api().get(`/v1/shared/${tokenOf(link.url)}`).expect(200);
    clock = new Date('2026-11-04T01:00:00Z');
    await api().get(`/v1/shared/${tokenOf(link.url)}`).expect(404);
    await api().get(`/s/${tokenOf(link.url)}`).expect(404);
    expect((await api().get(`/v1/journeys/${journey.id}`).set(auth).expect(200)).body.share).toBeNull();
    const over = await share(journey.id).expect(422);
    expect(over.body.error.code).toBe('journey_over');
  });

  it('goes with the journey, and nobody else can share or stop sharing it', async () => {
    const journey = await save();
    const link = (await share(journey.id).expect(201)).body;
    const other = await registerDevice(api);
    await api().post(`/v1/journeys/${journey.id}/share`).set(other.auth).expect(404);
    await api().delete(`/v1/journeys/${journey.id}/share`).set(other.auth).expect(404);
    await api().get(`/v1/shared/${tokenOf(link.url)}`).expect(200);
    await api().delete(`/v1/journeys/${journey.id}`).set(auth).expect(204);
    await api().get(`/v1/shared/${tokenOf(link.url)}`).expect(404);
  });

  it('rejects malformed tokens as not found', async () => {
    await api().get('/v1/shared/not-a-token').expect(404);
    await api().get('/v1/shared/AAAAAAAAAAAAAAAAAAAAAA').expect(404);
    await api().get('/s/%3Cscript%3E').expect(404);
  });
});

describe('rate limits on the public share routes', () => {
  // In production, loopback isn't exempt, so the limit applies to these test requests.
  const prod = createTestContext({ now: () => clock, production: true });
  afterAll(() => prod.db.destroy());

  it(`allows ${SHARED_LIMIT_PER_MINUTE} a minute per client, then 429`, async () => {
    for (let i = 0; i < SHARED_LIMIT_PER_MINUTE; i++) await prod.api().get('/v1/shared/AAAAAAAAAAAAAAAAAAAAAA').expect(404);
    const limited = await prod.api().get('/v1/shared/AAAAAAAAAAAAAAAAAAAAAA').expect(429);
    expect(limited.body.error.code).toBe('rate_limited');
    await prod.api().get('/s/AAAAAAAAAAAAAAAAAAAAAA').expect(429);
  });
});
