/**
 * Fills in CRS codes for TIPLOCs the schedule leaves blank, using only the
 * schedule's own TIPLOC records. See docs/rdm-notes.md ("TIPLOC to CRS").
 */

export interface TiplocRecord {
  tiploc: string;
  crs: string | null;
  crsSource: 'schedule' | 'nlc' | 'name' | null;
  nlc: string | null;
  stanox: string | null;
  name: string;
}

/** Words that mark a non-station location when they appear after the station's name. */
const NON_STATION = /\b(SIGNAL|SIG|LOOP|DEPOT|TERMINAL|SIDINGS?|SDGS|YARD|CS|JUNCTION|LUL)\b/;

function normalise(name: string) {
  return name
    .toUpperCase()
    .replace(/\./g, '')
    .replace(/\bJN\b/g, 'JUNCTION')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True if `parent`'s name starts `child`'s name and the remainder doesn't describe a signal, loop, etc. */
function sameStation(child: string, parent: string) {
  const c = normalise(child);
  const p = normalise(parent);
  if (c !== p && !c.startsWith(p + ' ')) return false;
  return !NON_STATION.test(c.slice(p.length));
}

export function deriveCrs(records: TiplocRecord[]) {
  const withCrs = records.filter((t) => t.crs);
  const mainByNlc4 = new Map<string, TiplocRecord>();
  for (const t of withCrs) {
    if (t.nlc?.length === 6 && t.nlc.endsWith('00')) mainByNlc4.set(t.nlc.slice(0, 4), t);
  }
  const byName = new Map<string, TiplocRecord[]>();
  for (const t of withCrs) {
    const key = normalise(t.name);
    byName.set(key, [...(byName.get(key) ?? []), t]);
  }

  for (const t of records) {
    if (t.crs) continue;
    const main = t.nlc ? mainByNlc4.get(t.nlc.slice(0, 4)) : undefined;
    if (main && sameStation(t.name, main.name)) {
      t.crs = main.crs;
      t.crsSource = 'nlc';
      continue;
    }
    // Try ever-shorter leading word sequences of the name, longest first.
    const words = normalise(t.name).split(' ');
    for (let n = words.length; n >= 1; n--) {
      const candidates = byName.get(words.slice(0, n).join(' '));
      if (!candidates) continue;
      const only = candidates.length === 1 ? candidates[0]! : null;
      if (only && sameStation(t.name, only.name)) {
        t.crs = only.crs;
        t.crsSource = 'name';
      }
      break;
    }
  }
}
