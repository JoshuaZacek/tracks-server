#!/bin/sh
# Daily backup of what can't be rebuilt: devices, journeys and Live Activity registrations.
# The timetable (schedule schemas), Darwin state, push log and meta are left out (their
# tables are still created on restore): the worker re-imports and re-reads them by itself.
# Checks hourly, writes at most one dump per day, keeps BACKUP_KEEP_DAYS days.
set -eu
keep="${BACKUP_KEEP_DAYS:-14}"
while true; do
  file="/backups/tracks-$(date +%Y-%m-%d).dump"
  if [ ! -f "$file" ]; then
    if pg_dump --dbname="$DATABASE_URL" --format=custom --exclude-schema='schedule*' \
        --exclude-table-data=darwin_services --exclude-table-data=darwin_locations \
        --exclude-table-data=push_log --exclude-table-data=meta \
        --file="$file.part"; then
      mv "$file.part" "$file"
      echo "backup: wrote $file ($(du -h "$file" | cut -f1))"
      find /backups -name 'tracks-*.dump' -mtime +"$keep" -delete
    else
      rm -f "$file.part"
      echo "backup: pg_dump failed; retrying in an hour" >&2
    fi
  fi
  sleep 3600
done
