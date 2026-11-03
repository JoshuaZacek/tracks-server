import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseMessage } from '../../src/darwin/parse.ts';
import { DarwinBatch, flushBatch, recordFeed } from '../../src/darwin/store.ts';
import { importSchedule } from '../../src/ingest/schedule/import.ts';
import { resetFeedCache } from '../../src/live/feed.ts';
import { journeysDueForTick, journeysForRuns, updateJourneys } from '../../src/live/updater.ts';
import { createLogger } from '../../src/logger.ts';
import type { PushRequest, PushResult, PushSender } from '../../src/push/apns.ts';
import { createNotifier, type Notifier } from '../../src/push/notifier.ts';
import { createTestContext, registerDevice, resetData } from '../helpers.ts';

const FIXTURE = fileURLToPath(new URL('../fixtures/schedule-mini.ndjson', import.meta.url));
const RID = '202611031234567';
const BUNDLE = 'com.joshuazacek.TrainTracker';
const APNS_TOKEN = 'a1'.repeat(32);
const ACTIVITY_TOKEN = 'b2'.repeat(128); // ActivityKit tokens are 128 bytes on iOS 26
const START_TOKEN = 'c3'.repeat(128);

let clock = new Date('2026-11-03T16:40:00Z');
const { db, api, config, lookups } = createTestContext({ now: () => clock, darwin: true });
const log = createLogger({ ...config, logLevel: 'silent' }, 'test');
let auth: { Authorization: string };
let seq = 1;

/** Records pushes instead of sending them; `reply` decides what APNs answers. */
class FakeSender implements PushSender {
  sent: PushRequest[] = [];
  reply: (r: PushRequest) => Partial<PushResult> = () => ({});
  async send(r: PushRequest): Promise<PushResult> {
    this.sent.push(r);
    return { ok: true, status: 200, apnsId: `id-${this.sent.length}`, reason: null, unregistered: false, retryable: false, ...this.reply(r) };
  }
  async close() {}
  take() {
    const s = this.sent;
    this.sent = [];
    return s;
  }
}

let sender: FakeSender;
let notifier: Notifier;

const message = (uR: object) =>
  JSON.stringify({ bytes: JSON.stringify({ ts: clock.toISOString(), version: '18.0', uR }), properties: { PushPortSequence: { string: String(seq++) } } });
const ts = (locations: object[]) => ({ TS: { rid: RID, uid: 'A00001', ssd: '2026-11-03', Location: locations.length === 1 ? locations[0] : locations } });
const SCHEDULE = {
  schedule: {
    rid: RID, uid: 'A00001', ssd: '2026-11-03', toc: 'GR', trainId: '1S25',
    OR: { tpl: 'KNGX', ptd: '17:00', wtd: '17:00' },
    IP: [{ tpl: 'PBRO', pta: '17:45', ptd: '17:47', wta: '17:45', wtd: '17:47' }, { tpl: 'YORK', pta: '19:00', ptd: '19:03', wta: '19:00', wtd: '19:03' }],
    DT: { tpl: 'EDINBUR', pta: '21:30', wta: '21:30' },
  },
};
const kgx = (extra: object) => ({ tpl: 'KNGX', ptd: '17:00', wtd: '17:00', ...extra });
const york = (extra: object) => ({ tpl: 'YORK', pta: '19:00', ptd: '19:03', wta: '19:00', wtd: '19:03', ...extra });

const deps = () => ({ db, lookups, now: () => clock, darwinEnabled: true, feedHealthy: () => true });

/** What the worker does: store the Darwin batch, update journeys, hand the changes to the notifier. */
async function deliver(...uRs: object[]) {
  const batch = new DarwinBatch();
  for (const uR of uRs) batch.add(parseMessage(message(uR)), clock.getTime());
  await lookups.ready(0);
  await flushBatch(db, batch, lookups.crsOf);
  // The store stamps runs with the database clock; follow the test clock instead.
  await db.updateTable('darwin_services').set({ updated_at: clock }).where('rid', 'in', [...batch.touched().rids]).execute();
  await feedAlive();
  const changes = await updateJourneys(deps(), await journeysForRuns(db, batch.touched()));
  notifier.journeysChanged(changes.map((c) => c.journey.id));
  await notifier.idle();
}

/** The consumer's record that the feed is alive (heartbeats arrive every few seconds). */
async function feedAlive(at = clock, lagSeconds = 0.3) {
  await recordFeed(db, { lastMessageAt: at.toISOString(), lagSeconds, gapAt: null });
  resetFeedCache();
}

/** The worker's clock tick; the feed is alive unless told otherwise. */
async function tick({ feedUp = true } = {}) {
  await feedAlive(feedUp ? clock : new Date(clock.getTime() - 10 * 60_000));
  const changes = await updateJourneys(deps(), await journeysDueForTick(db, clock));
  notifier.journeysChanged(changes.map((c) => c.journey.id));
  notifier.tick();
  await notifier.idle();
}

const save = async (body: object = {}) =>
  (await api().post('/v1/journeys').set(auth).send({ trainUid: 'A00001', runDate: '2026-11-03', fromCrs: 'KGX', toCrs: 'YRK', ...body }).expect(201)).body;
const pushLog = (journeyId: string) =>
  db.selectFrom('push_log').select(['channel', 'kind', 'outcome']).where('journey_id', '=', journeyId).orderBy('id').execute();
const alertsIn = (sent: PushRequest[]) => sent.filter((r) => r.pushType === 'alert').map((r) => (r.payload as { aps: { alert: { body: string } } }).aps.alert.body);

beforeAll(async () => {
  await importSchedule(config.databaseUrl, FIXTURE, () => {});
});
beforeEach(async () => {
  clock = new Date('2026-11-03T16:40:00Z');
  await resetData(db);
  await sql`INSERT INTO meta (key, value) VALUES ('schedule_imported_at', now()::text)`.execute(db);
  await recordFeed(db, { lastMessageAt: clock.toISOString(), lagSeconds: 0.3, gapAt: null });
  resetFeedCache();
  sender = new FakeSender();
  notifier = createNotifier({ db, log, sender, bundleId: BUNDLE, darwinEnabled: true, now: () => clock });
  ({ auth } = await registerDevice(api));
  await api().patch('/v1/devices/me').set(auth).send({ apnsToken: APNS_TOKEN, apnsEnvironment: 'sandbox' }).expect(200);
});
afterAll(() => db.destroy());

describe('alerts', () => {
  it('sends platform, delay, departure, approach and arrival alerts to the device, each once', async () => {
    const journey = await save();
    await deliver(SCHEDULE, ts([kgx({ dep: { et: '17:00' }, plat: { conf: 'true', '': '7' } })]));
    const sent = sender.take();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      token: APNS_TOKEN,
      env: 'sandbox',
      pushType: 'alert',
      topic: BUNDLE,
      priority: 10,
      collapseId: `${journey.id}:platform`,
      payload: {
        aps: { alert: { title: "17:00 London Kings Cross to York", body: 'Departs from platform 7.' }, sound: 'default', 'thread-id': journey.id },
        journeyId: journey.id,
        kind: 'platform',
      },
    });

    // The same data again (e.g. reprocessed after a restart): nothing new.
    await deliver(ts([kgx({ dep: { et: '17:00' }, plat: { conf: 'true', '': '7' } })]));
    notifier.journeysChanged([journey.id]);
    await notifier.idle();
    expect(sender.take()).toEqual([]);

    await deliver(ts([kgx({ dep: { et: '17:12' }, plat: { conf: 'true', '': '7' } })]));
    expect(alertsIn(sender.take())).toEqual(["Delayed by 12 min: now expected to leave London Kings Cross at 17:12."]);

    clock = new Date('2026-11-03T17:13:00Z');
    await deliver(ts([kgx({ dep: { at: '17:12' } }), york({ arr: { et: '19:10' } })]));
    expect(alertsIn(sender.take())).toEqual(["Left London Kings Cross at 17:12, 12 min late. Due at York at 19:10."]);

    // Nothing changes, but time passes: the tick sends "approaching" 10 minutes out, as the
    // train is still reporting (here, the same estimate again at 18:58).
    clock = new Date('2026-11-03T18:58:00Z');
    await deliver(ts([york({ arr: { et: '19:10' } })]));
    expect(sender.take()).toEqual([]);
    clock = new Date('2026-11-03T19:01:00Z');
    await tick();
    expect(alertsIn(sender.take())).toEqual(['Arriving at York at 19:10.']);

    clock = new Date('2026-11-03T19:11:00Z');
    await deliver(ts([york({ arr: { at: '19:11' } })]));
    expect(alertsIn(sender.take())).toEqual(['Arrived at York at 19:11, 11 min late.']);

    expect((await pushLog(journey.id)).map((r) => `${r.kind}:${r.outcome}`)).toEqual([
      'platform:sent', 'delay:sent', 'departed:sent', 'approaching:sent', 'arrived:sent',
    ]);
  });

  it('does not alert for what was already known when the journey was saved', async () => {
    await deliver(SCHEDULE, ts([kgx({ dep: { et: '17:20' }, plat: { conf: 'true', '': '7' } })]));
    const journey = await save();
    expect(journey.live.service.delayMinutes).toBe(20);
    notifier.journeysChanged([journey.id]);
    await notifier.idle();
    expect(sender.take()).toEqual([]);

    await deliver(ts([kgx({ dep: { et: '17:30' }, plat: { conf: 'true', '': '7' } })]));
    expect(alertsIn(sender.take())).toEqual(["Delayed by 30 min: now expected to leave London Kings Cross at 17:30."]);
  });

  it('follows device preferences and per-journey overrides', async () => {
    await api().patch('/v1/devices/me').set(auth).send({ prefs: { delays: false } }).expect(200);
    const journey = await save();
    await api().patch(`/v1/journeys/${journey.id}`).set(auth).send({ prefs: { platforms: false } }).expect(200);
    await deliver(SCHEDULE, ts([kgx({ dep: { et: '17:15' }, plat: { conf: 'true', '': '7' } })]));
    expect(sender.take()).toEqual([]);
    await deliver(ts([kgx({ dep: { et: '17:15' }, plat: { conf: 'true', '': '8' } })]));
    expect(sender.take()).toEqual([]);
  });

  it('forgets a device token APNs says is dead', async () => {
    await save();
    sender.reply = () => ({ ok: false, status: 410, reason: 'Unregistered', unregistered: true });
    await deliver(SCHEDULE, ts([kgx({ plat: { conf: 'true', '': '7' } })]));
    expect(sender.take()).toHaveLength(1);
    expect((await api().get('/v1/devices/me').set(auth).expect(200)).body.apnsTokenRegistered).toBe(false);
  });

  it('holds alerts while the Darwin feed is down, and works them out from fresh data when it is back', async () => {
    const journey = await save();
    await deliver(SCHEDULE, ts([kgx({ dep: { et: '17:00' }, plat: { conf: 'true', '': '7' } })]));
    sender.take();
    clock = new Date('2026-11-03T17:13:00Z');
    await deliver(ts([kgx({ dep: { at: '17:12' } }), york({ arr: { et: '19:10' } })]));
    expect(alertsIn(sender.take())).toEqual(["Left London Kings Cross at 17:12, 12 min late. Due at York at 19:10."]);

    // The feed dies at 17:13. By 19:05 the frozen estimate says York is 5 minutes away: no "approaching".
    clock = new Date('2026-11-03T19:05:00Z');
    await tick({ feedUp: false });
    expect(sender.take()).toEqual([]);
    expect((await pushLog(journey.id)).map((r) => r.kind)).not.toContain('approaching');

    // Feed back, but nothing new about this train yet: still no "approaching" from the old estimate.
    await tick();
    expect(sender.take()).toEqual([]);

    // Fresh data: the train is now due at 19:20, so "approaching" comes once it is 10 minutes out.
    await deliver(ts([york({ arr: { et: '19:20' } })]));
    expect(alertsIn(sender.take())).toEqual(['Running 20 min late: now due at York at 19:20.']);
    clock = new Date('2026-11-03T19:11:00Z');
    await deliver(ts([york({ arr: { et: '19:20' }, plat: { conf: 'true', '': '4' } })]));
    expect(alertsIn(sender.take())).toEqual(['Arriving at York at 19:20, platform 4.']);
  });

  it('holds alerts while the consumer replays a backlog, then alerts once from the latest status', async () => {
    const journey = await save();
    await deliver(SCHEDULE, ts([kgx({ dep: { et: '17:00' }, plat: { conf: 'true', '': '7' } })]));
    sender.take();

    // Catching up after a restart: messages from minutes ago, one estimate after another.
    const replay = async (et: string) => {
      const batch = new DarwinBatch();
      batch.add(parseMessage(message(ts([kgx({ dep: { et }, plat: { conf: 'true', '': '7' } })]))), clock.getTime());
      await flushBatch(db, batch, lookups.crsOf);
      await feedAlive(clock, 900);
      const changes = await updateJourneys(deps(), await journeysForRuns(db, batch.touched()));
      notifier.journeysChanged(changes.map((c) => c.journey.id));
      await notifier.idle();
    };
    await replay('17:05');
    await replay('17:00');
    await replay('17:15');
    expect(sender.take()).toEqual([]);

    // Caught up: the next tick looks at the held journey and says what is true now, once.
    await tick();
    expect(alertsIn(sender.take())).toEqual(["Delayed by 15 min: now expected to leave London Kings Cross at 17:15."]);
    expect((await pushLog(journey.id)).filter((r) => r.channel === 'alert').map((r) => r.kind)).toEqual(['platform', 'delay']);
  });

  it('records alerts it cannot send: no token, or APNs not configured (dry run)', async () => {
    await api().patch('/v1/devices/me').set(auth).send({ apnsToken: null }).expect(200);
    const journey = await save();
    await deliver(SCHEDULE, ts([kgx({ plat: { conf: 'true', '': '7' } })]));
    expect(sender.take()).toEqual([]);
    expect(await pushLog(journey.id)).toEqual([{ channel: 'alert', kind: 'platform', outcome: 'no_token' }]);

    await api().patch('/v1/devices/me').set(auth).send({ apnsToken: APNS_TOKEN }).expect(200);
    notifier = createNotifier({ db, log, sender: null, bundleId: BUNDLE, darwinEnabled: true, now: () => clock });
    await deliver(ts([kgx({ plat: { conf: 'true', '': '9' } })]));
    expect((await pushLog(journey.id)).at(-1)).toEqual({ channel: 'alert', kind: 'platform', outcome: 'disabled' });
  });
});

describe('Live Activities', () => {
  type Aps = { aps: Record<string, unknown> & { 'content-state': Record<string, unknown> } };
  const activityPushes = () => sender.take().filter((r) => r.pushType === 'liveactivity');

  it('pushes content updates to a registered activity, rate-limited, and ends it on arrival', async () => {
    const journey = await save();
    await api().put(`/v1/journeys/${journey.id}/live-activity`).set(auth).send({ pushToken: ACTIVITY_TOKEN.toUpperCase() }).expect(204);

    // Registered: the next tick sends the current content.
    await tick();
    let [push] = activityPushes();
    expect(push).toMatchObject({ token: ACTIVITY_TOKEN, env: 'sandbox', topic: `${BUNDLE}.push-type.liveactivity`, priority: 10 });
    const aps = (push!.payload as Aps).aps;
    expect(aps).toMatchObject({ event: 'update', timestamp: Math.floor(clock.getTime() / 1000) });
    expect(aps['stale-date']).toBe(Date.parse('2026-11-03T17:20:00Z') / 1000);
    expect(aps['content-state']).toEqual({
      state: 'scheduled',
      scheduledDeparture: '2026-11-03T17:00:00+00:00',
      expectedDeparture: null,
      actualDeparture: null,
      scheduledArrival: '2026-11-03T19:00:00+00:00',
      expectedArrival: null,
      actualArrival: null,
      delayMinutes: null,
      platform: { number: '7', confirmed: false }, // timetabled until Darwin has one
      isCancelled: false,
      message: null,
      nextStopName: null,
      legDepartedAt: null,
      nextExpectedAt: null,
    });

    // A change within 15 s of the last push is held back, then sent by the tick.
    clock = new Date(clock.getTime() + 5_000);
    await deliver(SCHEDULE, ts([kgx({ dep: { et: '17:02' }, plat: { conf: 'true', '': '7' } })]));
    expect(activityPushes()).toEqual([]);
    clock = new Date(clock.getTime() + 15_000);
    await tick();
    [push] = activityPushes();
    expect((push!.payload as Aps).aps['content-state']).toMatchObject({ state: 'live', expectedDeparture: '2026-11-03T17:02:00+00:00', delayMinutes: 2, platform: { number: '7', confirmed: true } });

    // Unchanged content: nothing.
    clock = new Date(clock.getTime() + 60_000);
    await tick();
    expect(activityPushes()).toEqual([]);

    // Under way: the leg to Peterborough.
    clock = new Date('2026-11-03T17:03:00Z');
    await deliver(ts([kgx({ dep: { at: '17:02' } }), { tpl: 'PBRO', pta: '17:45', ptd: '17:47', wta: '17:45', wtd: '17:47', arr: { et: '17:46' } }]));
    [push] = activityPushes();
    expect(push!.priority).toBe(10);
    expect((push!.payload as Aps).aps['content-state']).toMatchObject({
      state: 'departed',
      actualDeparture: '2026-11-03T17:02:00+00:00',
      nextStopName: 'Peterborough',
      legDepartedAt: '2026-11-03T17:02:00+00:00',
      nextExpectedAt: '2026-11-03T17:46:00+00:00',
    });

    // Arrived: an end event that stays on the Lock Screen for 15 minutes, then no more pushes.
    clock = new Date('2026-11-03T19:01:00Z');
    await deliver(ts([york({ arr: { at: '19:01' } })]));
    [push] = activityPushes();
    expect((push!.payload as Aps).aps).toMatchObject({ event: 'end', 'dismissal-date': Date.parse('2026-11-03T19:16:00Z') / 1000 });
    expect((push!.payload as Aps).aps['content-state']).toMatchObject({ state: 'arrived', actualArrival: '2026-11-03T19:01:00+00:00' });
    clock = new Date('2026-11-03T19:05:00Z');
    await tick();
    expect(activityPushes()).toEqual([]);
  });

  it('stops pushing when the user ends the activity, and when APNs says the token is dead', async () => {
    const journey = await save();
    await api().put(`/v1/journeys/${journey.id}/live-activity`).set(auth).send({ pushToken: ACTIVITY_TOKEN }).expect(204);
    await api().delete(`/v1/journeys/${journey.id}/live-activity`).set(auth).expect(204);
    await tick();
    expect(activityPushes()).toEqual([]);

    await api().put(`/v1/journeys/${journey.id}/live-activity`).set(auth).send({ pushToken: ACTIVITY_TOKEN }).expect(204);
    sender.reply = (r) => (r.pushType === 'liveactivity' ? { ok: false, status: 410, reason: 'Unregistered', unregistered: true } : {});
    await tick();
    expect(activityPushes()).toHaveLength(1);
    clock = new Date(clock.getTime() + 60_000);
    await deliver(SCHEDULE, ts([kgx({ dep: { et: '17:09' } })]));
    expect(activityPushes()).toEqual([]);
  });

  it('starts an activity by push 30 minutes before departure, once, unless turned off', async () => {
    await api().patch('/v1/devices/me').set(auth).send({ pushToStartToken: START_TOKEN }).expect(200);
    const journey = await save();
    await deliver(SCHEDULE, ts([kgx({ dep: { et: '17:00' }, plat: { conf: 'true', '': '7' } })]));
    sender.take();

    clock = new Date('2026-11-03T16:29:00Z');
    await tick();
    expect(activityPushes()).toEqual([]);

    // Not while the feed is down: the content would be out of date.
    clock = new Date('2026-11-03T16:31:00Z');
    await tick({ feedUp: false });
    expect(activityPushes()).toEqual([]);

    await tick();
    const [push] = activityPushes();
    expect(push).toMatchObject({ token: START_TOKEN, topic: `${BUNDLE}.push-type.liveactivity`, priority: 10 });
    expect((push!.payload as Aps).aps).toMatchObject({
      event: 'start',
      'attributes-type': 'TrainActivityAttributes',
      attributes: {
        journeyId: journey.id,
        headcode: '1S25',
        operatorName: 'LNER',
        fromCrs: 'KGX',
        fromName: "London Kings Cross",
        toCrs: 'YRK',
        toName: 'York',
      },
      alert: { title: "17:00 London Kings Cross to York", body: 'Leaves at 17:00, platform 7.' },
      'content-state': { state: 'live', platform: { number: '7', confirmed: true } },
    });

    clock = new Date('2026-11-03T16:35:00Z');
    await tick();
    expect(activityPushes()).toEqual([]);

    // Turned off for a journey: no start.
    const other = await save({ toCrs: 'PBO' });
    await api().patch(`/v1/journeys/${other.id}`).set(auth).send({ prefs: { liveActivity: false } }).expect(200);
    await tick();
    expect(activityPushes()).toEqual([]);
  });
});
