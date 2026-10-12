#!/usr/bin/env bash
# Proves that submit-checkin cannot run on staging with ALLOW_FAKE_LOCATION:
# starts a throwaway copy of the functions container with the setting added
# ("true" and "false"), calls the function, and expects the router to report
# that the function failed to start. The real functions container is not touched.
. "$(dirname "$0")/lib.sh"

ANON=$(bq-secret ANON_KEY)
failures=0
for value in true false; do
  name="bq-fake-test-$(openssl rand -hex 3)"
  bq-compose run --rm --detach --no-deps --name "$name" -e "ALLOW_FAKE_LOCATION=$value" functions >/dev/null
  for _ in $(seq 1 30); do
    docker exec "$name" bash -c '</dev/tcp/127.0.0.1/9000' 2>/dev/null && break
    sleep 1
  done
  # Called from another container on the same network (busybox wget).
  body=$(docker exec supabase-mail-templates wget -qO- --post-data='' \
    --header "Authorization: Bearer $ANON" "http://$name:9000/submit-checkin" 2>&1 || true)
  sleep 1
  refused=$(docker logs "$name" 2>&1 | grep -c "ALLOW_FAKE_LOCATION must not be set when APP_ENV=staging" || true)
  docker rm -f "$name" >/dev/null 2>&1 || true
  if [ "$refused" -ge 1 ]; then
    printf '  ok    ALLOW_FAKE_LOCATION=%-6s the function refuses to start\n' "$value"
  else
    printf '  FAIL  ALLOW_FAKE_LOCATION=%-6s response: %s\n' "$value" "$(head -c 200 <<<"$body")"
    failures=$((failures + 1))
  fi
done
[ "$failures" = 0 ] || die "the function started with ALLOW_FAKE_LOCATION set"
log "submit-checkin refuses ALLOW_FAKE_LOCATION on staging, whatever its value"
