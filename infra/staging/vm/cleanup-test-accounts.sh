#!/usr/bin/env bash
# Deletes the throwaway accounts that checks and tests create on staging: only
# addresses ending in @example.test (a reserved domain, never a real user),
# through the Auth admin API, so their profiles and data go with them.
# Prints counts only.
. "$(dirname "$0")/lib.sh"

GW=http://127.0.0.1:8000
SEC=$(bq-secret SUPABASE_SECRET_KEY)
psql_q() { bq-compose exec -T db psql -U postgres -Atc "$1" </dev/null; }

ids=$(psql_q "select id from auth.users where email like '%@example.test'")
deleted=0
for id in $ids; do
  code=$(printf 'header = "apikey: %s"\nheader = "Authorization: Bearer %s"\n' "$SEC" "$SEC" |
    curl -sS -K - -o /dev/null -w '%{http_code}' -X DELETE "$GW/auth/v1/admin/users/$id")
  [ "$code" = 200 ] || die "deleting a test account failed: HTTP $code"
  deleted=$((deleted + 1))
done
left=$(psql_q "select count(*) from auth.users where email like '%@example.test'")
orphans=$(psql_q "select count(*) from public.profiles p left join auth.users u on u.id = p.id where u.id is null")
log "test accounts deleted: $deleted, left: $left, profiles without account: $orphans"
[ "$left" = 0 ] && [ "$orphans" = 0 ] || die "cleanup incomplete"
