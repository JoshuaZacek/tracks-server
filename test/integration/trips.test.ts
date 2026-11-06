import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseMessage } from '../../src/darwin/parse.ts';
import { DarwinBatch, flushBatch, recordFeed } from '../../src/darwin/store.ts';
import { importSchedule } from '../../src/ingest/schedule/import.ts';
import { resetFeedCache } from '../../src/live/feed.ts';
import { journeysForRuns, updateJourneys } from '../../src/live/updater.ts';
import { createLogger } from '../../src/logger.ts';
import { createNotifier, type Notifier } from '../../src/push/notifier.ts';
import { createTestContext, registerDevice, resetData } from '../helpers.ts';

const FIXTURE = fileURLToPath(new URL('../fixtures/schedule-mini.ndjson', import.meta.url));
const BUNDLE = 'com.joshuazacek.TrainTracker';

/**
 * A trip with a change at Peterborough on Tuesday 3 Nov 2026: the 16:50 Finsbury
 * Park to Peterborough (A00007, due 17:38, platform 3), then the 17:47 to York
 * (A00001, platform 4). 9 minutes to change; 5 needed.
 */
const LEG1 = { trainUid: 'A00007', runDate: '2026-11-03', fromCrs: 'FPK', toCrs: 'PBO' };
const LEG2 = { trainUid: 'A00001', runDate: '2026-11-03', fromCrs: 'PBO', toCrs: 'YRK' };
const RID1 = '202611037000001';
const RID2 = '202611031234567';

let clock = new Date('2026-11-03T16:40:00Z');
const { db, api, config, lookups } = createTestContext({ now: () => clock, darwin: true });
const log = createLogger({ ...config, logLevel: 'silent' }, 'test');
let auth: { Authorization: string };
let notifier: Notifier;
let seq = 1;

const message = (uR: object) =>
  JSON.stringify({ bytes: JSON.stringify({ ts: clock.toISOString(), version: '18.0', uR }), properties: { PushPortSequence: { string: String(seq++) } } });
const SCHEDULES = [
  {
    schedule: {
      rid: RID1, uid: 'A00007', ssd: '2026-11-03', toc: 'GN', trainId: '2P07',
      OR: { tpl: 'FNPK', ptd: '16:50', wtd: '16:50' },
      DT: { tpl: 'PBRO', pta: '17:38', wta: '17:38' },
    },
  },
  {
    schedule: {
      rid: RID2, uid: 'A00001', ssd: '2026-11-03', toc: 'GR', trainId: '1S25',
      OR: { tpl: 'KNGX', ptd: '17:00', wtd: '17:00' },
      IP: [{ tpl: 'PBRO', pta: '17:45', ptd: '17:47', wta: '17:45', wtd: '17:47' }, { tpl: 'YORK', pta: '19:00', ptd: '19:03', wta: '19:00', wtd: '19:03' }],
      DT: { tpl: 'EDINBUR', pta: '21:30', wta: '21:30' },
    },
  },
];
/** Leg 1 now expected at Peterborough at `et`. */
const leg1Due = (et: string) => ({ TS: { rid: RID1, uid: 'A00007', ssd: '2026-11-03', Location: { tpl: 'PBRO', pta: '17:38', wta: '17:38', arr: { et } } } });
const leg2Cancelled = { schedule: { ...SCHEDULES[1]!.schedule, IP: SCHEDULES[1]!.schedule.IP!.map((l) => ({ ...l, can: 'true' })) } };

/** What the worker does with a Darwin batch: store it, update journeys, hand the changes to the notifier. */
async function deliver(...uRs: object[]) {
  const batch = new DarwinBatch();
  for (const uR of uRs) batch.add(parseMessage(message(uR)), clock.getTime());
  await lookups.ready(0);
  await flushBatch(db, batch, lookups.crsOf);
  await db.updateTable('darwin_services').set({ updated_at: clock }).where('rid', 'in', [...batch.touched().rids]).execute();
  await feedAlive();
  const changes = await updateJourneys(
    { db, lookups, now: () => clock, darwinEnabled: true, feedHealthy: () => true },
    await journeysForRuns(db, batch.touched()),
  );
  notifier.journeysChanged(changes.map((c) => c.journey.id));
  await notifier.idle();
}

async function feedAlive() {
  await recordFeed(db, { lastMessageAt: clock.toISOString(), lagSeconds: 0.3, gapAt: null });
  resetFeedCache();
}

const save = async (body: object) => (await api().post('/v1/journeys').set(auth).send(body).expect(201)).body;
const link = (journeyIds: string[]) => api().post('/v1/trips').set(auth).send({ journeyIds });
async function trip() {
  const a = await save(LEG1);
  const b = await save(LEG2);
  const res = await link([a.id, b.id]).expect(201);
  return { a, b, trip: res.body };
}

beforeAll(async () => {
  await importSchedule(config.databaseUrl, FIXTURE, () => {});
});
beforeEach(async () => {
  clock = new Date('2026-11-03T16:40:00Z');
  await resetData(db);
  await sql`INSERT INTO meta (key, value) VALUES ('schedule_imported_at', now()::text)`.execute(db);
  await feedAlive();
  notifier = createNotifier({ db, log, sender: null, bundleId: BUNDLE, darwinEnabled: true, lookups, now: () => clock });
  ({ auth } = await registerDevice(api));
  await api().patch('/v1/devices/me').set(auth).send({ apnsToken: 'a1'.repeat(32), apnsEnvironment: 'sandbox' }).expect(200);
});
afterAll(() => db.destroy());

describe('POST /v1/trips', () => {
  it('links journeys into a trip and follows the change', async () => {
    const { a, b, trip: t } = await trip();
    expect(t.legs.map((l: { id: string }) => l.id)).toEqual([a.id, b.id]);
    expect(t.connections).toEqual([
      {
        leg: 1,
        station: { crs: 'PBO', name: 'Peterborough', lat: null, lon: null },
        status: 'ok',
        message: '9 min to change',
        arrival: '2026-11-03T17:38:00+00:00',
        arrivalPlatform: { number: '3', source: 'booked', confirmed: false, hidden: false },
        departure: '2026-11-03T17:47:00+00:00',
        departurePlatform: { number: '4', source: 'booked', confirmed: false, hidden: false },
        minimumChangeMinutes: 5,
        marginMinutes: 4,
        scheduledMarginMinutes: 4,
        cancelled: false,
        alternatives: [],
      },
    ]);
    expect(t.legs[0]).toMatchObject({ trip: { id: t.id, leg: 1, legs: 2 }, connection: { leg: 1, status: 'ok' } });
    expect(t.legs[1]).toMatchObject({ trip: { id: t.id, leg: 2, legs: 2 }, connection: null });

    // Journeys and the list carry it too.
    expect((await api().get(`/v1/journeys/${a.id}`).set(auth).expect(200)).body).toMatchObject({ trip: { id: t.id, leg: 1 }, connection: { status: 'ok' } });
    const list = (await api().get('/v1/journeys').set(auth).expect(200)).body.journeys;
    expect(list.map((j: { trip: { leg: number }; connection: { status: string } | null }) => [j.trip.leg, j.connection?.status ?? null])).toEqual([
      [1, 'ok'],
      [2, null],
    ]);
    expect((await api().get(`/v1/trips/${t.id}`).set(auth).expect(200)).body).toEqual(t);
  });

  it('rejects legs that do not connect', async () => {
    const a = await save(LEG1);
    const kgx = await save({ trainUid: 'A00001', runDate: '2026-11-03', fromCrs: 'KGX', toCrs: 'YRK' });
    expect((await link([a.id, kgx.id]).expect(422)).body.error.code).toBe('not_connected');
    // Peterborough the next morning, then the evening before.
    const morning = await save({ trainUid: 'A00006', runDate: '2026-11-04', fromCrs: 'FPK', toCrs: 'PBO' });
    const evening = await save(LEG2);
    expect((await link([morning.id, evening.id]).expect(422)).body.error.message).toMatch(/before leg 1 is due/);
    expect((await link([a.id, a.id]).expect(400)).body.error.code).toBe('validation_failed');
  });

  it("can't link another device's journeys", async () => {
    const a = await save(LEG1);
    const other = await registerDevice(api);
    const b = (await api().post('/v1/journeys').set(other.auth).send(LEG2).expect(201)).body;
    expect((await link([a.id, b.id]).expect(404)).body.error.code).toBe('journey_not_found');
    const mine = await save(LEG2);
    const t = (await link([a.id, mine.id]).expect(201)).body;
    await api().get(`/v1/trips/${t.id}`).set(other.auth).expect(404);
    await api().delete(`/v1/trips/${t.id}`).set(other.auth).expect(404);
  });

  it('adds a connecting train by linking the trip again with it, leaving no empty trip behind', async () => {
    const { a, b, trip: t } = await trip();
    const c = await save({ trainUid: 'A00001', runDate: '2026-11-03', fromCrs: 'YRK', toCrs: 'EDB' });
    const bigger = (await link([a.id, b.id, c.id]).expect(201)).body;
    expect(bigger.legs.map((l: { trip: { leg: number; legs: number } }) => l.trip)).toEqual([1, 2, 3].map((leg) => ({ id: bigger.id, leg, legs: 3 })));
    expect(bigger.connections.map((x: { station: { crs: string } }) => x.station.crs)).toEqual(['PBO', 'YRK']);
    await api().get(`/v1/trips/${t.id}`).set(auth).expect(404);
  });
});

describe('when the change goes wrong', () => {
  it('offers the next trains that still work when the change is missed', async () => {
    const { trip: t } = await trip();
    await deliver(...SCHEDULES, leg1Due('17:52'));
    const res = (await api().get(`/v1/trips/${t.id}`).set(auth).expect(200)).body;
    expect(res.connections[0]).toMatchObject({
      status: 'missed',
      message: 'The 17:47 leaves before you arrive',
      arrival: '2026-11-03T17:52:00+00:00',
      marginMinutes: -10,
      scheduledMarginMinutes: 4,
    });
    // Not the 17:47 itself: the 00:37 (the late train from King's Cross), the next day's trains after that.
    expect(res.connections[0].alternatives.map((d: { trainUid: string; scheduledDeparture: string }) => `${d.trainUid} ${d.scheduledDeparture}`)).toEqual([
      'A00002 2026-11-04T00:37:00+00:00',
      'A00001 2026-11-04T18:02:00+00:00',
    ]);
    expect(res.connections[0].alternatives[0].arrival).toMatchObject({ station: { crs: 'YRK' }, scheduledArrival: '2026-11-04T01:50:00+00:00' });
  });

  it('is missed when the next train is cancelled', async () => {
    const { trip: t } = await trip();
    await deliver(...SCHEDULES.slice(0, 1), leg2Cancelled);
    const c = (await api().get(`/v1/trips/${t.id}`).set(auth).expect(200)).body.connections[0];
    expect(c).toMatchObject({ status: 'missed', cancelled: true, marginMinutes: null, message: 'The 17:47 is cancelled' });
    expect(c.alternatives.length).toBeGreaterThan(0);
  });

  it('switches a leg to another train', async () => {
    const { a, b, trip: t } = await trip();
    await api().patch(`/v1/journeys/${b.id}`).set(auth).send({ prefs: { delays: false } }).expect(200);
    const res = (await api().put(`/v1/trips/${t.id}/legs/2`).set(auth).send({ trainUid: 'A00002', runDate: '2026-11-03' }).expect(200)).body;
    expect(res.legs.map((l: { id: string; trainUid: string }) => l.trainUid)).toEqual(['A00007', 'A00002']);
    expect(res.legs[0].id).toBe(a.id);
    expect(res.legs[1]).toMatchObject({ from: { crs: 'PBO' }, to: { crs: 'YRK' }, prefs: { delays: false }, trip: { id: t.id, leg: 2 } });
    expect(res.connections[0]).toMatchObject({ status: 'ok', departure: '2026-11-04T00:37:00+00:00' });
    await api().get(`/v1/journeys/${b.id}`).set(auth).expect(404);

    // A train that leaves before leg 1 gets there is refused, and not saved.
    const before = (await api().get('/v1/journeys').set(auth).expect(200)).body.journeys.length;
    expect((await api().put(`/v1/trips/${t.id}/legs/2`).set(auth).send({ trainUid: 'A00001', runDate: '2026-11-02' }).expect(422)).body.error.code).toBe(
      'not_connected',
    );
    expect((await api().get('/v1/journeys?scope=past').set(auth).expect(200)).body.journeys).toHaveLength(0);
    expect((await api().get('/v1/journeys').set(auth).expect(200)).body.journeys).toHaveLength(before);
    await api().put(`/v1/trips/${t.id}/legs/3`).set(auth).send({ trainUid: 'A00002', runDate: '2026-11-03' }).expect(404);
  });
});

describe('unlinking', () => {
  it('deleting a leg of a two-leg trip leaves the other on its own', async () => {
    const { a, b, trip: t } = await trip();
    await api().delete(`/v1/journeys/${b.id}`).set(auth).expect(204);
    expect((await api().get(`/v1/journeys/${a.id}`).set(auth).expect(200)).body).toMatchObject({ trip: null, connection: null });
    await api().get(`/v1/trips/${t.id}`).set(auth).expect(404);
  });

  it('deleting the first of three legs keeps the rest, renumbered', async () => {
    const { a, b } = await trip();
    const c = await save({ trainUid: 'A00001', runDate: '2026-11-03', fromCrs: 'YRK', toCrs: 'EDB' });
    const t = (await link([a.id, b.id, c.id]).expect(201)).body;
    await api().delete(`/v1/journeys/${a.id}`).set(auth).expect(204);
    const left = (await api().get(`/v1/trips/${t.id}`).set(auth).expect(200)).body;
    expect(left.legs.map((l: { id: string; trip: { leg: number } }) => [l.id, l.trip.leg])).toEqual([
      [b.id, 1],
      [c.id, 2],
    ]);
  });

  it('DELETE /v1/trips/{id} keeps the journeys', async () => {
    const { a, b, trip: t } = await trip();
    await api().delete(`/v1/trips/${t.id}`).set(auth).expect(204);
    for (const id of [a.id, b.id]) expect((await api().get(`/v1/journeys/${id}`).set(auth).expect(200)).body.trip).toBeNull();
    await api().delete(`/v1/trips/${t.id}`).set(auth).expect(404);
  });
});

describe('connection alerts (dry run)', () => {
  const connectionLog = (journeyId: string) =>
    db
      .selectFrom('push_log')
      .select(['outcome', 'payload'])
      .where('journey_id', '=', journeyId)
      .where('kind', '=', 'connection')
      .orderBy('id')
      .execute()
      .then((rows) =>
        rows.map((r) => {
          const p = r.payload as { tripId: string; aps: { alert: { title: string; body: string } } };
          return `${r.outcome} ${p.aps.alert.title}: ${p.aps.alert.body}`;
        }),
      );

  it('alerts the leg into the change when it becomes at risk or missed, and when it is back on, each once', async () => {
    const { a, b, trip: t } = await trip();
    await deliver(...SCHEDULES, leg1Due('17:39'));
    expect(await connectionLog(a.id)).toEqual([]);

    clock = new Date('2026-11-03T17:00:00Z');
    await deliver(leg1Due('17:44'));
    await deliver(leg1Due('17:51'));
    await deliver(leg1Due('17:51')); // nothing new
    await deliver(leg1Due('17:38'));
    expect(await connectionLog(a.id)).toEqual([
      'disabled Your change at Peterborough: Tight change: 3 min for the 17:47 to York from platform 4 (5 needed).',
      "disabled Your change at Peterborough: You'll miss the 17:47 to York: you're due at 17:51 and it leaves at 17:47. Next train: the 00:37, arriving 01:50.",
      'disabled Your change at Peterborough: Back on: 9 min to change for the 17:47 to York from platform 4.',
    ]);
    expect(await connectionLog(b.id)).toEqual([]);
    const sent = await db.selectFrom('push_log').select('payload').where('kind', '=', 'connection').executeTakeFirstOrThrow();
    expect(sent.payload).toMatchObject({ kind: 'connection', journeyId: a.id, tripId: t.id });
    expect((await db.selectFrom('trips').select('alert_state').where('id', '=', t.id).executeTakeFirstOrThrow()).alert_state).toEqual({ 1: 'ok' });
  });

  it('alerts when the next train is cancelled, and not with the preference off', async () => {
    const { a } = await trip();
    await deliver(...SCHEDULES);
    await deliver(leg2Cancelled);
    expect(await connectionLog(a.id)).toEqual(['disabled Your change at Peterborough: The 17:47 to York is cancelled. Next train: the 00:37, arriving 01:50.']);

    await resetData(db);
    await sql`INSERT INTO meta (key, value) VALUES ('schedule_imported_at', now()::text)`.execute(db);
    ({ auth } = await registerDevice(api));
    await api().patch('/v1/devices/me').set(auth).send({ apnsToken: 'a1'.repeat(32), prefs: { connections: false } }).expect(200);
    const second = await trip();
    await deliver(...SCHEDULES);
    await deliver(leg2Cancelled);
    expect(await connectionLog(second.a.id)).toEqual([]);
  });
});
