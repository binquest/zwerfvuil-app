#!/usr/bin/env bash
# Smoke test of the Supabase stack through the gateway on 127.0.0.1:8000.
# Prints only status codes; keys are read from the secrets file and passed to
# curl on stdin, so they never show up in output or in the process list.
# Leaves nothing behind (the storage test bucket is removed again).
. "$(dirname "$0")/lib.sh"

GW=http://127.0.0.1:8000
SECRETS=/opt/binquest/secrets/supabase.env
[ -r "$SECRETS" ] || die "no $SECRETS; run 70-supabase.sh first"
secret() { sed -n "s/^$1=//p" "$SECRETS" | tail -1 | sed "s/^'\(.*\)'$/\1/"; }

failures=0
# check <name> <expected codes, e.g. 200|204> <curl config lines> -- <curl args>
check() {
  local name="$1" expected="$2" config="$3"
  shift 4
  local code
  code=$(printf '%s' "$config" | curl -sS -K - -o /dev/null -w '%{http_code}' "$@" 2>/dev/null || true)
  if [[ "$code" =~ ^($expected)$ ]]; then
    printf '  ok    %-58s %s\n' "$name" "$code"
  else
    printf '  FAIL  %-58s %s (want %s)\n' "$name" "$code" "$expected"
    failures=$((failures + 1))
  fi
}
apikey() { printf 'header = "apikey: %s"\n' "$1"; }
bearer() { printf 'header = "Authorization: Bearer %s"\n' "$1"; }

PUB=$(secret SUPABASE_PUBLISHABLE_KEY)
SEC=$(secret SUPABASE_SECRET_KEY)
ANON=$(secret ANON_KEY)
DASH=$(secret DASHBOARD_PASSWORD)
DASH_USER=$(sed -n 's/^DASHBOARD_USERNAME=//p' /opt/binquest/compose/settings.env)

log "API gateway (Envoy) on $GW"
check "auth health, publishable key"                 200 "$(apikey "$PUB")" -- "$GW/auth/v1/health"
check "auth settings, legacy anon key"               200 "$(apikey "$ANON")" -- "$GW/auth/v1/settings"
check "auth settings, unknown key"                   401 "$(apikey "sb_publishable_wrong")" -- "$GW/auth/v1/settings"
check "auth settings, no key"                        401 "" -- "$GW/auth/v1/settings"
check "rest openapi, secret key"                     200 "$(apikey "$SEC")" -- "$GW/rest/v1/"
check "rest openapi, publishable key (not allowed)"  "401|403" "$(apikey "$PUB")" -- "$GW/rest/v1/"
check "storage bucket list, secret key"              200 "$(apikey "$SEC")" -- "$GW/storage/v1/bucket"
# VERIFY_JWT accepts any valid JWT, also the anon one Envoy mints for the
# publishable key (as on hosted Supabase); submit-checkin checks the user itself.
check "functions, no key and no JWT"                 401 "" -- -X POST "$GW/functions/v1/bq-missing"
check "functions, invalid JWT"                       401 "$(bearer "eyJhbGciOiJIUzI1NiJ9.e30.invalid")" -- -X POST "$GW/functions/v1/bq-missing"
check "functions, publishable key, unknown function" 404 "$(apikey "$PUB")" -- -X POST "$GW/functions/v1/bq-missing"
check "functions, legacy JWT, unknown function"      404 "$(apikey "$PUB"; bearer "$ANON")" -- -X POST "$GW/functions/v1/bq-missing"
check "studio without login"                         401 "" -- "$GW/"
check "studio with dashboard login"                  "200|307|308" "$(printf 'user = "%s:%s"\n' "$DASH_USER" "$DASH")" -- "$GW/"

log "storage writes to the data disk"
bucket="bq-smoke-$(openssl rand -hex 4)"
check "create test bucket"  200 "$(apikey "$SEC")" -- -X POST -H 'Content-Type: application/json' \
  -d "{\"id\":\"$bucket\",\"name\":\"$bucket\",\"public\":false}" "$GW/storage/v1/bucket"
check "upload test object"  200 "$(apikey "$SEC")" -- -X POST -H 'Content-Type: text/plain' \
  --data-binary "smoke $(date -Iseconds)" "$GW/storage/v1/object/$bucket/smoke.txt"
if find "$BQ_DATA/storage" -path "*/$bucket/smoke.txt*" | grep -q .; then
  printf '  ok    %-58s %s\n' "object is stored under $BQ_DATA/storage" "found"
else
  printf '  FAIL  %-58s\n' "object is stored under $BQ_DATA/storage"
  failures=$((failures + 1))
fi
check "download test object" 200 "$(apikey "$SEC")" -- "$GW/storage/v1/object/$bucket/smoke.txt"
check "delete test object"   200 "$(apikey "$SEC")" -- -X DELETE -H 'Content-Type: application/json' \
  -d '{"prefixes":["smoke.txt"]}' "$GW/storage/v1/object/$bucket"
check "delete test bucket"   200 "$(apikey "$SEC")" -- -X DELETE "$GW/storage/v1/bucket/$bucket"

log "database and logs"
if bq-compose exec -T db psql -U postgres -Atc 'select 1' >/dev/null 2>&1; then
  printf '  ok    %-58s\n' "psql in the db container"
else
  printf '  FAIL  %-58s\n' "psql in the db container"
  failures=$((failures + 1))
fi
# Logflare keeps one table per log source (log_events_<source token>).
per_source=$(bq-compose exec -T db psql -U supabase_admin -d _supabase -At -F ' ' -c "
  select s.name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from _analytics.%I',
         'log_events_' || replace(s.token::text, '-', '_')), false, true, '')))[1]::text::int
  from _analytics.sources s
  where to_regclass(format('_analytics.%I', 'log_events_' || replace(s.token::text, '-', '_'))) is not null
  order by 1" 2>/dev/null || true)
if [ -n "$per_source" ]; then
  printf '  ok    %-58s\n' "log events stored by Logflare (per source):"
  echo "$per_source" | sed 's/^/          /'
else
  printf '  FAIL  %-58s\n' "log events stored by Logflare"
  failures=$((failures + 1))
fi

[ "$failures" = 0 ] || die "$failures check(s) failed"
log "all checks passed"
