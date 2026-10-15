#!/usr/bin/env bash
# Tailscale from the official apt repository. The first run prints a login URL
# that has to be approved in a browser; later runs only re-apply the settings.
#
# --accept-dns=false: keep the LAN's DNS (Pi-hole) instead of MagicDNS.
# --accept-routes=false: the VM is on the LAN itself; it must not route the
#   LAN through the subnet router on the tailnet.
. "$(dirname "$0")/lib.sh"

TAILSCALE_KEY_FPR=2596A99EAAB33821893C0A79458CA832957F5868
TS_FLAGS=(--accept-dns=false --accept-routes=false --hostname=binquest-staging)

codename=$(. /etc/os-release && echo "$VERSION_CODENAME")
log "tailscale apt repository"
fetch_verified_key "https://pkgs.tailscale.com/stable/debian/$codename.noarmor.gpg" \
  /usr/share/keyrings/tailscale-archive-keyring.gpg "$TAILSCALE_KEY_FPR"
list="deb [signed-by=/usr/share/keyrings/tailscale-archive-keyring.gpg] https://pkgs.tailscale.com/stable/debian $codename main"
if [ "$(cat /etc/apt/sources.list.d/tailscale.list 2>/dev/null)" != "$list" ]; then
  echo "$list" >/etc/apt/sources.list.d/tailscale.list
fi
apt-get update -q
apt-get -q -y install tailscale
systemctl enable --now tailscaled >/dev/null

state() { tailscale status --json 2>/dev/null | jq -r '.BackendState'; }

if [ "$(state)" = "Running" ]; then
  tailscale set "${TS_FLAGS[@]}"
  log "tailscale is logged in; settings applied"
else
  # `tailscale up` waits until the login is approved; keep it running in a
  # transient unit and print the login URL it gets.
  systemctl stop bq-tailscale-up.service 2>/dev/null || true
  systemctl reset-failed bq-tailscale-up.service 2>/dev/null || true
  systemd-run --quiet --unit=bq-tailscale-up --collect tailscale up "${TS_FLAGS[@]}"
  url=""
  for _ in $(seq 1 30); do
    url=$(tailscale status --json 2>/dev/null | jq -r '.AuthURL // empty')
    [ -n "$url" ] && break
    sleep 1
  done
  [ -n "$url" ] || die "no login URL after 30s; see: journalctl -u bq-tailscale-up"
  log "approve this node in a browser: $url"
  log "then run 60-tailscale.sh again to check"
  exit 0
fi

tailscale status --self --peers=false
tailscale debug prefs | jq '{CorpDNS, RouteAll, Hostname, ShieldsUp}'
