#!/usr/bin/env bash
# One-time host setup for tracks-server on Ubuntu with nginx, Postgres and certbot already in use.
# Run as root, from a directory holding this script, tracks-api.conf and cloudflare-origin-pull-ca.pem:
#
#   sudo bash setup-host.sh <deploy-user> <db-user> <domain>
#
# Safe to run again: each step checks what is already there. It changes, in order:
#   1. Docker Engine installed (if missing); <deploy-user> added to the docker group
#   2. Postgres: database "tracks" owned by <db-user>; one pg_hba.conf line letting <db-user> log in to it with
#      a password over the Unix socket (backup of pg_hba.conf kept; restored if Postgres reports an error)
#   3. certbot: a certificate for <domain>, the same way as the other sites (nginx plugin)
#   4. nginx: the site for <domain> plus Cloudflare's origin-pull CA; checked with nginx -t before reloading
set -euo pipefail
DEPLOY_USER="${1:?usage: sudo bash setup-host.sh <deploy-user> <db-user> <domain>}"
DB_USER="${2:?usage: sudo bash setup-host.sh <deploy-user> <db-user> <domain>}"
DOMAIN="${3:?usage: sudo bash setup-host.sh <deploy-user> <db-user> <domain>}"
DB_NAME=tracks
HERE="$(cd "$(dirname "$0")" && pwd)"
[ "$(id -u)" = 0 ] || { echo "Run it with sudo." >&2; exit 1; }
id "$DEPLOY_USER" >/dev/null
for f in tracks-api.conf cloudflare-origin-pull-ca.pem; do [ -f "$HERE/$f" ] || { echo "Missing $HERE/$f" >&2; exit 1; }; done
grep -q "server_name $DOMAIN;" "$HERE/tracks-api.conf" || { echo "tracks-api.conf is not for $DOMAIN" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }
pg() { sudo -u postgres psql -X -Atq "$@"; }

step "1. Docker"
if command -v docker >/dev/null; then
  echo "Already installed: $(docker --version)"
else
  curl -fsSL https://get.docker.com | sh
fi
usermod -aG docker "$DEPLOY_USER"
echo "$DEPLOY_USER is in the docker group (takes effect on its next login)"
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  echo "ufw is active; nothing to open (the API listens on 127.0.0.1 only)"
fi

step "2. Postgres: database $DB_NAME for $DB_USER"
[ "$(pg -c "SELECT count(*) FROM pg_roles WHERE rolname = '$DB_USER'")" = 1 ] || { echo "No Postgres role $DB_USER" >&2; exit 1; }
case "$(pg -c "SELECT CASE WHEN rolpassword IS NULL THEN 'none' WHEN rolpassword LIKE 'SCRAM-SHA-256%' THEN 'scram' ELSE 'md5' END FROM pg_authid WHERE rolname = '$DB_USER'")" in
  none) echo "Postgres role $DB_USER has no password; set one: sudo -u postgres psql -c '\\password $DB_USER'" >&2; exit 1 ;;
  scram) METHOD=scram-sha-256 ;;
  *) METHOD=md5 ;; # an MD5-stored password can't do SCRAM; md5 also accepts SCRAM ones
esac
if [ "$(pg -c "SELECT count(*) FROM pg_database WHERE datname = '$DB_NAME'")" = 1 ]; then
  echo "Database $DB_NAME already exists (owner: $(pg -c "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '$DB_NAME'"))"
else
  sudo -u postgres createdb --owner="$DB_USER" "$DB_NAME"
  echo "Created database $DB_NAME owned by $DB_USER"
fi

HBA="$(pg -c 'SHOW hba_file')"
if grep -qE "^local[[:space:]]+$DB_NAME[[:space:]]+$DB_USER[[:space:]]" "$HBA"; then
  echo "pg_hba.conf already has a line for $DB_NAME/$DB_USER"
else
  BACKUP="$HBA.before-tracks-$(date +%Y%m%d%H%M%S)"
  cp -a "$HBA" "$BACKUP"
  # Above the first "local" rule, since the first matching line wins (Ubuntu's are "peer").
  awk -v line="local   $DB_NAME   $DB_USER   $METHOD" '
    !done && /^local[[:space:]]/ { print "# tracks-server: password login to its database over the Unix socket"; print line; done = 1 }
    { print }' "$BACKUP" > "$HBA"
  if [ "$(pg -c 'SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL')" != 0 ]; then
    cp -a "$BACKUP" "$HBA"
    echo "Postgres rejected the new pg_hba.conf; restored the original" >&2
    exit 1
  fi
  pg -c 'SELECT pg_reload_conf()' >/dev/null
  echo "Added to $HBA (backup: $BACKUP): local   $DB_NAME   $DB_USER   $METHOD"
fi

step "3. Certificate for $DOMAIN"
if [ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  echo "Already there"
else
  certbot certonly --nginx --non-interactive --agree-tos -d "$DOMAIN"
fi

step "4. nginx site for $DOMAIN"
install -m 644 "$HERE/cloudflare-origin-pull-ca.pem" /etc/nginx/cloudflare-origin-pull-ca.pem
install -m 644 "$HERE/tracks-api.conf" "/etc/nginx/sites-available/$DOMAIN"
ln -sfn "/etc/nginx/sites-available/$DOMAIN" "/etc/nginx/sites-enabled/$DOMAIN"
if ! nginx -t; then
  rm -f "/etc/nginx/sites-enabled/$DOMAIN"
  echo "nginx -t failed: the site was disabled again and nginx was not reloaded" >&2
  exit 1
fi
systemctl reload nginx
echo "Enabled and reloaded"

step "Done"
echo "Next: Cloudflare SSL/TLS 'Full (strict)' + Authenticated Origin Pulls, then the GitHub secrets (docs/deploy.md)."
