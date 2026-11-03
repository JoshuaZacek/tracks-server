# tracks-server

Backend API for **tracks**, an iOS app for following UK trains. Express 5 + TypeScript on Node 26 (run directly via type stripping, no build step), PostgreSQL via Kysely, zod schemas that generate the OpenAPI document the iOS app is built from.

The implementation plan, including the phases, lives in `~/.claude/plans/this-project-will-contain-jolly-swan.md`. The proof of concept this replaces is in `~/Desktop/UK-Train-Tracker-Project`.

## Status

| Phase | What | State |
|---|---|---|
| 0 | Darwin Push Port spike: format, volume, retention (`docs/darwin-notes.md`) | **done** (daytime rate still to measure) |
| 1 | Foundation + full endpoint structure | **done** |
| 2 | Reference data: schedule, stations, departures, trains, places | **done** |
| 3 | Devices and journeys | **done** |
| 4 | Darwin ingest and live status | **done** |
| 5 | Push: APNs alerts and Live Activities | **done** (sending needs an APNs key; dry run until then) |
| 6 | TRUST (optional) | skipped: Darwin's passing-point reports are enough |
| 7 | Deployment: Docker stack with HTTPS, backups, health | **done** (`docs/deploy.md`) |

Every endpoint from the plan is implemented.

## Running locally

Requires Node 26 and PostgreSQL (14+ works locally; Docker uses 17).

```sh
npm install
cp .env.example .env          # defaults point at postgres://localhost:5432/tracks
createdb tracks
npm run migrate
npm run import:schedule -- path/to/CIF_ALL_FULL_DAILY_toc-full.json.gz   # ~20 s
npm run import:stations       # Knowledgebase names + coordinates, ~15 min the first time (needs KB_STATIONS_*)
npm run dev                   # API on http://localhost:3000
npm run dev:worker            # background worker (separate terminal)
```

The worker re-imports `DATA_DIR/CIF_ALL_FULL_DAILY_toc-full.json.gz` at startup and daily at `SCHEDULE_REFRESH_TIME` whenever the file is newer than the last import (downloading it first if `NWR_SCHEDULE_URL` is set), and refreshes stations older than a week. Imports build a complete copy in a staging schema and swap it in atomically, so the API never sees a half-imported timetable.

`assets/places.json` (OS Open Names, served by `/v1/reference/places`) is committed; rebuild with `npm run build:places` (downloads ~100 MB, needs `unzip`). Contains OS data © Crown copyright and database right.

### Live data (Darwin)

With `DARWIN_KAFKA_*` set, the worker consumes the Darwin Push Port topic: each batch is stored (`darwin_services`, `darwin_locations`), the journeys on the runs it touched are recomputed, and only then are offsets committed, so a restart resumes exactly where it stopped. On first start it reads everything the topic retains (~57k messages, about 20 s). A 30 s clock tick handles time-based changes (`not_found`, arrival by deactivation). The API only reads stored state; `stale` and `nextPollSeconds` are worked out when a status is read. Without Darwin, journeys show timetable data. Format notes: `docs/darwin-notes.md`.

### Push (APNs)

The worker's notifier turns journey changes into APNs alerts and Live Activity updates (`src/push/`). Alerts (platform, delay, cancellation, departed, approaching, arrived) are worked out against what the user has already been told (`journeys.alert_state`), so they fire on real changes only and never repeat after a restart. Live Activities get a content update when a time, platform or state changes (at most one per journey every 15 s, priority 5 for small time changes so they don't use Apple's budget), an `end` event on arrival, cancellation or not_found, and can be started by push-to-start 30 minutes before departure. Dead tokens reported by APNs are forgotten. Every push is recorded in `push_log` (kept 7 days).

Set `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_KEY_PATH` (the `.p8`, outside the repo) and `APNS_BUNDLE_ID` to send. Without them the worker does a **dry run**: it works out every push and records it in `push_log` with outcome `disabled`, which is handy for checking alert rules on real trains.

### Production

Deployed by GitHub Actions (`.github/workflows/ci.yml`) to a VPS: the containers in `docker-compose.yml` (migrations, API
on 127.0.0.1, worker, daily backups), with the host's nginx for HTTPS behind Cloudflare and the host's Postgres over its
Unix socket. Configuration lives in GitHub secrets and is written to the server on each deploy. Setup, monitoring,
backups and restore are in **`docs/deploy.md`**.

Hosts without nginx or Postgres can add `docker-compose.caddy.yml` and `docker-compose.postgres.yml`. With both, the
whole stack runs locally too (see the end of `docs/deploy.md`).

## API

- OpenAPI 3.1: `openapi/openapi.json` (committed) and `GET /v1/openapi.json`. Regenerate with `npm run openapi`.
- Auth: `POST /v1/devices` returns a bearer token once; send `Authorization: Bearer <token>` on everything except `/health`, `/ready`, `/v1/status` and registration.
- Times: ISO 8601 with the UK offset, no fractional seconds (`2026-11-03T17:30:00+00:00`). Dates `YYYY-MM-DD`. Stations as upper-case CRS.
- Errors: `{ "error": { "code", "message", "details"? } }` with a stable `code`; `details` lists invalid fields for `validation_failed`.

| Method | Path | Phase |
|---|---|---|
| GET | `/health`, `/ready`, `/v1/status`, `/v1/openapi.json` | 1 |
| POST | `/v1/devices` | 1 |
| GET / PATCH / DELETE | `/v1/devices/me` | 1 |
| GET | `/v1/stations?q=`, `/v1/stations/nearby`, `/v1/stations/{crs}`, `/v1/stations/{crs}/departures` | 2 |
| GET | `/v1/trains/{uid}/{runDate}` | 2 |
| GET | `/v1/reference/places` | 2 |
| GET / POST | `/v1/journeys` | 3 |
| GET / PATCH / DELETE | `/v1/journeys/{id}` | 3 |
| GET | `/v1/journeys/{id}/live` | 3 (timetable), 4 (Darwin) |
| PUT / DELETE | `/v1/journeys/{id}/live-activity` | 5 |

## Code layout

```
src/
  server.ts  worker.ts  app.ts  routes.ts
  config/env.ts          zod-validated environment
  db/                    Kysely client, table types, migrations (listed in db/migrate.ts)
  http/                  route helper (one definition → Express route + validation + OpenAPI), errors, middleware
  modules/<resource>/    schemas.ts (zod, the API contract) and routes.ts
  ingest/                schedule import (parse → COPY → swap), Knowledgebase stations, daily refresh
  darwin/                Push Port parsing, batched storage, Kafka consumer
  live/                  live status computation (pure), loading, journey updater, tracking loop
  push/                  APNs client (node:http2), alert rules and Live Activity payloads (pure), notifier
  domain/                pure logic ported from the PoC (route points, operators, grid conversion)
scripts/                 migrate, generate-openapi, import-schedule, import-stations, build-places, capture-darwin
deploy/                  write-config.sh, deploy.sh, backup.sh, nginx site, Caddyfiles (see docs/deploy.md)
docs/                    RDM field notes and captured API samples (from the PoC)
test/                    integration tests (supertest + a throwaway Postgres database) and the OpenAPI contract test
```

Adding an endpoint: define it with `defineRoute` in the module's `routes.ts`. Responses are parsed through their schema before sending, so undeclared fields never leak and a contract break fails loudly. For a nullable reference to a named schema, use `orNull(Schema)`, not `.nullable()` (see `src/http/schemas.ts`).

## Checks

```sh
npm run check     # typecheck + lint + OpenAPI up to date + tests
npm test          # needs Postgres; recreates the database in TEST_DATABASE_URL (default tracks_test)
```
