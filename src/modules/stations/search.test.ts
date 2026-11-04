import { describe, expect, it } from 'vitest';
import { editDistance, normalise, rankStations, type SearchableStation } from './search.ts';

const stations: SearchableStation[] = [
  { crs: 'KGX', name: 'London Kings Cross', ok: true, calls: 7548 },
  { crs: 'STP', name: 'London St Pancras International', ok: true, calls: 3925 },
  { crs: 'KLN', name: 'Kings Lynn', ok: true, calls: 700 },
  { crs: 'KGL', name: 'Kings Langley', ok: true, calls: 1385 },
  { crs: 'EDB', name: 'Edinburgh', ok: true, calls: 8611 },
  { crs: 'EBR', name: 'Edenbridge (Kent)', ok: true, calls: 300 },
  { crs: 'SOT', name: 'Stoke-on-Trent', ok: true, calls: 4000 },
  { crs: 'HDM', name: 'Haddenham & Thame Parkway', ok: true, calls: 900 },
  { crs: 'WMW', name: "Walthamstow Queen's Road", ok: true, calls: 800 },
  { crs: 'LEU', name: 'Leuchars (for St. Andrews)', ok: true, calls: 600 },
  { crs: 'MAN', name: 'Manchester Piccadilly', ok: true, calls: 20000 },
  { crs: 'BYM', name: 'Burnley Manchester Road', ok: true, calls: 150 },
  { crs: 'YRK', name: 'York', ok: true, calls: 9000 },
  { crs: 'BYK', name: 'Bentley (South Yorkshire)', ok: true, calls: 400 },
  { crs: 'ZKB', name: 'Barking L.t.', ok: false, calls: 0 },
  { crs: 'BKG', name: 'Barking', ok: true, calls: 6000 },
  { crs: 'KNM', name: 'Kings Nympton', ok: true, calls: 40 },
  { crs: 'KGM', name: 'Kingsknowe', ok: true, calls: 90 },
];
const search = (q: string, limit = 15) => rankStations(stations, q, limit).map((s) => s.crs);

describe('normalise', () => {
  it('drops apostrophes and dots, reads & as and, and breaks words at other punctuation', () => {
    expect(normalise("King's Lynn")).toBe('kings lynn');
    expect(normalise('King’s')).toBe('kings');
    expect(normalise('Leuchars (for St. Andrews)')).toBe('leuchars for st andrews');
    expect(normalise('Stoke-on-Trent')).toBe('stoke on trent');
    expect(normalise('Haddenham & Thame')).toBe('haddenham and thame');
    expect(normalise('Ystrad Mynach (Café)')).toBe('ystrad mynach cafe');
  });
});

describe('rankStations', () => {
  it('ignores punctuation on both sides', () => {
    expect(search("King's")).toEqual(['KGX', 'KGL', 'KLN', 'KGM', 'KNM']);
    expect(search('kings lynn')).toEqual(['KLN']);
    expect(search("king's cross")).toEqual(['KGX']);
    expect(search('queens road')).toEqual(['WMW']);
    expect(search('haddenham and thame')).toEqual(['HDM']);
    expect(search('stoke on trent')).toEqual(['SOT']);
    expect(search('st. andrews')).toEqual(['LEU']);
  });

  it('matches every word as a prefix in any order, with x for cross and saint for st', () => {
    for (const q of ['kings cross london', 'cross kings', 'kings x', 'london kings c']) expect(search(q)).toEqual(['KGX']);
    expect(search('st pancras')).toEqual(['STP']);
    expect(search('saint pancras')).toEqual(['STP']);
  });

  it('matches with spaces ignored', () => {
    expect(search('kingscross')).toEqual(['KGX']);
    expect(search('stokeontrent')).toEqual(['SOT']);
    // Not across word breaks for short queries: "man" isn't in "Haddenham and".
    expect(search('man')).not.toContain('HDM');
  });

  it('tolerates typos only when nothing matches by word', () => {
    expect(search('edinbrugh')).toEqual(['EDB']);
    expect(search('kings corss')).toEqual(['KGX']);
    // Manchester … before a name that only contains it.
    expect(search('manchster')).toEqual(['MAN', 'BYM']);
    // Short words need an exact prefix, or everything would match.
    expect(search('yrx')).toEqual([]);
    // A real match means no typo matches alongside it.
    expect(search('edinburgh')).toEqual(['EDB']);
  });

  it('ranks exact CRS, the whole name, then all words with the busiest first, Knowledgebase-located first within a tier', () => {
    expect(search('york')).toEqual(['YRK', 'BYK']);
    expect(search('man')).toEqual(['MAN', 'BYM']);
    expect(search('barking')).toEqual(['BKG', 'ZKB']);
    expect(search('kgx')).toEqual(['KGX']);
    // A name starting with the query doesn't beat a busier station with the word later on.
    expect(search('kings', 2)).toEqual(['KGX', 'KGL']);
    expect(search('london')).toEqual(['KGX', 'STP']);
    // The whole name beats a busier station that only starts with it.
    expect(rankStations([...stations, { crs: 'XYS', name: 'Yorkshire Central', ok: true, calls: 99999 }], 'york', 3).map((s) => s.crs)).toEqual(['YRK', 'XYS', 'BYK']);
  });

  it('returns nothing for a query that is only punctuation', () => {
    expect(search('%')).toEqual([]);
    expect(search("'")).toEqual([]);
  });
});

describe('editDistance', () => {
  it('counts an adjacent swap as one edit', () => {
    expect(editDistance('corss', 'cross')).toBe(1);
    expect(editDistance('edinbrugh', 'edinburgh')).toBe(1);
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('', 'abc')).toBe(3);
  });
});
