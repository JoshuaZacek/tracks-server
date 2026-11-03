# Rail data: samples and field notes

Everything in `samples/` was captured from the real Rail Data Marketplace
products by `npm run capture-samples` (see `server/scripts/capture-samples.ts`).
API keys and auth headers are stripped; the script refuses to write a file that
contains a key from `.env`.

| File | Product | Notes |
|---|---|---|
| `ldbws-departure-board-KGX.json`, `-YRK.json` | Live Departure Board (LDBWS 20220120, REST/JSON) | `GetDepartureBoard/{crs}?numRows=15`, with response headers |
| `service-details.json` | Service Details | `GetServiceDetails/{serviceID}` for a through train at York |
| `kb-station-YRK.xml` (+ `.json` wrapper) | Knowledgebase Stations v4.0 | Per-station endpoint `station-{CRS}.xml` |
| `kb-stations-all-probe.json` | Knowledgebase Stations | `stations.xml` does not exist (HTTP 500 `RouteFailed`) |
| `schedule-excerpt.ndjson` | NWR Schedule | ~35 records from `CIF_ALL_FULL_DAILY_toc-full.json.gz` |

## NWR Schedule (file product, downloaded by hand)

- Format: **newline-delimited JSON** (NTROD "JsonTimetableV1"), not CIF.
  One record per line: `JsonTimetableV1` header, `TiplocV1` (all first),
  `JsonAssociationV1`, `JsonScheduleV1`, `EOF`.
- Schedule keys: `CIF_train_uid`, `CIF_stp_indicator` (P/O/N/C),
  `schedule_start_date`, `schedule_end_date`, `schedule_days_runs` (Mon..Sun,
  e.g. `"1111100"`), `train_status`, `atoc_code`, `CIF_bank_holiday_running`,
  `schedule_segment.signalling_id` (headcode), `schedule_segment.CIF_train_category`,
  `schedule_segment.schedule_location[]`.
- Location keys: `location_type`/`record_identity` (LO/LI/LT), `tiploc_code`,
  `arrival`, `departure`, `pass` (working times, `HHMM` or `HHMMH`),
  `public_arrival`, `public_departure` (`HHMM`, null when not a public call),
  `platform`.
- STP cancellations (`"C"`) have no `schedule_location`.
- **No retail service ID (`rsid`) anywhere in the file.**
- `TiplocV1` keys: `tiploc_code`, `nalco` (NLC), `stanox`, `crs_code`,
  `description`, `tps_description`.

## LDBWS departure board

Top level: `trainServices[]`, `generatedAt`, `locationName`, `crs`,
`filterType`, `platformAvailable` (station-level), `areServicesAvailable`.

Service keys: `serviceID`, `std` (`"HH:MM"`), `etd` (`"On time"`,
`"HH:MM"`, `"Cancelled"`, `"Delayed"`), `platform` (string, may be `"TBC"`
or absent), `operator`, `operatorCode`, `origin[]`/`destination[]`
(`locationName`, `crs`), `isCancelled`, `cancelReason`, `delayReason`,
`rsid` (**only on some services**), `length`, `serviceType`.

- **There is no per-service platform confirmation field.** Platforms are shown
  as "Live" (from LDBWS) or "Booked" (from the schedule).
- No rate-limit headers in any response (`x-request-id` only). The server logs
  any rate-limit style header it ever sees.
- Query parameters that work: `numRows` (150 accepted), `timeOffset`
  (-120..119), `timeWindow` (up to 120), `filterCrs` + `filterType=to`.
  Negative offsets return trains that have already left, still with `etd` and
  no `atd`, so the board alone can't tell whether a train has departed.
- **One bad service fails a whole board.** York on 5 Oct 2026 returned HTTP 500
  `{"Message":"The service is currently unavailable"}` for any request whose
  range included trains around 19:34-19:44 (also with `filterCrs`), while
  other ranges and stations worked. The backend retries with 10- and 3-minute
  windows around the saved train and otherwise backs off for that journey only.

## Service Details

Top level: `locationName`, `crs`, `operator`, `operatorCode`, `isCancelled`,
`platform`, `sta`/`eta`/`std`/`etd`, `delayReason`,
`previousCallingPoints[0].callingPoint[]`,
`subsequentCallingPoints[0].callingPoint[]`.

Once the train has left the station the serviceID came from, the top level has
`atd` (`"On time"` or `"HH:MM"`) instead of `etd`, and no `platform`.
`subsequentCallingPoints` then gains `at` for each stop called at, which is
how progress is worked out (`server/src/services/progress.ts`).

When a train finishes its run, Service Details for its serviceID starts
returning HTTP 500 `{"Message":"Unable to retrieve the requested data"}`. The
backend treats that, after the last expected arrival at my stop, as arrived
(flagged as not confirmed by Darwin).

Calling point keys: `locationName`, `crs`, `st`, `et` (future stops),
`at` (stops already called at; `"On time"` or `"HH:MM"`), `isCancelled`,
`length`, `delayReason`, `affectedByDiversion`. Times carry no date.

## Knowledgebase Stations

Per-station XML, root `StationV4.0` (default namespace
`http://nationalrail.co.uk/xml/station`): `CrsCode`,
`AlternativeIdentifiers/NationalLocationCode`, `Name`, `Longitude`,
`Latitude`, plus lots of facilities data. **No TIPLOC.**

## TIPLOC to CRS

The schedule's `TiplocV1.crs_code` puts each CRS on exactly one TIPLOC, so
secondary TIPLOCs at big stations have none (London Waterloo `WATRLMN`, London
Bridge `LNDNBDE`/`LNDNBDC`, Victoria `VICTRIC`/`VICTRIE`, Clapham Junction x4,
Wimbledon `WDON`, ...): 41 TIPLOCs, 4.2% of passenger public calls.

The importer fills these from the same file (no extra source):

1. `crs_code` on the TIPLOC itself.
2. Otherwise the TIPLOC with the same first four NLC digits and suffix `00`
   (the station's main record), if its name is a prefix of this TIPLOC's name
   and the rest is not a signal/loop/depot/junction (e.g. `WATRLMN` 559801 ->
   `WATRLOO` 559800 `WAT`).
3. Otherwise a unique CRS-bearing TIPLOC whose name is a prefix of this one's
   on the same terms (e.g. `RICHNLL` "RICHMOND NLL" -> `RICHMND` `RMD`).

Anything left is a non-station location (signals, loops, depots) and is
skipped. The import prints the coverage figures every time.

## NWR Train Movements (TRUST)

Kafka on Confluent Cloud (SASL PLAIN over TLS), topic `TRAIN_MVT_ALL_TOC`;
connection details from the RDM product's Pub/Sub section. Captured by
`npm run capture-trust --workspace server` into `trust-*.json`
(`trust-raw-messages.json` keeps whole Kafka messages with key and headers).

- Each Kafka message value is a JSON array of ~30 items
  `{ header: { msg_type, msg_queue_timestamp, source_system_id, original_data_source }, body }`.
- `0001` activation: `train_id` (10 chars), `train_uid` (= schedule
  `CIF_train_uid`), `tp_origin_timestamp` (run date, `YYYY-MM-DD`),
  `schedule_start_date` (start of the schedule's validity, not the run date),
  `schedule_type`, `origin_dep_timestamp`, `toc_id` (numeric business code).
- `0003` movement: `train_id`, `loc_stanox`, `event_type` (`ARRIVAL` |
  `DEPARTURE`), `planned_event_type`, `actual_timestamp`, `planned_timestamp`,
  `gbtt_timestamp` (absent where the train doesn't call: a "DEPARTURE" there is
  a pass), `timetable_variation` (unsigned minutes) with `variation_status`
  (`EARLY` | `ON TIME` | `LATE` | `OFF ROUTE`), `offroute_ind`,
  `next_report_stanox`, `next_report_run_time`, `train_terminated`.
- Also seen: `0002` cancellation, `0005` reinstatement, `0006` change of
  origin, `0008` change of location (not used).
- **Timestamps** (`actual_timestamp`, `planned_timestamp`, ...) are UK
  wall-clock time written as if UTC: a 20:21 BST departure is `20:21Z`.
  `msg_queue_timestamp` is real UTC.
- `train_id` embeds the headcode (characters 3-6) and day of month (9-10),
  e.g. `541S32MZ05` is 1S32 on the 5th; used to find trains whose activation
  was missed (sent about an hour before departure).
- Locations are STANOX codes, joined to the schedule through the
  `TiplocV1.stanox` field. Without BPLAN there are no coordinates for
  non-station timing points, so a report is placed by its working time between
  the two calling points either side (`server/src/services/position.ts`).

## OS Open Names (nearest town)

Not an RDM product: downloaded free from the OS Data Hub
(`opname_csv_gb.zip`, ~100 MB, Open Government Licence). `npm run
build:places` keeps cities, towns, villages and suburban areas (27,457
places), converts British National Grid to WGS84, adds extents for cities and
towns, and writes `web/public/data/places.json` (~900 KB, ~350 KB gzipped).
The browser looks up the nearest place itself, so the location never leaves
the device. Attribution: "Contains OS data © Crown copyright and database
right".

Suburbs and villages carry no parent town in this dataset, so labels combine
the nearest village/suburb with the town whose extent contains the position
("South Wimbledon, London") or the nearest town within 10 km
("Belmesthorpe, near Stamford").
