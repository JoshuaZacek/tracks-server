import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseMessage, type DarwinLocation } from '../darwin/parse.ts';
import type { FormationCoach } from '../db/types.ts';
import { computeJourneyStatus, type ComputeContext, type DarwinAssociation, type DarwinRunData, type JourneyInput } from './compute.ts';
import { coachNote, divisionShortText } from './division.ts';

/**
 * The real Horsham division (docs/samples/darwin-divide-horsham.json): Southern 1C46
 * Victoria 16:35 → Portsmouth Harbour divides at Horsham (arr 17:27, dep 17:31); 1B46
 * leaves Horsham 17:35 for Bognor Regis. Both call at Barnham. On the day it was captured
 * the train was disrupted (many `can`); the planned tests strip those.
 */

const sample = JSON.parse(readFileSync(new URL('../../docs/samples/darwin-divide-horsham.json', import.meta.url), 'utf8')) as {
  association: { tiploc: string; category: string; main: Record<string, string>; assoc: Record<string, string> };
  main: Record<string, unknown>;
  assoc: Record<string, unknown>;
};

const STATIONS: Record<string, [string, string]> = {
  VICTRIC: ['VIC', 'London Victoria'],
  CLPHMJC: ['CLJ', 'Clapham Junction'],
  ECROYDN: ['ECR', 'East Croydon'],
  GTWK: ['GTW', 'Gatwick Airport'],
  THBDGS: ['TBD', 'Three Bridges'],
  CRAWLEY: ['CRW', 'Crawley'],
  HORSHAM: ['HRH', 'Horsham'],
  CHRSTSH: ['CHH', "Christ's Hospital"],
  BILSHST: ['BIG', 'Billingshurst'],
  PULBRO: ['PUL', 'Pulborough'],
  AMLY: ['AMY', 'Amberley'],
  ARUNDEL: ['ARU', 'Arundel'],
  FORD: ['FOD', 'Ford'],
  BRHM: ['BAA', 'Barnham'],
  BOGNORR: ['BOG', 'Bognor Regis'],
  CHCHSTR: ['CCH', 'Chichester'],
  SBOURNE: ['SOB', 'Southbourne'],
  EMSWTH: ['EMS', 'Emsworth'],
  HAVANT: ['HAV', 'Havant'],
  HILSEA: ['HLS', 'Hilsea'],
  FRATTON: ['FTN', 'Fratton'],
  PSEA: ['PMS', 'Portsmouth & Southsea'],
  PHBR: ['PMH', 'Portsmouth Harbour'],
};
const BY_CRS = Object.fromEntries(Object.values(STATIONS).map(([crs, name]) => [crs, name]));

const ctx = (now: string): ComputeContext => ({
  now: new Date(now),
  darwinEnabled: true,
  feedHealthy: true,
  crsOf: (t) => STATIONS[t]?.[0] ?? null,
  nameOf: (t) => STATIONS[t]?.[1] ?? t,
  station: (crs) => (BY_CRS[crs] ? { name: BY_CRS[crs], lat: null, lon: null } : null),
});

const envelope = (doc: object) => JSON.stringify({ messageType: 'bytes', bytes: JSON.stringify(doc), properties: {} });
/** Both schedules through the parser: darwin_locations.loc by rid, in running order (the parser groups them by type). */
const parsed = parseMessage(envelope({ uR: { schedule: [sample.main, sample.assoc] } }));
const byTime = (a: DarwinLocation, b: DarwinLocation) => (a.wta ?? a.wtp ?? a.wtd ?? '').localeCompare(b.wta ?? b.wtp ?? b.wtd ?? '');

/** A schedule's stored locations; `planned` clears the day's cancellations (the undisrupted timetable). */
function locationsOf(schedule: Record<string, unknown>, { planned = false } = {}): DarwinLocation[] {
  return parsed.locations
    .filter((l) => l.rid === schedule.rid)
    .map(({ loc }) => {
      if (!planned) return loc;
      const { can: _can, ...rest } = loc;
      return rest;
    })
    .sort(byTime);
}

const RUN_DATE = '2026-11-07';
const iso = (hhmm: string, day = RUN_DATE) => `${day}T${hhmm}:00+00:00`;

/** My journey on 1C46 between two of its stations, from the timetable's public calls. */
function journeyOn(locations: DarwinLocation[], from: string, to: string): JourneyInput {
  const calls = locations
    .filter((l) => l.pta || l.ptd)
    .map((l) => ({
      crs: STATIONS[l.tpl]![0],
      name: STATIONS[l.tpl]![1],
      lat: null,
      lon: null,
      scheduledArrival: l.pta ? iso(l.pta) : null,
      scheduledDeparture: l.ptd ? iso(l.ptd) : null,
      bookedPlatform: null,
      live: null,
    }));
  return { runDate: RUN_DATE, callingPoints: calls, fromIndex: calls.findIndex((c) => c.crs === from), toIndex: calls.findIndex((c) => c.crs === to) };
}

const service = {
  rid: sample.association.main.rid!,
  uid: 'G26226',
  ssd: RUN_DATE,
  toc: 'SN',
  trainId: '1C46',
  cancelReason: null,
  lateReason: null,
  deactivated: false,
};

function horsham(
  opts: { planned?: boolean; cancelled?: boolean; portion?: boolean; main?: (l: DarwinLocation) => DarwinLocation; formations?: Record<string, FormationCoach[]> } = {},
) {
  const planned = opts.planned ?? true;
  const main = locationsOf(sample.main, { planned }).map(opts.main ?? ((l) => l));
  const association: DarwinAssociation = {
    tiploc: sample.association.tiploc,
    mainTimes: sample.association.main,
    assocRid: sample.association.assoc.rid!,
    cancelled: opts.cancelled ?? false,
    assocLocations: opts.portion === false ? [] : locationsOf(sample.assoc, { planned }),
  };
  const data: DarwinRunData = { service, locations: main, associations: [association], formations: opts.formations ?? {} };
  return data;
}

const plannedMain = locationsOf(sample.main, { planned: true });
const BEFORE = '2026-11-07T16:20:00Z';

describe('divides: the real Horsham division', () => {
  it('is the VV association from the captured feed', () => {
    expect(sample.association).toMatchObject({ tiploc: 'HORSHAM', category: 'VV', main: { rid: '202611077126226' }, assoc: { rid: '202611076782431' } });
  });

  it('Victoria → Barnham: both parts call at Barnham', () => {
    const s = computeJourneyStatus(journeyOn(plannedMain, 'VIC', 'BAA'), horsham(), ctx(BEFORE));
    expect(s.divides).toEqual({
      atCrs: 'HRH',
      atName: 'Horsham',
      at: '2026-11-07T17:27:00+00:00',
      portions: [
        { destCrs: 'PMH', destName: 'Portsmouth Harbour', yours: true, note: null },
        { destCrs: 'BOG', destName: 'Bognor Regis', yours: true, note: null },
      ],
      message: 'This train divides at Horsham; both parts call at Barnham.',
    });
    expect(divisionShortText(s.divides!)).toBe('Divides at Horsham');
  });

  it('Victoria → Chichester: only my train after Horsham goes there', () => {
    const s = computeJourneyStatus(journeyOn(plannedMain, 'VIC', 'CCH'), horsham(), ctx(BEFORE));
    expect(s.divides!.portions).toEqual([
      { destCrs: 'PMH', destName: 'Portsmouth Harbour', yours: true, note: null },
      { destCrs: 'BOG', destName: 'Bognor Regis', yours: false, note: null },
    ]);
    expect(s.divides!.message).toBe('This train divides at Horsham; only some coaches go to Chichester.');
  });

  it('is null for a journey ending at Horsham, boarding there or after it, or ending before it', () => {
    for (const [from, to] of [
      ['VIC', 'HRH'],
      ['HRH', 'BAA'],
      ['BAA', 'CCH'],
      ['VIC', 'CRW'],
    ] as const) {
      expect(computeJourneyStatus(journeyOn(plannedMain, from, to), horsham(), ctx(BEFORE)).divides, `${from} → ${to}`).toBeNull();
    }
  });

  it('stays while the train is on its way to Horsham, and goes once it has left there', () => {
    const at = (times: Record<string, Partial<DarwinLocation>>) => (l: DarwinLocation) => ({ ...l, ...times[l.tpl] });
    const j = journeyOn(plannedMain, 'VIC', 'CCH');
    const onTheWay = computeJourneyStatus(j, horsham({ main: at({ VICTRIC: { dep: { at: '16:35' } }, CRAWLEY: { dep: { at: '17:19' } } }) }), ctx('2026-11-07T17:20:00Z'));
    expect(onTheWay.state).toBe('departed');
    expect(onTheWay.divides).not.toBeNull();
    // Arrived at Horsham, not yet divided.
    const there = computeJourneyStatus(j, horsham({ main: at({ VICTRIC: { dep: { at: '16:35' } }, HORSHAM: { arr: { at: '17:28' } } }) }), ctx('2026-11-07T17:29:00Z'));
    expect(there.divides).not.toBeNull();
    const left = computeJourneyStatus(j, horsham({ main: at({ VICTRIC: { dep: { at: '16:35' } }, HORSHAM: { arr: { at: '17:28' }, dep: { at: '17:32' } } }) }), ctx('2026-11-07T17:33:00Z'));
    expect(left.state).toBe('departed');
    expect(left.divides).toBeNull();
    // Reported beyond Horsham (its own departure fell in a feed gap).
    const beyond = computeJourneyStatus(j, horsham({ main: at({ VICTRIC: { dep: { at: '16:35' } }, BRHM: { arr: { at: '18:00' } } }) }), ctx('2026-11-07T18:01:00Z'));
    expect(beyond.divides).toBeNull();
  });

  it('ignores a cancelled association', () => {
    expect(computeJourneyStatus(journeyOn(plannedMain, 'VIC', 'BAA'), horsham({ cancelled: true }), ctx(BEFORE)).divides).toBeNull();
  });

  it('on the disrupted day (a cancelled call is not a call): null while my journey is cancelled; once under way, only the Bognor portion reaches Barnham', () => {
    const disrupted = locationsOf(sample.main);
    const j = journeyOn(plannedMain, 'VIC', 'BAA');
    const before = computeJourneyStatus(j, horsham({ planned: false }), ctx(BEFORE));
    expect(before.state).toBe('cancelled');
    expect(before.divides).toBeNull();
    expect(disrupted.find((l) => l.tpl === 'BRHM')!.can).toBe(true);

    const left = (l: DarwinLocation) => (l.tpl === 'VICTRIC' ? { ...l, dep: { at: '16:36' } } : l);
    const s = computeJourneyStatus(j, horsham({ planned: false, main: left }), ctx('2026-11-07T16:50:00Z'));
    expect(s.state).toBe('departed');
    // Everything after Horsham on 1C46 was cancelled: it terminated there.
    expect(s.divides!.portions.map((p) => [p.destCrs, p.destName, p.yours])).toEqual([
      ['BOG', 'Bognor Regis', true],
      ['HRH', 'Horsham', false],
    ]);
    expect(s.divides!.message).toBe('This train divides at Horsham; only some coaches go to Barnham.');
  });

  it('without the portion in Darwin, says to check which coaches go', () => {
    const s = computeJourneyStatus(journeyOn(plannedMain, 'VIC', 'CCH'), horsham({ portion: false }), ctx(BEFORE));
    expect(s.divides!.portions).toEqual([{ destCrs: 'PMH', destName: 'Portsmouth Harbour', yours: true, note: null }]);
    expect(s.divides!.message).toBe('This train divides at Horsham. Check which coaches go to Chichester.');
  });

  it('is null with no associations (boards and trains load none)', () => {
    const data: DarwinRunData = { service, locations: plannedMain };
    expect(computeJourneyStatus(journeyOn(plannedMain, 'VIC', 'BAA'), data, ctx(BEFORE)).divides).toBeNull();
  });
});

describe('divides: coach notes from formations (synthetic)', () => {
  const coachesOf = (...numbers: string[]) => numbers.map((number) => ({ number, class: 'Standard' }));
  const eight = coachesOf('1', '2', '3', '4', '5', '6', '7', '8');
  /** Formation fids on 1C46: `before` up to Horsham, `after` on it beyond; the portion's own. */
  const withFids = (before: string, after: string) => (l: DarwinLocation) => ({ ...l, fid: (l.wta ?? l.wtp ?? l.wtd)! <= '17:27' ? before : after });
  const portionFid = (fid: string, data: DarwinRunData) => {
    const a = data.associations![0]!;
    a.assocLocations = a.assocLocations.map((l) => ({ ...l, fid }));
    return data;
  };

  it('my part is the front 4 coaches', () => {
    const data = portionFid(
      'P',
      horsham({ main: withFids('F8', 'F4'), formations: { F8: eight, F4: coachesOf('1', '2', '3', '4'), P: coachesOf('5', '6', '7', '8') } }),
    );
    const s = computeJourneyStatus(journeyOn(plannedMain, 'VIC', 'CCH'), data, ctx(BEFORE));
    expect(s.divides!.portions).toEqual([
      { destCrs: 'PMH', destName: 'Portsmouth Harbour', yours: true, note: 'Front 4 coaches' },
      { destCrs: 'BOG', destName: 'Bognor Regis', yours: false, note: 'Rear 4 coaches' },
    ]);
    expect(s.divides!.message).toBe('This train divides at Horsham. Sit in the front 4 coaches for Chichester.');
    expect(divisionShortText(s.divides!)).toBe('Divides at Horsham · front 4 coaches');
  });

  it('my part is the rear 3 coaches', () => {
    const data = portionFid(
      'P',
      horsham({ main: withFids('F8', 'R3'), formations: { F8: eight, R3: coachesOf('6', '7', '8'), P: coachesOf('1', '2', '3', '4', '5') } }),
    );
    const s = computeJourneyStatus(journeyOn(plannedMain, 'VIC', 'CCH'), data, ctx(BEFORE));
    expect(s.divides!.portions.map((p) => p.note)).toEqual(['Rear 3 coaches', 'Front 5 coaches']);
    expect(s.divides!.message).toBe('This train divides at Horsham. Sit in the rear 3 coaches for Chichester.');
  });

  it('both parts mine: the notes are there but the message says both call', () => {
    const data = portionFid(
      'P',
      horsham({ main: withFids('F8', 'F4'), formations: { F8: eight, F4: coachesOf('1', '2', '3', '4'), P: coachesOf('5', '6', '7', '8') } }),
    );
    const s = computeJourneyStatus(journeyOn(plannedMain, 'VIC', 'BAA'), data, ctx(BEFORE));
    expect(s.divides!.message).toBe('This train divides at Horsham; both parts call at Barnham.');
    expect(divisionShortText(s.divides!)).toBe('Divides at Horsham');
  });

  it('no note when the formation does not change, or is not a front or rear run', () => {
    const same = horsham({ main: (l) => ({ ...l, fid: 'F8' }), formations: { F8: eight } });
    expect(computeJourneyStatus(journeyOn(plannedMain, 'VIC', 'CCH'), same, ctx(BEFORE)).divides!.portions[0]!.note).toBeNull();
    expect(coachNote(eight, coachesOf('3', '4', '5'))).toBeNull();
    expect(coachNote(eight, eight)).toBeNull();
    expect(coachNote(undefined, eight)).toBeNull();
    expect(coachNote(eight, coachesOf('1'))).toBe('Front 1 coach');
  });
});

describe('divides: across midnight', () => {
  it('resolves the division and the portion on the next day', () => {
    // 23:40 VIC → 00:10 HRH (divides) → 00:40 CCH; the portion leaves HRH at 00:15 for BOG 00:45.
    const main: DarwinLocation[] = [
      { tpl: 'VICTRIC', ptd: '23:40', wtd: '23:40' },
      { tpl: 'HORSHAM', pta: '00:10', ptd: '00:13', wta: '00:10', wtd: '00:13' },
      { tpl: 'CHCHSTR', pta: '00:40', wta: '00:40' },
    ];
    const portion: DarwinLocation[] = [
      { tpl: 'HORSHAM', ptd: '00:15', wtd: '00:15' },
      { tpl: 'BOGNORR', pta: '00:45', wta: '00:45' },
    ];
    const j: JourneyInput = {
      runDate: '2026-11-07',
      callingPoints: [
        { crs: 'VIC', name: 'London Victoria', lat: null, lon: null, scheduledArrival: null, scheduledDeparture: iso('23:40'), bookedPlatform: null, live: null },
        { crs: 'HRH', name: 'Horsham', lat: null, lon: null, scheduledArrival: iso('00:10', '2026-11-08'), scheduledDeparture: iso('00:13', '2026-11-08'), bookedPlatform: null, live: null },
        { crs: 'CCH', name: 'Chichester', lat: null, lon: null, scheduledArrival: iso('00:40', '2026-11-08'), scheduledDeparture: null, bookedPlatform: null, live: null },
      ],
      fromIndex: 0,
      toIndex: 2,
    };
    const data: DarwinRunData = {
      service,
      locations: main,
      associations: [{ tiploc: 'HORSHAM', mainTimes: { wta: '00:10', wtd: '00:13' }, assocRid: 'p', cancelled: false, assocLocations: portion }],
    };
    const s = computeJourneyStatus(j, data, ctx('2026-11-07T23:30:00Z'));
    expect(s.divides).toMatchObject({
      atCrs: 'HRH',
      at: '2026-11-08T00:10:00+00:00',
      portions: [
        { destCrs: 'CCH', yours: true },
        { destCrs: 'BOG', yours: false },
      ],
    });
    const left = { ...data, locations: main.map((l) => (l.tpl === 'HORSHAM' ? { ...l, dep: { at: '00:14' } } : l.tpl === 'VICTRIC' ? { ...l, dep: { at: '23:41' } } : l)) };
    expect(computeJourneyStatus(j, left, ctx('2026-11-08T00:15:00Z')).divides).toBeNull();
  });
});
