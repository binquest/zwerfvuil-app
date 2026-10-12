#!/usr/bin/env bash
# Installs what `stagingctl.py deploy` ships from supabase/ in the repo:
#   deploy/functions/<name>   edge functions (submit-checkin, _shared)
#   deploy/templates          email templates for Auth (otp-code.html)
#
# - Every shipped function directory replaces the installed one as a whole.
# - The upstream router (functions/main) uses one import map for all
#   functions, functions/deno.jsonc, instead of the deno.json per function used
#   locally. It is rebuilt here: the upstream imports plus those of every
#   function; a name mapped to two different targets is an error.
# - The functions container must run with APP_ENV=staging and without
#   ALLOW_FAKE_LOCATION; the script fails otherwise.
. "$(dirname "$0")/lib.sh"

SRC="$BQ_ROOT/deploy"
BQ=/opt/binquest
FN="$BQ/functions"
UPSTREAM_IMPORTS="$BQ/upstream/docker/volumes/functions/deno.jsonc"
GW=http://127.0.0.1:8000

[ -d "$SRC/functions" ] && [ -d "$SRC/templates" ] || die "nothing to deploy; use: python infra/staging/stagingctl.py deploy"
systemctl is-active --quiet bq-supabase.service || die "bq-supabase is not running; run 70-supabase.sh first"

# --- functions -----------------------------------------------------------------
for dir in "$SRC"/functions/*/; do
  name=$(basename "$dir")
  [[ "$name" =~ ^[a-z0-9_-]+$ ]] && [ "$name" != main ] || die "refusing function directory '$name'"
  tmp=$(mktemp -d "$FN/.deploy-$name.XXXXXX")
  cp -a "$dir." "$tmp/"
  chmod -R u=rwX,go=rX "$tmp"
  chmod 755 "$tmp"
  rm -rf "$FN/.old-$name"
  [ ! -d "$FN/$name" ] || mv "$FN/$name" "$FN/.old-$name"
  mv "$tmp" "$FN/$name"
  rm -rf "$FN/.old-$name"
  log "installed function $name ($(find "$FN/$name" -type f | wc -l) files)"
done

# --- shared import map ---------------------------------------------------------
maps=("$UPSTREAM_IMPORTS")
for f in "$FN"/*/deno.json; do [ "$(dirname "$f")" = "$FN/main" ] || maps+=("$f"); done
jq -e . "${maps[@]}" >/dev/null || die "an import map is not plain JSON: ${maps[*]}"
conflicts=$(jq -rs '[.[].imports // {} | to_entries[]] | group_by(.key)[]
  | select((map(.value) | unique | length) > 1) | .[0].key' "${maps[@]}")
[ -z "$conflicts" ] || die "import map conflict for: $conflicts"
merged=$(mktemp)
jq -s '{imports: (map(.imports // {}) | add)}' "${maps[@]}" >"$merged"
if ! cmp -s "$merged" "$FN/deno.jsonc"; then
  install -m 644 "$merged" "$FN/deno.jsonc"
  log "import map: $(jq -r '.imports | keys | join(", ")' "$FN/deno.jsonc")"
fi
rm -f "$merged"

# --- templates -----------------------------------------------------------------
for f in "$SRC"/templates/*; do
  install -m 644 "$f" "$BQ/templates/$(basename "$f")"
done
log "templates: $(ls "$BQ/templates" | paste -sd' ')"

# --- restart and checks --------------------------------------------------------
bq-compose restart functions >/dev/null 2>&1
bq-compose up --detach --wait --wait-timeout 120 functions mail-templates >/dev/null 2>&1 ||
  die "functions or mail-templates did not become healthy"

env_names=$(docker inspect supabase-edge-functions --format '{{range .Config.Env}}{{println .}}{{end}}' | cut -d= -f1)
app_env=$(docker inspect supabase-edge-functions --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^APP_ENV=//p')
[ "$app_env" = "staging" ] || die "the functions container has APP_ENV='$app_env', expected 'staging'"
! grep -qx ALLOW_FAKE_LOCATION <<<"$env_names" || die "ALLOW_FAKE_LOCATION is set in the functions container"
log "functions container: APP_ENV=staging, no ALLOW_FAKE_LOCATION"

template_ok=$(docker exec supabase-auth wget -qO- http://mail-templates/otp-code.html 2>/dev/null | grep -c '{{ .Token }}' || true)
[ "$template_ok" -ge 1 ] || die "Auth cannot load http://mail-templates/otp-code.html"
log "Auth can load the OTP template"

# Calls submit-checkin without a user session: the function itself must answer
# (401 from its own handler, not a 404 or a boot error from the router).
pub=$(bq-secret SUPABASE_PUBLISHABLE_KEY)
body=$(printf 'header = "apikey: %s"\n' "$pub" | curl -sS -K - -X POST "$GW/functions/v1/submit-checkin" || true)
grep -q '"code":"unauthorized"' <<<"$body" || die "submit-checkin did not answer as expected: $body"
log "submit-checkin is running (answers unauthorized without a session)"
bq-compose logs --since 5m functions 2>&1 | grep -o 'submit-checkin: started ([^)]*)' | tail -1
