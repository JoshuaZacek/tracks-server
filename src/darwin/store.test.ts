import fs from 'node:fs';
import { sql } from 'kysely';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../db/client.ts';
import { parseMessage, type DarwinLocation } from './parse.ts';
import { DarwinBatch, flushBatch, mergeLocation, pruneDarwin } from './store.ts';

const base = { tpl: 'MNCRPIC', ptd: '00:52', wtd: '00:52' };
const confirmed7 = { number: '7', confirmed: true, suppressed: false };

describe('mergeLocation', () => {
  const before: DarwinLocation = { ...base, dep: { et: '00:52' }, arr: null, pass: null, plat: confirmed7 };

  it('keeps the platform the train left from when the departure report leaves it out', () => {
    const merged = mergeLocation(before, { ...base, dep: { at: '00:53' }, arr: null, pass: null, plat: null });
    expect(merged.dep).toEqual({ at: '00:53' });
    expect(merged.plat).toEqual(confirmed7);
  });

  it('keeps it confirmed when a report after departure restates it without conf', () => {
    const merged = mergeLocation(before, { ...base, dep: { at: '00:53' }, arr: null, pass: null, plat: { number: '7', confirmed: false, suppressed: true } });
    expect(merged.plat).toEqual({ number: '7', confirmed: true, suppressed: true });
  });

  it('takes a different platform number, after departure too', () => {
    const plat = { number: '8', confirmed: false, suppressed: false };
    expect(mergeLocation(before, { ...base, dep: { at: '00:53' }, arr: null, pass: null, plat }).plat).toEqual(plat);
  });

  it('lets Darwin drop or unconfirm a platform before the train has left', () => {
    expect(mergeLocation(before, { ...base, dep: { et: '00:55' }, arr: null, pass: null, plat: null }).plat).toBeNull();
    const unconfirmed = { number: '7', confirmed: false, suppressed: false };
    expect(mergeLocation(before, { ...base, dep: { et: '00:55' }, arr: null, pass: null, plat: unconfirmed }).plat).toEqual(unconfirmed);
  });

  it('keeps forecasts and the platform when a schedule restates planned fields', () => {
    const departed: DarwinLocation = { ...before, dep: { at: '00:53' } };
    expect(mergeLocation(departed, { ...base, ptd: '00:52', can: false })).toEqual({ ...departed, can: false });
  });
});

describe('mergeLocation with loading', () => {
  const key = { tpl: 'KEWGRDN', wta: '16:34', wtd: '16:34:30', pta: '16:34', ptd: '16:34' };
  const plat = { number: '1', confirmed: true, suppressed: false };
  const coachLoading = { fid: 'R-001', coaches: [{ number: '1', percentage: 40 }] };

  it('a loading update keeps forecasts, platform, cancellation and formation', () => {
    const stored: DarwinLocation = { ...key, can: false, fid: 'R-001', arr: { et: '16:36' }, dep: { et: '16:37' }, pass: null, plat };
    expect(mergeLocation(stored, { ...key, loading: 33 })).toEqual({ ...stored, loading: 33 });
    expect(mergeLocation(stored, { ...key, coachLoading })).toEqual({ ...stored, coachLoading });
  });

  it('a TS or a schedule keeps the loading and formation already stored', () => {
    const stored: DarwinLocation = { ...key, can: false, fid: 'R-001', loading: 33, coachLoading, arr: null, dep: { et: '16:37' }, pass: null, plat: null };
    const ts = parseMessage(JSON.stringify({ bytes: JSON.stringify({ uR: { TS: { rid: 'R', uid: 'U', ssd: '2026-11-07', Location: { ...key, dep: { at: '16:38' } } } } }) }));
    expect(mergeLocation(stored, ts.locations[0]!.loc)).toEqual({ ...stored, dep: { at: '16:38' } });
    const schedule = parseMessage(JSON.stringify({ bytes: JSON.stringify({ uR: { schedule: { rid: 'R', uid: 'U', ssd: '2026-11-07', IP: { ...key, can: 'true' } } } }) }));
    expect(mergeLocation(stored, schedule.locations[0]!.loc)).toEqual({ ...stored, can: true });
  });
});

const sample = <T>(name: string): T => JSON.parse(fs.readFileSync(new URL(`../../docs/samples/${name}`, import.meta.url), 'utf8')) as T;
let seq = 1;
const message = (uR: object) => JSON.stringify({ bytes: JSON.stringify({ ts: '2026-11-07T17:30:00Z', uR }), properties: { PushPortSequence: { string: String(seq++) } } });
const batchOf = (...uRs: object[]) => {
  const batch = new DarwinBatch();
  for (const uR of uRs) batch.add(parseMessage(message(uR)), Date.now());
  return batch;
};

const MAIN = '202611077126226';
const PORTION = '202611076782431';
const vv = (extra: object = {}) => ({
  tiploc: 'HORSHAM',
  category: 'VV',
  main: { rid: MAIN, wta: '17:27', wtd: '17:31', pta: '17:27', ptd: '17:31' },
  assoc: { rid: PORTION, wtd: '17:35', ptd: '17:35' },
  ...extra,
});

describe('DarwinBatch', () => {
  it('keeps the last update of each association, deletions included, and touches both trains', () => {
    const batch = batchOf({ association: vv() }, { association: [vv({ isCancelled: 'true' }), vv({ category: 'NP' })] });
    expect([...batch.associations.values()]).toEqual([expect.objectContaining({ mainRid: MAIN, assocRid: PORTION, cancelled: true, deleted: false })]);
    batch.add(parseMessage(message({ association: vv({ isDeleted: 'true' }) })), Date.now());
    expect([...batch.associations.values()]).toEqual([expect.objectContaining({ deleted: true })]);
    expect(batch.empty).toBe(false);
    expect(batch.touched()).toEqual({ rids: [MAIN, PORTION], trains: [] });
  });

  it('keeps formations by id and station messages by id, and touches the formation run only', () => {
    const batch = batchOf(
      { scheduleFormations: { rid: 'R1', formation: { fid: 'R1-001', coaches: { coach: { coachNumber: '1' } } } } },
      { scheduleFormations: { rid: 'R1', formation: { fid: 'R1-001', coaches: { coach: [{ coachNumber: '1' }, { coachNumber: '2' }] } } } },
      { OW: { id: '9', cat: 'Station', sev: '0', Station: { crs: 'KGX' }, Msg: 'A' } },
      { OW: { id: '9', cat: 'Station', sev: '0', Msg: 'A' } },
    );
    expect(batch.formations.get('R1-001')!.coaches).toHaveLength(2);
    expect(batch.stationMessages.get('9')!.crs).toEqual([]);
    expect(batch.touched().rids).toEqual(['R1']);
    expect(batchOf({ OW: { id: '9', cat: 'Station', sev: '0', Msg: 'A' } }).empty).toBe(false);
  });
});

describe('flushBatch and pruneDarwin (database)', () => {
  const db = createDb(process.env.DATABASE_URL!, { max: 1 });
  const crsOf = (tpl: string) => ({ HORSHAM: 'HRH', BRHM: 'BAA', KEWGRDN: 'KWG' })[tpl] ?? null;
  const flush = (...uRs: object[]) => flushBatch(db, batchOf(...uRs), crsOf);
  const stored = async (rid: string, tpl: string) =>
    (await db.selectFrom('darwin_locations').select('loc').where('rid', '=', rid).where('tpl', '=', tpl).executeTakeFirstOrThrow()).loc as DarwinLocation;
  const associations = () => db.selectFrom('darwin_associations').selectAll().orderBy('main_rid').orderBy('category').execute();
  const messages = () => db.selectFrom('darwin_station_messages').selectAll().orderBy('id').execute();

  beforeEach(async () => {
    await sql`TRUNCATE darwin_services, darwin_locations, darwin_associations, darwin_formations, darwin_station_messages`.execute(db);
  });
  afterAll(() => db.destroy());

  it('stores loading on the location without losing forecasts, and the other way round', async () => {
    const kew = { tpl: 'KEWGRDN', wta: '16:34', wtd: '16:34:30', pta: '16:34', ptd: '16:34' };
    const ts = (dep: object) => ({ TS: { rid: 'R1', uid: 'C00001', ssd: '2026-11-07', Location: { ...kew, dep, plat: { conf: 'true', '': '2' } } } });
    await flush(ts({ et: '16:36' }));
    await flush({ serviceLoading: { rid: 'R1', ...kew, loadingPercentage: '33' } });
    await flush({ formationLoading: { fid: 'R1-001', rid: 'R1', ...kew, loading: [{ coachNumber: '1', '': '20' }, { coachNumber: '2', '': '50' }] } });
    expect(await stored('R1', 'KEWGRDN')).toEqual({
      ...kew,
      arr: null,
      dep: { et: '16:36' },
      pass: null,
      plat: { number: '2', confirmed: true, suppressed: false },
      loading: 33,
      coachLoading: { fid: 'R1-001', coaches: [{ number: '1', percentage: 20 }, { number: '2', percentage: 50 }] },
    });
    await flush(ts({ at: '16:37' }), { schedule: { rid: 'R1', uid: 'C00001', ssd: '2026-11-07', IP: { ...kew, fid: 'R1-001' } } });
    expect(await stored('R1', 'KEWGRDN')).toMatchObject({ dep: { at: '16:37' }, can: false, fid: 'R1-001', loading: 33, coachLoading: { fid: 'R1-001' } });
    // Loading for a run not seen yet (Darwin sends tomorrow's) is kept too, and has a CRS.
    await flush({ serviceLoading: { rid: 'R2', ...kew, loadingPercentage: '5' } });
    expect(await db.selectFrom('darwin_locations').select(['crs', 'loc']).where('rid', '=', 'R2').execute()).toEqual([{ crs: 'KWG', loc: { ...kew, loading: 5 } }]);
  });

  it('stores divides and joins, updates a cancellation, removes a deleted one and ignores next-workings', async () => {
    const { association, main, assoc } = sample<{ association: object; main: object; assoc: object }>('darwin-divide-horsham.json');
    await flush({ schedule: [main, assoc], association }, { association: sample<object[]>('darwin-association.json') });
    const rows = await associations();
    // VV Horsham (cancelled by the later message), VV Purley, JJ Horsham ×2; the deleted JJ never stored.
    expect(rows.map((r) => `${r.category} ${r.tiploc} ${r.cancelled}`).sort()).toEqual(['JJ HORSHAM false', 'JJ HORSHAM false', 'VV HORSHAM true', 'VV PURLEY false']);
    expect(rows.find((r) => r.main_rid === MAIN)).toMatchObject({
      assoc_rid: PORTION,
      main_times: { wta: '17:27', pta: '17:27' },
      assoc_times: { wtd: '17:35', ptd: '17:35' },
    });
    await flush({ association: vv() });
    expect((await associations()).find((r) => r.main_rid === MAIN)).toMatchObject({ cancelled: false, main_times: { wta: '17:27', wtd: '17:31', pta: '17:27', ptd: '17:31' } });
    await flush({ association: vv({ isDeleted: 'true' }) });
    expect((await associations()).find((r) => r.main_rid === MAIN)).toBeUndefined();
    expect(await associations()).toHaveLength(3);
  });

  it('stores formations by id, replacing their coaches', async () => {
    await flush({ scheduleFormations: sample<object[]>('darwin-scheduleFormations.json') });
    const rows = await db.selectFrom('darwin_formations').selectAll().orderBy('fid').execute();
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ fid: '202611076736997-001', rid: '202611076736997', coaches: expect.arrayContaining([{ number: '1', class: 'Standard' }]) });
    await flush({ scheduleFormations: { rid: '202611076736997', formation: { fid: '202611076736997-001', coaches: { coach: { coachNumber: '1', coachClass: 'First' } } } } });
    expect((await db.selectFrom('darwin_formations').select('coaches').where('fid', '=', '202611076736997-001').executeTakeFirstOrThrow()).coaches).toEqual([
      { number: '1', class: 'First' },
    ]);
  });

  it('stores station messages, replacing their stations, and removes one restated without stations', async () => {
    await flush({ OW: sample<object[]>('darwin-OW.json') });
    let rows = await messages();
    expect(rows.map((r) => r.id)).toEqual(['145744', '190185', '190195', '190196', '190197']);
    // The last restatement wins: 145744 grew to 47 stations within the hour.
    expect(rows[0]!.crs).toHaveLength(47);
    expect(rows[2]).toMatchObject({ category: 'Train', severity: 1, suppress: false, url: 'https://www.nationalrail.co.uk/service-disruptions/aberdour-20261107/' });
    const taplow = await db.selectFrom('darwin_station_messages').select('id').where(sql<boolean>`crs @> ARRAY['TAP']`).execute();
    expect(taplow).toEqual([{ id: '190197' }]);
    await flush({ OW: [{ id: '190197', cat: 'Station', sev: '2', Station: [{ crs: 'TAP' }, { crs: 'MAI' }], Msg: 'Lifts' }, { id: '190185', cat: 'Train', sev: '1', Msg: 'Gone' }] });
    rows = await messages();
    expect(rows.map((r) => r.id)).toEqual(['145744', '190195', '190196', '190197']);
    expect(rows[3]).toMatchObject({ severity: 2, message: 'Lifts', crs: ['TAP', 'MAI'] });
  });

  it('prunes associations and formations with their runs, and station messages not restated for 3 days', async () => {
    await flush(
      { association: [vv(), vv({ main: { rid: '202611047126226' }, assoc: { rid: '202611076782431' } })] },
      { scheduleFormations: [{ rid: '202611041111111', formation: { fid: 'old-001' } }, { rid: '202611061111111', formation: { fid: 'new-001' } }] },
      { OW: [{ id: 'old', cat: 'Station', sev: '0', Station: { crs: 'KGX' }, Msg: 'Old' }, { id: 'new', cat: 'Station', sev: '0', Station: { crs: 'KGX' }, Msg: 'New' }] },
    );
    await sql`UPDATE darwin_station_messages SET updated_at = now() - interval '3 days 1 hour' WHERE id = 'old'`.execute(db);
    await pruneDarwin(db, '2026-11-07');
    expect((await associations()).map((r) => r.main_rid)).toEqual([MAIN]);
    expect((await db.selectFrom('darwin_formations').select('fid').execute()).map((r) => r.fid)).toEqual(['new-001']);
    expect((await messages()).map((r) => r.id)).toEqual(['new']);
  });
});
