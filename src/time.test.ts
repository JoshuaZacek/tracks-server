import { describe, expect, it } from 'vitest';
import { addDays, dayIndex, toUkIso, ukIsoAt } from './time.ts';

describe('toUkIso', () => {
  it('uses +00:00 in winter (GMT)', () => {
    expect(toUkIso(new Date('2026-11-03T17:30:00.123Z'))).toBe('2026-11-03T17:30:00+00:00');
  });

  it('uses +01:00 in summer (BST)', () => {
    expect(toUkIso(new Date('2026-07-01T07:05:09Z'))).toBe('2026-07-01T08:05:09+01:00');
  });

  it('handles the clocks going back (the 01:xx hour happens twice)', () => {
    expect(toUkIso(new Date('2026-10-25T00:30:00Z'))).toBe('2026-10-25T01:30:00+01:00');
    expect(toUkIso(new Date('2026-10-25T01:30:00Z'))).toBe('2026-10-25T01:30:00+00:00');
  });

  it('crosses midnight into the next UK day in summer', () => {
    expect(toUkIso(new Date('2026-06-30T23:15:00Z'))).toBe('2026-07-01T00:15:00+01:00');
  });
});

describe('ukWallClock / ukIsoAt', () => {
  it('converts winter and summer wall-clock times', () => {
    expect(ukIsoAt('2026-11-03', 17 * 60 + 30)).toBe('2026-11-03T17:30:00+00:00');
    expect(ukIsoAt('2026-07-01', 8 * 60 + 5)).toBe('2026-07-01T08:05:00+01:00');
  });

  it('rolls minutes past 24:00 into the next day', () => {
    expect(ukIsoAt('2026-11-03', 24 * 60 + 15)).toBe('2026-11-04T00:15:00+00:00');
    expect(ukIsoAt('2026-06-30', 25 * 60)).toBe('2026-07-01T01:00:00+01:00');
  });

  it('handles the nights the clocks change', () => {
    // 29 Mar 2026: 01:00 GMT -> 02:00 BST. 00:30 is GMT, 03:00 is BST.
    expect(ukIsoAt('2026-03-29', 30)).toBe('2026-03-29T00:30:00+00:00');
    expect(ukIsoAt('2026-03-29', 180)).toBe('2026-03-29T03:00:00+01:00');
    // 25 Oct 2026: 02:00 BST -> 01:00 GMT. The repeated 01:30 resolves to the first (BST) one.
    expect(ukIsoAt('2026-10-25', 90)).toBe('2026-10-25T01:30:00+01:00');
    expect(ukIsoAt('2026-10-25', 180)).toBe('2026-10-25T03:00:00+00:00');
  });
});

describe('date helpers', () => {
  it('addDays and dayIndex', () => {
    expect(addDays('2026-11-01', -1)).toBe('2026-10-31');
    expect(dayIndex('2026-11-02')).toBe(1); // Monday
    expect(dayIndex('2026-11-08')).toBe(7); // Sunday
  });
});
