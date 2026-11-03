# Deploying tracks-server

**The production setup:** the Hetzner VPS's own nginx and Postgres, behind Cloudflare's proxy, deployed by GitHub
Actions with all configuration in GitHub secrets.

```
visitor ──HTTPS──▶ Cloudflare ──HTTPS + client cert──▶ nginx (host) ──▶ 127.0.0.1:3000 api ─┐
                                                                                             ├─ Postgres (host, Unix socket)
                                                      worker (Darwin, timetable, push) ──────┤
                                                      backup (daily pg_dump) ────────────────┘
```

| Container | What it does |
|---|---|
| `api` | The Express API, published on `127.0.0.1:${API_PORT}` (3000) only, for nginx |
| `worker` | Timetable and station refresh, the Darwin consumer, the journey updater and push (a dry run without an APNs key) |
| `migrate` | Runs database migrations before the API and worker start, then exits |
| `backup` | A daily dump of devices and journeys into `~/tracks-server/backups` |

**Size:** measured in Docker, about 200 MB of memory for the containers, plus about 175 MB for 20 s during the daily
timetable import. The `tracks` database is about 1 GB, mostly the timetable.

**For hosts without nginx or Postgres:** `docker-compose.caddy.yml` adds a Caddy container for HTTPS
(`REVERSE_PROXY=caddy`), and `docker-compose.postgres.yml` adds a Postgres container (use `POSTGRES_PASSWORD` instead of
`DB_USER`/`DB_PASSWORD`). Both are covered at the end.

## 1. Server, once

`deploy/setup-host.sh` does sections 1–3 in one go: Docker, the database and `pg_hba.conf` line, the certificate, and
the nginx site. Each step checks what's already there, so it's safe to run again. Copy it to the VPS with
`deploy/nginx/tracks-api.conf` and `deploy/cloudflare-origin-pull-ca.pem`, then run
`sudo bash setup-host.sh <deploy-user> <db-user> tracks-api.joshuazacek.com`.

The same steps by hand, on the VPS as a user with `sudo`:

```sh
curl -fsSL https://get.docker.com | sudo sh          # Docker Engine + Compose plugin (skip if installed)
sudo apt-get install -y rsync
sudo adduser --disabled-password --gecos "" deploy   # the user GitHub Actions deploys as
sudo usermod -aG docker deploy                       # membership of "docker" is effectively root: deploys only
```

**Firewall:** nothing new to open. nginx already serves 80/443, and the API only listens on 127.0.0.1.

## 2. Postgres: a `tracks` database

Tracks uses its own database in the host's Postgres, connecting through the **Unix socket**. Postgres doesn't need to
listen on any new address, and nothing depends on Docker's network addresses.

1. **The database**, owned by the user tracks connects as (your existing user):
   ```sh
   sudo -u postgres createdb --owner=<your-db-user> tracks
   ```
2. **Password login on the socket for that user.** Debian and Ubuntu default to `peer`, which checks the OS user name,
   so add one line to `pg_hba.conf` (`sudo -u postgres psql -Atc 'SHOW hba_file'` shows where it is). Put it **above**
   the existing `local all all peer` line, because the first match wins:
   ```
   local   tracks   <your-db-user>   scram-sha-256
   ```
   Then `sudo systemctl reload postgresql`.
   - If login then fails with "password authentication failed" although the password is right, the password is stored
     as MD5. Use `md5` instead of `scram-sha-256` in that line, which accepts both.
3. Check, as any OS user:
   `psql "postgres://<your-db-user>@localhost/tracks?host=/var/run/postgresql" -c 'select 1'`, which asks for the
   password.

Tracks creates its tables on first deploy (`migrate`), and each timetable import swaps a schema inside this database.
Postgres 13 or newer is fine; the backup container's `pg_dump` 18 handles any version.

## 3. nginx and certificates (behind Cloudflare)

The DNS record `tracks-api` is **Proxied** (orange cloud): visitors connect to Cloudflare, and Cloudflare connects to
nginx.

1. **A certificate for `tracks-api.joshuazacek.com`.** If your existing certbot certificate is a wildcard
   (`*.joshuazacek.com`), use it as it is. Otherwise get one for the name. Cloudflare's "Full (strict)" mode accepts any
   publicly trusted certificate:
   ```sh
   sudo certbot certonly --webroot -w /var/www/html -d tracks-api.joshuazacek.com
   ```
   - If that fails because Cloudflare can't yet reach a valid certificate on the server (error 526), issue it once with
     the record set to **DNS only** (grey cloud) or SSL mode **Full**, then switch back.
   - Renewals then work through Cloudflare: the nginx config serves certbot's challenge on both 80 and 443.
2. **The nginx site** (`deploy/nginx/tracks-api.conf` in this repository). It takes the certificate paths, enforces
   Cloudflare's client certificate, and passes the visitor's address to the API:
   ```sh
   cd /home/deploy/tracks-server        # after the first deploy; or copy the two files from the repository
   sudo cp deploy/nginx/tracks-api.conf /etc/nginx/sites-available/
   sudo cp deploy/cloudflare-origin-pull-ca.pem /etc/nginx/
   sudo nano /etc/nginx/sites-available/tracks-api.conf    # certificate paths if not /etc/letsencrypt/live/tracks-api.joshuazacek.com/
   sudo ln -s /etc/nginx/sites-available/tracks-api.conf /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   ```
   - On nginx older than 1.25.1, `nginx -t` rejects `http2 on;`. Follow the comment on that line.
3. **In Cloudflare** (joshuazacek.com → SSL/TLS):
   - **Overview: encryption mode "Full (strict)".** "Flexible" would talk plain HTTP to nginx, which redirects to HTTPS,
     in a loop.
   - **Origin Server → Authenticated Origin Pulls: On.** Cloudflare then presents its client certificate to nginx.
     nginx only accepts requests with it (`cloudflare-origin-pull-ca.pem`, Cloudflare's public CA, valid until 2029),
     so nobody can reach the API around Cloudflare. This setting covers the whole zone. Your other sites behind
     Cloudflare are unaffected unless their own nginx config asks for the certificate.

**Why this matters for rate limits:** only Cloudflare can connect, so its `CF-Connecting-IP` header is the visitor's real
address. nginx passes it as the only `X-Forwarded-For` entry, and the API's per-visitor rate limits use it. Without the
client-certificate check, anyone could send a fake `CF-Connecting-IP` straight to the server.

## 4. Configuration (GitHub secrets)

All configuration lives in GitHub, under Settings → Secrets and variables → Actions:
- **Secrets** for anything sensitive.
- **Variables** (optional) to override the defaults below.

Each deploy runs `deploy/write-config.sh`, which writes them to the server as `~/tracks-server/.env` (mode 600) over SSH.
To change a setting, edit it in GitHub and deploy again.

**Secrets:**

| Secret | Value | |
|---|---|---|
| `DEPLOY_HOST` | the VPS's IP address | required |
| `DEPLOY_USER` | `deploy` | required |
| `DEPLOY_SSH_KEY` | the **private** deploy key, the whole file (see step 5) | required |
| `DEPLOY_KNOWN_HOSTS` | the output of `ssh-keyscan <server-ip>` (pins the server's host key) | required |
| `DB_USER`, `DB_PASSWORD` | your Postgres user and its password (step 2); any characters are fine | required |
| `KB_STATIONS_API_KEY` | from the Mac's `.env` | station names and coordinates |
| `DARWIN_KAFKA_BOOTSTRAP`, `DARWIN_KAFKA_GROUP_ID`, `DARWIN_KAFKA_USERNAME`, `DARWIN_KAFKA_PASSWORD` | from the Mac's `.env` | live data |
| `NWR_SCHEDULE_URL` + `NWR_SCHEDULE_USERNAME`/`NWR_SCHEDULE_PASSWORD` (or `NWR_SCHEDULE_API_KEY`) | see "Timetable" | optional: daily timetable download |
| `APNS_KEY_ID`, `APNS_KEY_P8` | the key's ID, and the whole `.p8` file | optional: push |

**Variables, with their defaults:**

| Variable | Default |
|---|---|
| `DOMAIN` | `tracks-api.joshuazacek.com` |
| `REVERSE_PROXY` | `nginx` (the host's) |
| `API_PORT` | `3000` (change it if something on the VPS already uses 127.0.0.1:3000, and in the nginx site too) |
| `DB_NAME`, `DB_SOCKET_DIR` | `tracks`, `/var/run/postgresql` |
| `DARWIN_KAFKA_TOPIC` | `prod-1010-Darwin-Train-Information-Push-Port-IIII2_0-JSON` |
| `DARWIN_KAFKA_SASL_MECHANISM` | `plain` |
| `KB_STATIONS_URL` | `https://api1.raildata.org.uk/1010-knowlegebase-stations-xml-feed1_1/4.0/station-{CRS}.xml` |
| `RDM_AUTH_HEADER` | `x-apikey` |
| `SCHEDULE_REFRESH_TIME`, `BACKUP_KEEP_DAYS`, `LOG_LEVEL` | `04:00`, `14`, `info` |
| `APNS_TEAM_ID`, `APNS_BUNDLE_ID` | `TYKCDFU4XA`, `com.joshuazacek.TrainTracker` |

`NODE_ENV`, `DATA_DIR`, `PORT` and `TRUST_PROXY` are set by the compose file. `DATABASE_URL` is built from `DB_*`, with
special characters in the password percent-encoded.

> **Only one Darwin consumer per group.** The Darwin consumer group is tied to the RDM subscription. Stop the worker on the
> Mac before the server's starts: two consumers in the same group take turns and share one committed position.

## 5. Deploying with GitHub Actions

`.github/workflows/ci.yml` runs the checks (typecheck, lint, OpenAPI, and the tests against a Postgres container) on every
push and pull request. On a push to `main` that passes:
1. it writes the configuration (`deploy/write-config.sh`)
2. it copies the code over SSH and builds the image on the server (`deploy/deploy.sh`), so there's no image registry
3. it restarts the stack, migrations first; a failed build leaves the running version alone
4. it waits for `https://tracks-api.joshuazacek.com/health`

Until `DEPLOY_HOST` is set, the deploy job is skipped. You can also start it under **Actions → CI → Run workflow**.

**The deploy key**, made on the Mac. The private half goes to GitHub, the public half to the server:

```sh
ssh-keygen -t ed25519 -N "" -C "tracks GitHub Actions deploy" -f ~/.ssh/tracks_deploy
# On the VPS, add the contents of ~/.ssh/tracks_deploy.pub to /home/deploy/.ssh/authorized_keys
pbcopy < ~/.ssh/tracks_deploy        # paste into the DEPLOY_SSH_KEY secret
ssh-keyscan <server-ip>              # paste the output into DEPLOY_KNOWN_HOSTS
```

Optional: under Settings → Environments → `production`, add yourself as a required reviewer to approve each deploy.

**By hand:** `deploy/deploy.sh deploy@<server-ip>` sends just the code, using the configuration from the last CI deploy.

## 6. First start

- **Timetable:** the worker imports `/data/CIF_ALL_FULL_DAILY_toc-full.json.gz` at startup and daily at
  `SCHEDULE_REFRESH_TIME` whenever the file is newer than the last import. It downloads the file first if
  `NWR_SCHEDULE_URL` is set. Until a timetable is imported, `/ready` and the timetable endpoints return 503
  `schedule_not_loaded`. To provide the file by hand:
  ```sh
  scp CIF_ALL_FULL_DAILY_toc-full.json.gz deploy@<server-ip>:
  ssh deploy@<server-ip> 'cd tracks-server && docker compose cp ~/CIF_ALL_FULL_DAILY_toc-full.json.gz worker:/data/ && docker compose restart worker'
  ```
- **Stations:** names and coordinates come from Knowledgebase, about 15 minutes the first time, in the background.
- **Darwin:** on first start the worker reads everything the topic still holds, about an hour of messages in the
  daytime.
- **Check:** `https://tracks-api.joshuazacek.com/v1/status` should show `"healthy": true`.

## Timetable

The Network Rail timetable has to be refreshed regularly: short-term changes (engineering works, extra trains) only appear
in newer files. The worker downloads it from **Network Rail Open Data (NROD)**, which is free:

1. Register at <https://publicdatafeeds.networkrail.co.uk/> (new accounts can take a while to be activated).
2. Under **My Feeds**, subscribe to **SCHEDULE** for **All TOCs**. The daily full extract is part of that subscription.
3. Add the repository secrets and deploy:
   - `NWR_SCHEDULE_URL` = `https://publicdatafeeds.networkrail.co.uk/ntrod/CifFileAuthenticate?type=CIF_ALL_FULL_DAILY&day=toc-full`
   - `NWR_SCHEDULE_USERNAME` = the account's email address
   - `NWR_SCHEDULE_PASSWORD` = its password

**What the worker then does:**
- **When:** downloads at `SCHEDULE_REFRESH_TIME` (04:00 UK) each day, after Network Rail publishes the night's extract,
  and at startup if the imported timetable was generated over 26 hours ago.
- **Credentials:** they go to NROD only. NROD redirects to a pre-signed storage URL, and the credentials aren't sent on
  there.
- **Checks before use:** the file must decompress to the end, start with the timetable header and end with the EOF
  record, and be newer than the one imported. Otherwise the current timetable stays.
- **Failures:** retried hourly, five times. The log says `Refresh: downloaded a new timetable` (with its generation time)
  or why not.
- **Import:** about 20 s, with no interruption to the API (the new timetable is built alongside and swapped in).
- `/v1/status` → `schedule.generatedAt` shows which extract is live.

**By hand instead:** copy a fresh file as in "First start". It's imported within a day, or straight away after
`docker compose restart worker`.

## Monitoring

`GET /v1/status` needs no auth. Its top-level `healthy` is false when the timetable is missing, the worker has stopped,
or the Darwin feed has had no messages for 5 minutes.

A free uptime monitor (for example UptimeRobot or Healthchecks.io) can check that URL every few minutes for the text
`"healthy":true` and email you otherwise.

Logs: `cd ~/tracks-server && docker compose logs -f worker` (or `api`, `backup`).

## Backups

The `backup` container writes `~/tracks-server/backups/tracks-YYYY-MM-DD.dump` daily and keeps 14 days
(`BACKUP_KEEP_DAYS`). A dump holds devices, journeys and Live Activity registrations; with today's data it's under 1 MB.
- **Left out:** the timetable, Darwin state, the push log and `meta`. The worker rebuilds them by itself.
- **Off-site:** the dumps sit on the same disk. Copy them off now and then
  (`scp deploy@<server-ip>:tracks-server/backups/* .`), or turn on Hetzner's server backups (a paid add-on).

Restore (into the `tracks` database, replacing what's there):

```sh
cd ~/tracks-server
docker compose stop api worker
docker compose run --rm -T --entrypoint sh backup -c \
  'pg_restore --dbname="$DATABASE_URL" --clean --if-exists --no-owner /backups/tracks-YYYY-MM-DD.dump'
docker compose up -d   # migrations run; the worker re-imports the timetable and catches up on Darwin
```

## Without the host's nginx or Postgres

- **Caddy instead of nginx:** set the variable `REVERSE_PROXY=caddy`. Caddy then serves 80/443 itself.
  - Direct mode (`CADDYFILE=Caddyfile`, the default): it gets a Let's Encrypt certificate by itself.
  - Behind Cloudflare (`CADDYFILE=Caddyfile.cloudflare`): it uses a Cloudflare Origin Certificate from the secrets
    `CF_ORIGIN_CERT` and `CF_ORIGIN_KEY`, with the same client-certificate check as the nginx site.
- **Bundled Postgres:** leave `DB_USER`/`DB_PASSWORD` unset and set the secret `POSTGRES_PASSWORD`
  (`openssl rand -hex 24`; never change it after the first deploy).
- **Locally:** a `.env` with `COMPOSE_FILE=docker-compose.yml:docker-compose.postgres.yml:docker-compose.caddy.yml`,
  `DOMAIN=localhost`, `POSTGRES_PASSWORD=…` and `DATABASE_URL=postgres://tracks:…@postgres:5432/tracks` runs everything
  in Docker.
