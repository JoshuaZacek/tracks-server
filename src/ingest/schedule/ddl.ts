/**
 * The timetable lives in its own Postgres schema. An import builds a complete
 * copy in `schedule_staging` and swaps it in with two renames inside one
 * transaction, so the API keeps answering from the old copy until the new one
 * is ready.
 */
export const SCHEDULE_SCHEMA = 'schedule';
export const STAGING_SCHEMA = 'schedule_staging';
export const OLD_SCHEMA = 'schedule_old';

export function scheduleTablesSql(schema: string) {
  return `
CREATE SCHEMA ${schema};

CREATE TABLE ${schema}.tiplocs (
  tiploc     text PRIMARY KEY,
  crs        text,
  crs_source text,                    -- 'schedule' | 'nlc' | 'name' | NULL
  nlc        text,
  stanox     text,
  name       text NOT NULL
);

CREATE TABLE ${schema}.schedules (
  id           integer PRIMARY KEY,
  train_uid    text NOT NULL,
  stp          char(1) NOT NULL,       -- CIF_stp_indicator
  stp_rank     smallint NOT NULL,      -- C=0 N=1 O=2 P=3: the lowest valid rank wins on a date
  start_date   date NOT NULL,
  end_date     date NOT NULL,
  days_runs    char(7) NOT NULL,       -- Mon..Sun
  is_passenger boolean NOT NULL,
  headcode     text,
  toc          text,
  origin_crs   text,
  dest_crs     text,
  dest_tiploc  text,
  timings      text                    -- passenger only: JSON Timing[] (see ingest/schedule/parse.ts)
);

-- Public calls of passenger schedules. Times are minutes after midnight of the
-- run date, so calls after midnight are >= 1440.
CREATE TABLE ${schema}.schedule_locations (
  schedule_id integer NOT NULL,
  seq         smallint NOT NULL,
  tiploc      text NOT NULL,
  crs         text,
  public_arr  integer,
  public_dep  integer,
  platform    text
);
`;
}

/** Built after the bulk load, which is much faster than maintaining them during COPY. */
export function scheduleIndexesSql(schema: string) {
  return `
ALTER TABLE ${schema}.schedule_locations ADD PRIMARY KEY (schedule_id, seq);
CREATE INDEX ON ${schema}.schedules (train_uid, stp_rank);
CREATE INDEX ON ${schema}.schedule_locations (crs, public_dep);
CREATE INDEX ON ${schema}.tiplocs (stanox);
CREATE INDEX ON ${schema}.tiplocs (crs);
ANALYZE ${schema}.tiplocs;
ANALYZE ${schema}.schedules;
ANALYZE ${schema}.schedule_locations;
`;
}
