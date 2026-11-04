/**
 * Station search as you type. Pure: the service loads the ~2,700 stations
 * (about 2 ms) and this ranks them in memory, which keeps typo tolerance
 * simple and needs no database extension.
 *
 * Both sides are normalised: case and accents ignored, apostrophes and dots
 * dropped ("King's" = "Kings", "St." = "St"), "&" read as "and", any other
 * punctuation a word break ("Stoke-on-Trent" = "stoke on trent").
 */

export interface SearchableStation {
  crs: string;
  name: string;
  /** Located by Knowledgebase: ranks above the rest within a tier. */
  ok: boolean;
  /** Public calls in the timetable: busier stations first within a tier. */
  calls: number;
}

/** Query words read as another word: "kings x" is Kings Cross, "saint" is "St". */
const QUERY_ALIASES: Record<string, string> = { x: 'cross', saint: 'st', intl: 'international', stn: 'station' };

export function normalise(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’‘`.]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const words = (normalised: string) => (normalised ? normalised.split(' ') : []);

/**
 * Tiers, best first: exact CRS; the whole name; every query word starts a
 * word of the name, in any order (a name starting with the query is just a
 * case of this, so "King's" puts London Kings Cross above Kings Nympton);
 * the query appears in the name (with spaces ignored from 6 letters:
 * "kingscross", but "man" isn't in "Haddenham and"). Only when none of those
 * match anything: every query word within a typo or two of a word of the
 * name, fewest typos first. Within a tier, Knowledgebase-located stations
 * first, then the busiest.
 */
export function rankStations<T extends SearchableStation>(stations: T[], q: string, limit: number): T[] {
  const query = normalise(q);
  if (!query) return [];
  const qWords = words(query).map((w) => QUERY_ALIASES[w] ?? w);
  const qCompact = query.replace(/ /g, '');
  const crs = q.trim().toUpperCase();
  const prefix = (q: string, w: string) => (w.startsWith(q) ? 0 : null);

  const ranked: { s: T; tier: number; edits: number }[] = [];
  const names = stations.map((s) => normalise(s.name));
  const nameWords = names.map(words);
  stations.forEach((s, i) => {
    const name = names[i]!;
    const tier =
      s.crs === crs ? 0
      : name === query ? 1
      : name.startsWith(query) || assign(qWords, nameWords[i]!, prefix) !== null ? 2
      : name.includes(query) || (qCompact.length >= 6 && name.replace(/ /g, '').includes(qCompact)) ? 3
      : null;
    if (tier !== null) ranked.push({ s, tier, edits: 0 });
  });

  if (ranked.length === 0) {
    stations.forEach((s, i) => {
      const edits = assign(qWords, nameWords[i]!, typoDistance);
      if (edits !== null) ranked.push({ s, tier: 4, edits });
    });
  }

  return ranked
    .sort((a, b) => a.tier - b.tier || a.edits - b.edits || Number(b.s.ok) - Number(a.s.ok) || b.s.calls - a.s.calls || a.s.name.localeCompare(b.s.name))
    .slice(0, limit)
    .map((r) => r.s);
}

/**
 * Matches each query word to a different word of the name, longest query
 * words first; `cost` is null for no match. The total cost, or null if some
 * query word has no match.
 */
function assign(qWords: string[], nameWords: string[], cost: (q: string, w: string) => number | null): number | null {
  const free = nameWords.map(() => true);
  let total = 0;
  for (const q of [...qWords].sort((a, b) => b.length - a.length)) {
    let best: { i: number; c: number } | null = null;
    nameWords.forEach((w, i) => {
      if (!free[i]) return;
      const c = cost(q, w);
      if (c !== null && (best === null || c < best.c)) best = { i, c };
    });
    if (best === null) return null;
    free[(best as { i: number }).i] = false;
    total += (best as { c: number }).c;
  }
  return total;
}

/**
 * Edits between a query word and the start of a name word (so a word still
 * being typed counts), or null beyond the allowance: none up to 3 letters,
 * 1 up to 7, then 2.
 */
function typoDistance(q: string, w: string): number | null {
  if (w.startsWith(q)) return 0;
  const allowed = q.length <= 3 ? 0 : q.length <= 7 ? 1 : 2;
  if (allowed === 0) return null;
  let best = Infinity;
  for (let len = q.length - allowed; len <= Math.min(w.length, q.length + allowed); len++) {
    if (len > 0) best = Math.min(best, editDistance(q, w.slice(0, len)));
  }
  return best <= allowed ? best : null;
}

/** Levenshtein with adjacent swaps as one edit ("corss" → "cross" is 1), in three rolling rows. */
export function editDistance(a: string, b: string): number {
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      let v = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2]! + 1);
      row.push(v);
    }
    prev2 = prev;
    prev = row;
  }
  return prev[b.length]!;
}
