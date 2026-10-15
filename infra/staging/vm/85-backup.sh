#!/usr/bin/env bash
# Nightly database dumps (bq-backup.timer, 03:30) to /srv/bq-data/backups/pg,
# kept 7 days. Runs one backup right away, so there is always a recent dump.
. "$(dirname "$0")/lib.sh"

mountpoint -q "$BQ_DATA" && [ -f "$BQ_DATA_MARKER" ] || die "data disk not mounted"
systemctl is-active --quiet bq-supabase.service || die "bq-supabase is not running"

install_file usr/local/sbin/bq-backup 700
install_file etc/systemd/system/bq-backup.service 644
install_file etc/systemd/system/bq-backup.timer 644
systemctl daemon-reload
systemctl enable --now bq-backup.timer >/dev/null

log "running a backup now"
systemctl start bq-backup.service
journalctl -u bq-backup.service --since "-2min" -o cat --no-pager | grep '^bq-backup:' | tail -3
systemctl list-timers bq-backup.timer --no-pager --no-legend
