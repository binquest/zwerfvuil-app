# Shared helpers for the VM scripts. Sourced by every script in vm/.
#
# The scripts run as root on binquest-staging, normally through
# `python infra/staging/stagingctl.py run vm/<script>.sh`, which copies
# infra/staging/ to a temporary directory on the VM first. They can be run
# again at any time: each step checks the current state before changing it.

set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

BQ_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BQ_FILES="$BQ_ROOT/files"
# Mount point of the second virtual disk (photos and backups).
BQ_DATA=/srv/bq-data
BQ_DATA_MARKER="$BQ_DATA/.bq-data-disk"

log() { printf '==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (stagingctl does this with sudo)"

# install_file <path> <mode>: copies files/<path> to /<path>. Sets CHANGED=1
# when the target was created or differs, so callers can reload a service.
CHANGED=0
install_file() {
  local rel="$1" mode="$2"
  local src="$BQ_FILES/$rel" dst="/$rel"
  [ -f "$src" ] || die "missing $src"
  if [ -f "$dst" ] && cmp -s "$src" "$dst" && [ "$(stat -c %a "$dst")" = "$mode" ]; then
    return 0
  fi
  install -D -m "$mode" -o root -g root "$src" "$dst"
  log "wrote $dst"
  CHANGED=1
}

# Safety net for changes that could lock us out: run <command> after
# <seconds> unless disarm_rollback <name> is called first.
arm_rollback() {
  local name="$1" seconds="$2" command="$3"
  disarm_rollback "$name"
  systemd-run --quiet --unit="bq-rollback-$name" --on-active="$seconds" /bin/sh -c "$command"
  log "rollback '$name' armed: runs in ${seconds}s unless confirmed"
}

disarm_rollback() {
  local name="$1"
  if systemctl is-active --quiet "bq-rollback-$name.timer"; then
    systemctl stop "bq-rollback-$name.timer"
    log "rollback '$name' disarmed"
  fi
  systemctl reset-failed "bq-rollback-$name.service" "bq-rollback-$name.timer" 2>/dev/null || true
}

ip_to_int() {
  local IFS=.
  # shellcheck disable=SC2086
  set -- $1
  echo $(( ($1 << 24) + ($2 << 16) + ($3 << 8) + $4 ))
}

# ip_in_cidr <ipv4> <ipv4/len>
ip_in_cidr() {
  local ip net bits mask
  ip=$(ip_to_int "$1")
  net=$(ip_to_int "${2%/*}")
  bits=${2#*/}
  mask=$(( bits == 0 ? 0 : (0xFFFFFFFF << (32 - bits)) & 0xFFFFFFFF ))
  (( (ip & mask) == (net & mask) ))
}

is_ipv4_cidr() {
  [[ "$1" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})/([0-9]{1,2})$ ]] || return 1
  local i
  for i in 1 2 3 4; do (( BASH_REMATCH[i] <= 255 )) || return 1; done
  (( BASH_REMATCH[5] <= 32 ))
}

# Fetches a signing key to <dest> and fails unless its fingerprint is <fpr>.
fetch_verified_key() {
  local url="$1" dest="$2" fpr="$3" tmp actual
  tmp=$(mktemp)
  curl -fsSL "$url" -o "$tmp"
  actual=$(gpg --show-keys --with-colons "$tmp" 2>/dev/null | awk -F: '$1 == "fpr" { print $10; exit }')
  if [ "$actual" != "$fpr" ]; then
    rm -f "$tmp"
    die "unexpected key fingerprint for $url: got '$actual', want '$fpr'"
  fi
  install -D -m 0644 -o root -g root "$tmp" "$dest"
  rm -f "$tmp"
}
