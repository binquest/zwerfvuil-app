#!/usr/bin/env bash
# SSH: key-only login for deploy, no root login.
#
#   20-ssh.sh           install the config; it is rolled back after 5 minutes
#   20-ssh.sh confirm   keep it (after a new SSH login from the PC worked)
. "$(dirname "$0")/lib.sh"

CONF=etc/ssh/sshd_config.d/10-bq.conf

if [ "${1:-}" = "confirm" ]; then
  disarm_rollback ssh
  exit 0
fi

[ -s /home/deploy/.ssh/authorized_keys ] || die "deploy has no authorized_keys; refusing to disable passwords"

install_file "$CONF" 644
sshd -t || { rm -f "/$CONF"; die "sshd -t failed; config removed"; }
if [ "$CHANGED" = 1 ]; then
  arm_rollback ssh 300 "rm -f /$CONF && systemctl reload ssh"
  systemctl reload ssh
  log "sshd reloaded; open a NEW SSH session, then run: 20-ssh.sh confirm"
fi

sshd -T | grep -Ei '^(authenticationmethods|passwordauthentication|kbdinteractiveauthentication|permitrootlogin|allowusers|allowtcpforwarding) '
