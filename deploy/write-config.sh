#!/usr/bin/env bash
# Writes the server's configuration from environment variables (in CI: repository secrets and
# variables) and sends it to the server in one SSH connection.
#
# Database: with DB_USER/DB_PASSWORD, the host's own Postgres over its Unix socket (database
# DB_NAME, default tracks; socket directory DB_SOCKET_DIR, default /var/run/postgresql). Without
# them, the bundled Postgres container (docker-compose.postgres.yml) with POSTGRES_PASSWORD.
#
# HTTPS: REVERSE_PROXY=nginx (default) leaves it to the host's web server (deploy/nginx/), with
# the API on 127.0.0.1:API_PORT; REVERSE_PROXY=caddy adds the bundled Caddy (docker-compose.caddy.yml).
#
# Files written:
#   <remote-dir>/.env                               settings for docker compose (mode 600)
#   <remote-dir>/secrets/cloudflare/origin.pem      Cloudflare Origin Certificate, if CF_ORIGIN_CERT is set
#   <remote-dir>/secrets/cloudflare/origin-key.pem  its private key (CF_ORIGIN_KEY); only bundled Caddy uses these
#   <remote-dir>/secrets/AuthKey.p8                 APNs key, if APNS_KEY_P8 is set
#
#   deploy/write-config.sh user@host [remote-dir]
#
# Every deploy rewrites these, so GitHub stays the single source of truth. Values are written
# single-quoted, which docker compose reads literally (no $ expansion, # is not a comment).
set -euo pipefail
HOST="${1:?usage: deploy/write-config.sh user@host [remote-dir]}"
DIR="${2:-tracks-server}"

missing=()
[ -n "${DOMAIN:-}" ] || missing+=(DOMAIN)
if [ -z "${DB_USER:-}" ] && [ -z "${POSTGRES_PASSWORD:-}" ]; then missing+=("DB_USER and DB_PASSWORD (or POSTGRES_PASSWORD)"); fi
if [ -n "${DB_USER:-}" ] && [ -z "${DB_PASSWORD:-}" ]; then missing+=(DB_PASSWORD); fi
REVERSE_PROXY="${REVERSE_PROXY:-nginx}"
case "$REVERSE_PROXY" in nginx | caddy) ;; *) echo "::error::REVERSE_PROXY must be nginx or caddy" >&2; exit 1 ;; esac
if [ "$REVERSE_PROXY" = caddy ] && [ "${CADDYFILE:-Caddyfile}" = Caddyfile.cloudflare ]; then
  for name in CF_ORIGIN_CERT CF_ORIGIN_KEY; do [ -n "${!name:-}" ] || missing+=("$name"); done
fi
if [ ${#missing[@]} -gt 0 ]; then
  echo "::error::Missing settings: ${missing[*]} (see docs/deploy.md, \"Configuration\")" >&2
  exit 1
fi

uri() { jq -rn --arg v "$1" '$v|@uri'; } # percent-encodes, so any password works in the URL
DB_NAME="${DB_NAME:-tracks}"
DB_SOCKET_DIR="${DB_SOCKET_DIR:-/var/run/postgresql}"
if [ -n "${DB_USER:-}" ]; then
  DATABASE_URL="postgres://$(uri "$DB_USER"):$(uri "$DB_PASSWORD")@localhost/$(uri "$DB_NAME")?host=/var/run/postgresql" # the host parameter (the socket) overrides "localhost"
  COMPOSE_FILE=docker-compose.yml
  POSTGRES_PASSWORD=''
else
  DATABASE_URL="postgres://tracks:$(uri "$POSTGRES_PASSWORD")@postgres:5432/tracks"
  COMPOSE_FILE=docker-compose.yml:docker-compose.postgres.yml
fi
[ "$REVERSE_PROXY" = caddy ] && COMPOSE_FILE="$COMPOSE_FILE:docker-compose.caddy.yml"
API_PORT="${API_PORT:-3000}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
umask 077
mkdir -p "$work/secrets/cloudflare"

env_file="$work/.env"
: > "$env_file"
put() {
  local name="$1" value="${!1:-}"
  case "$value" in
    *"'"* | *$'\n'*) echo "::error::$name contains a single quote or a line break, which .env can't hold" >&2; exit 1 ;;
  esac
  printf "%s='%s'\n" "$name" "$value" >> "$env_file"
}
for name in COMPOSE_FILE DOMAIN API_PORT CADDYFILE DATABASE_URL DB_SOCKET_DIR POSTGRES_PASSWORD LOG_LEVEL SCHEDULE_REFRESH_TIME BACKUP_KEEP_DAYS \
  RDM_AUTH_HEADER KB_STATIONS_URL KB_STATIONS_API_KEY \
  NWR_SCHEDULE_URL NWR_SCHEDULE_API_KEY NWR_SCHEDULE_USERNAME NWR_SCHEDULE_PASSWORD \
  DARWIN_KAFKA_BOOTSTRAP DARWIN_KAFKA_TOPIC DARWIN_KAFKA_GROUP_ID DARWIN_KAFKA_USERNAME DARWIN_KAFKA_PASSWORD \
  DARWIN_KAFKA_SASL_MECHANISM APNS_TEAM_ID APNS_BUNDLE_ID; do
  put "$name"
done

files=(.env)
if [ -n "${CF_ORIGIN_CERT:-}" ]; then
  printf '%s\n' "$CF_ORIGIN_CERT" > "$work/secrets/cloudflare/origin.pem"
  printf '%s\n' "$CF_ORIGIN_KEY" > "$work/secrets/cloudflare/origin-key.pem"
  chmod 644 "$work/secrets/cloudflare/origin.pem" # the key stays 600: Caddy's container reads it as root
  files+=(secrets/cloudflare/origin.pem secrets/cloudflare/origin-key.pem)
fi
if [ -n "${APNS_KEY_P8:-}" ]; then
  printf '%s\n' "$APNS_KEY_P8" > "$work/secrets/AuthKey.p8"
  # The worker runs as the image's `node` user, whose uid needn't match the deploy user's.
  chmod 644 "$work/secrets/AuthKey.p8"
  files+=(secrets/AuthKey.p8)
  APNS_KEY_PATH=/run/secrets/AuthKey.p8
else
  APNS_KEY_PATH=''
fi
put APNS_KEY_ID
put APNS_KEY_PATH

tar -C "$work" -cf - "${files[@]}" | ssh "$HOST" "mkdir -p '$DIR' && tar -C '$DIR' -xpf - && echo 'Configuration written: ${files[*]}'"
