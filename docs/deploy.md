# Deploying tracks-server

Everything runs on one Linux server with Docker, using `docker-compose.yml`:

| Service | What it does |
|---|---|
| `caddy` | HTTPS on ports 80/443. It gets and renews a free Let's Encrypt certificate for `DOMAIN` by itself, and forwards requests to the API. |
| `api` | The Express API (not reachable directly, only through Caddy) |
| `worker` | Timetable and station refresh, the Darwin consumer, the journey updater and push (a dry run without an APNs key) |
| `postgres` | The database: about 1 GB, mostly the timetable |
| `migrate` | Runs database migrations before the API and worker start, then exits |
| `backup` | A daily dump of devices and journeys into `./backups` |

**Size:** memory use measured in Docker was about 300 MB, and the daily timetable import adds about 175 MB for 20 s. A server
with 2 GB of RAM is plenty, and 4 GB leaves room. Disk use is about 2 GB plus images and logs (logs rotate at 50 MB per
service).

## 1. Server, once

On the server, as a user who can use `sudo`:

```sh
curl -fsSL https://get.docker.com | sudo sh   # Docker Engine + Compose plugin
sudo usermod -aG docker "$USER"                # then log out and back in
```

- **Firewall:** only 22 (SSH), 80 and 443 need to be open. With a Hetzner Cloud Firewall, allow TCP 22, 80, 443 and
  UDP 443 (HTTP/3).
  - Docker publishes ports past `ufw`, but only Caddy publishes any here. Postgres and the API stay on Docker's
    internal network.
- **Ports 80 and 443 must be free.** If the server already runs a web server (nginx, another Caddy), either stop it or
  put this API behind that server: remove the `caddy` service, publish `api` on `127.0.0.1:3000`, and proxy
  `DOMAIN` to it. Keep `TRUST_PROXY=1`.

## 2. DNS

At the DNS provider for `joshuazacek.com`, add an **A record** for the API's name (for example `tracks-api`) pointing at
the server's IPv4 address. Add an **AAAA** record with its IPv6 address too, if it has one. Caddy can only get a certificate
once the name resolves to the server.

## 3. `.env` on the server

The deploy script never copies `.env`: the server keeps its own. Create `~/tracks-server/.env` (`chmod 600`):

```sh
DOMAIN=tracks-api.joshuazacek.com
POSTGRES_PASSWORD=<run: openssl rand -hex 24>
SCHEDULE_REFRESH_TIME=04:00

# Rail Data Marketplace (same values as the Mac's .env)
RDM_AUTH_HEADER=x-apikey
KB_STATIONS_URL=...
KB_STATIONS_API_KEY=...
DARWIN_KAFKA_BOOTSTRAP=...
DARWIN_KAFKA_TOPIC=prod-1010-Darwin-Train-Information-Push-Port-IIII2_0-JSON
DARWIN_KAFKA_GROUP_ID=...
DARWIN_KAFKA_USERNAME=...
DARWIN_KAFKA_PASSWORD=...
DARWIN_KAFKA_SASL_MECHANISM=plain

# Daily timetable download (see "Timetable" below); leave blank to copy the file by hand
NWR_SCHEDULE_URL=
NWR_SCHEDULE_USERNAME=
NWR_SCHEDULE_PASSWORD=

# Optional push: put AuthKey_XXXXXXXXXX.p8 in ~/tracks-server/secrets/
APNS_KEY_ID=
APNS_TEAM_ID=TYKCDFU4XA
APNS_KEY_PATH=/run/secrets/AuthKey_XXXXXXXXXX.p8
APNS_BUNDLE_ID=com.joshuazacek.TrainTracker
```

`DATABASE_URL`, `DATA_DIR`, `PORT`, `NODE_ENV` and `TRUST_PROXY` are set by the compose file.

> **Only one Darwin consumer per group.** The Darwin consumer group is tied to the RDM subscription. Stop the worker on the
> Mac before starting the one on the server: two consumers in the same group take turns and share one committed position.

## 4. Deploy

From the repository on the Mac:

```sh
deploy/deploy.sh user@server           # copies the code, builds on the server, migrates, (re)starts
```

Run the same command for every update. It sends only what changed, and leaves the server's `.env`, `secrets/` and
`backups/` alone. Each restart is graceful: the API drains its requests, and the worker commits its Darwin position.

## 5. First start

- **Timetable:** the worker imports `/data/CIF_ALL_FULL_DAILY_toc-full.json.gz` at startup and daily at
  `SCHEDULE_REFRESH_TIME` whenever the file is newer than the last import. It downloads the file first if
  `NWR_SCHEDULE_URL` is set. Until a timetable is imported, `/ready` returns 503 `schedule_not_loaded`. To provide the
  file by hand:
  ```sh
  scp CIF_ALL_FULL_DAILY_toc-full.json.gz user@server:
  ssh user@server 'cd tracks-server && docker compose cp ~/CIF_ALL_FULL_DAILY_toc-full.json.gz worker:/data/ && docker compose restart worker'
  ```
- **Stations:** names and coordinates come from Knowledgebase, about 15 minutes the first time, in the background.
- **Darwin:** on first start the worker reads everything the topic still holds, about an hour of messages in the
  daytime.
- **Check:** `https://<DOMAIN>/v1/status` should show `"healthy": true`.

## Timetable

The Network Rail timetable has to be refreshed regularly: short-term changes (engineering works, extra trains) only appear
in newer files. Either:

- **Automatic:** set `NWR_SCHEDULE_URL` (plus `NWR_SCHEDULE_USERNAME`/`PASSWORD` for HTTP Basic auth, or
  `NWR_SCHEDULE_API_KEY` for an `x-apikey` header). The worker downloads it daily and follows redirects.
  - With a free Network Rail Open Data account (subscribed to the SCHEDULE feed for all TOCs), the URL is
    `https://publicdatafeeds.networkrail.co.uk/ntrod/CifFileAuthenticate?type=CIF_ALL_FULL_DAILY&day=toc-full`.
- **By hand:** copy a fresh file as in "First start". It's imported within a day, or straight away after `restart worker`.

## Monitoring

`GET /v1/status` needs no auth. Its top-level `healthy` is false when the timetable is missing, the worker has stopped,
or the Darwin feed has had no messages for 5 minutes.

A free uptime monitor (for example UptimeRobot or Healthchecks.io) can check that URL every few minutes for the text
`"healthy":true` and email you otherwise.

Logs: `docker compose logs -f worker` (or `api`, `caddy`, `backup`).

## Backups

The `backup` service writes `backups/tracks-YYYY-MM-DD.dump` daily and keeps 14 days (`BACKUP_KEEP_DAYS`). A dump holds
devices, journeys and Live Activity registrations; with today's data it's under 1 MB.
- **Left out:** the timetable, Darwin state, the push log and `meta`. The worker rebuilds them by itself.
- **Off-site:** the dumps sit on the same disk. Copy them off now and then (`scp user@server:tracks-server/backups/* .`),
  or turn on Hetzner's server backups (a paid add-on).

Restore into a fresh stack:

```sh
docker compose up -d postgres
docker compose exec -T postgres pg_restore -U tracks -d tracks --clean --if-exists --no-owner < backups/tracks-YYYY-MM-DD.dump
docker compose up -d   # migrations run; the worker re-imports the timetable and catches up on Darwin
```

The same steps move existing data from the Mac to the server. On the Mac, dump the database with the flags in
`deploy/backup.sh`, copy the file to the server, and restore it as above.
