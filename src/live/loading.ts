import type { z } from 'zod';
import type { DarwinLocation } from '../darwin/parse.ts';
import type { FormationCoach } from '../db/types.ts';
import type { LoadingLevel, TrainLoading } from '../modules/journeys/schemas.ts';

/**
 * How busy the train is expected to be leaving my boarding station, from
 * Darwin's loading data at that location: the train's loading percentage
 * (serviceLoading), else the mean of its coaches (formationLoading). Coaches
 * get their class from the formation they belong to. Pure.
 */

type TrainLoadingOut = z.input<typeof TrainLoading>;
type Level = z.infer<typeof LoadingLevel>;

const percent = (n: number) => Math.min(100, Math.max(0, Math.round(n)));

export function loadingLevel(percentage: number): Level {
  return percentage < 30 ? 'quiet' : percentage < 60 ? 'moderate' : percentage < 85 ? 'busy' : 'very_busy';
}

/** Up to this many of the quietest coaches are named. */
const QUIETEST = 2;

export function loading(loc: DarwinLocation | null | undefined, formations: Record<string, FormationCoach[]>): TrainLoadingOut | null {
  if (!loc) return null;
  const formation = loc.coachLoading ? formations[loc.coachLoading.fid] : undefined;
  const coaches = (loc.coachLoading?.coaches ?? [])
    .filter((c) => Number.isFinite(c.percentage))
    .map((c) => ({ number: c.number, percentage: percent(c.percentage), class: formation?.find((f) => f.number === c.number)?.class ?? null }));
  const train = typeof loc.loading === 'number' && Number.isFinite(loc.loading) ? loc.loading : null;
  const percentage = train ?? (coaches.length ? coaches.reduce((sum, c) => sum + c.percentage, 0) / coaches.length : null);
  if (percentage === null) return null;
  // Sort is stable, so equal coaches stay front first.
  const quietest = [...coaches].sort((a, b) => a.percentage - b.percentage).slice(0, QUIETEST);
  return {
    percentage: percent(percentage),
    level: loadingLevel(percent(percentage)),
    coaches: coaches.length ? coaches : null,
    quietestCoaches: quietest.map((c) => c.number),
  };
}
