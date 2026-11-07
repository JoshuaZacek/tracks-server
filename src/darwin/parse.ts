/**
 * Darwin Push Port messages from the RDM JSON topic, normalised. See
 * docs/darwin-notes.md for the format and its XML→JSON quirks:
 * - the Darwin document is a JSON string in the envelope's `bytes`
 * - one child is an object, several are an array (always use toArray)
 * - XML text content is under the "" key; booleans and numbers are strings
 * Pure: no I/O, so it is tested against the captured samples.
 */

/** Forecast or actual at a location: `et` estimate, `at` actual, both "HH:MM". */
export interface Forecast {
  et?: string;
  at?: string;
  /** Darwin says "delayed" without an estimate. */
  delayed?: boolean;
}

export interface DarwinPlatform {
  number: string;
  confirmed: boolean;
  /** Hidden from passengers (platsup / cisPlatsup): never show it. */
  suppressed: boolean;
}

/** One location of a run, as stored in darwin_locations.loc. */
export interface DarwinLocation {
  tpl: string;
  pta?: string;
  ptd?: string;
  wta?: string;
  wtd?: string;
  wtp?: string;
  /** Forecast fields: a TS states them all for its location, so absent ones are explicitly null. */
  arr?: Forecast | null;
  dep?: Forecast | null;
  pass?: Forecast | null;
  plat?: DarwinPlatform | null;
  /** From schedule messages: cancelled at this location. */
  can?: boolean;
  /** From schedule messages: the formation (darwin_formations.fid) that applies here. */
  fid?: string;
  /** From serviceLoading: how full the train is expected to be here, 0-100 %. */
  loading?: number | null;
  /** From formationLoading: per-coach loading here, front to rear. */
  coachLoading?: CoachLoading | null;
}

export interface CoachLoading {
  fid: string;
  coaches: { number: string; percentage: number }[];
}

/** A train dividing (VV) or joining (JJ) another at a location. See darwin_associations. */
export interface AssociationUpdate {
  mainRid: string;
  assocRid: string;
  tiploc: string;
  category: 'VV' | 'JJ';
  mainTimes: { wta?: string; wtd?: string; wtp?: string; pta?: string; ptd?: string };
  assocTimes: { wta?: string; wtd?: string; wtp?: string; pta?: string; ptd?: string };
  cancelled: boolean;
  /** Darwin removed it. */
  deleted: boolean;
}

/** A run's coaches for one formation, front to rear (scheduleFormations). */
export interface FormationUpdate {
  rid: string;
  fid: string;
  coaches: { number: string; class: string | null }[];
}

/** A station message (OW). An update with no stations removes it. */
export interface StationMessageUpdate {
  id: string;
  category: string;
  severity: number;
  suppress: boolean;
  /** Plain text: Darwin's markup (<p>, <a>…) flattened in reading order. */
  message: string;
  url: string | null;
  crs: string[];
}

export interface ServiceUpdate {
  rid: string;
  uid: string;
  ssd: string;
  /** Only set by schedule messages. */
  toc?: string | null;
  trainId?: string | null;
  cancelReason?: string | null;
  /** Only set by TS messages. */
  lateReason?: string | null;
}

export interface LocationUpdate {
  rid: string;
  key: string;
  loc: DarwinLocation;
}

export interface ParsedMessage {
  /** Darwin's PushPortSequence, for gap detection. */
  sequence: number | null;
  /** Document timestamp (ISO). */
  ts: string | null;
  heartbeat: boolean;
  services: ServiceUpdate[];
  locations: LocationUpdate[];
  deactivated: string[];
  associations: AssociationUpdate[];
  formations: FormationUpdate[];
  stationMessages: StationMessageUpdate[];
}

/* eslint-disable @typescript-eslint/no-explicit-any -- raw feed records */

export const toArray = <T>(v: T | T[] | null | undefined): T[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

const bool = (v: unknown) => v === true || v === 'true';

/** XML text content: "" key of an element object, or the value itself when it had no attributes. */
function text(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'object' && '' in (v as object)) return text((v as Record<string, unknown>)['']);
  return null;
}

/** Stable identity of a location within a run (a TIPLOC can appear twice, e.g. on a loop). */
export const locationKey = (l: { tpl: string; wta?: string; wtd?: string; wtp?: string }) => `${l.tpl}|${l.wta ?? ''}|${l.wtd ?? ''}|${l.wtp ?? ''}`;

function planned(l: any) {
  const out: DarwinLocation = { tpl: String(l.tpl) };
  for (const k of ['pta', 'ptd', 'wta', 'wtd', 'wtp'] as const) if (typeof l[k] === 'string') out[k] = l[k];
  return out;
}

function forecast(f: any): Forecast | null {
  if (!f || typeof f !== 'object') return null;
  const out: Forecast = {};
  if (typeof f.at === 'string') out.at = f.at;
  else if (typeof f.et === 'string') out.et = f.et;
  if (bool(f.delayed) || bool(f.etUnknown)) out.delayed = true;
  return out.at || out.et || out.delayed ? out : null;
}

function platform(p: any): DarwinPlatform | null {
  const number = text(p);
  if (!number) return null;
  return { number, confirmed: bool(p?.conf), suppressed: bool(p?.platsup) || bool(p?.cisPlatsup) };
}

/** Train Status: forecasts and actuals for the locations that changed. */
function parseTs(ts: any, out: ParsedMessage) {
  if (!ts?.rid || !ts.uid || !ts.ssd) return;
  out.services.push({ rid: ts.rid, uid: ts.uid, ssd: ts.ssd, lateReason: text(ts.LateReason) });
  for (const l of toArray<any>(ts.Location)) {
    if (!l?.tpl) continue;
    const loc: DarwinLocation = { ...planned(l), arr: forecast(l.arr), dep: forecast(l.dep), pass: forecast(l.pass), plat: platform(l.plat) };
    out.locations.push({ rid: ts.rid, key: locationKey(loc), loc });
  }
}

const SCHEDULE_LOCATION_TYPES = ['OR', 'OPOR', 'IP', 'OPIP', 'PP', 'DT', 'OPDT'];

/** Darwin's schedule for a run: planned times, per-location cancellations and formations (no forecasts). */
function parseSchedule(s: any, out: ParsedMessage) {
  if (!s?.rid || !s.uid || !s.ssd) return;
  out.services.push({
    rid: s.rid,
    uid: s.uid,
    ssd: s.ssd,
    toc: s.toc ?? null,
    trainId: s.trainId ?? null,
    cancelReason: text(s.cancelReason),
  });
  for (const type of SCHEDULE_LOCATION_TYPES) {
    for (const l of toArray<any>(s[type])) {
      if (!l?.tpl) continue;
      const loc: DarwinLocation = { ...planned(l), can: bool(l.can) };
      // Only when stated: a location without one keeps what is stored.
      if (typeof l.fid === 'string' && l.fid) loc.fid = l.fid;
      out.locations.push({ rid: s.rid, key: locationKey(loc), loc });
    }
  }
}

/** A whole percentage from Darwin's string (or text-content) number; null when there isn't one. */
function percentage(v: unknown): number | null {
  const t = text(v);
  if (t === null || !/^\d+(\.\d+)?$/.test(t)) return null;
  return Math.round(Number(t));
}

/**
 * How full a run is expected to be at a location. Keyed like a TS location, and carries only the planned
 * fields and `loading`, so merging it into what is stored keeps the forecasts, platform and formation.
 */
function parseServiceLoading(l: any, out: ParsedMessage) {
  if (!l?.rid || !l.tpl) return;
  const loc: DarwinLocation = { ...planned(l), loading: percentage(l.loadingPercentage) };
  out.locations.push({ rid: String(l.rid), key: locationKey(loc), loc });
}

/** Per-coach loading at a location, front to rear. Like serviceLoading, it only adds `coachLoading`. */
function parseFormationLoading(l: any, out: ParsedMessage) {
  if (!l?.rid || !l.tpl) return;
  const coaches = toArray<any>(l.loading).flatMap((c) => {
    const n = percentage(c);
    return typeof c?.coachNumber === 'string' && n !== null ? [{ number: c.coachNumber, percentage: n }] : [];
  });
  const loc: DarwinLocation = { ...planned(l), coachLoading: l.fid && coaches.length ? { fid: String(l.fid), coaches } : null };
  out.locations.push({ rid: String(l.rid), key: locationKey(loc), loc });
}

/** A run's formations: one update per formation id, coaches front to rear. */
function parseScheduleFormations(f: any, out: ParsedMessage) {
  if (!f?.rid) return;
  for (const formation of toArray<any>(f.formation)) {
    if (!formation?.fid) continue;
    const coaches = toArray<any>(formation.coaches?.coach).flatMap((c) =>
      typeof c?.coachNumber === 'string' ? [{ number: c.coachNumber, class: text(c.coachClass) }] : [],
    );
    out.formations.push({ rid: String(f.rid), fid: String(formation.fid), coaches });
  }
}

const ASSOCIATION_CATEGORIES = new Set(['VV', 'JJ']);

function associationTimes(t: any): AssociationUpdate['mainTimes'] {
  const out: AssociationUpdate['mainTimes'] = {};
  for (const k of ['wta', 'wtd', 'wtp', 'pta', 'ptd'] as const) if (typeof t?.[k] === 'string') out[k] = t[k];
  return out;
}

/** Divides (VV) and joins (JJ). Next-working (NP) and linked (LK) associations aren't passenger-relevant. */
function parseAssociation(a: any, out: ParsedMessage) {
  if (!ASSOCIATION_CATEGORIES.has(a?.category) || !a.tiploc || !a.main?.rid || !a.assoc?.rid) return;
  out.associations.push({
    mainRid: String(a.main.rid),
    assocRid: String(a.assoc.rid),
    tiploc: String(a.tiploc),
    category: a.category,
    mainTimes: associationTimes(a.main),
    assocTimes: associationTimes(a.assoc),
    cancelled: bool(a.isCancelled),
    deleted: bool(a.isDeleted),
  });
}

/** Attributes of Darwin's XHTML elements: not text. */
const MARKUP_ATTRIBUTES = new Set(['href', 'target', 'rel', 'title', 'class', 'style', 'id', 'lang', 'xmlns']);
/** Elements that separate words from their neighbours. */
const BLOCK_ELEMENTS = new Set(['p', 'div', 'br', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/**
 * An OW message's XHTML, converted to JSON, as text. The conversion loses the order of mixed content
 * ({"": ["before ", "after"], a: {…}}), so the best guess is used: text pieces with the child elements
 * between them, in order. Links found on the way are collected in `links`, first one first.
 */
function markupText(node: unknown, links: string[]): string {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (Array.isArray(node)) return node.map((n) => markupText(n, links)).join(' ');
  if (typeof node !== 'object') return '';
  const el = node as Record<string, unknown>;
  if (typeof el.href === 'string' && el.href) links.push(el.href);
  const pieces = toArray(el['']).map((p) => markupText(p, links));
  const children = Object.entries(el)
    .filter(([k]) => k !== '' && !MARKUP_ATTRIBUTES.has(k))
    .map(([k, v]) => {
      const t = toArray(v)
        .map((c) => markupText(c, links))
        .join(' ');
      return BLOCK_ELEMENTS.has(k) ? ` ${t} ` : t;
    });
  let out = '';
  for (let i = 0; i < Math.max(pieces.length, children.length); i++) out += (pieces[i] ?? '') + (children[i] ?? '');
  return out;
}

/** A station message. One without stations (none seen so far) removes it. */
function parseStationMessage(m: any, out: ParsedMessage) {
  if (m?.id === undefined || m.id === null || m.id === '') return;
  const links: string[] = [];
  const message = markupText(m.Msg, links).replace(/\s+/g, ' ').trim();
  const severity = Number(text(m.sev) ?? 0);
  const crs = [...new Set(toArray<any>(m.Station).flatMap((s) => (typeof s?.crs === 'string' && s.crs ? [s.crs] : [])))];
  out.stationMessages.push({
    id: String(m.id),
    category: text(m.cat) ?? 'Misc',
    severity: Number.isInteger(severity) && severity >= 0 && severity <= 3 ? severity : 0,
    suppress: bool(m.suppress),
    message,
    url: links[0] ?? null,
    crs,
  });
}

/** The Darwin document inside a Kafka message value (the JSON envelope's `bytes`). */
export function parseMessage(value: string | Buffer): ParsedMessage {
  const out: ParsedMessage = {
    sequence: null,
    ts: null,
    heartbeat: false,
    services: [],
    locations: [],
    deactivated: [],
    associations: [],
    formations: [],
    stationMessages: [],
  };
  const envelope = JSON.parse(value.toString()) as any;
  const seq = envelope?.properties?.PushPortSequence?.string;
  out.sequence = seq !== undefined && seq !== null && /^\d+$/.test(String(seq)) ? Number(seq) : null;
  const bytes = envelope?.bytes ?? envelope?.text;
  if (typeof bytes !== 'string') return out;
  const doc = JSON.parse(bytes) as any;
  out.ts = typeof doc.ts === 'string' ? doc.ts : null;
  if (doc.FailureResp) {
    out.heartbeat = text(doc.FailureResp.code) === 'HBOK' || doc.FailureResp.code === 'HBOK';
    return out;
  }
  const block = doc.uR ?? doc.sR;
  if (!block || typeof block !== 'object') return out;
  for (const ts of toArray<any>(block.TS)) parseTs(ts, out);
  for (const s of toArray<any>(block.schedule)) parseSchedule(s, out);
  for (const d of toArray<any>(block.deactivated)) if (d?.rid) out.deactivated.push(String(d.rid));
  for (const l of toArray<any>(block.serviceLoading)) parseServiceLoading(l, out);
  for (const l of toArray<any>(block.formationLoading)) parseFormationLoading(l, out);
  for (const f of toArray<any>(block.scheduleFormations)) parseScheduleFormations(f, out);
  for (const a of toArray<any>(block.association)) parseAssociation(a, out);
  for (const m of toArray<any>(block.OW)) parseStationMessage(m, out);
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
