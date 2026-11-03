import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseKbStation } from './stations.ts';

describe('parseKbStation', () => {
  it('reads name, coordinates and NLC from the captured York record', () => {
    const xml = fs.readFileSync(new URL('../../docs/samples/kb-station-YRK.xml', import.meta.url), 'utf8');
    const s = parseKbStation(xml);
    expect(s).toMatchObject({ crs: 'YRK', name: 'York' });
    expect(s!.lat).toBeCloseTo(53.958, 2);
    expect(s!.lon).toBeCloseTo(-1.093, 2);
    expect(s!.nlc).toMatch(/^\d+$/);
  });

  it('returns null for something that is not a station record', () => {
    expect(parseKbStation('<Error>nope</Error>')).toBeNull();
  });
});
