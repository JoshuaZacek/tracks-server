import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { importSchedule } from '../../src/ingest/schedule/import.ts';
import { createTestContext, registerDevice, resetData } from '../helpers.ts';

const FIXTURE = fileURLToPath(new URL('../fixtures/schedule-mini.ndjson', import.meta.url));

/** Tuesday 3 Nov 2026, midday. Tests move the clock as needed. */
let clock = new Date('2026-11-03T12:00:00Z');
const { db, api, config } = createTestContext({ now: () => clock });
let auth: { Authorization: string };

const post = (body: object) => api().post('/v1/journeys').set(auth).send(body);
const list = async (scope: 'upcoming' | 'past') => (await api().get(`/v1/journeys?scope=${scope}`).set(auth).expect(200)).body;
const ids = (body: { journeys: { id: string }[] }) => body.journeys.map((j) => j.id);

beforeAll(async () => {
  await importSchedule(config.databaseUrl, FIXTURE, () => {});
  await db.updateTable('stations').set({ lat: 51.5643, lon: -0.1065, kb_status: 'ok' }).where('crs', '=', 'FPK').execute();
});
beforeEach(async () => {
  clock = new Date('2026-11-03T12:00:00Z');
  await resetData(db);
  // resetData clears meta; mark the timetable imported again.
  await sql`INSERT INTO meta (key, value) VALUES ('schedule_imported_at', now()::text)`.execute(db);
  ({ auth } = await registerDevice(api));
});
afterAll(() => db.destroy());

describe('POST /v1/journeys', () => {
  it('saves a journey with a snapshot of the train and its timetable live status', async () => {
    const res = await post({ trainUid: 'a00001', runDate: '2026-11-03', fromCrs: 'kgx', toCrs: 'YRK' }).expect(201);
    expect(res.body).toMatchObject({
      trainUid: 'A00001',
      runDate: '2026-11-03',
      date: '2026-11-03',
      headcode: '1S25',
      operator: { code: 'GR', name: 'LNER' },
      from: { crs: 'KGX', name: 'London Kings Cross' },
      to: { crs: 'YRK', name: 'York' },
      scheduledDeparture: '2026-11-03T17:00:00+00:00',
      scheduledArrival: '2026-11-03T19:00:00+00:00',
      bookedPlatform: '7',
      prefs: {},
      archivedAt: null,
      fromIndex: 0,
      toIndex: 2,
      live: { state: 'scheduled', stale: false, service: null, progress: null, position: null, nextPollSeconds: 3600 },
    });
    expect(res.body.callingPoints.map((c: { crs: string }) => c.crs)).toEqual(['KGX', 'PBO', 'YRK', 'EDB']);
    expect(res.body.route).toEqual([{ lat: 51.5643, lon: -0.1065, leg: 0, f: 4 / 45 }]);
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns the existing journey (200) when the same trip is saved again', async () => {
    const first = await post({ trainUid: 'A00001', runDate: '2026-11-03', fromCrs: 'KGX', toCrs: 'YRK' }).expect(201);
    const again = await post({ trainUid: 'A00001', runDate: '2026-11-03', fromCrs: 'KGX', toCrs: 'YRK' }).expect(200);
    expect(again.body.id).toBe(first.body.id);
    expect((await list('upcoming')).journeys).toHaveLength(1);
  });

  it("defaults to the train's final stop", async () => {
    const res = await post({ trainUid: 'A00001', runDate: '2026-11-03', fromCrs: 'PBO' }).expect(201);
    expect(res.body).toMatchObject({ to: { crs: 'EDB' }, fromIndex: 1, toIndex: 3, scheduledArrival: '2026-11-03T21:30:00+00:00' });
  });

  it('dates a journey by when I leave my station, even when the train started the day before', async () => {
    const res = await post({ trainUid: 'A00002', runDate: '2026-11-03', fromCrs: 'PBO', toCrs: 'YRK' }).expect(201);
    expect(res.body).toMatchObject({ runDate: '2026-11-03', date: '2026-11-04', scheduledDeparture: '2026-11-04T00:37:00+00:00' });
  });

  it.each([
    ['a station the train does not call at', { trainUid: 'A00001', runDate: '2026-11-03', fromCrs: 'WAT' }, 422, 'station_not_on_route'],
    ['a destination before the boarding station', { trainUid: 'A00001', runDate: '2026-11-03', fromCrs: 'YRK', toCrs: 'KGX' }, 422, 'station_not_on_route'],
    ['boarding at the final stop', { trainUid: 'A00001', runDate: '2026-11-03', fromCrs: 'EDB' }, 422, 'station_not_on_route'],
    ['the same station twice', { trainUid: 'A00001', runDate: '2026-11-03', fromCrs: 'KGX', toCrs: 'KGX' }, 400, 'validation_failed'],
    ['a cancelled run', { trainUid: 'A00003', runDate: '2026-11-03', fromCrs: 'KGX' }, 404, 'train_not_running'],
    ['a run date the timetable does not cover', { trainUid: 'A00001', runDate: '2026-04-01', fromCrs: 'KGX' }, 404, 'train_not_running'],
  ])('rejects %s', async (_label, body, status, code) => {
    expect((await post(body).expect(status)).body.error.code).toBe(code);
  });

  it('accepts a past run the timetable still covers, straight into past', async () => {
    const res = await post({ trainUid: 'A00001', runDate: '2026-11-02', fromCrs: 'KGX', toCrs: 'YRK' }).expect(201);
    expect(ids(await list('past'))).toEqual([res.body.id]);
    expect((await list('upcoming')).journeys).toEqual([]);
    expect(res.body.live.nextPollSeconds).toBeNull();
  });
});

describe('GET /v1/journeys', () => {
  it('lists upcoming soonest first with a card-ready summary, and when to refresh', async () => {
    const late = (await post({ trainUid: 'A00002', runDate: '2026-11-03', fromCrs: 'KGX', toCrs: 'YRK' }).expect(201)).body;
    const early = (await post({ trainUid: 'A00001', runDate: '2026-11-03', fromCrs: 'KGX', toCrs: 'YRK' }).expect(201)).body;
    const body = await list('upcoming');
    expect(ids(body)).toEqual([early.id, late.id]);
    expect(body.journeys[0]).toMatchObject({
      from: { crs: 'KGX' },
      to: { crs: 'YRK' },
      bookedPlatform: '7',
      live: { state: 'scheduled', expectedDeparture: null, actualDeparture: null, platform: null, isCancelled: false, stale: false, checkedAt: null },
    });
    expect(body.journeys[0]).not.toHaveProperty('callingPoints');
    expect(body.nextPollSeconds).toBe(3600);

    // A minute before the 19:00 arrival, the list is due to change in a minute.
    clock = new Date('2026-11-03T18:59:00Z');
    expect((await list('upcoming')).nextPollSeconds).toBe(60);
  });

  it('moves a journey to past at its scheduled arrival, unless the train is still running', async () => {
    const j = (await post({ trainUid: 'A00001', runDate: '2026-11-03', fromCrs: 'KGX', toCrs: 'YRK' }).expect(201)).body;
    clock = new Date('2026-11-03T19:10:00Z');
    expect(ids(await list('past'))).toEqual([j.id]);

    // Running late: stays upcoming until it arrives.
    await db.updateTable('journeys').set({ state: 'departed' }).where('id', '=', j.id).execute();
    expect(ids(await list('upcoming'))).toEqual([j.id]);
    expect((await list('past')).journeys).toEqual([]);

    await db.updateTable('journeys').set({ state: 'arrived' }).where('id', '=', j.id).execute();
    expect(ids(await list('past'))).toEqual([j.id]);
  });

  it('has no nextPollSeconds when nothing upcoming will change', async () => {
    expect(await list('upcoming')).toEqual({ journeys: [], nextPollSeconds: null });
  });

  it("never shows another device's journeys", async () => {
    await post({ trainUid: 'A00001', runDate: '2026-11-03', fromCrs: 'KGX' }).expect(201);
    const other = await registerDevice(api);
    expect((await api().get('/v1/journeys').set(other.auth).expect(200)).body.journeys).toEqual([]);
  });
});

describe('one journey', () => {
  let id: string;
  beforeEach(async () => {
    id = (await post({ trainUid: 'A00001', runDate: '2026-11-03', fromCrs: 'KGX', toCrs: 'YRK' }).expect(201)).body.id;
  });

  it('GET returns it and GET /live its status', async () => {
    expect((await api().get(`/v1/journeys/${id}`).set(auth).expect(200)).body.id).toBe(id);
    const live = (await api().get(`/v1/journeys/${id}/live`).set(auth).expect(200)).body;
    expect(live).toEqual({
      state: 'scheduled',
      checkedAt: '2026-11-03T12:00:00+00:00',
      nextPollSeconds: 3600,
      stale: false,
      message: null,
      service: null,
      progress: null,
      position: null,
      divides: null,
      loading: null,
    });
  });

  it('PATCH sets and clears notification overrides, and archives', async () => {
    let res = await api().patch(`/v1/journeys/${id}`).set(auth).send({ prefs: { delays: false, delayThresholdMinutes: 10 } }).expect(200);
    expect(res.body.prefs).toEqual({ delays: false, delayThresholdMinutes: 10 });
    res = await api().patch(`/v1/journeys/${id}`).set(auth).send({ prefs: { delays: null } }).expect(200);
    expect(res.body.prefs).toEqual({ delayThresholdMinutes: 10 });

    res = await api().patch(`/v1/journeys/${id}`).set(auth).send({ archived: true }).expect(200);
    expect(res.body.archivedAt).toBe('2026-11-03T12:00:00+00:00');
    expect(ids(await list('past'))).toEqual([id]);

    // Saving the same trip again brings it back.
    await post({ trainUid: 'A00001', runDate: '2026-11-03', fromCrs: 'KGX', toCrs: 'YRK' }).expect(200);
    expect(ids(await list('upcoming'))).toEqual([id]);
  });

  it('DELETE removes it', async () => {
    await api().delete(`/v1/journeys/${id}`).set(auth).expect(204);
    expect((await api().get(`/v1/journeys/${id}`).set(auth).expect(404)).body.error.code).toBe('journey_not_found');
    await api().delete(`/v1/journeys/${id}`).set(auth).expect(404);
  });

  it("is invisible to other devices: 404 for read, change and delete", async () => {
    const other = await registerDevice(api);
    await api().get(`/v1/journeys/${id}`).set(other.auth).expect(404);
    await api().patch(`/v1/journeys/${id}`).set(other.auth).send({ archived: true }).expect(404);
    await api().delete(`/v1/journeys/${id}`).set(other.auth).expect(404);
    await api().get(`/v1/journeys/${id}`).set(auth).expect(200);
  });

  it('goes when the device is deleted', async () => {
    await api().delete('/v1/devices/me').set(auth).expect(204);
    const left = await db.selectFrom('journeys').select('id').execute();
    expect(left).toEqual([]);
  });
});
