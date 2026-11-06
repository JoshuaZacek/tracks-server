import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importSchedule } from '../../src/ingest/schedule/import.ts';
import { resetScheduleCache } from '../../src/modules/reference.ts';
import { createTestContext, registerDevice, resetData } from '../helpers.ts';

const FIXTURE = fileURLToPath(new URL('../fixtures/schedule-mini.ndjson', import.meta.url));
const { db, api, config } = createTestContext();
let auth: { Authorization: string };

const get = (path: string) => api().get(path).set(auth);
const quiet = () => {};

beforeAll(async () => {
  await resetData(db);
  await sql`TRUNCATE stations`.execute(db);
  resetScheduleCache();
  ({ auth } = await registerDevice(api));
});
afterAll(() => db.destroy());

describe('before any timetable import', () => {
  it('departures and trains answer 503 schedule_not_loaded, and /ready is not ready', async () => {
    expect((await get('/v1/stations/KGX/departures?date=2026-11-03').expect(503)).body.error.code).toBe('schedule_not_loaded');
    expect((await get('/v1/trains/A00001/2026-11-03').expect(503)).body.error.code).toBe('schedule_not_loaded');
    expect((await api().get('/ready').expect(503)).body.error.code).toBe('schedule_not_loaded');
  });
});

describe('with the fixture timetable', () => {
  beforeAll(async () => {
    // Twice: the second import must swap cleanly over the first.
    await importSchedule(config.databaseUrl, FIXTURE, quiet);
    const summary = await importSchedule(config.databaseUrl, FIXTURE, quiet);
    expect(summary).toMatchObject({ schedules: 9, passengerSchedules: 7, unmappedCalls: 0 });
    resetScheduleCache();
    // Knowledgebase coordinates for a few stations (normally fetched by the worker).
    const coords: [string, number, number][] = [
      ['KGX', 51.5308, -0.1238],
      ['FPK', 51.5643, -0.1065],
      ['PBO', 52.5748, -0.2501],
      ['YRK', 53.958, -1.093],
    ];
    for (const [crs, lat, lon] of coords) {
      await db.updateTable('stations').set({ lat, lon, kb_status: 'ok' }).where('crs', '=', crs).execute();
    }
  });

  it('marks the timetable loaded in /v1/status and /ready', async () => {
    const status = (await api().get('/v1/status').expect(200)).body;
    expect(status.schedule).toMatchObject({ loaded: true, generatedAt: '2026-10-05T01:00:00+01:00' });
    expect(status.stations).toEqual({ total: 7, withCoordinates: 4 });
    await api().get('/ready').expect(200);
  });

  it('counts each station\'s public calls, for ranking search results', async () => {
    const rows = await db.selectFrom('stations').select(['crs', 'calls']).where('in_schedule', '=', true).execute();
    const { rows: counted } = await sql<{ crs: string; n: number }>`
      SELECT crs, count(*)::int AS n FROM schedule.schedule_locations WHERE crs IS NOT NULL GROUP BY crs`.execute(db);
    expect(Object.fromEntries(rows.map((r) => [r.crs, r.calls]))).toEqual(Object.fromEntries(counted.map((r) => [r.crs, r.n])));
    expect(rows.every((r) => r.calls > 0)).toBe(true);
  });

  describe('stations', () => {
    it('searches by name and by CRS code, exact CRS first, Knowledgebase-located stations before others', async () => {
      const york = (await get('/v1/stations?q=york').expect(200)).body.stations;
      expect(york[0]).toEqual({ crs: 'YRK', name: 'York', lat: 53.958, lon: -1.093 });
      const kgx = (await get('/v1/stations?q=kgx').expect(200)).body.stations;
      expect(kgx.map((s: { crs: string }) => s.crs)).toEqual(['KGX']);
      expect((await get('/v1/stations?q=lon').expect(200)).body.stations.map((s: { crs: string }) => s.crs)).toEqual(['KGX', 'WAT']);
    });

    it('treats LIKE wildcards in the query literally', async () => {
      expect((await get('/v1/stations?q=%25').expect(200)).body.stations).toEqual([]);
    });

    it('finds the nearest stations with distances', async () => {
      const res = await get('/v1/stations/nearby?lat=51.5320&lon=-0.1233&limit=2').expect(200);
      expect(res.body.stations.map((s: { crs: string }) => s.crs)).toEqual(['KGX', 'FPK']);
      expect(res.body.stations[0].distanceMeters).toBeGreaterThan(100);
      expect(res.body.stations[0].distanceMeters).toBeLessThan(200);
    });

    it('gets one station; unknown codes are 404 station_not_found', async () => {
      expect((await get('/v1/stations/yrk').expect(200)).body).toMatchObject({ crs: 'YRK', name: 'York' });
      expect((await get('/v1/stations/ZZZ').expect(404)).body.error.code).toBe('station_not_found');
    });

    it('names stations from the timetable until Knowledgebase has them, and maps secondary TIPLOCs by NLC', async () => {
      expect((await get('/v1/stations/WAT').expect(200)).body).toEqual({ crs: 'WAT', name: 'London Waterloo', lat: null, lon: null });
    });
  });

  describe('departures', () => {
    const headcodes = (body: { departures: { headcode: string }[] }) => body.departures.map((d) => d.headcode);

    it('lists passenger trains, hides STP cancellations and freight', async () => {
      const res = await get('/v1/stations/KGX/departures?date=2026-11-03').expect(200);
      expect(headcodes(res.body)).toEqual(['1S25', '1N99']);
      expect(res.body.departures[0]).toEqual({
        trainUid: 'A00001',
        runDate: '2026-11-03',
        headcode: '1S25',
        operator: { code: 'GR', name: 'LNER' },
        scheduledDeparture: '2026-11-03T17:00:00+00:00',
        bookedPlatform: '7',
        destination: { crs: 'EDB', name: 'Edinburgh', lat: null, lon: null },
        arrival: null,
        live: null,
      });
      expect(res.body.nextCursor).toBeNull();
    });

    it('applies STP overlays on their day', async () => {
      const res = await get('/v1/stations/KGX/departures?date=2026-11-04').expect(200);
      expect(res.body.departures.map((d: { scheduledDeparture: string }) => d.scheduledDeparture)).toEqual([
        '2026-11-04T17:15:00+00:00',
        '2026-11-04T18:00:00+00:00',
        '2026-11-04T23:50:00+00:00',
      ]);
    });

    it('adds the arrival at `to`, crossing midnight', async () => {
      const res = await get('/v1/stations/KGX/departures?date=2026-11-03&to=yrk').expect(200);
      expect(res.body.to.crs).toBe('YRK');
      expect(res.body.departures.map((d: { arrival: unknown }) => d.arrival)).toEqual([
        { station: { crs: 'YRK', name: 'York', lat: 53.958, lon: -1.093 }, scheduledArrival: '2026-11-03T19:00:00+00:00' },
        { station: { crs: 'YRK', name: 'York', lat: 53.958, lon: -1.093 }, scheduledArrival: '2026-11-04T01:50:00+00:00' },
      ]);
    });

    it('includes trains that started the previous day and call after midnight', async () => {
      const res = await get('/v1/stations/PBO/departures?date=2026-11-04').expect(200);
      expect(res.body.departures[0]).toMatchObject({
        trainUid: 'A00002',
        runDate: '2026-11-03',
        scheduledDeparture: '2026-11-04T00:37:00+00:00',
      });
    });

    it('filters by `after` and pages with a cursor', async () => {
      expect(headcodes((await get('/v1/stations/KGX/departures?date=2026-11-03&after=18:00').expect(200)).body)).toEqual(['1N99']);

      const first = (await get('/v1/stations/KGX/departures?date=2026-11-04&limit=2').expect(200)).body;
      expect(first.departures).toHaveLength(2);
      expect(first.nextCursor).toEqual(expect.any(String));
      const second = (await get(`/v1/stations/KGX/departures?date=2026-11-04&limit=2&cursor=${first.nextCursor}`).expect(200)).body;
      expect(headcodes(second)).toEqual(['1N99']);
      expect(second.nextCursor).toBeNull();
    });

    it('rejects a bad cursor, the same station twice and unknown stations', async () => {
      expect((await get('/v1/stations/KGX/departures?date=2026-11-04&cursor=nonsense').expect(400)).body.error.details).toEqual([
        { in: 'query', path: 'cursor', message: 'Invalid cursor' },
      ]);
      await get('/v1/stations/KGX/departures?date=2026-11-04&to=KGX').expect(400);
      expect((await get('/v1/stations/ZZZ/departures?date=2026-11-04').expect(404)).body.error.code).toBe('station_not_found');
    });

    it('uses CRS codes derived for secondary TIPLOCs', async () => {
      expect(headcodes((await get('/v1/stations/WAT/departures?date=2026-11-03').expect(200)).body)).toEqual(['2C10']);
    });
  });

  describe('trains', () => {
    it('returns calling points with ISO times and the route of stations passed', async () => {
      const res = await get('/v1/trains/a00001/2026-11-03').expect(200);
      expect(res.body).toMatchObject({ trainUid: 'A00001', runDate: '2026-11-03', headcode: '1S25', operator: { code: 'GR', name: 'LNER' } });
      expect(res.body.callingPoints.map((c: { crs: string }) => c.crs)).toEqual(['KGX', 'PBO', 'YRK', 'EDB']);
      expect(res.body.callingPoints[0]).toEqual({
        crs: 'KGX',
        name: 'London Kings Cross',
        lat: 51.5308,
        lon: -0.1238,
        scheduledArrival: null,
        scheduledDeparture: '2026-11-03T17:00:00+00:00',
        bookedPlatform: '7',
        live: null,
      });
      expect(res.body.callingPoints.at(-1)).toMatchObject({ scheduledArrival: '2026-11-03T21:30:00+00:00', scheduledDeparture: null });
      // Finsbury Park, passed 4 minutes into the 45-minute leg to Peterborough; the junction has no CRS.
      expect(res.body.route).toEqual([{ lat: 51.5643, lon: -0.1065, leg: 0, f: 4 / 45 }]);
    });

    it('uses the overlay on its day', async () => {
      const res = await get('/v1/trains/A00001/2026-11-04').expect(200);
      expect(res.body.callingPoints.map((c: { scheduledDeparture: string | null }) => c.scheduledDeparture)).toEqual([
        '2026-11-04T17:15:00+00:00',
        '2026-11-04T18:02:00+00:00',
        null,
      ]);
    });

    it('is 404 train_not_running when cancelled, freight, or not running that day', async () => {
      for (const path of ['/v1/trains/A00003/2026-11-03', '/v1/trains/A00004/2026-11-03', '/v1/trains/A00001/2026-11-07']) {
        expect((await get(path).expect(404)).body.error.code, path).toBe('train_not_running');
      }
    });
  });

  describe('places', () => {
    it('serves the dataset gzipped with an ETag, and 304 when unchanged', async () => {
      const res = await get('/v1/reference/places').set('Accept-Encoding', 'gzip').expect(200);
      expect(res.headers['content-encoding']).toBe('gzip');
      expect(res.headers['cache-control']).toBe('public, max-age=86400');
      expect(res.body.attribution).toMatch(/Crown copyright/);
      expect(res.body.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/);
      expect(res.body.places.length).toBeGreaterThan(20_000);
      await get('/v1/reference/places').set('If-None-Match', res.headers.etag!).expect(304);
    });
  });
});
