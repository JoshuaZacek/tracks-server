# Darwin Push Port: field notes (Phase 0 spike)

Captured with `npm run capture:darwin` (`scripts/capture-darwin.ts`; it has since changed to read without a consumer group, see "Sprint 3 spike") on 3 Nov 2026, 01:56–01:59 UK time, from the RDM topic
`prod-1010-Darwin-Train-Information-Push-Port-IIII2_0-JSON`. Samples are in `samples/darwin-*.json`, and figures in
`samples/darwin-stats.json`. The capture never commits offsets, and every file is checked for configured secrets before it is written.

## Connection

- Confluent Cloud Kafka: SASL PLAIN over TLS, the same as TRUST. The connection code is `src/rdm/kafka.ts`.
- The topic has **1 partition**, so ordering is total.
- Kafka timestamps were a median of **~260 ms** behind wall-clock time (max ~400 ms).

## Envelope

Each Kafka message value is a JSON object bridged from JMS (ActiveMQ). The fields that matter are:

| Field | Meaning |
|---|---|
| `bytes` | **A JSON string**: the Darwin Push Port document. Parse it a second time. |
| `properties.PushPortSequence.string` | Darwin's sequence number (string). It increases by 1 per message, so gaps can be detected. |
| `timestamp` | JMS timestamp (ms since epoch) |
| `messageID` | Also repeated as the Kafka key (`{"messageID": …}`) |

There are no Kafka headers. The other envelope fields (`destination`, `priority`, `map`, `text`, …) aren't used.

## Document (inside `bytes`)

`{"ts": "2026-11-03T01:56:11.1302752+00:00", "version": "18.0", …}` plus one of:

- `uR`: an update. It holds `updateOrigin` (e.g. `"TD"`, `"CIS"`, `"Darwin"`), sometimes `requestSource`/`requestID`, and then one
  or more element kinds.
- `FailureResp` with `code: "HBOK"`: a **heartbeat**, roughly every few seconds. It's a quarter of the messages at night. Ignore it,
  but use it as the liveness signal for "is the feed alive".
- `sR` (snapshot) wasn't seen.

`ts` has 7 fractional digits; parse it with care.

## The XML→JSON conversion quirks (handle in the parser)

1. **A single child is an object, more than one is an array.** For example, `TS.Location` is sometimes `{…}` and sometimes `[{…}, …]`;
   the same goes for schedule `IP`/`PP` and every element kind under `uR`. Normalise everything with `toArray()`.
2. **XML text content sits under the empty-string key**: `"plat": {"platsrc": "A", "conf": "true", "": "4"}`. The platform number is
   `plat[""]`.
3. **Booleans are strings**: `"true"`/`"false"` (`conf`, `platsup`, `cisPlatsup`, `isCancelled`, …). Absent means false.
4. **Numbers are strings**: `length`, `loadingPercentage`, `LateReason` codes.
5. **Times are `HH:MM` or `HH:MM:SS`** with no date. Resolve them against `ssd` (scheduled start date) with day-rollover logic, as
   `ingest/schedule/parse.ts` does for the NWR Schedule.

## Element kinds seen (3 minutes at night)

| Kind | Count | What it is | Used for |
|---|---|---|---|
| `TS` | 678 | Train Status: forecasts and actuals per location | **Live status, platforms, delays, position** |
| `schedule` | 143 | Darwin's schedule for a run | `rid` ↔ `uid`/`ssd`; calling pattern changes |
| `serviceLoading` | 107 | Loading % at a location | "How busy" (Sprint 3, below) |
| `association` | 40 | Joins and divides (`NP`/`JJ`/`VV`) | Trains that divide (Sprint 3, below) |
| `deactivated` | 28 | `{rid}`: the run is finished or removed | Stop tracking |

Expected in the daytime but not seen at night: station messages (`OW`), `formationLoading`, `trainAlert`, `trackingID`, `alarm`.
See "Sprint 3 spike" below for an evening hour.

### `TS` (train status)

```json
{ "rid": "202611036710190", "uid": "C10190", "ssd": "2026-11-03", "LateReason": "895",
  "Location": [ { "tpl": "NEWSGAT", "wta": "01:55", "wtd": "01:55:30", "pta": "01:55", "ptd": "01:55",
                  "arr": { "at": "01:54", "atClass": "Automatic", "src": "TD" },
                  "dep": { "et": "01:55", "src": "Darwin" },
                  "plat": { "platsrc": "A", "conf": "true", "": "4" }, "length": "6" } ] }
```

- **`uid` + `ssd` are on every TS.** They match NWR Schedule's `CIF_train_uid` and our journey `run_date`, so **a saved journey
  matches its live train exactly**. The PoC's guesswork matcher isn't needed. The `rid` can come from any TS or schedule message,
  so no separate RID lookup is needed.
- Each location carries `arr`/`dep`/`pass`, with `et` (estimate) or `at` (actual) and a `src`. Sources seen are `TD` (train
  describer), `TRUST` and `Darwin`. Actuals are reported **at passing points too** (e.g. `CTSARTJ` with `pass.at`).
- `plat`: number in `""`, `conf` (confirmed), `platsup`/`cisPlatsup` (suppressed from public display: don't show it), and
  `platsrc` (`A` = automatic, `P` = planned, `M` = manual).
- A TS is a **delta**: only the locations that changed. Live state has to be accumulated per `rid`.
- `LateReason` and cancellation reasons are **numeric codes**. Their text comes from Darwin reference data (see open questions).

### `schedule`

`rid`, `uid`, `trainId` (headcode), `rsid`, `ssd`, `toc`, then locations by type: `OR` (origin), `IP` (intermediate
passenger), `PP` (passing point), `DT` (destination), and also `OPOR`/`OPIP`/`OPDT` (operational). Each location has `tpl`, public
(`pta`/`ptd`) and working (`wta`/`wtd`/`wtp`) times, `act` (activity codes, `T ` = stops, `TB` = train begins, `TF` = finishes),
and `can="true"` when cancelled at that location.

## Volume

| | Night (01:56–01:59) | Daytime |
|---|---|---|
| Messages/s (mean / p95 / max) | 6.2 / 33 / 115 | **~32 mean** (12:31–14:36, from offsets) |
| Mean message size | 1.7 KB (max 17 KB) | |

Even at 10–20× the night rate, this is a few hundred small JSON messages a second, which is comfortable for one Node worker. A
daytime capture (`npm run capture:darwin -- --seconds 300` around 08:00 or 17:30) should confirm it before Phase 4 is finished.

## ⚠️ Retention is short

The topic offsets at capture time were `low = 442,425,141` and `high = 442,482,424`, so **only about 57,000 messages are
retained**. Asking for the offset "one day ago" returned the low watermark. At night that's about 2.5 hours. At daytime rates
it's probably **well under an hour**, though that needs measuring.

What this means for Phase 4:

- After a worker outage longer than retention, updates in between are **lost**. Kafka can't replay them, and no snapshot
  (`sR`) arrives on this topic.
- Because TS messages are deltas, a missed one (e.g. a platform assignment) stays missing until that location changes again.
- **Planned mitigation:** the consumer compares its committed offset with the low watermark at startup, and checks
  `PushPortSequence` for gaps while running. On a gap it marks Darwin state as possibly incomplete and **backfills the journeys
  being tracked from LDBWS Service Details**, using the PoC's proven client. That is one call per tracked train, once, not
  polling. Status is shown as `stale` until the backfill or a fresh TS arrives.
- Keep the worker's downtime short (graceful restarts, Docker `restart: unless-stopped`).

### Measured: 3 Nov, daytime (from an outage)

The consumer crashed at 12:31 and was restarted at 14:35 (see below). Offsets then: committed `443,386,370`, low
`443,514,063`, high `443,625,029`. So:

- **About 239k messages in 2 h 04 min, ~32 messages/s on average** in the daytime. The worker kept up with 0.3 s lag
  after catching up, so throughput isn't a concern.
- **Only about 111k messages are retained in the daytime: roughly an hour.** Any time the consumer isn't reading for
  more than about an hour loses updates for good. Here about 128k messages were lost, and `gapAt` recorded it.

### Consumer crash (3 Nov 12:31) and the fix

After about 40 minutes of flaky connections to Confluent (TLS disconnects, `ECONNRESET`, `ETIMEDOUT`), the group coordinator
dropped our member, and kafkajs raised `KafkaJSNonRetriableError: The coordinator is not aware of this member`. kafkajs
**never restarts a consumer after a non-retriable crash**, and the worker carried on without one for two hours. Its
heartbeat still showed it as healthy.

Fixes:
- **Self-restart:** the consumer now restarts itself. On a non-retriable `CRASH`, a failed start, or a stall (nothing
  processed, not even heartbeats, for 3 minutes), it disconnects and starts a fresh consumer. Backoff is 5 s, 15 s, 30 s,
  1 min, 2 min, then 5 min, and the consumer resumes from the committed offset.
- **Overall health flag:** `/v1/status` has a top-level `healthy` that is false when the Darwin feed is down, even if the
  worker process is alive.
- **No alerts on frozen data:** while the feed is down, alerts and Live Activity push-to-start wait. "Approaching" (a
  time rule on an estimate) also needs a Darwin message about that train within the last 15 minutes.
- **No alerts during catch-up:** alerts also wait while the consumer is more than 60 s behind real time, i.e. while it
  replays a backlog. On restart at 14:35 the replay produced "5 min late" and then "back on time" a second apart, from
  estimates that were already history. Journeys skipped meanwhile are re-checked once the consumer has caught up, so
  each gets one alert based on its latest status.

Still open: backfilling the journeys being tracked (e.g. from LDBWS) after a gap longer than retention.

## TRUST

Darwin already forwards TRUST and TD actuals, including at passing points (`src: "TRUST"`/`"TD"`). **TRUST is unnecessary for
positions.** Phase 4 confirmed it on a real train: the Caledonian Sleeper 1S25 overnight was placed by passing points (signal
MC863 near Kirkpatrick at 02:16, Lockerbie at 02:26) with the next location's estimate (Beattock, revised from 02:37 to 02:33).
Recommendation: drop Phase 6.

## Phase 4 observations (first live run, 3 Nov ~02:20)

- First start read the whole retained backlog (~69k messages: 5.8k runs, 90k locations) in about 20 s, then kept up with
  0.3 s lag.
- After a graceful restart, the consumer resumed from its committed offset (about 150 messages behind), with no backlog re-read.
- Times past midnight resolve correctly: 1S25 departed Euston 21:15 on 2 Nov, and Preston showed 00:38/00:43 on 3 Nov.
- `jsonb` reorders object keys, so status change detection compares canonical (key-sorted) JSON.

## Sprint 3 spike (7 Nov 2026, evening)

Read on Sat 7 Nov 2026, 17:34–18:38 UK time: everything the topic retained, about 105k messages. Curated fixtures are in
`samples/` (below); the parser (`src/darwin/parse.ts`) and its tests are written against them.

### How it was captured (and how to capture safely)

RDM authorises **only the subscription's one consumer group**, and the production worker is a member of it. A capture that
joins that group takes the topic's single partition away from the worker (a rebalance, then the worker sits idle until the
capture leaves); a capture under any other group id is refused. So this hour was read **without a consumer group**: plain Kafka
Fetch requests to the partition leader (`replicaId: -1`, like any consumer outside a group), from the low watermark to the high
watermark, committing nothing. `scripts/capture-darwin.ts` now works that way: by default it reads the last `--seconds` (the
offset at that time comes from ListOffsets, `fetchTopicOffsetsByTimestamp`), or everything retained with `--from-start`. kafkajs
has no public group-less fetch, so the script reaches its private cluster (the `private:Kafka:createCluster` symbol) and fails
loudly if a kafkajs upgrade removes it. Output goes to `data/darwin-capture/` (not committed) unless `--out` is given, so a capture
never overwrites the fixtures the tests read.

### Element counts in the hour

| Kind | Count | Notes |
|---|---|---|
| `TS` | 92,559 | as before |
| `serviceLoading` | 3,928 | loading % per location |
| `schedule` | 3,848 | locations now carry `fid` (and `avgLoading`) |
| `deactivated` | 1,786 | |
| `association` | 1,714 | almost all `NP` |
| `formationLoading` | 1,126 | per-coach loading, 164 runs |
| `scheduleFormations` | 49 | coaches per formation, 49 runs |
| `OW` | 10 | 5 distinct messages |
| `trainAlert` | **0** | none seen, so not parsed yet |

### `association` (`samples/darwin-association.json`, `samples/darwin-divide-horsham.json`)

```json
{ "tiploc": "HORSHAM", "category": "VV", "isCancelled": "true",
  "main":  { "rid": "202611077126226", "wta": "17:27", "wtd": "17:31", "pta": "17:27", "ptd": "17:31" },
  "assoc": { "rid": "202611076782431", "wtd": "17:35", "ptd": "17:35" } }
```

- `main`/`assoc` hold the two trains' rids and their planned times at the tiploc (any of `wta`/`wtd`/`pta`/`ptd`).
- Categories in a sample of 400: **NP 391, VV 5, JJ 4**. `VV` = divides: `main` runs through the tiploc and `assoc` is the
  portion that starts there (its schedule's `OR` is the tiploc). `JJ` = joins: `assoc` ends at the tiploc and joins `main`. `NP`
  (next working: the unit's next trip) and `LK` (linked) aren't passenger-relevant and aren't stored.
- `isDeleted: "true"` removes it (20 of the 400, mostly NP); `isCancelled: "true"` keeps it, marked cancelled (29).
- The same association is restated often (unchanged, or with `isCancelled` toggling as the day's disruption changes).
- Real example (`darwin-divide-horsham.json`, shape `{ association, main, assoc }` with both Darwin schedules): Southern 1C46
  (rid 202611077126226, uid G26226) Victoria 16:35 → Portsmouth Harbour divides at Horsham (17:27/17:31); the portion 1B46
  (rid 202611076782431) leaves Horsham 17:35 for Bognor Regis. Both call at Barnham (`BRHM`). That evening it was disrupted
  (`cancelReason` 704): 1C46's schedule shows Horsham as a `DT` with `act: "TF"`, `planAct: "T -D"` (planned: stop and detach),
  alongside the cancelled original `DT` Portsmouth Harbour, so **`DT` can be an array** too.
- The CIF timetable import ignores associations, so a saved journey is always on the `main` train.

### `serviceLoading` (`samples/darwin-serviceLoading.json`)

```json
{ "rid": "202611077158934", "tpl": "KEWGRDN", "wta": "16:34", "wtd": "16:34:30", "pta": "16:34", "ptd": "16:34", "loadingPercentage": "33" }
```

- Keyed exactly like a TS location (`tpl` + working times), so it merges into `darwin_locations.loc` as `loading` (a number).
- `loadingPercentage` is a string number; no `loadingCategory` was seen. It also arrives for **tomorrow's runs** (rids starting
  20261108) before their schedule, so a location row can exist with only planned fields and `loading`.

### `formationLoading` (`samples/darwin-formationLoading.json`)

```json
{ "fid": "202611078089053-001", "rid": "202611078089053", "tpl": "WENHNGR", "wta": "17:32:30", "wtd": "17:33", "pta": "17:33", "ptd": "17:33",
  "loading": [ { "coachNumber": "A1", "": "32" }, { "coachNumber": "A2", "": "42" }, … ] }
```

- Per-coach percentages, front to rear, as text content (`""`). Same location key as TS; stored as `loc.coachLoading`
  `{ fid, coaches: [{ number, percentage }] }`. Coach numbers are `1`…`9` or unit-and-coach (`A1`…`A4`, `B1`…`B3`).

### `scheduleFormations` (`samples/darwin-scheduleFormations.json`)

```json
{ "rid": "202611076736997",
  "formation": { "fid": "202611076736997-001", "coaches": { "coach": [ { "coachNumber": "1", "coachClass": "Standard" }, … ] } } }
```

- `formation` and `coach` can each be an object or an array. Some coaches also carry `toilet` (`"Standard"`, or
  `{ "status": "NotInService", "": "Accessible" }`), not used. Every one of the 451 coaches seen was `Standard`.
- Schedule locations name the formation that applies there in `fid` (3,850 locations in 2,471 schedules). Stored in
  `darwin_formations` (one row per `fid`) and on the location (`loc.fid`).
- **No formations were seen for the dividing trains**, so coach-level division notes ("front 4 coaches") only appear where
  formations exist; they are tested with synthetic fixtures.

### `OW` station messages (`samples/darwin-OW.json`)

```json
{ "id": "190195", "cat": "Train", "sev": "1", "Station": [ { "crs": "AUR" }, { "crs": "BTS" }, … ],
  "Msg": { "": "Trains running between Edinburgh and Leven / Ladybank may be … Disruptions area of the ",
           "a": { "href": "https://www.nationalrail.co.uk/service-disruptions/aberdour-20261107/", "": "National Rail website." } } }
```

- `cat` (`Train`, `Station`, …), `sev` `"0"`–`"3"` (normal, minor, major, severe), optional `suppress`, `Station` (one object or
  an array) and `Msg`.
- `Msg` is XHTML converted to JSON, so **mixed content loses its order**. Shapes seen: a plain string;
  `{"": "text before ", a: {href, "": "link text"}}`; `{p: {"": ["before ", "after"], a: {…}}}`; `{p: ["para 1", "para 2", ""]}`.
  The parser flattens it to plain text as best it can (text pieces with the child elements between them, in order; paragraphs
  separated by a space; whitespace collapsed) and keeps the first `href` as `url`.
- The same id is **re-sent whenever its station list changes** (145744, "ticket office closed", went from 42 to 47 stations in
  the hour); each update replaces the stored message. **No deletions were seen.** An `OW` without `Station` is treated as a
  removal, and since there's no snapshot and a removal could be missed, messages not restated for 3 days are pruned.

## Open questions

1. **Reference data:** what text goes with `LateReason`/cancel reason codes, and the TOC names. Darwin publishes these in its
   reference files (`*_ref_v*.xml`). Is that file available through the RDM subscription (`DARWIN_REFERENCE_URL`)? If not, the
   standard code list is small and stable enough to bundle.
2. **Daytime message rate and real retention** (see above).
3. **Snapshot:** whether RDM offers a Darwin snapshot (the classic Push Port had one over FTP) for cold starts. Without one, the
   state of a train is built from messages since the worker started, plus the LDBWS backfill.
