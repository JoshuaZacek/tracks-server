import { describe, expect, it } from 'vitest';
import { datesToCreate, daysToMask, giveUpOn, maskToDays, pickDeparture, runsOn, searchFrom } from './occurrences.ts';

const WEEKDAYS = daysToMask([1, 2, 3, 4, 5]);
/** Tuesday 3 Nov 2026 (GMT). */
const at = (iso: string) => new Date(iso);

describe('weekday masks', () => {
  it('maps ISO weekdays to bits and back, sorted and unique', () => {
    expect(WEEKDAYS).toBe(0b0011111);
    expect(daysToMask([7, 1, 1])).toBe(0b1000001);
    expect(maskToDays(0b1000001)).toEqual([1, 7]);
    expect(maskToDays(127)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('knows which dates a mask runs on', () => {
    expect(runsOn(WEEKDAYS, '2026-11-03')).toBe(true); // Tuesday
    expect(runsOn(WEEKDAYS, '2026-11-07')).toBe(false); // Saturday
    expect(runsOn(daysToMask([7]), '2026-11-08')).toBe(true);
  });
});

describe('datesToCreate', () => {
  const t = (o: Partial<{ days: number; departTime: string; lastCreatedDate: string | null }> = {}) => ({
    days: WEEKDAYS,
    departTime: '17:00',
    lastCreatedDate: null,
    ...o,
  });

  it('covers today (while the time is ahead) and tomorrow', () => {
    expect(datesToCreate(t(), at('2026-11-03T12:00:00Z'))).toEqual(['2026-11-03', '2026-11-04']);
    expect(datesToCreate(t(), at('2026-11-03T17:00:00Z'))).toEqual(['2026-11-04']);
    expect(datesToCreate(t(), at('2026-11-03T16:59:00Z'))).toEqual(['2026-11-03', '2026-11-04']);
  });

  it('only on the chosen weekdays', () => {
    // Friday: today, but not Saturday.
    expect(datesToCreate(t(), at('2026-11-06T08:00:00Z'))).toEqual(['2026-11-06']);
    // Saturday: Monday is not yet tomorrow.
    expect(datesToCreate(t(), at('2026-11-07T08:00:00Z'))).toEqual([]);
    expect(datesToCreate(t(), at('2026-11-08T08:00:00Z'))).toEqual(['2026-11-09']);
  });

  it('only after the last date made, so a deleted journey is not made again', () => {
    expect(datesToCreate(t({ lastCreatedDate: '2026-11-03' }), at('2026-11-03T12:00:00Z'))).toEqual(['2026-11-04']);
    expect(datesToCreate(t({ lastCreatedDate: '2026-11-04' }), at('2026-11-03T12:00:00Z'))).toEqual([]);
  });

  it('uses UK dates and wall-clock times (summer time)', () => {
    // 23:30 UTC on 30 June is 00:30 on 1 July in London.
    expect(datesToCreate(t({ departTime: '07:00' }), at('2026-06-30T23:30:00Z'))).toEqual(['2026-07-01', '2026-07-02']);
    // 07:00 BST is 06:00 UTC: gone at 06:30 UTC.
    expect(datesToCreate(t({ departTime: '07:00' }), at('2026-07-01T06:30:00Z'))).toEqual(['2026-07-02']);
  });
});

describe('pickDeparture', () => {
  const d = (trainUid: string, hhmm: string) => ({ trainUid, scheduledDeparture: `2026-11-03T${hhmm}:00+00:00` });

  it('takes the departure nearest the time, within 30 minutes either side', () => {
    expect(pickDeparture([d('A', '07:20'), d('B', '07:45'), d('C', '08:00')], '2026-11-03', '07:42', null)).toEqual(d('B', '07:45'));
    expect(pickDeparture([d('A', '07:11'), d('C', '08:13')], '2026-11-03', '07:42', null)).toBeNull();
    expect(pickDeparture([d('A', '07:12'), d('C', '08:12')], '2026-11-03', '07:42', null)).toEqual(d('A', '07:12'));
  });

  it('breaks a tie with the earlier train', () => {
    expect(pickDeparture([d('B', '07:52'), d('A', '07:32')], '2026-11-03', '07:42', null)).toEqual(d('A', '07:32'));
  });

  it('prefers the train last matched while it runs in the window, e.g. retimed', () => {
    expect(pickDeparture([d('A', '07:42'), d('B', '07:55')], '2026-11-03', '07:42', 'B')).toEqual(d('B', '07:55'));
    expect(pickDeparture([d('A', '07:42'), d('B', '08:30')], '2026-11-03', '07:42', 'B')).toEqual(d('A', '07:42'));
  });

  it('measures in UK wall-clock time', () => {
    const summer = { trainUid: 'S', scheduledDeparture: '2026-07-01T07:42:00+01:00' };
    expect(pickDeparture([summer], '2026-07-01', '07:42', null)).toEqual(summer);
  });
});

describe('helpers', () => {
  it('starts the search 30 minutes early, not before midnight', () => {
    expect(searchFrom('07:42')).toBe('07:12');
    expect(searchFrom('00:10')).toBe('00:00');
    expect(searchFrom('10:05')).toBe('09:35');
  });

  it('gives a date up on its second failure only', () => {
    expect(giveUpOn(null, '2026-11-03')).toBe(false);
    expect(giveUpOn('2026-11-02', '2026-11-03')).toBe(false);
    expect(giveUpOn('2026-11-03', '2026-11-03')).toBe(true);
  });
});
