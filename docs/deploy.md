# Deploying tracks-server

Everything runs on one Linux server with Docker, using `docker-compose.yml`:

| Service | What it does |
|---|---|
| `caddy` | HTTPS on ports 80/443, forwarding to the API. The certificate is Let's Encrypt's (automatic) or, behind Cloudflare, a Cloudflare Origin Certificate. |
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

## 2. DNS and certificates

Add an **A record** for the API's name (`tracks-api`) pointing at the server's IPv4 address. Then choose one of the two
modes below.

### Direct (DNS only): `CADDYFILE=Caddyfile`, the default

The record is **DNS only** (grey cloud in Cloudflare). Clients connect straight to the server, and Caddy gets a Let's
Encrypt certificate by itself once the name resolves to the server. Ports 80 and 443 must be open to everyone.

### Cloudflare: `CADDYFILE=Caddyfile.cloudflare`

The record is **Proxied** (orange cloud): clients connect to Cloudflare, and Cloudflare connects to the server. Set up in
the Cloudflare dashboard for `joshuazacek.com`, in this order:

1. **SSL/TLS → Origin Server → Create Certificate.** Use the defaults ("Generate private key and CSR with Cloudflare",
   15 years) with the hostname `tracks-api.joshuazacek.com`. Save the two texts it shows, on the server:
   - "Origin Certificate" → `~/tracks-server/secrets/cloudflare/origin.pem`
   - "Private Key" → `~/tracks-server/secrets/cloudflare/origin-key.pem`
   - The private key is shown only once. Keep both files `chmod 644` and owned by `deploy`: Caddy's container must be
     able to read them, and nothing outside the server ever sees them.
2. **SSL/TLS → Overview: encryption mode "Full (strict)".** "Flexible" would talk plain HTTP to the server, which
   redirects to HTTPS, in a loop.
3. **SSL/TLS → Origin Server → Authenticated Origin Pulls: On.** Cloudflare then presents its client certificate to the
   server. Caddy only accepts connections with that certificate (`deploy/cloudflare-origin-pull-ca.pem`, Cloudflare's
   public CA, valid until 2029), so nobody can reach the server around Cloudflare.
   - Turn this on **before** deploying: with it off, Cloudflare's requests are refused (error 525/526).
4. In the server's `.env`, set `CADDYFILE=Caddyfile.cloudflare`.

**What this gives you:**
- **Visitors' addresses:** Caddy passes the visitor's address from Cloudflare's `CF-Connecting-IP` header to the API.
  That's safe only because nothing but Cloudflare can connect, and it means rate limits apply per visitor, not per
  Cloudflare server.
- **Firewall:** only 443 needs to be open, though 80 does no harm (Caddy just redirects).
- **HTTP/3:** visitors get HTTP/3 from Cloudflare.

## 3. `.env` on the server

The deploy script never copies `.env`: the server keeps its own. Create `~/tracks-server/.env` (`chmod 600`):

```sh
DOMAIN=tracks-api.joshuazacek.com
CADDYFILE=Caddyfile.cloudflare        # or Caddyfile for DNS only (see step 2)
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

## 4. Deploy with GitHub Actions

`.github/workflows/ci.yml` runs the checks (typecheck, lint, OpenAPI, the tests against a Postgres container) on every
push and pull request. On a push to `main` that passes, it deploys with `deploy/deploy.sh`: it copies the code over SSH,
builds the image on the server and restarts the stack (migrations first). A failed build leaves the running version
alone. The job then waits for `https://tracks-api.joshuazacek.com/health`. You can also start it by hand under
**Actions → CI → Run workflow**.

### One-time setup

1. **A deploy user on the server**, allowed to run Docker. Membership of the `docker` group is effectively root, so
   keep this key for deploys only.
   ```sh
   sudo adduser --disabled-password --gecos "" deploy
   sudo usermod -aG docker deploy
   sudo apt-get install -y rsync
   ```
2. **A key pair just for deploys**, made on the Mac. The private half goes to GitHub, the public half to the server.
   ```sh
   ssh-keygen -t ed25519 -N "" -C "tracks GitHub Actions deploy" -f ~/.ssh/tracks_deploy
   ssh-copy-id -i ~/.ssh/tracks_deploy.pub deploy@<server-ip>   # or append it to ~deploy/.ssh/authorized_keys
   ```
3. **The `.env` from step 3**, at `/home/deploy/tracks-server/.env`, owned by `deploy`, `chmod 600`.
4. **Repository secrets**: in GitHub under Settings → Secrets and variables → Actions, or with the `gh` CLI:
   ```sh
   gh secret set DEPLOY_HOST --body "<server-ip>"
   gh secret set DEPLOY_USER --body "deploy"
   gh secret set DEPLOY_SSH_KEY < ~/.ssh/tracks_deploy
   ssh-keyscan <server-ip> | gh secret set DEPLOY_KNOWN_HOSTS
   ```
   `DEPLOY_KNOWN_HOSTS` pins the server's host key, so the workflow refuses to talk to anything else at that address.
5. Optional: under Settings → Environments → `production`, add yourself as a required reviewer to approve each deploy.

### By hand

The same script works from the Mac with your own SSH access: `deploy/deploy.sh deploy@<server-ip>`. It sends only what
changed, and leaves the server's `.env`, `secrets/` and `backups/` alone. Each restart is graceful: the API drains its
requests, and the worker commits its Darwin position.

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
