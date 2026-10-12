#!/usr/bin/env bash
# Read-only overview of the VM: system, SSH, firewall, data disk, Docker,
# Tailscale and every listening socket.
. "$(dirname "$0")/lib.sh"
set +e

section() { printf '\n--- %s\n' "$*"; }

section system
. /etc/os-release && echo "$PRETTY_NAME, kernel $(uname -r), up $(uptime -p | sed 's/^up //')"
newest=$(ls /boot/vmlinuz-* | sort -V | tail -1)
[ "$newest" = "/boot/vmlinuz-$(uname -r)" ] || echo "reboot needed for kernel ${newest#/boot/vmlinuz-}"
timedatectl show -p Timezone --value
echo "pending upgrades: $(apt-get -s -q upgrade 2>/dev/null | grep -c '^Inst ')"
systemctl is-active unattended-upgrades apt-daily-upgrade.timer | paste -sd' '
free -h | sed -n 2p

section ssh
sshd -T | grep -Ei '^(authenticationmethods|passwordauthentication|permitrootlogin|allowusers) '

section firewall
systemctl is-enabled bq-firewall.service nftables.service | paste -sd' '
nft list table inet bq_filter
systemctl list-timers --all 'bq-rollback-*' --no-legend

section data disk
findmnt "$BQ_DATA" || echo "NOT MOUNTED"
[ -f "$BQ_DATA_MARKER" ] && echo "marker present" || echo "marker MISSING"
df -h "$BQ_DATA" /

section docker
systemctl is-active docker
command -v docker >/dev/null && docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'

section supabase
if [ -x /usr/local/sbin/bq-compose ]; then
  echo "bq-supabase: $(systemctl is-active bq-supabase.service), upstream $(cut -c1-12 /opt/binquest/compose/SUPABASE_REF 2>/dev/null)"
  bq-compose ps --format 'table {{.Service}}\t{{.Status}}'
  docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}'
  du -sh /opt/binquest/data/db "$BQ_DATA/storage" 2>/dev/null
fi

section tailscale
command -v tailscale >/dev/null && tailscale status --self --peers=false
command -v tailscale >/dev/null && tailscale serve status

section listening sockets
ss -Htlnup | awk '{ print $1, $5, $7 }' | sort -k2
