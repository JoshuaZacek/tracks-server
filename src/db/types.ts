import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

/**
 * Table types for Kysely. Keep in step with src/db/migrations/.
 */
export interface Database {
  meta: MetaTable;
  devices: DevicesTable;
  stations: StationsTable;
  journeys: JourneysTable;
  journey_templates: JourneyTemplatesTable;
  trips: TripsTable;
  darwin_services: DarwinServicesTable;
  darwin_locations: DarwinLocationsTable;
  darwin_associations: DarwinAssociationsTable;
  darwin_formations: DarwinFormationsTable;
  darwin_station_messages: DarwinStationMessagesTable;
  live_activities: LiveActivitiesTable;
  push_log: PushLogTable;
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
  liveActivity: boolean;
  morningSummary: boolean;
  leaveNow: boolean;
  connections: boolean;
  divides: boolean;
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
  /** Public calls in the imported timetable: how busy the station is. */
  calls: Generated<number>;
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
  /** AlertState (src/push/alerts.ts): what the user has been told; null until first seen. */
  alert_state: ColumnType<unknown, string | null | undefined, string | null>;
  created_at: Timestamp;
  archived_at: Date | null;
  /** The regular journey (template) it was made from; null when saved by hand or the template was deleted. */
  template_id: ColumnType<string | null, string | null | undefined, string | null>;
  /** Minutes to get to the boarding station, for the leave_now alert. */
  travel_minutes: ColumnType<number | null, number | null | undefined, number | null>;
  /** The trip (a journey with changes) this is a leg of; null on its own. */
  trip_id: ColumnType<string | null, string | null | undefined, string | null>;
  /** 1 for the first train of the trip; null without a trip. */
  leg: ColumnType<number | null, number | null | undefined, number | null>;
}

export type JourneyRow = Selectable<JourneysTable>;

export interface TripsTable {
  id: Generated<string>;
  device_id: string;
  /** Connection status last told per change, keyed by the arriving leg: { "1": "ok" }. */
  alert_state: ColumnType<Record<string, string>, string | undefined, string>;
  created_at: Timestamp;
}

export type TripRow = Selectable<TripsTable>;

export interface JourneyTemplatesTable {
  id: Generated<string>;
  device_id: string;
  /** The train last matched: a hint only, since UIDs change with the timetable. */
  train_uid: string | null;
  from_crs: string;
  to_crs: string;
  /** "HH:MM", UK local. */
  depart_time: string;
  /** Bitmask: bit 0 = Monday … bit 6 = Sunday. */
  days: number;
  travel_minutes: number | null;
  /** "HH:MM" to send the morning summary; null = none. */
  summary_time: string | null;
  /** JourneyPrefs copied onto each journey made. */
  prefs: ColumnType<Record<string, boolean | number>, string | undefined, string>;
  /** DATE columns come back as 'YYYY-MM-DD'. */
  last_created_date: string | null;
  problem_date: string | null;
  created_at: Timestamp;
}

export type JourneyTemplateRow = Selectable<JourneyTemplatesTable>;

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

/** Planned times at an association's location, as Darwin gives them. */
export interface AssociationTimes {
  wta?: string;
  wtd?: string;
  wtp?: string;
  pta?: string;
  ptd?: string;
}

export interface DarwinAssociationsTable {
  /** The train running through the location. */
  main_rid: string;
  /** VV: the portion that starts at the location; JJ: the one that ends there. */
  assoc_rid: string;
  tiploc: string;
  /** VV divides, JJ joins. */
  category: 'VV' | 'JJ';
  main_times: ColumnType<AssociationTimes, string, string>;
  assoc_times: ColumnType<AssociationTimes, string, string>;
  cancelled: Generated<boolean>;
  updated_at: Timestamp;
}

/** One coach of a formation, front to rear. */
export interface FormationCoach {
  number: string;
  /** "First", "Standard", "Mixed"…; null when Darwin doesn't say. */
  class: string | null;
}

export interface DarwinFormationsTable {
  fid: string;
  rid: string;
  coaches: ColumnType<FormationCoach[], string, string>;
  updated_at: Timestamp;
}

export interface DarwinStationMessagesTable {
  id: string;
  /** Darwin's category: Train, Station, Connections, System, Misc, PriorTrains, PriorOther. */
  category: string;
  /** 0 normal, 1 minor, 2 major, 3 severe. */
  severity: number;
  /** Darwin asks for it not to be shown. */
  suppress: Generated<boolean>;
  /** Plain text (Darwin's markup flattened). */
  message: string;
  /** The first link in the message, if any. */
  url: string | null;
  crs: string[];
  updated_at: Timestamp;
}

export interface LiveActivitiesTable {
  journey_id: string;
  /** ActivityKit update token (hex). */
  push_token: string;
  /** LiveActivityContent last pushed; null = push the current content at the next chance. */
  sent_content: ColumnType<unknown, string | null | undefined, string | null>;
  last_pushed_at: Date | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  ended_at: Date | null;
}

export type LiveActivityRow = Selectable<LiveActivitiesTable>;

export type PushOutcome = 'pending' | 'sent' | 'disabled' | 'no_token' | 'unregistered' | 'failed';

export interface PushLogTable {
  id: Generated<string>;
  /** Null for a push about a template (template_unmatched). */
  journey_id: string | null;
  template_id: string | null;
  channel: 'alert' | 'live_activity' | 'background';
  kind: string;
  dedupe_key: string | null;
  payload: ColumnType<unknown, string, string>;
  outcome: ColumnType<PushOutcome, PushOutcome | undefined, PushOutcome>;
  http_status: number | null;
  reason: string | null;
  apns_id: string | null;
  created_at: Timestamp;
}
