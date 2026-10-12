#!/usr/bin/env bash
# End-to-end check of login by email code on staging, through the gateway:
#   1. request a code for a throwaway address (<random>@example.test)
#   2. read the mail in Mailpit: subject and template as in supabase/templates
#   3. sign in with the 6-digit code
#   4. with that session, a check-in with fake_location=true must be refused
#   5. delete the test account and its mails again
# Prints statuses only, never the code, the session or a key.
. "$(dirname "$0")/lib.sh"

GW=http://127.0.0.1:8000
MAILPIT=http://127.0.0.1:8025
SUBJECT="Je inlogcode voor Zwerfvuil Gent"
PUB=$(bq-secret SUPABASE_PUBLISHABLE_KEY)
SEC=$(bq-secret SUPABASE_SECRET_KEY)
email="bq-check-$(openssl rand -hex 4)@example.test"
user_id=""
mail_ids="[]"

cleanup() {
  if [ -n "$user_id" ]; then
    printf 'header = "apikey: %s"\nheader = "Authorization: Bearer %s"\n' "$SEC" "$SEC" |
      curl -sS -K - -o /dev/null -X DELETE "$GW/auth/v1/admin/users/$user_id" || true
  fi
  curl -sS -o /dev/null -X DELETE -H 'Content-Type: application/json' \
    -d "{\"IDs\": $mail_ids}" "$MAILPIT/api/v1/messages" || true
}
trap cleanup EXIT
step() { printf '  %-52s %s\n' "$1" "$2"; }

log "login by email code for a throwaway account"
code=$(printf 'header = "apikey: %s"\n' "$PUB" | curl -sS -K - -o /dev/null -w '%{http_code}' -X POST \
  -H 'Content-Type: application/json' -d "{\"email\":\"$email\",\"create_user\":true}" "$GW/auth/v1/otp")
step "request code (POST /auth/v1/otp)" "$code"
[ "$code" = 200 ] || die "requesting a code failed"

msg=""
for _ in $(seq 1 20); do
  msg=$(curl -sS "$MAILPIT/api/v1/search?query=to:%22$email%22" | jq -r '.messages[0].ID // empty')
  [ -n "$msg" ] && break
  sleep 1
done
[ -n "$msg" ] || die "no mail for the test address in Mailpit"
mail_ids=$(jq -cn --arg id "$msg" '[$id]')
mail=$(curl -sS "$MAILPIT/api/v1/message/$msg")
subject=$(jq -r .Subject <<<"$mail")
step "mail arrived in Mailpit, subject" "$([ "$subject" = "$SUBJECT" ] && echo ok || echo "WRONG: $subject")"
[ "$subject" = "$SUBJECT" ] || die "unexpected subject"
grep -q 'Je inlogcode' <<<"$(jq -r .HTML <<<"$mail")" || die "the mail does not use supabase/templates/otp-code.html"
otp=$(jq -r .Text <<<"$mail" | grep -oE '\b[0-9]{6}\b' | head -1)
step "template otp-code.html with a 6-digit code" "$([ -n "$otp" ] && echo ok || echo MISSING)"
[ -n "$otp" ] || die "no 6-digit code in the mail"

session=$(printf 'header = "apikey: %s"\n' "$PUB" | curl -sS -K - -X POST -H 'Content-Type: application/json' \
  -d "{\"type\":\"email\",\"email\":\"$email\",\"token\":\"$otp\"}" "$GW/auth/v1/verify")
token=$(jq -r '.access_token // empty' <<<"$session")
user_id=$(jq -r '.user.id // empty' <<<"$session")
step "sign in with the code (POST /auth/v1/verify)" "$([ -n "$token" ] && echo "ok, session for a new user" || echo FAILED)"
[ -n "$token" ] || die "verifying the code failed"

log "submit-checkin with that session"
response=$(printf 'header = "apikey: %s"\nheader = "Authorization: Bearer %s"\n' "$PUB" "$token" |
  curl -sS -K - -w '\n%{http_code}' -X POST -F bin_id=1 -F lat=51.0523 -F lon=3.7169 -F accuracy_m=5 \
    -F is_mocked=false -F fake_location=true "$GW/functions/v1/submit-checkin")
status=$(tail -1 <<<"$response")
reason=$(head -n -1 <<<"$response" | jq -r '.error.code // empty')
step "fake_location=true" "$status $reason"
[ "$status" = 403 ] && [ "$reason" = fake_location_not_allowed ] || die "a fake location was not refused"

log "all auth checks passed (test account and mail are removed)"
