import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { locationKey, parseMessage, toArray } from './parse.ts';

const sample = <T>(name: string): T => JSON.parse(fs.readFileSync(new URL(`../../docs/samples/${name}`, import.meta.url), 'utf8')) as T;

/** Wraps a Darwin document the way the RDM JSON topic does. */
const envelope = (doc: object, seq = 1) =>
  JSON.stringify({ messageType: 'bytes', bytes: JSON.stringify(doc), properties: { PushPortSequence: { string: String(seq), propertyType: 'string' } } });

describe('parseMessage', () => {
  it('reads every captured raw message: heartbeats and updates, with sequence numbers', () => {
    const raw = sample<{ value: object }[]>('darwin-raw-messages.json');
    const parsed = raw.map((m) => parseMessage(JSON.stringify(m.value)));
    expect(parsed.filter((p) => p.heartbeat).length).toBeGreaterThan(0);
    expect(parsed.filter((p) => p.services.length).length).toBeGreaterThan(0);
    for (const p of parsed) expect(p.sequence).toEqual(expect.any(Number));
    const seqs = parsed.map((p) => p.sequence!);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('normalises a TS: single Location object, platform text under "", string booleans', () => {
    const [ts] = sample<object[]>('darwin-TS.json');
    const p = parseMessage(envelope({ ts: '2026-11-03T01:56:11+00:00', uR: { TS: ts } }));
    expect(p.services).toEqual([{ rid: '202611036710190', uid: 'C10190', ssd: '2026-11-03', lateReason: null }]);
    expect(p.locations).toEqual([
      {
        rid: '202611036710190',
        key: 'NEWSGAT|01:55|01:55:30|',
        loc: {
          tpl: 'NEWSGAT',
          pta: '01:55',
          ptd: '01:55',
          wta: '01:55',
          wtd: '01:55:30',
          arr: { at: '01:54' },
          dep: { at: '01:55' },
          pass: null,
          plat: { number: '4', confirmed: true, suppressed: false },
        },
      },
    ]);
  });

  it('keeps estimates, late reasons and suppressed platforms from TS arrays', () => {
    const all = sample<{ LateReason?: string; Location: unknown }[]>('darwin-TS.json');
    const ts = all.find((t) => t.LateReason)!;
    const p = parseMessage(envelope({ uR: { TS: ts } }));
    expect(p.services[0]!.lateReason).toBe(ts.LateReason);
    expect(p.locations.length).toBe(toArray(ts.Location).length);
    expect(p.locations.some((l) => l.loc.dep?.et || l.loc.arr?.et || l.loc.pass?.et)).toBe(true);
    expect(p.locations.some((l) => l.loc.plat?.suppressed)).toBe(true);
  });

  it('reads a schedule: service fields and planned locations of every type, keyed like TS', () => {
    const [s] = sample<{ rid: string; IP: unknown[] }[]>('darwin-schedule.json');
    const p = parseMessage(envelope({ uR: { schedule: s } }));
    expect(p.services[0]).toMatchObject({ rid: s!.rid, uid: 'Y41858', ssd: '2026-11-03', toc: 'GW', trainId: '2F06', cancelReason: null });
    // OR + 19 IP + 2 PP + DT
    expect(p.locations).toHaveLength(23);
    expect(p.locations[0]!.loc).toEqual({ tpl: 'PAIGNTN', ptd: '05:57', wtd: '05:57', can: false });
    expect(p.locations[0]!.key).toBe(locationKey({ tpl: 'PAIGNTN', wtd: '05:57' }));
  });

  it('reads deactivations', () => {
    const captured = sample<{ rid: string }[]>('darwin-deactivated.json');
    const p = parseMessage(envelope({ uR: { deactivated: captured } }));
    expect(p.deactivated).toEqual(captured.map((d) => d.rid));
    expect(parseMessage(envelope({ uR: { deactivated: { rid: 'R1' } } })).deactivated).toEqual(['R1']);
  });

  it('marks a cancelled location and a cancellation reason on a schedule', () => {
    const p = parseMessage(
      envelope({
        uR: {
          schedule: {
            rid: 'R1',
            uid: 'A00001',
            ssd: '2026-11-03',
            toc: 'GR',
            trainId: '1S25',
            cancelReason: { '': '104' },
            OR: { tpl: 'KNGX', ptd: '17:00', wtd: '17:00', can: 'true' },
            DT: { tpl: 'YORK', pta: '19:00', wta: '19:00', can: 'true' },
          },
        },
      }),
    );
    expect(p.services[0]!.cancelReason).toBe('104');
    expect(p.locations.map((l) => l.loc.can)).toEqual([true, true]);
  });
});

describe('parseMessage: Sprint 3 elements', () => {
  type Raw = Record<string, unknown>;

  it('keeps divides (VV) and joins (JJ), with cancelled and deleted, and drops next-workings (NP)', () => {
    const captured = sample<Raw[]>('darwin-association.json');
    const p = parseMessage(envelope({ uR: { association: captured } }));
    expect(p.associations).toHaveLength(captured.filter((a) => a.category === 'VV' || a.category === 'JJ').length);
    expect(p.associations.every((a) => a.category === 'VV' || a.category === 'JJ')).toBe(true);
    expect(p.associations[1]).toEqual({
      mainRid: '202611077126226',
      assocRid: '202611076782431',
      tiploc: 'HORSHAM',
      category: 'VV',
      mainTimes: { wta: '17:27', wtd: '17:31', pta: '17:27', ptd: '17:31' },
      assocTimes: { wtd: '17:35', ptd: '17:35' },
      cancelled: false,
      deleted: false,
    });
    expect(p.associations[2]).toMatchObject({ tiploc: 'HORSHAM', category: 'VV', cancelled: true, deleted: false, mainTimes: { wta: '17:27', pta: '17:27' } });
    expect(p.associations[0]).toMatchObject({ tiploc: 'MCHYNLT', category: 'JJ', deleted: true, cancelled: false });
    // A single association is an object, not an array.
    expect(parseMessage(envelope({ uR: { association: captured[2] } })).associations).toEqual([p.associations[1]]);
    expect(parseMessage(envelope({ uR: { association: captured[0] } })).associations).toEqual([]);
  });

  it('reads the Horsham division fixture: the portion starts where the main train divides', () => {
    const { association, main, assoc } = sample<{ association: Raw; main: Raw; assoc: Raw }>('darwin-divide-horsham.json');
    const p = parseMessage(envelope({ uR: { association, schedule: [main, assoc] } }));
    expect(p.associations).toEqual([expect.objectContaining({ mainRid: main.rid, assocRid: assoc.rid, tiploc: 'HORSHAM', category: 'VV' })]);
    expect(p.services.map((s) => s.trainId)).toEqual(['1C46', '1B46']);
    const portion = p.locations.filter((l) => l.rid === assoc.rid);
    expect(portion.find((l) => l.loc.tpl === 'HORSHAM')!.loc).toEqual({ tpl: 'HORSHAM', ptd: '17:35', wtd: '17:35', can: false });
    expect(portion.find((l) => l.loc.tpl === 'BRHM')!.loc.can).toBe(false);
  });

  it('reads service loading as a location update with planned fields and loading only', () => {
    const captured = sample<Raw[]>('darwin-serviceLoading.json');
    const p = parseMessage(envelope({ uR: { serviceLoading: captured } }));
    expect(p.locations).toHaveLength(captured.length);
    expect(p.locations[1]).toEqual({
      rid: '202611077158934',
      key: 'KEWGRDN|16:34|16:34:30|',
      loc: { tpl: 'KEWGRDN', wta: '16:34', wtd: '16:34:30', pta: '16:34', ptd: '16:34', loading: 33 },
    });
    expect(p.locations[0]!.loc).toEqual({ tpl: 'RICHNLL', wtd: '16:31', ptd: '16:31', loading: 20 });
    expect(p.services).toEqual([]);
    // The same key as a TS for that location, so the two merge.
    const ts = parseMessage(envelope({ uR: { TS: { rid: 'R', uid: 'U', ssd: '2026-11-07', Location: { tpl: 'KEWGRDN', wta: '16:34', wtd: '16:34:30', pta: '16:34', ptd: '16:34' } } } }));
    expect(ts.locations[0]!.key).toBe(p.locations[1]!.key);
    // Text content and a missing percentage.
    const odd = parseMessage(envelope({ uR: { serviceLoading: [{ rid: 'R', tpl: 'X', wtd: '10:00', loadingPercentage: { type: 'Typical', '': '45' } }, { rid: 'R', tpl: 'Y', wtd: '10:05' }] } }));
    expect(odd.locations.map((l) => l.loc.loading)).toEqual([45, null]);
  });

  it('reads formation loading: per-coach percentages front to rear, with the formation id', () => {
    const captured = sample<Raw[]>('darwin-formationLoading.json');
    const p = parseMessage(envelope({ uR: { formationLoading: captured } }));
    expect(p.locations).toHaveLength(captured.length);
    const wenhaston = p.locations.find((l) => l.loc.tpl === 'WENHNGR')!;
    expect(wenhaston).toEqual({
      rid: '202611078089053',
      key: 'WENHNGR|17:32:30|17:33|',
      loc: {
        tpl: 'WENHNGR',
        wta: '17:32:30',
        wtd: '17:33',
        pta: '17:33',
        ptd: '17:33',
        coachLoading: {
          fid: '202611078089053-001',
          coaches: [
            { number: 'A1', percentage: 32 },
            { number: 'A2', percentage: 42 },
            { number: 'A3', percentage: 43 },
            { number: 'A4', percentage: 23 },
            { number: 'B1', percentage: 13 },
            { number: 'B2', percentage: 16 },
            { number: 'B3', percentage: 52 },
          ],
        },
      },
    });
    expect(p.locations.every((l) => l.loc.coachLoading?.coaches.length === 9 || l.loc.tpl === 'WENHNGR')).toBe(true);
    // One coach is an object; a coach without a number is dropped.
    const one = parseMessage(envelope({ uR: { formationLoading: { fid: 'F', rid: 'R', tpl: 'X', wtd: '10:00', loading: [{ coachNumber: '1', '': '7' }, { '': '9' }] } } }));
    expect(one.locations[0]!.loc.coachLoading).toEqual({ fid: 'F', coaches: [{ number: '1', percentage: 7 }] });
  });

  it('reads schedule formations: one per formation id, coaches front to rear with their class', () => {
    const captured = sample<Raw[]>('darwin-scheduleFormations.json');
    const p = parseMessage(envelope({ uR: { scheduleFormations: captured } }));
    expect(p.formations.map((f) => f.fid)).toEqual(['202611076736997-001', '202611078085418-002', '202611076737361-001', '202611078089105-004']);
    expect(p.formations[0]).toEqual({
      rid: '202611076736997',
      fid: '202611076736997-001',
      coaches: ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((number) => ({ number, class: 'Standard' })),
    });
    // Toilet details are ignored.
    expect(p.formations[1]!.coaches.slice(0, 2)).toEqual([
      { number: 'A1', class: 'Standard' },
      { number: 'A2', class: 'Standard' },
    ]);
    // Several formations, a single coach, and no class.
    const synthetic = parseMessage(
      envelope({
        uR: {
          scheduleFormations: {
            rid: 'R',
            formation: [
              { fid: 'R-001', coaches: { coach: [{ coachNumber: 'A', coachClass: 'First' }, { coachNumber: 'B' }] } },
              { fid: 'R-002', coaches: { coach: { coachNumber: 'A', coachClass: 'Mixed' } } },
            ],
          },
        },
      }),
    );
    expect(synthetic.formations).toEqual([
      { rid: 'R', fid: 'R-001', coaches: [{ number: 'A', class: 'First' }, { number: 'B', class: null }] },
      { rid: 'R', fid: 'R-002', coaches: [{ number: 'A', class: 'Mixed' }] },
    ]);
  });

  it('keeps the formation id a schedule names at each location', () => {
    const p = parseMessage(
      envelope({
        uR: {
          schedule: {
            rid: 'R',
            uid: 'C00001',
            ssd: '2026-11-07',
            OR: { tpl: 'PADTLL', ptd: '17:00', wtd: '17:00', fid: 'R-001' },
            DT: { tpl: 'ABWDXR', pta: '17:30', wta: '17:30' },
          },
        },
      }),
    );
    expect(p.locations.map((l) => l.loc.fid)).toEqual(['R-001', undefined]);
    expect('fid' in p.locations[1]!.loc).toBe(false);
  });

  it('reads station messages, flattening every captured markup shape to text with the first link', () => {
    const captured = sample<Raw[]>('darwin-OW.json');
    const p = parseMessage(envelope({ uR: { OW: captured } }));
    const byId = (id: string) => p.stationMessages.filter((m) => m.id === id);
    expect(p.stationMessages).toHaveLength(captured.length);

    const [office, resent] = byId('145744');
    expect(office).toMatchObject({ category: 'Station', severity: 0, suppress: false, message: 'The ticket office is currently closed at this station.', url: null });
    expect(office!.crs).toHaveLength(42);
    expect(office!.crs.slice(0, 3)).toEqual(['ACG', 'ACT', 'BDH']);
    expect(resent!.crs.length).toBeGreaterThan(42);

    expect(byId('190195')[0]).toMatchObject({
      category: 'Train',
      severity: 1,
      message:
        'Trains running between Edinburgh and Leven / Ladybank may be cancelled, delayed or revised. Latest information can be found in the Disruptions area of the National Rail website.',
      url: 'https://www.nationalrail.co.uk/service-disruptions/aberdour-20261107/',
    });
    expect(byId('190196')[0]).toMatchObject({
      message:
        'Trains running between Nottingham and Mansfield may be delayed by up to 30 minutes. Latest information can be found in the Disruptions area of the National Rail website.',
      url: 'https://www.nationalrail.co.uk/service-disruptions/newstead-20261107/',
    });
    // Paragraphs, and a single station as an object.
    expect(byId('190185')[0]).toMatchObject({
      crs: ['CWX'],
      message:
        'Canary Wharf will not be served as there is a problem with the platform equipment at the station. You can use your ticket, at no extra cost, on Jubilee line or Docklands Light Railway services to help you to complete your journey.',
      url: null,
    });
    expect(byId('190197')[0]).toMatchObject({ crs: ['TAP'], message: 'The lifts are out of order between platform 3 and the concourse at Taplow station.' });
  });

  it('reads a station message with no stations as a removal, and suppress as a boolean', () => {
    const p = parseMessage(envelope({ uR: { OW: [{ id: '1', cat: 'Misc', sev: '3', suppress: 'true', Station: { crs: 'KGX' }, Msg: { p: { '': 'Text', br: '' } } }, { id: '2', cat: 'Station', sev: '0', Msg: 'Gone' }] } }));
    expect(p.stationMessages).toEqual([
      { id: '1', category: 'Misc', severity: 3, suppress: true, message: 'Text', url: null, crs: ['KGX'] },
      { id: '2', category: 'Station', severity: 0, suppress: false, message: 'Gone', url: null, crs: [] },
    ]);
  });
});
