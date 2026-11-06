import { sql } from 'kysely';
import type { z } from 'zod';
import type { AppDeps } from '../../app.ts';
import type { Db } from '../../db/client.ts';
import type { DeviceRow, JourneyTemplateRow } from '../../db/types.ts';
import { ApiError } from '../../http/errors.ts';
import type { Logger } from '../../logger.ts';
import { templateUnmatchedText } from '../../push/alerts.ts';
import { templateAlertPayload } from '../../push/notifier.ts';
import { addDays, toUkIso, ukToday } from '../../time.ts';
import { applyPrefsUpdate, findOwned, isPast, saveDepsOf, saveJourney, type SaveDeps } from '../journeys/service.ts';
import { findDepartures, getStation } from '../stations/service.ts';
import { datesToCreate, daysToMask, giveUpOn, maskToDays, pickDeparture, searchFrom } from './occurrences.ts';
import type { CreateJourneyTemplateRequest, JourneyTemplate, JourneyTemplateList, UpdateJourneyTemplateRequest } from './schemas.ts';

type TemplateOut = z.input<typeof JourneyTemplate>;

/** Materialising needs what saving a journey needs, and somewhere to log. */
export interface MaterialiseDeps extends SaveDeps {
  log: Logger;
}

const notFound = () => ApiError.notFound('not_found', 'No such regular journey');

// ---- reading ---------------------------------------------------------------------

type TemplateWithStations = JourneyTemplateRow & {
  from_name: string;
  from_lat: number | null;
  from_lon: number | null;
  to_name: string;
  to_lat: number | null;
  to_lon: number | null;
};

const withStations = (db: Db) =>
  db
    .selectFrom('journey_templates as t')
    .innerJoin('stations as fs', 'fs.crs', 't.from_crs')
    .innerJoin('stations as ts', 'ts.crs', 't.to_crs')
    .selectAll('t')
    .select(['fs.name as from_name', 'fs.lat as from_lat', 'fs.lon as from_lon', 'ts.name as to_name', 'ts.lat as to_lat', 'ts.lon as to_lon']);

interface NextJourney {
  id: string;
  template_id: string;
  date: string;
  scheduled_departure: Date;
}

/** The soonest upcoming journey made from each template. */
async function nextJourneys(db: Db, templateIds: string[], now: Date): Promise<Map<string, NextJourney>> {
  if (!templateIds.length) return new Map();
  const { rows } = await sql<NextJourney>`
    SELECT DISTINCT ON (template_id) id, template_id, date, scheduled_departure
    FROM journeys
    WHERE template_id = ANY(${templateIds}::uuid[]) AND NOT ${isPast(now)}
    ORDER BY template_id, scheduled_departure, id`.execute(db);
  return new Map(rows.map((r) => [r.template_id, r]));
}

function toTemplate(row: TemplateWithStations, next: NextJourney | undefined): TemplateOut {
  return {
    id: row.id,
    from: { crs: row.from_crs, name: row.from_name, lat: row.from_lat, lon: row.from_lon },
    to: { crs: row.to_crs, name: row.to_name, lat: row.to_lat, lon: row.to_lon },
    departTime: row.depart_time,
    days: maskToDays(row.days),
    trainUid: row.train_uid,
    travelMinutes: row.travel_minutes,
    summaryTime: row.summary_time,
    prefs: row.prefs,
    problem: row.problem_date
      ? { date: row.problem_date, message: templateUnmatchedText(row.depart_time, row.from_name, row.to_name, row.problem_date) }
      : null,
    nextJourney: next ? { id: next.id, date: next.date, scheduledDeparture: toUkIso(next.scheduled_departure) } : null,
    createdAt: toUkIso(row.created_at),
  };
}

export async function listTemplates(deps: AppDeps, device: DeviceRow): Promise<z.input<typeof JourneyTemplateList>> {
  const rows = await withStations(deps.db).where('t.device_id', '=', device.id).orderBy('t.depart_time').orderBy('t.created_at').orderBy('t.id').execute();
  const next = await nextJourneys(deps.db, rows.map((r) => r.id), deps.now());
  return { templates: rows.map((r) => toTemplate(r, next.get(r.id))) };
}

async function getOwned(deps: AppDeps, device: DeviceRow, id: string): Promise<TemplateOut> {
  const row = await withStations(deps.db).where('t.id', '=', id).where('t.device_id', '=', device.id).executeTakeFirst();
  // Someone else's template looks exactly like a missing one.
  if (!row) throw notFound();
  const next = await nextJourneys(deps.db, [row.id], deps.now());
  return toTemplate(row, next.get(row.id));
}

// ---- changing ----------------------------------------------------------------------

const materialiseDepsOf = (deps: AppDeps): MaterialiseDeps => ({ ...saveDepsOf(deps), log: deps.log });

/**
 * Creates a regular journey and, straight away, its next journey(s). With `journeyId`
 * (Repeat on weekdays… from a saved journey) that journey is linked, its date counts as
 * made, and its train, travel time and prefs fill in what the body leaves out.
 */
export async function createTemplate(deps: AppDeps, device: DeviceRow, body: z.output<typeof CreateJourneyTemplateRequest>) {
  if (body.fromCrs === body.toCrs) {
    throw new ApiError(422, 'validation_failed', 'fromCrs and toCrs must differ', [{ in: 'body', path: 'toCrs', message: 'Must differ from fromCrs' }]);
  }
  await getStation(deps.db, body.fromCrs);
  await getStation(deps.db, body.toCrs);
  const journey = body.journeyId ? await findOwned(deps, device, body.journeyId) : null;

  const row = await deps.db
    .insertInto('journey_templates')
    .values({
      device_id: device.id,
      train_uid: body.trainUid !== undefined ? body.trainUid : (journey?.train_uid ?? null),
      from_crs: body.fromCrs,
      to_crs: body.toCrs,
      depart_time: body.departTime,
      days: daysToMask(body.days),
      travel_minutes: body.travelMinutes !== undefined ? body.travelMinutes : (journey?.travel_minutes ?? null),
      summary_time: body.summaryTime ?? null,
      prefs: JSON.stringify(body.prefs ?? journey?.prefs ?? {}),
      last_created_date: journey?.date ?? null,
      created_at: deps.now(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  if (journey) {
    await deps.db
      .updateTable('journeys')
      .set({ template_id: row.id, travel_minutes: journey.travel_minutes ?? row.travel_minutes })
      .where('id', '=', journey.id)
      .execute();
  }
  await materialiseTemplate(materialiseDepsOf(deps), row);
  return getOwned(deps, device, row.id);
}

/**
 * Changes a regular journey. New times or days apply to journeys made from now on; those
 * already made stay as they are. They also clear a problem, so the date is tried afresh.
 */
export async function updateTemplate(deps: AppDeps, device: DeviceRow, id: string, body: z.output<typeof UpdateJourneyTemplateRequest>) {
  const row = await deps.db.selectFrom('journey_templates').selectAll().where('id', '=', id).where('device_id', '=', device.id).executeTakeFirst();
  if (!row) throw notFound();
  const changes: { depart_time?: string; days?: number; travel_minutes?: number | null; summary_time?: string | null; prefs?: string; problem_date?: null } = {};
  if (body.departTime !== undefined) changes.depart_time = body.departTime;
  if (body.days !== undefined) changes.days = daysToMask(body.days);
  if (changes.depart_time !== undefined || changes.days !== undefined) changes.problem_date = null;
  if (body.travelMinutes !== undefined) changes.travel_minutes = body.travelMinutes;
  if (body.summaryTime !== undefined) changes.summary_time = body.summaryTime;
  if (body.prefs) changes.prefs = JSON.stringify(applyPrefsUpdate(row.prefs, body.prefs));
  if (Object.keys(changes).length) {
    const updated = await deps.db.updateTable('journey_templates').set(changes).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    // E.g. a day added that is today or tomorrow.
    await materialiseTemplate(materialiseDepsOf(deps), updated);
  }
  return getOwned(deps, device, id);
}

/** Stop repeating. Journeys already made stay (no longer linked). */
export async function deleteTemplate(deps: AppDeps, device: DeviceRow, id: string) {
  const result = await deps.db.deleteFrom('journey_templates').where('id', '=', id).where('device_id', '=', device.id).executeTakeFirst();
  if (!result.numDeletedRows) throw notFound();
}

// ---- materialising -----------------------------------------------------------------

/** The timetabled departure for `date`, or null when none is near the template's time. */
async function findMatch(db: Db, t: JourneyTemplateRow, date: string) {
  const { departures } = await findDepartures(db, { date, from: t.from_crs, to: t.to_crs, after: searchFrom(t.depart_time), limit: 50 });
  return pickDeparture(departures, date, t.depart_time, t.train_uid);
}

/** Records the template_unmatched alert (once per template and date); the notifier's tick sends it. */
async function recordUnmatched(deps: MaterialiseDeps, t: JourneyTemplateRow, date: string) {
  const names = await deps.db.selectFrom('stations').select(['crs', 'name']).where('crs', 'in', [t.from_crs, t.to_crs]).execute();
  const name = (crs: string) => names.find((n) => n.crs === crs)?.name ?? crs;
  const payload = templateAlertPayload(t.id, date, templateUnmatchedText(t.depart_time, name(t.from_crs), name(t.to_crs), date));
  await deps.db
    .insertInto('push_log')
    .values({
      template_id: t.id,
      channel: 'alert',
      kind: 'template_unmatched',
      dedupe_key: `template_unmatched:${date}`,
      payload: JSON.stringify(payload),
      created_at: deps.now(),
    })
    .onConflict((oc) => oc.columns(['template_id', 'dedupe_key']).where('template_id', 'is not', null).where('dedupe_key', 'is not', null).doNothing())
    .execute();
}

/**
 * Makes the template's journeys for today and tomorrow (see datesToCreate), each on the
 * timetabled train nearest its time. Idempotent: `last_created_date` moves past each date
 * made, so a journey the user deleted is not made again. When no train matches, the date
 * gets a problem and an alert, and stays open for one more try at the next run.
 */
export async function materialiseTemplate(deps: MaterialiseDeps, t: JourneyTemplateRow) {
  let last = t.last_created_date;
  let problem = t.problem_date;
  let trainUid = t.train_uid;
  let created = 0;
  try {
    for (const date of datesToCreate({ days: t.days, departTime: t.depart_time, lastCreatedDate: last }, deps.now())) {
      const match = await findMatch(deps.db, { ...t, train_uid: trainUid }, date);
      if (match) {
        await saveJourney(
          deps,
          t.device_id,
          { trainUid: match.trainUid, runDate: match.runDate, fromCrs: t.from_crs, toCrs: t.to_crs },
          { prefs: t.prefs, templateId: t.id, travelMinutes: t.travel_minutes },
        );
        created++;
        last = date;
        problem = null;
        trainUid = match.trainUid;
      } else if (giveUpOn(problem, date)) {
        deps.log.warn({ template: t.id, date }, 'Regular journey: still no train; skipping the date');
        last = date;
      } else {
        deps.log.warn({ template: t.id, date }, 'Regular journey: no train matched');
        problem = date;
        await recordUnmatched(deps, t, date);
        break;
      }
    }
  } catch (err) {
    // E.g. no timetable yet: try again at the next run.
    deps.log.error({ err, template: t.id }, 'Regular journey: creating journeys failed');
  }
  if (last !== t.last_created_date || problem !== t.problem_date || trainUid !== t.train_uid) {
    await deps.db
      .updateTable('journey_templates')
      .set({ last_created_date: last, problem_date: problem, train_uid: trainUid })
      .where('id', '=', t.id)
      .execute();
  }
  return created;
}

/**
 * Every template that may need a journey for today or tomorrow: daily after the timetable
 * import, and hourly so a missed refresh still makes tomorrow's. Cheap when there's nothing
 * to do. Returns the number of journeys made.
 */
export async function materialiseTemplates(deps: MaterialiseDeps) {
  const tomorrow = addDays(ukToday(deps.now()), 1);
  const templates = await deps.db
    .selectFrom('journey_templates')
    .selectAll()
    .where((eb) => eb.or([eb('last_created_date', 'is', null), eb('last_created_date', '<', tomorrow)]))
    .orderBy('id')
    .execute();
  let created = 0;
  for (const t of templates) created += await materialiseTemplate(deps, t);
  if (created) deps.log.info({ created }, 'Regular journeys: journeys made');
  return created;
}
