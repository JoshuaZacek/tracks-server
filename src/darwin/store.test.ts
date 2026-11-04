import { describe, expect, it } from 'vitest';
import type { DarwinLocation } from './parse.ts';
import { mergeLocation } from './store.ts';

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
