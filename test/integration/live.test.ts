import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseMessage } from '../../src/darwin/parse.ts';
import { DarwinBatch, flushBatch, recordFeed } from '../../src/darwin/store.ts';
import { importSchedule } from '../../src/ingest/schedule/import.ts';
import { resetFeedCache } from '../../src/live/feed.ts';
import { journeysDueForTick, journeysForRuns, updateJourneys } from '../../src/live/updater.ts';
import { createTestContext, registerDevice, resetData } from '../helpers.ts';

const FIXTURE = fileURLToPath(new URL('../fixtures/schedule-mini.ndjson', import.meta.url));
const RID = '202611031234567';

let clock = new Date('2026-11-03T16:40:00Z');
const { db, api, config, lookups } = createTestContext({ now: () => clock, darwin: true });
let auth: { Authorization: string };
let seq = 1;

/** A Darwin message as it arrives from the RDM topic. */
const message = (uR: object) => JSON.stringify({ messageType: 'bytes', bytes: JSON.stringify({ ts: clock.toISOString(), version: '18.0', uR }), properties: { PushPortSequence: { string: String(seq++) } } });

const ts = (locations: object[]) => ({ TS: { rid: RID, uid: 'A00001', ssd: '2026-11-03', Location: locations.length === 1 ? locations[0] : locations } });

/** What the worker does with a Kafka batch: store it, then update the journeys on the runs it touched. */
async function deliver(...uRs: object[]) {
  const batch = new DarwinBatch();
  for (const uR of uRs) batch.add(parseMessage(message(uR)), clock.getTime());
  await lookups.ready(0);
  await flushBatch(db, batch, lookups.crsOf);
  const deps = { db, lookups, now: () => clock, darwinEnabled: true, feedHealthy: () => true };
  await updateJourneys(deps, await journeysForRuns(db, batch.touched()));
  await feedAlive();
}

async function feedAlive(at = clock) {
  await recordFeed(db, { lastMessageAt: at.toISOString(), lagSeconds: 0.3, gapAt: null });
  resetFeedCache();
}

const live = async (id: string) => (await api().get(`/v1/journeys/${id}/live`).set(auth).expect(200)).body;
const save = async () => (await api().post('/v1/journeys').set(auth).send({ trainUid: 'A00001', runDate: '2026-11-03', fromCrs: 'KGX', toCrs: 'YRK' }).expect(201)).body;

beforeAll(async () => {
  await importSchedule(config.databaseUrl, FIXTURE, () => {});
  await db.updateTable('stations').set({ lat: 51.5643, lon: -0.1065, kb_status: 'ok' }).where('crs', '=', 'FPK').execute();
});
beforeEach(async () => {
  clock = new Date('2026-11-03T16:40:00Z');
  await resetData(db);
  await sql`INSERT INTO meta (key, value) VALUES ('schedule_imported_at', now()::text)`.execute(db);
  await feedAlive();
  ({ auth } = await registerDevice(api));
});
afterAll(() => db.destroy());

describe('live status from Darwin', () => {
  it('follows a journey from scheduled through live and departed to arrived', async () => {
    const journey = await save();
    expect(journey.live).toMatchObject({ state: 'scheduled', service: null });

    // Darwin's schedule and a first forecast: platform 7 confirmed, 5 minutes late.
    await deliver(
      {
        schedule: {
          rid: RID, uid: 'A00001', ssd: '2026-11-03', toc: 'GR', trainId: '1S25',
          OR: { tpl: 'KNGX', ptd: '17:00', wtd: '17:00' },
          PP: [{ tpl: 'FNPK', wtp: '17:04' }, { tpl: 'HLWYSJ', wtp: '17:07' }],
          IP: [{ tpl: 'PBRO', pta: '17:45', ptd: '17:47', wta: '17:45', wtd: '17:47' }, { tpl: 'YORK', pta: '19:00', ptd: '19:03', wta: '19:00', wtd: '19:03' }],
          DT: { tpl: 'EDINBUR', pta: '21:30', wta: '21:30' },
        },
      },
      ts([{ tpl: 'KNGX', ptd: '17:00', wtd: '17:00', dep: { et: '17:05', src: 'Darwin' }, plat: { platsrc: 'A', conf: 'true', '': '7' } }]),
    );
    let status = await live(journey.id);
    expect(status).toMatchObject({
      state: 'live',
      stale: false,
      nextPollSeconds: 30,
      service: { rid: RID, expectedDeparture: '2026-11-03T17:05:00+00:00', delayMinutes: 5, platform: { number: '7', source: 'live', confirmed: true, hidden: false } },
      progress: { lastPassedIndex: -1, nextIndex: 0, arrived: false },
      position: null,
    });

    // The list carries the card fields.
    const list = (await api().get('/v1/journeys').set(auth).expect(200)).body;
    expect(list.nextPollSeconds).toBe(30);
    expect(list.journeys[0].live).toMatchObject({
      state: 'live',
      expectedDeparture: '2026-11-03T17:05:00+00:00',
      delayMinutes: 5,
      platform: { number: '7', confirmed: true },
      isCancelled: false,
      stale: false,
      checkedAt: '2026-11-03T16:40:00+00:00',
    });

    // Away at 17:04, passing Finsbury Park at 17:08.
    clock = new Date('2026-11-03T17:09:00Z');
    await deliver(
      ts([
        { tpl: 'KNGX', ptd: '17:00', wtd: '17:00', dep: { at: '17:04', src: 'TD' } },
        { tpl: 'FNPK', wtp: '17:04', pass: { at: '17:08', src: 'TD' } },
        { tpl: 'HLWYSJ', wtp: '17:07', pass: { et: '17:11', src: 'Darwin' } },
        { tpl: 'YORK', pta: '19:00', ptd: '19:03', wta: '19:00', wtd: '19:03', arr: { et: '19:03', src: 'Darwin' } },
      ]),
    );
    status = await live(journey.id);
    expect(status).toMatchObject({
      state: 'departed',
      service: { actualDeparture: '2026-11-03T17:04:00+00:00', delayMinutes: 4 },
      position: {
        source: 'darwin',
        last: { tiploc: 'FNPK', crs: 'FPK', name: 'Finsbury Park', time: '2026-11-03T17:08:00+00:00', event: 'pass', lat: 51.5643 },
        next: { tiploc: 'HLWYSJ', crs: null, expectedTime: '2026-11-03T17:11:00+00:00' },
        legFrom: 'KGX',
        legTo: 'PBO',
      },
    });
    const card = (await api().get('/v1/journeys').set(auth).expect(200)).body.journeys[0].live;
    expect(card).toMatchObject({ state: 'departed', actualDeparture: '2026-11-03T17:04:00+00:00', expectedArrival: '2026-11-03T19:03:00+00:00' });

    // Arrived at York: final, and the journey moves to past.
    clock = new Date('2026-11-03T19:04:00Z');
    await deliver(ts([{ tpl: 'YORK', pta: '19:00', ptd: '19:03', wta: '19:00', wtd: '19:03', arr: { at: '19:03', src: 'TD' } }]));
    status = await live(journey.id);
    expect(status).toMatchObject({ state: 'arrived', nextPollSeconds: null, position: null, progress: { arrived: true, nextIndex: null } });
    expect((await api().get('/v1/journeys?scope=past').set(auth).expect(200)).body.journeys.map((j: { id: string }) => j.id)).toEqual([journey.id]);
  });

  it('serves statuses stored before platforms had a hidden flag', async () => {
    const journey = await save();
    await deliver(ts([{ tpl: 'KNGX', ptd: '17:00', wtd: '17:00', dep: { et: '17:05' }, plat: { conf: 'true', '': '7' } }]));
    // As stored by the previous version.
    await sql`UPDATE journeys SET status = jsonb_set(status, '{service,platform}', '{"number":"7","source":"live","confirmed":true}') WHERE id = ${journey.id}`.execute(db);
    expect((await live(journey.id)).service.platform).toEqual({ number: '7', source: 'live', confirmed: true, hidden: false });
    expect((await api().get('/v1/journeys').set(auth).expect(200)).body.journeys[0].live.platform).toMatchObject({ hidden: false });
  });

  it('does not rewrite a status that has not changed (stored jsonb reorders keys)', async () => {
    const journey = await save();
    await deliver(ts([{ tpl: 'KNGX', ptd: '17:00', wtd: '17:00', dep: { et: '17:05' } }]));
    const first = await db.selectFrom('journeys').select('status_updated_at').where('id', '=', journey.id).executeTakeFirstOrThrow();
    clock = new Date(clock.getTime() + 60_000);
    const deps = { db, lookups, now: () => clock, darwinEnabled: true, feedHealthy: () => true };
    expect(await updateJourneys(deps, await journeysDueForTick(db, clock))).toEqual([]);
    await deliver(ts([{ tpl: 'KNGX', ptd: '17:00', wtd: '17:00', dep: { et: '17:05' } }]));
    const after = await db.selectFrom('journeys').select('status_updated_at').where('id', '=', journey.id).executeTakeFirstOrThrow();
    expect(after.status_updated_at).toEqual(first.status_updated_at);
  });

  it('keeps a late train upcoming after its scheduled arrival', async () => {
    const journey = await save();
    clock = new Date('2026-11-03T19:10:00Z');
    await deliver(ts([{ tpl: 'KNGX', ptd: '17:00', wtd: '17:00', dep: { at: '17:40' } }, { tpl: 'YORK', pta: '19:00', ptd: '19:03', wta: '19:00', wtd: '19:03', arr: { et: '19:42' } }]));
    expect((await live(journey.id)).state).toBe('departed');
    const upcoming = (await api().get('/v1/journeys').set(auth).expect(200)).body;
    expect(upcoming.journeys.map((j: { id: string }) => j.id)).toEqual([journey.id]);
    expect(upcoming.journeys[0].live).toMatchObject({ delayMinutes: 40, expectedArrival: '2026-11-03T19:42:00+00:00' });
  });

  it('shows a new journey on a run Darwin already knows straight away', async () => {
    await deliver(ts([{ tpl: 'KNGX', ptd: '17:00', wtd: '17:00', dep: { et: '17:02' }, plat: { conf: 'false', '': '8' } }]));
    const journey = await save();
    expect(journey.live).toMatchObject({ state: 'live', service: { rid: RID, platform: { number: '8', confirmed: false } } });
    expect((await db.selectFrom('journeys').select('rid').executeTakeFirstOrThrow()).rid).toBe(RID);
  });

  it('marks statuses stale when the feed goes quiet, and explains why', async () => {
    const journey = await save();
    await deliver(ts([{ tpl: 'KNGX', ptd: '17:00', wtd: '17:00', dep: { et: '17:00' } }]));
    await feedAlive(new Date(clock.getTime() - 10 * 60_000));
    const status = await live(journey.id);
    expect(status).toMatchObject({ state: 'live', stale: true, message: expect.stringMatching(/paused/) });
    expect((await api().get('/v1/journeys').set(auth).expect(200)).body.journeys[0].live.stale).toBe(true);
  });

  it('goes not_found 30 minutes after departure with no Darwin data (clock tick)', async () => {
    const journey = await save();
    clock = new Date('2026-11-03T17:31:00Z');
    const deps = { db, lookups, now: () => clock, darwinEnabled: true, feedHealthy: () => true };
    await updateJourneys(deps, await journeysDueForTick(db, clock));
    expect(await live(journey.id)).toMatchObject({ state: 'not_found', nextPollSeconds: null });
  });

  it('is cancelled when Darwin cancels the boarding call', async () => {
    const journey = await save();
    await deliver({
      schedule: {
        rid: RID, uid: 'A00001', ssd: '2026-11-03', toc: 'GR', trainId: '1S25', cancelReason: { '': '104' },
        OR: { tpl: 'KNGX', ptd: '17:00', wtd: '17:00', can: 'true' },
        DT: { tpl: 'YORK', pta: '19:00', wta: '19:00', can: 'true' },
      },
    });
    expect(await live(journey.id)).toMatchObject({ state: 'cancelled', message: 'Cancelled', service: { isCancelled: true } });
    expect((await api().get('/v1/journeys').set(auth).expect(200)).body.journeys[0].live).toMatchObject({ state: 'cancelled', isCancelled: true });
  });
});

describe('live overlays on reference data', () => {
  beforeEach(async () => {
    await deliver(
      ts([
        { tpl: 'KNGX', ptd: '17:00', wtd: '17:00', dep: { et: '17:06' }, plat: { conf: 'true', '': '9' } },
        { tpl: 'PBRO', pta: '17:45', ptd: '17:47', wta: '17:45', wtd: '17:47', arr: { et: '17:50' }, dep: { et: '17:52' } },
      ]),
    );
  });

  it('adds live data to departures', async () => {
    const res = await api().get('/v1/stations/KGX/departures?date=2026-11-03').set(auth).expect(200);
    expect(res.body.departures[0]).toMatchObject({
      trainUid: 'A00001',
      live: { expectedDeparture: '2026-11-03T17:06:00+00:00', actualDeparture: null, delayMinutes: 6, platform: { number: '9', confirmed: true }, isCancelled: false },
    });
    // Darwin has nothing for the late train: no overlay.
    expect(res.body.departures[1].live).toBeNull();
  });

  it('adds live data to train calling points', async () => {
    const res = await api().get('/v1/trains/A00001/2026-11-03').set(auth).expect(200);
    expect(res.body.callingPoints[1].live).toEqual({
      expectedArrival: '2026-11-03T17:50:00+00:00',
      expectedDeparture: '2026-11-03T17:52:00+00:00',
      actualArrival: null,
      actualDeparture: null,
      platform: null,
      isCancelled: false,
    });
    expect(res.body.callingPoints[3].live).toBeNull();
  });

  it('reports the feed in /v1/status', async () => {
    const res = await api().get('/v1/status').expect(200);
    expect(res.body.darwin).toEqual({ enabled: true, healthy: expect.any(Boolean), lastMessageAt: '2026-11-03T16:40:00+00:00', lagSeconds: 0.3, gapAt: null });
  });
});
