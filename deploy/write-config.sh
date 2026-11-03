#!/usr/bin/env bash
# Writes the server's configuration from environment variables (in CI: repository secrets and
# variables) and sends it to the server in one SSH connection:
#   <remote-dir>/.env                               settings for docker compose (mode 600)
#   <remote-dir>/secrets/cloudflare/origin.pem      Cloudflare Origin Certificate  (CF_ORIGIN_CERT)
#   <remote-dir>/secrets/cloudflare/origin-key.pem  its private key                (CF_ORIGIN_KEY)
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
for name in DOMAIN POSTGRES_PASSWORD; do [ -n "${!name:-}" ] || missing+=("$name"); done
if [ "${CADDYFILE:-Caddyfile}" = Caddyfile.cloudflare ]; then
  for name in CF_ORIGIN_CERT CF_ORIGIN_KEY; do [ -n "${!name:-}" ] || missing+=("$name"); done
fi
if [ ${#missing[@]} -gt 0 ]; then
  echo "::error::Missing settings: ${missing[*]} (see docs/deploy.md, \"Configuration\")" >&2
  exit 1
fi

# It goes inside DATABASE_URL, where characters like # @ / : or spaces would break the URL.
if ! [[ "$POSTGRES_PASSWORD" =~ ^[A-Za-z0-9._~-]+$ ]]; then
  echo "::error::POSTGRES_PASSWORD may only contain letters, digits and . _ ~ - (generate one with: openssl rand -hex 24)" >&2
  exit 1
fi

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
for name in DOMAIN CADDYFILE POSTGRES_PASSWORD LOG_LEVEL SCHEDULE_REFRESH_TIME BACKUP_KEEP_DAYS \
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
