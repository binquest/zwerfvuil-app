#!/usr/bin/env bash
# Publishes the Supabase API on the tailnet: https://<name>.<tailnet>.ts.net
# (HTTPS certificate from Tailscale). Only the API paths the app uses are
# mounted; everything else (Studio on /, /pg, /analytics, /graphql, realtime)
# gets a 404 from tailscale serve and is only reachable through an SSH tunnel.
. "$(dirname "$0")/lib.sh"

GATEWAY=http://127.0.0.1:8000
PATHS=(/auth/v1 /rest/v1 /storage/v1 /functions/v1)

[ "$(tailscale status --json | jq -r .BackendState)" = "Running" ] || die "tailscale is not logged in"
code=$(curl -sS -o /dev/null -w '%{http_code}' "$GATEWAY/" 2>/dev/null || true)
[ -n "$code" ] && [ "$code" != "000" ] || die "the API gateway does not answer on $GATEWAY; run 70-supabase.sh first"

want=$(printf '%s\n' "${PATHS[@]}" | sort)
have=$(tailscale serve status --json | jq -r '.Web // {} | to_entries[] | .value.Handlers // {} | keys[]' | sort)
proxies=$(tailscale serve status --json | jq -r '.Web // {} | to_entries[] | .value.Handlers // {} | to_entries[] | .value.Proxy' | sort -u)
expected_proxies=$(for p in "${PATHS[@]}"; do echo "$GATEWAY$p"; done | sort -u)

if [ "$have" != "$want" ] || [ "$proxies" != "$expected_proxies" ]; then
  log "configuring tailscale serve"
  tailscale serve reset
  for p in "${PATHS[@]}"; do
    # When Serve is not yet enabled for the tailnet, the CLI prints a consent
    # URL and waits; time out and show that URL instead of hanging.
    if ! out=$(timeout 20 tailscale serve --bg --https=443 --set-path="$p" "$GATEWAY$p" </dev/null 2>&1); then
      echo "$out" >&2
      die "tailscale serve failed for $p (if it asks to enable Serve: open the URL, enable it, run this script again)"
    fi
  done
fi
tailscale serve status
