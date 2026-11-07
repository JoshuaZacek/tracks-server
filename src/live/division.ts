import type { z } from 'zod';
import type { FormationCoach } from '../db/types.ts';
import type { TrainDivision } from '../modules/journeys/schemas.ts';
import { ukIsoAt } from '../time.ts';
import type { DarwinAssociation } from './compute.ts';
import { DarwinRun, type Resolved } from './run.ts';

/**
 * Dividing trains: whether my train splits somewhere between my boarding
 * station and my destination, and which part to be on. Pure.
 *
 * A saved journey is always on Darwin's `main` train of a VV association (the
 * timetable import has no associations, so nobody can save a trip that only the
 * portion reaches). The portion is the train that starts at the division.
 * Which coaches go where comes from Darwin's formations, where it has them: a
 * part whose coaches after the division are a front or rear run of the coaches
 * before it gets a note ("Front 4 coaches").
 */

type TrainDivisionOut = z.input<typeof TrainDivision>;
type PortionOut = TrainDivisionOut['portions'][number];

export interface DivisionInput {
  runDate: string;
  /** My train, resolved. */
  run: DarwinRun;
  /** My boarding station's location (null in a feed gap) and its scheduled departure (minutes on the run date). */
  board: { r: Resolved | null; scheduledMin: number };
  /** My destination's location and scheduled arrival, with its CRS and name. */
  dest: { r: Resolved | null; scheduledMin: number; crs: string; name: string };
  associations: DarwinAssociation[];
  formations: Record<string, FormationCoach[]>;
  crsOf: (tiploc: string) => string | null;
  nameOf: (tiploc: string) => string;
}

/** The run's location for an association: its tiploc, at the times Darwin gave (a train can pass a place twice). */
function divisionLocation(run: DarwinRun, a: DarwinAssociation): Resolved | null {
  const at = run.locations.filter((r) => r.loc.tpl === a.tiploc);
  const t = a.mainTimes;
  const same = (x: string | undefined, y: string | undefined) => x !== undefined && x === y;
  return (
    at.find((r) => same(t.wta, r.loc.wta) || same(t.wtd, r.loc.wtd) || same(t.pta, r.loc.pta) || same(t.ptd, r.loc.ptd)) ?? at[0] ?? null
  );
}

/** Where a run (or the part of it after a point) ends: its last public call that isn't cancelled. */
function destinationOf(locations: Resolved[]): Resolved | null {
  const calls = locations.filter((r) => r.loc.pta);
  return calls.findLast((r) => !r.loc.can) ?? calls.at(-1) ?? locations.at(-1) ?? null;
}

const callsAt = (locations: Resolved[], crs: string) => locations.some((r) => r.crs === crs && r.loc.pta !== undefined && !r.loc.can);

const coaches = (n: number) => `${n} coach${n === 1 ? '' : 'es'}`;

/** "Front N coaches" / "Rear N coaches" when `after` is a front or rear run of `before` (by coach number). */
export function coachNote(before: FormationCoach[] | undefined, after: FormationCoach[] | undefined): string | null {
  if (!before?.length || !after?.length || after.length >= before.length) return null;
  const numbers = after.map((c) => c.number);
  const matches = (run: FormationCoach[]) => run.every((c, i) => c.number === numbers[i]);
  if (matches(before.slice(0, after.length))) return `Front ${coaches(after.length)}`;
  if (matches(before.slice(before.length - after.length))) return `Rear ${coaches(after.length)}`;
  return null;
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** My part's coach note, when exactly one part goes to my destination and Darwin says which coaches. */
export function myCoachNote(d: Pick<TrainDivisionOut, 'portions'>): string | null {
  const mine = d.portions.filter((p) => p.yours);
  return mine.length === 1 ? (mine[0]!.note ?? null) : null;
}

/** Both parts call at my destination: nothing to do about it (no alert). */
export const bothMine = (d: Pick<TrainDivisionOut, 'portions'>) => d.portions.length > 1 && d.portions.every((p) => p.yours);

/** Short form for the Live Activity: "Divides at Horsham", or "Divides at Horsham · front 4 coaches". */
export function divisionShortText(d: TrainDivisionOut): string {
  const note = myCoachNote(d);
  return `Divides at ${d.atName}${note ? ` · ${lowerFirst(note)}` : ''}`;
}

function messageOf(atName: string, toName: string, portions: PortionOut[], portionKnown: boolean) {
  const mine = portions.filter((p) => p.yours);
  const note = mine.length === 1 ? mine[0]!.note : null;
  if (note) return `This train divides at ${atName}. Sit in the ${lowerFirst(note)} for ${toName}.`;
  if (portionKnown && mine.length === 2) return `This train divides at ${atName}; both parts call at ${toName}.`;
  if (portionKnown && mine.length === 1) return `This train divides at ${atName}; only some coaches go to ${toName}.`;
  return `This train divides at ${atName}. Check which coaches go to ${toName}.`;
}

/**
 * The first division of my train strictly between my boarding station and my
 * destination that it hasn't left yet (an actual departure or pass there, or
 * anywhere after). Cancelled associations are ignored; a cancelled journey is
 * the caller's to leave out. Portions: my train after the division and the
 * portion, mine first; `yours` = it calls at my destination.
 */
export function divides(input: DivisionInput): TrainDivisionOut | null {
  const { run, board, dest } = input;
  const afterBoard = (r: Resolved) => (board.r ? r.index > board.r.index : r.at > board.scheduledMin);
  const beforeDest = (r: Resolved) => (dest.r ? r.index < dest.r.index : r.at < dest.scheduledMin);

  const candidates = input.associations
    .filter((a) => !a.cancelled)
    .flatMap((a) => {
      const d = divisionLocation(run, a);
      const atCrs = input.crsOf(a.tiploc);
      return d && atCrs && afterBoard(d) && beforeDest(d) && !run.leftFrom(d) ? [{ a, d, atCrs }] : [];
    })
    .sort((x, y) => x.d.index - y.d.index);
  const first = candidates[0];
  if (!first) return null;
  const { a, d, atCrs } = first;

  const mainAfter = run.locations.filter((r) => r.index > d.index);
  const portionRun = new DarwinRun(a.assocLocations, d.at, input.crsOf);
  const portionKnown = portionRun.locations.length > 0;

  // The formation before the division, and the first different one on each part after it.
  const beforeFid = run.locations.findLast((r) => r.index < d.index && r.loc.fid)?.loc.fid ?? d.loc.fid;
  const mainFid = [d, ...mainAfter].map((r) => r.loc.fid).find((f) => f && f !== beforeFid);
  const portionFid = portionRun.locations.find((r) => r.loc.fid)?.loc.fid;
  const before = beforeFid ? input.formations[beforeFid] : undefined;
  const noteFor = (fid: string | undefined) => (fid && fid !== beforeFid ? coachNote(before, input.formations[fid]) : null);

  const portionOf = (locations: Resolved[], fid: string | undefined): PortionOut => {
    const end = destinationOf(locations);
    return {
      destCrs: end ? input.crsOf(end.loc.tpl) : null,
      destName: end ? input.nameOf(end.loc.tpl) : '',
      yours: callsAt(locations, dest.crs),
      note: noteFor(fid),
    };
  };
  // My train's part ends at its last call still served: the division station itself when disruption cut it short there.
  const parts = [portionOf([d, ...mainAfter], mainFid), ...(portionKnown ? [portionOf(portionRun.locations, portionFid)] : [])];
  // Mine first; the train I'm on before the other when both or neither are.
  const portions = [...parts.filter((p) => p.yours), ...parts.filter((p) => !p.yours)];
  const atName = input.nameOf(a.tiploc);
  return {
    atCrs,
    atName,
    at: ukIsoAt(input.runDate, Math.floor(d.arr.planned ?? d.at)),
    portions,
    message: messageOf(atName, dest.name, portions, portionKnown),
  };
}
