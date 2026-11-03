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

/** Darwin's schedule for a run: planned times and per-location cancellations (no forecasts). */
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
      out.locations.push({ rid: s.rid, key: locationKey(loc), loc });
    }
  }
}

/** The Darwin document inside a Kafka message value (the JSON envelope's `bytes`). */
export function parseMessage(value: string | Buffer): ParsedMessage {
  const out: ParsedMessage = { sequence: null, ts: null, heartbeat: false, services: [], locations: [], deactivated: [] };
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
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
