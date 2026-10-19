#!/usr/bin/env bash
# Restore test: restores a dump into a throwaway Postgres container (the same
# supabase/postgres image as supabase-db, no network, data in RAM) and compares
# row counts with the live database. The live database is only read.
#
#   check-restore.sh                 the newest dump in /srv/bq-data/backups/pg
#   check-restore.sh <file.dump>     a specific dump
#
# Restoring onto a freshly initialised database of the same image is also how a
# real restore would go (see docs/STAGING.md); pg_restore runs with --clean
# --if-exists, so objects the image already created are replaced by the dump's.
. "$(dirname "$0")/lib.sh"

DIR=/srv/bq-data/backups/pg
dump=${1:-$(ls -1t "$DIR"/postgres-*.dump 2>/dev/null | head -1)}
[ -n "$dump" ] && [ -f "$dump" ] || die "no dump found in $DIR"
(cd "$(dirname "$dump")" && sha256sum -c --quiet "$(basename "$dump").sha256") || die "checksum mismatch for $dump"
log "dump: $(basename "$dump") ($(du -h "$dump" | cut -f1)), checksum ok"

# Tables whose row counts must match. Counted in the live database right after
# the dump would be best; between the nightly dump and this check new rows can
# appear, so the newest dump should be fresh (the script makes one if asked).
TABLES=(public.bins public.profiles public.checkins public.point_transactions public.bin_reports
  public.milestones public.discoveries public.user_milestones private.game_errors public.levels public.avatars
  public.game_config public.event_names public.app_events private.game_config_rules private.app_environment auth.users auth.identities storage.buckets storage.objects supabase_migrations.schema_migrations)

image=$(docker inspect -f '{{.Config.Image}}' supabase-db)
name="bq-restore-test-$(openssl rand -hex 3)"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# Same init scripts as the live database (roles, webhooks, jwt, ... from the
# upstream checkout, mounted into /docker-entrypoint-initdb.d), read-only, and
# the same non-secret settings; a fresh random password. Never the live data dir.
mounts=()
while IFS='|' read -r src dst; do
  [[ "$dst" == /docker-entrypoint-initdb.d/* ]] && mounts+=(-v "$src:$dst:ro")
done < <(docker inspect -f '{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}}|{{.Destination}}{{"\n"}}{{end}}{{end}}' supabase-db)
[ "${#mounts[@]}" -gt 0 ] || die "no init scripts found on supabase-db"
envs=()
while read -r kv; do
  case "${kv%%=*}" in JWT_EXP | POSTGRES_HOST | POSTGRES_PORT | PGPORT | POSTGRES_DB | PGDATABASE) envs+=(-e "$kv") ;; esac
done < <(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' supabase-db)
password=$(openssl rand -hex 16)

log "starting $name ($image, $(( ${#mounts[@]} / 2 )) init scripts, no network, data in RAM)"
docker run -d --name "$name" --network none \
  --mount type=tmpfs,destination=/var/lib/postgresql/data,tmpfs-size=2g \
  "${mounts[@]}" "${envs[@]}" -e POSTGRES_PASSWORD="$password" -e PGPASSWORD="$password" \
  "$image" postgres -c config_file=/etc/postgresql/postgresql.conf >/dev/null
for _ in $(seq 1 90); do
  docker exec "$name" pg_isready -U postgres -h localhost -q 2>/dev/null && break
  sleep 2
done
docker exec "$name" pg_isready -U postgres -h localhost -q || die "the test database did not start"
sleep 5  # the image runs its init scripts before the final start

log "restoring"
started=$(date +%s)
errors=$(docker exec -i "$name" pg_restore -U supabase_admin -d postgres --clean --if-exists <"$dump" 2>&1 >/dev/null || true)
error_count=$(grep -c '^pg_restore: error' <<<"$errors" || true)
log "pg_restore finished in $(( $(date +%s) - started ))s with $error_count error(s)"
[ "$error_count" = 0 ] || grep '^pg_restore: error' <<<"$errors" | head -10 | sed 's/^/    /'

count() { # <container> <table>
  docker exec "$1" psql -U supabase_admin -d postgres -Atc "select count(*) from $2" 2>/dev/null </dev/null || echo "missing"
}
mismatches=0
printf '  %-38s %8s %8s\n' table live restored
for t in "${TABLES[@]}"; do
  live=$(count supabase-db "$t")
  restored=$(count "$name" "$t")
  mark=ok
  [ "$live" = "$restored" ] || { mark=DIFF; mismatches=$((mismatches + 1)); }
  printf '  %-38s %8s %8s  %s\n' "$t" "$live" "$restored" "$mark"
done
env_marker=$(docker exec "$name" psql -U supabase_admin -d postgres -Atc "select name from private.app_environment" </dev/null)
log "restored environment marker: ${env_marker:-none}"

[ "$mismatches" = 0 ] && [ "$error_count" = 0 ] || die "restore test failed ($error_count errors, $mismatches table(s) differ)"
log "restore test passed; $name is removed"
