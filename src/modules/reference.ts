import { sql } from 'kysely';
import type { Db } from '../db/client.ts';
import { getMeta } from '../db/meta.ts';
import { ApiError } from '../http/errors.ts';
import { META_KEYS } from '../ingest/schedule/import.ts';
import { dayIndex } from '../time.ts';

/** Shared by the station, departure and train services. */

let loadedCache: { at: number; loaded: boolean } | null = null;

/** Whether a timetable has been imported. Cached briefly: it only changes once per import. */
export async function scheduleLoaded(db: Db): Promise<boolean> {
  if (loadedCache && Date.now() - loadedCache.at < 30_000) return loadedCache.loaded;
  const loaded = (await getMeta(db, META_KEYS.importedAt)) !== null;
  loadedCache = { at: Date.now(), loaded };
  return loaded;
}

export async function requireSchedule(db: Db) {
  if (!(await scheduleLoaded(db))) throw new ApiError(503, 'schedule_not_loaded', 'The timetable has not been imported yet');
}

/** For tests that import a timetable mid-run. */
export const resetScheduleCache = () => {
  loadedCache = null;
};

/**
 * SQL that is true when schedule `s` is the one that applies on `run`: it runs
 * that day and no lower-ranked STP schedule (C < N < O < P) for the same train
 * also runs that day. A winning cancellation therefore hides the train.
 */
export function runsAndWins(alias: string, run: string) {
  const day = dayIndex(run);
  return sql`
    ${sql.ref(`${alias}.start_date`)} <= ${run}::date AND ${sql.ref(`${alias}.end_date`)} >= ${run}::date
    AND substr(${sql.ref(`${alias}.days_runs`)}, ${day}, 1) = '1'
    AND NOT EXISTS (
      SELECT 1 FROM schedule.schedules w
      WHERE w.train_uid = ${sql.ref(`${alias}.train_uid`)} AND w.stp_rank < ${sql.ref(`${alias}.stp_rank`)}
        AND w.start_date <= ${run}::date AND w.end_date >= ${run}::date AND substr(w.days_runs, ${day}, 1) = '1'
    )`;
}
