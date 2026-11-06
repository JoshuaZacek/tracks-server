import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { importSchedule } from '../../src/ingest/schedule/import.ts';
import { createLogger } from '../../src/logger.ts';
import { materialiseTemplates } from '../../src/modules/journey-templates/service.ts';
import type { PushRequest, PushResult, PushSender } from '../../src/push/apns.ts';
import { createNotifier } from '../../src/push/notifier.ts';
import { createTestContext, registerDevice, resetData } from '../helpers.ts';

const FIXTURE = fileURLToPath(new URL('../fixtures/schedule-mini.ndjson', import.meta.url));
const BUNDLE = 'com.joshuazacek.TrainTracker';
const APNS_TOKEN = 'a1'.repeat(32);

/** Tuesday 3 Nov 2026, midday. Tests move the clock as needed. */
let clock = new Date('2026-11-03T12:00:00Z');
const { db, api, config, lookups } = createTestContext({ now: () => clock });
const log = createLogger({ ...config, logLevel: 'silent' }, 'test');
let auth: { Authorization: string };

/** What the worker does daily after the timetable import (and hourly). */
const materialise = () => materialiseTemplates({ db, lookups, now: () => clock, darwinEnabled: false, log });

const WEEKDAYS = [1, 2, 3, 4, 5];
const KGX_YRK = { fromCrs: 'KGX', toCrs: 'YRK', departTime: '17:00', days: WEEKDAYS };
/** A00005 runs every day at 10:00, Waterloo to Clapham Junction. */
const WAT_CLJ = { fromCrs: 'WAT', toCrs: 'CLJ', departTime: '10:00', days: [1, 2, 3, 4, 5, 6, 7] };

const create = (body: object, as = auth) => api().post('/v1/journey-templates').set(as).send(body);
const templates = async (as = auth) => (await api().get('/v1/journey-templates').set(as).expect(200)).body.templates;
const journeysOf = (templateId: string) =>
  db.selectFrom('journeys').select(['id', 'date', 'train_uid', 'scheduled_departure', 'prefs', 'travel_minutes']).where('template_id', '=', templateId).orderBy('date').execute();

beforeAll(async () => {
  await importSchedule(config.databaseUrl, FIXTURE, () => {});
});
beforeEach(async () => {
  clock = new Date('2026-11-03T12:00:00Z');
  await resetData(db);
  await sql`INSERT INTO meta (key, value) VALUES ('schedule_imported_at', now()::text)`.execute(db);
  ({ auth } = await registerDevice(api));
});
afterAll(() => db.destroy());

describe('regular journeys API', () => {
  it('creates a template and its next journeys straight away', async () => {
    const res = await create({ ...KGX_YRK, days: [5, 1, 2, 3, 4, 1], travelMinutes: 20, summaryTime: '16:15', prefs: { delays: false } }).expect(201);
    expect(res.body).toMatchObject({
      from: { crs: 'KGX', name: 'London Kings Cross' },
      to: { crs: 'YRK', name: 'York' },
      departTime: '17:00',
      days: [1, 2, 3, 4, 5],
      trainUid: 'A00001',
      travelMinutes: 20,
      summaryTime: '16:15',
      prefs: { delays: false },
      problem: null,
      nextJourney: { date: '2026-11-03', scheduledDeparture: '2026-11-03T17:00:00+00:00' },
      createdAt: '2026-11-03T12:00:00+00:00',
    });
    // Today's 17:00 and tomorrow's, which the timetable moves to 17:15 that day (same train).
    const made = await journeysOf(res.body.id);
    expect(made.map((j) => [j.date, j.train_uid, j.scheduled_departure.toISOString()])).toEqual([
      ['2026-11-03', 'A00001', '2026-11-03T17:00:00.000Z'],
      ['2026-11-04', 'A00001', '2026-11-04T17:15:00.000Z'],
    ]);
    expect(made.every((j) => j.travel_minutes === 20 && j.prefs.delays === false)).toBe(true);

    const journey = (await api().get(`/v1/journeys/${res.body.nextJourney.id}`).set(auth).expect(200)).body;
    expect(journey).toMatchObject({ templateId: res.body.id, travelMinutes: 20, prefs: { delays: false } });
    const listed = (await api().get('/v1/journeys').set(auth).expect(200)).body.journeys;
    expect(listed.map((j: { templateId: string }) => j.templateId)).toEqual([res.body.id, res.body.id]);
  });

  it('lists by departure time, changes and deletes templates', async () => {
    const evening = (await create(KGX_YRK).expect(201)).body;
    const morning = (await create(WAT_CLJ).expect(201)).body;
    expect((await templates()).map((t: { id: string }) => t.id)).toEqual([morning.id, evening.id]);

    const res = await api()
      .patch(`/v1/journey-templates/${evening.id}`)
      .set(auth)
      .send({ days: [1, 3], travelMinutes: 25, summaryTime: '16:00', prefs: { delays: false, stopAlarm: true } })
      .expect(200);
    expect(res.body).toMatchObject({ days: [1, 3], travelMinutes: 25, summaryTime: '16:00', prefs: { delays: false, stopAlarm: true }, departTime: '17:00' });
    const cleared = await api()
      .patch(`/v1/journey-templates/${evening.id}`)
      .set(auth)
      .send({ travelMinutes: null, summaryTime: null, prefs: { delays: null }, departTime: '17:10' })
      .expect(200);
    expect(cleared.body).toMatchObject({ travelMinutes: null, summaryTime: null, prefs: { stopAlarm: true }, departTime: '17:10' });
    // Journeys already made keep their time.
    expect((await journeysOf(evening.id)).map((j) => j.scheduled_departure.toISOString())).toEqual([
      '2026-11-03T17:00:00.000Z',
      '2026-11-04T17:15:00.000Z',
    ]);

    // Stop repeating: the journeys stay, no longer linked.
    const before = await db.selectFrom('journeys').select('id').where('template_id', '=', evening.id).execute();
    await api().delete(`/v1/journey-templates/${evening.id}`).set(auth).expect(204);
    await api().delete(`/v1/journey-templates/${evening.id}`).set(auth).expect(404);
    const after = await db.selectFrom('journeys').select(['id', 'template_id']).where('id', 'in', before.map((j) => j.id)).execute();
    expect(after).toHaveLength(2);
    expect(after.every((j) => j.template_id === null)).toBe(true);
    expect((await templates()).map((t: { id: string }) => t.id)).toEqual([morning.id]);
  });

  it.each([
    ['the same station twice', { ...KGX_YRK, toCrs: 'KGX' }, 422, 'validation_failed'],
    ['an unknown station', { ...KGX_YRK, toCrs: 'ZZZ' }, 404, 'station_not_found'],
    ['an unknown journey', { ...KGX_YRK, journeyId: '00000000-0000-4000-8000-000000000000' }, 404, 'journey_not_found'],
    ['no days', { ...KGX_YRK, days: [] }, 400, 'validation_failed'],
    ['a day out of range', { ...KGX_YRK, days: [0] }, 400, 'validation_failed'],
    ['a bad time', { ...KGX_YRK, departTime: '7:42' }, 400, 'validation_failed'],
    ['a travel time over 4 hours', { ...KGX_YRK, travelMinutes: 241 }, 400, 'validation_failed'],
  ])('rejects %s', async (_label, body, status, code) => {
    expect((await create(body).expect(status)).body.error.code).toBe(code);
  });

  it("keeps templates to their device: another device's is 404, and they go with the device", async () => {
    const mine = (await create(KGX_YRK).expect(201)).body;
    const other = await registerDevice(api);
    expect(await templates(other.auth)).toEqual([]);
    await api().patch(`/v1/journey-templates/${mine.id}`).set(other.auth).send({ days: [1] }).expect(404);
    await api().delete(`/v1/journey-templates/${mine.id}`).set(other.auth).expect(404);
    await api().get('/v1/journey-templates').expect(401);
    // Nor can another device repeat my journey.
    const res = await create({ ...KGX_YRK, journeyId: mine.nextJourney.id }, other.auth).expect(404);
    expect(res.body.error.code).toBe('journey_not_found');

    expect((await templates()).map((t: { id: string }) => t.id)).toEqual([mine.id]);
    await api().delete('/v1/devices/me').set(auth).expect(204);
    expect(await db.selectFrom('journey_templates').select('id').execute()).toEqual([]);
  });

  it('repeats a saved journey (journeyId): links it, counts its date as made, and takes its settings as defaults', async () => {
    const saved = (await api().post('/v1/journeys').set(auth).send({ trainUid: 'A00001', runDate: '2026-11-03', fromCrs: 'KGX', toCrs: 'YRK' }).expect(201)).body;
    await api()
      .patch(`/v1/journeys/${saved.id}`)
      .set(auth)
      .send({ travelMinutes: 15, prefs: { delays: false } })
      .expect(200);
    const res = await create({ ...KGX_YRK, journeyId: saved.id }).expect(201);
    expect(res.body).toMatchObject({ trainUid: 'A00001', travelMinutes: 15, prefs: { delays: false }, nextJourney: { id: saved.id, date: '2026-11-03' } });
    expect((await api().get(`/v1/journeys/${saved.id}`).set(auth).expect(200)).body).toMatchObject({ templateId: res.body.id, travelMinutes: 15 });
    // Today was the saved journey; tomorrow's is new.
    const made = await journeysOf(res.body.id);
    expect(made.map((j) => [j.id === saved.id, j.date, j.travel_minutes, j.prefs])).toEqual([
      [true, '2026-11-03', 15, { delays: false }],
      [false, '2026-11-04', 15, { delays: false }],
    ]);
    const row = await db.selectFrom('journey_templates').select('last_created_date').where('id', '=', res.body.id).executeTakeFirstOrThrow();
    expect(row.last_created_date).toBe('2026-11-04');

    // Values in the body win over the journey's.
    const late = (await api().post('/v1/journeys').set(auth).send({ trainUid: 'A00002', runDate: '2026-11-03', fromCrs: 'KGX', toCrs: 'YRK' }).expect(201)).body;
    await api().patch(`/v1/journeys/${late.id}`).set(auth).send({ travelMinutes: 15, prefs: { delays: false } }).expect(200);
    const other = await create({ ...KGX_YRK, departTime: '23:50', journeyId: late.id, travelMinutes: null, prefs: {} }).expect(201);
    expect(other.body).toMatchObject({ trainUid: 'A00002', travelMinutes: null, prefs: {}, nextJourney: { id: late.id } });
  });

  it('PATCH /v1/journeys sets and clears the travel time', async () => {
    const saved = (await api().post('/v1/journeys').set(auth).send({ trainUid: 'A00001', runDate: '2026-11-03', fromCrs: 'KGX', toCrs: 'YRK' }).expect(201)).body;
    expect(saved).toMatchObject({ templateId: null, travelMinutes: null });
    expect((await api().patch(`/v1/journeys/${saved.id}`).set(auth).send({ travelMinutes: 12 }).expect(200)).body.travelMinutes).toBe(12);
    await api().patch(`/v1/journeys/${saved.id}`).set(auth).send({ travelMinutes: 241 }).expect(400);
    expect((await api().patch(`/v1/journeys/${saved.id}`).set(auth).send({ travelMinutes: null }).expect(200)).body.travelMinutes).toBeNull();
  });
});

describe('materialising', () => {
  it('creates a journey every day for a week, and only once however often it runs', async () => {
    // Created at midday, after the 10:00: tomorrow is the first.
    const daily = (await create(WAT_CLJ).expect(201)).body;
    const weekdays = (await create(KGX_YRK).expect(201)).body;

    // The daily refresh at 04:00 for a week, plus the hourly catch-up.
    for (let day = 4; day <= 10; day++) {
      clock = new Date(`2026-11-${String(day).padStart(2, '0')}T04:00:00Z`);
      await materialise();
      clock = new Date(clock.getTime() + 3600_000);
      expect(await materialise()).toBe(0);
    }
    expect((await journeysOf(daily.id)).map((j) => `${j.date} ${j.scheduled_departure.toISOString().slice(11, 16)} ${j.train_uid}`)).toEqual([
      '2026-11-04 10:00 A00005',
      '2026-11-05 10:00 A00005',
      '2026-11-06 10:00 A00005',
      '2026-11-07 10:00 A00005',
      '2026-11-08 10:00 A00005',
      '2026-11-09 10:00 A00005',
      '2026-11-10 10:00 A00005',
      '2026-11-11 10:00 A00005',
    ]);
    // Weekdays only (today included, as it was made before 17:00).
    expect((await journeysOf(weekdays.id)).map((j) => j.date)).toEqual([
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
      '2026-11-09',
      '2026-11-10',
      '2026-11-11',
    ]);
    const [t] = await templates();
    expect(t).toMatchObject({ id: daily.id, problem: null, nextJourney: { date: '2026-11-10' } });
  });

  it('never makes a skipped (deleted) journey again', async () => {
    const t = (await create(WAT_CLJ).expect(201)).body;
    const [tomorrow] = await journeysOf(t.id);
    expect(tomorrow!.date).toBe('2026-11-04');
    await api().delete(`/v1/journeys/${tomorrow!.id}`).set(auth).expect(204);

    await materialise();
    clock = new Date('2026-11-04T04:00:00Z');
    await materialise();
    expect((await journeysOf(t.id)).map((j) => j.date)).toEqual(['2026-11-05']);
    expect((await templates())[0].nextJourney.date).toBe('2026-11-05');
  });

  it('flags a date with no matching train, alerts once, retries once, then moves on', async () => {
    await api().patch('/v1/devices/me').set(auth).send({ apnsToken: APNS_TOKEN, apnsEnvironment: 'sandbox' }).expect(200);
    // Nothing leaves King's Cross for York around 14:00, on Tuesdays only.
    const t = (await create({ ...KGX_YRK, departTime: '14:00', days: [2] }).expect(201)).body;
    const problem = { date: '2026-11-03', message: "Couldn't find your 14:00 London Kings Cross → York on Tuesday. Check your regular journey." };
    expect(t).toMatchObject({ problem, nextJourney: null });
    expect(await journeysOf(t.id)).toEqual([]);

    const log_ = () =>
      db.selectFrom('push_log').select(['journey_id', 'template_id', 'channel', 'kind', 'dedupe_key', 'outcome', 'payload']).orderBy('id').execute();
    expect(await log_()).toEqual([
      {
        journey_id: null,
        template_id: t.id,
        channel: 'alert',
        kind: 'template_unmatched',
        dedupe_key: 'template_unmatched:2026-11-03',
        outcome: 'pending',
        payload: {
          aps: { alert: { title: 'Regular journey', body: problem.message }, sound: 'default', 'thread-id': t.id, 'interruption-level': 'active' },
          kind: 'template_unmatched',
          templateId: t.id,
          date: '2026-11-03',
        },
      },
    ]);

    // The notifier's tick sends it, once.
    const sent: PushRequest[] = [];
    const sender: PushSender = {
      async send(r: PushRequest): Promise<PushResult> {
        sent.push(r);
        return { ok: true, status: 200, apnsId: 'x', reason: null, unregistered: false, retryable: false };
      },
      async close() {},
    };
    const notifier = createNotifier({ db, log, sender, bundleId: BUNDLE, darwinEnabled: false, now: () => clock });
    notifier.tick();
    await notifier.idle();
    notifier.tick();
    await notifier.idle();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ token: APNS_TOKEN, pushType: 'alert', topic: BUNDLE, priority: 10 });
    expect(sent[0]!.payload).not.toHaveProperty('journeyId');
    expect((await log_())[0]!.outcome).toBe('sent');

    // The next run tries the date again (no second alert), then gives it up; the problem shows until a match.
    await materialise();
    const row = await db.selectFrom('journey_templates').select(['last_created_date', 'problem_date']).where('id', '=', t.id).executeTakeFirstOrThrow();
    expect(row).toEqual({ last_created_date: '2026-11-03', problem_date: '2026-11-03' });
    expect(await log_()).toHaveLength(1);
    expect((await templates())[0].problem).toEqual(problem);

    // Fixing the time clears it; the next Tuesday matches.
    const fixed = await api().patch(`/v1/journey-templates/${t.id}`).set(auth).send({ departTime: '17:00' }).expect(200);
    expect(fixed.body.problem).toBeNull();
    clock = new Date('2026-11-09T04:00:00Z');
    await materialise();
    expect((await journeysOf(t.id)).map((j) => j.date)).toEqual(['2026-11-10']);
  });
});
