#!/bin/sh
# Copies this checkout to the server and (re)starts the stack there:
#   deploy/deploy.sh user@host [remote-dir]
#
# rsync sends only what changed. The server's own .env, secrets/ and backups/ are never
# touched (they are excluded, so --delete leaves them alone). The image is built on the
# server, so its CPU architecture doesn't matter. Migrations run before the new API starts.
set -eu
HOST="${1:?usage: deploy/deploy.sh user@host [remote-dir]}"
DIR="${2:-tracks-server}"
cd "$(dirname "$0")/.."

rsync -az --delete \
  --include '.env.example' --exclude '.env' --exclude '.env.*' \
  --exclude .git --exclude node_modules --exclude data --exclude backups --exclude secrets --exclude coverage --exclude .DS_Store \
  ./ "$HOST:$DIR/"

ssh "$HOST" "set -e; cd '$DIR'
  test -f .env || { echo 'No .env on the server: see docs/deploy.md'; exit 1; }
  mkdir -p secrets backups
  docker compose up -d --build --remove-orphans
  docker image prune -f >/dev/null
  docker compose ps --format '{{.Service}}: {{.Status}}'"
