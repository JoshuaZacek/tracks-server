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
| 4 | Darwin ingest and live status | — |
| 5 | Push: APNs alerts and Live Activities | — |
| 6 | TRUST (optional) | — |
| 7 | Deployment hardening | — |

Every endpoint from the plan already exists with validated input and a documented response. Endpoints whose data arrives in a later phase return `501 not_implemented`.

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

Or with Docker: `docker compose up --build` (Postgres, migrations, API on :3000 and the worker).

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
| GET | `/v1/journeys/{id}/live` | 3 (timetable only); 4 (Darwin) |
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
  domain/                pure logic ported from the PoC (route points, operators, grid conversion)
scripts/                 migrate, generate-openapi, import-schedule, import-stations, build-places, capture-darwin
docs/                    RDM field notes and captured API samples (from the PoC)
test/                    integration tests (supertest + a throwaway Postgres database) and the OpenAPI contract test
```

Adding an endpoint: define it with `defineRoute` in the module's `routes.ts`. Responses are parsed through their schema before sending, so undeclared fields never leak and a contract break fails loudly. For a nullable reference to a named schema, use `orNull(Schema)`, not `.nullable()` (see `src/http/schemas.ts`).

## Checks

```sh
npm run check     # typecheck + lint + OpenAPI up to date + tests
npm test          # needs Postgres; recreates the database in TEST_DATABASE_URL (default tracks_test)
```
