import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

/**
 * Table types for Kysely. Keep in step with src/db/migrations/.
 * Later phases add the schedule, Darwin, journey and push tables.
 */
export interface Database {
  meta: MetaTable;
  devices: DevicesTable;
  stations: StationsTable;
  journeys: JourneysTable;
  darwin_services: DarwinServicesTable;
  darwin_locations: DarwinLocationsTable;
  'schedule.tiplocs': TiplocsTable;
  'schedule.schedules': SchedulesTable;
  'schedule.schedule_locations': ScheduleLocationsTable;
}

/** timestamptz with a database default: optional on insert, a Date when selected. */
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface MetaTable {
  key: string;
  value: string | null;
  updated_at: Timestamp;
}

export type ApnsEnvironment = 'sandbox' | 'production';

export interface NotificationPrefs {
  delays: boolean;
  platforms: boolean;
  cancellations: boolean;
  departure: boolean;
  arrival: boolean;
  delayThresholdMinutes: number;
}

export interface DevicesTable {
  id: Generated<string>;
  /** SHA-256 (hex) of the bearer token; the token itself is never stored. */
  token_hash: string;
  apns_token: string | null;
  apns_env: ApnsEnvironment;
  push_to_start_token: string | null;
  app_version: string;
  locale: string | null;
  prefs: ColumnType<NotificationPrefs, string, string>;
  created_at: Timestamp;
  last_seen_at: Timestamp;
}

export type DeviceRow = Selectable<DevicesTable>;
export type NewDevice = Insertable<DevicesTable>;
export type DeviceUpdate = Updateable<DevicesTable>;

export interface StationsTable {
  crs: string;
  name: string;
  lat: number | null;
  lon: number | null;
  nlc: string | null;
  kb_status: 'ok' | 'not_found' | null;
  fetched_at: Date | null;
  in_schedule: Generated<boolean>;
}

export interface TiplocsTable {
  tiploc: string;
  crs: string | null;
  crs_source: 'schedule' | 'nlc' | 'name' | null;
  nlc: string | null;
  stanox: string | null;
  name: string;
}

export interface SchedulesTable {
  id: number;
  train_uid: string;
  stp: string;
  stp_rank: number;
  /** DATE columns come back as 'YYYY-MM-DD' (see db/client.ts). */
  start_date: string;
  end_date: string;
  days_runs: string;
  is_passenger: boolean;
  headcode: string | null;
  toc: string | null;
  origin_crs: string | null;
  dest_crs: string | null;
  dest_tiploc: string | null;
  timings: string | null;
}

export interface ScheduleLocationsTable {
  schedule_id: number;
  seq: number;
  tiploc: string;
  crs: string | null;
  public_arr: number | null;
  public_dep: number | null;
  platform: string | null;
}

export type JourneyState = 'scheduled' | 'live' | 'departed' | 'arrived' | 'cancelled' | 'not_found';

export interface JourneysTable {
  id: Generated<string>;
  device_id: string;
  train_uid: string;
  run_date: string;
  date: string;
  from_crs: string;
  to_crs: string;
  from_index: number;
  to_index: number;
  headcode: string;
  toc: string;
  scheduled_departure: Date;
  scheduled_arrival: Date;
  booked_platform: string | null;
  /** CallingPoint[] as returned by the API when saved (JSON). */
  calling_points: ColumnType<unknown, string, string>;
  route: ColumnType<unknown, string, string>;
  prefs: ColumnType<Record<string, boolean | number>, string | undefined, string>;
  rid: string | null;
  state: ColumnType<JourneyState, JourneyState | undefined, JourneyState>;
  /** LiveStatus (Phase 4). */
  status: ColumnType<unknown, string | null | undefined, string | null>;
  status_updated_at: Date | null;
  created_at: Timestamp;
  archived_at: Date | null;
}

export type JourneyRow = Selectable<JourneysTable>;

export interface DarwinServicesTable {
  rid: string;
  uid: string;
  ssd: string;
  toc: string | null;
  train_id: string | null;
  cancel_reason: string | null;
  late_reason: string | null;
  deactivated: Generated<boolean>;
  updated_at: Timestamp;
}

export interface DarwinLocationsTable {
  rid: string;
  key: string;
  tpl: string;
  crs: string | null;
  /** DarwinLocation (src/darwin/types.ts). */
  loc: ColumnType<unknown, string, string>;
  updated_at: Timestamp;
}
