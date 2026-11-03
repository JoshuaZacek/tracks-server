# Darwin Push Port: field notes (Phase 0 spike)

Captured with `npm run capture:darwin` (`scripts/capture-darwin.ts`) on 3 Nov 2026, 01:56–01:59 UK time, from the RDM topic
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
| `serviceLoading` | 107 | Loading % at a location | Not v1 (possible "how busy" later) |
| `association` | 40 | Joins and divides (`NP`/`JJ`/`VV`) | Later: trains that divide |
| `deactivated` | 28 | `{rid}`: the run is finished or removed | Stop tracking |

Expected in the daytime but not seen at night: station messages (`OW`), `formationLoading`, `trainAlert`, `trackingID`, `alarm`.

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
| Messages/s (mean / p95 / max) | 6.2 / 33 / 115 | **to measure** |
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

## Open questions

1. **Reference data:** what text goes with `LateReason`/cancel reason codes, and the TOC names. Darwin publishes these in its
   reference files (`*_ref_v*.xml`). Is that file available through the RDM subscription (`DARWIN_REFERENCE_URL`)? If not, the
   standard code list is small and stable enough to bundle.
2. **Daytime message rate and real retention** (see above).
3. **Snapshot:** whether RDM offers a Darwin snapshot (the classic Push Port had one over FTP) for cold starts. Without one, the
   state of a train is built from messages since the worker started, plus the LDBWS backfill.
