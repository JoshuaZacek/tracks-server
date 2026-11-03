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
