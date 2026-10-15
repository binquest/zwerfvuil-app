#!/usr/bin/env bash
# Base system: all updates, unattended security updates (installed at 04:00,
# reboot at 04:30 only when needed), time zone, guest agent.
. "$(dirname "$0")/lib.sh"

log "apt: update and full-upgrade"
apt-get update -q
apt-get -q -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold full-upgrade
apt-get -q -y install ca-certificates curl gnupg jq unattended-upgrades qemu-guest-agent
apt-get -q -y autoremove --purge

log "unattended-upgrades: Debian security updates only, reboot at 04:30 when needed"
install_file etc/apt/apt.conf.d/20auto-upgrades 644
install_file etc/apt/apt.conf.d/52bq-unattended-upgrades 644
install_file etc/systemd/system/apt-daily.timer.d/10-bq.conf 644
install_file etc/systemd/system/apt-daily-upgrade.timer.d/10-bq.conf 644
systemctl daemon-reload
systemctl enable apt-daily.timer apt-daily-upgrade.timer >/dev/null
systemctl restart apt-daily.timer apt-daily-upgrade.timer
apt-config dump | grep -E '^Unattended-Upgrade::Automatic-Reboot(-Time)? '
systemctl list-timers apt-daily.timer apt-daily-upgrade.timer --no-pager --no-legend

log "time zone: Europe/Brussels"
timedatectl set-timezone Europe/Brussels

log "qemu guest agent"
systemctl start qemu-guest-agent

newest=$(ls /boot/vmlinuz-* | sort -V | tail -1)
if [ "$newest" != "/boot/vmlinuz-$(uname -r)" ]; then
  warn "reboot needed: running kernel $(uname -r), newest installed ${newest#/boot/vmlinuz-}"
fi
log "done"
