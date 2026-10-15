#!/usr/bin/env bash
# Second virtual disk (scsi1, ~100 GB on the Proxmox storage media1tb-vzdump):
# ext4 with label bq-data, mounted on /srv/bq-data via fstab (UUID, nofail).
#
# This formats a disk INSIDE the VM, and only when it is completely empty
# (no partitions, no filesystem signatures). An existing bq-data filesystem
# is kept as is. The physical HDD of the Proxmox host is never visible here.
#
# DATA_DISK overrides the device (default: the Proxmox scsi1 disk).
. "$(dirname "$0")/lib.sh"

DISK="${DATA_DISK:-/dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_drive-scsi1}"
LABEL=bq-data
MIN_BYTES=$(( 90 * 1024 ** 3 ))
MAX_BYTES=$(( 110 * 1024 ** 3 ))

[ -b "$DISK" ] || die "$DISK not found; is the second disk attached as scsi1?"
dev=$(readlink -f "$DISK")
root_disk=$(lsblk -no PKNAME "$(findmnt -no SOURCE /)")
[ "$(basename "$dev")" != "$root_disk" ] || die "$dev holds the root filesystem"
[ "$(lsblk -dno TYPE "$dev")" = "disk" ] || die "$dev is not a whole disk"
size=$(blockdev --getsize64 "$dev")
(( size >= MIN_BYTES && size <= MAX_BYTES )) || die "$dev is $size bytes, expected ~100 GB"

fstype=$(blkid -p -s TYPE -o value "$dev" 2>/dev/null || true)
label=$(blkid -p -s LABEL -o value "$dev" 2>/dev/null || true)
if [ "$fstype" = "ext4" ] && [ "$label" = "$LABEL" ]; then
  log "$dev already has the ext4 filesystem $LABEL; not formatting"
else
  [ "$(lsblk -no NAME "$dev" | wc -l)" = 1 ] || die "$dev has partitions; refusing to format"
  [ -z "$(wipefs --noheadings "$dev")" ] || die "$dev has a filesystem or other signature; refusing to format"
  log "formatting $dev ($(( size / 1024 ** 3 )) GiB) as ext4, label $LABEL"
  # -m 1: 1% reserved blocks instead of 5% (this disk only holds data).
  mkfs.ext4 -q -L "$LABEL" -m 1 "$dev"
fi
uuid=$(blkid -p -s UUID -o value "$dev")
[ -n "$uuid" ] || die "no UUID on $dev"

# The empty mount point is immutable, so nothing can write to the system disk
# under /srv/bq-data while the data disk is not mounted.
mkdir -p "$BQ_DATA"
if ! mountpoint -q "$BQ_DATA"; then
  [ -z "$(ls -A "$BQ_DATA")" ] || die "$BQ_DATA is not mounted but not empty"
  chattr +i "$BQ_DATA"
fi

line="UUID=$uuid $BQ_DATA ext4 defaults,noatime,nofail,x-systemd.device-timeout=30s 0 2"
if ! grep -qxF "$line" /etc/fstab; then
  cp /etc/fstab "/etc/fstab.bak.$(date +%Y%m%d%H%M%S)"
  grep -v "[[:space:]]$BQ_DATA[[:space:]]" /etc/fstab | grep -v '^# bq-data' >/etc/fstab.new || true
  printf '# bq-data: photos and backups (infra/staging/vm/40-datadisk.sh)\n%s\n' "$line" >>/etc/fstab.new
  mv /etc/fstab.new /etc/fstab
  log "fstab: $line"
fi
systemctl daemon-reload

mountpoint -q "$BQ_DATA" || mount "$BQ_DATA"
mountpoint -q "$BQ_DATA" || die "$BQ_DATA did not mount"
[ "$(findmnt -no SOURCE "$BQ_DATA")" = "$dev" ] || die "$BQ_DATA is mounted from an unexpected device"

if [ ! -f "$BQ_DATA_MARKER" ]; then
  printf 'bq-data disk of binquest-staging (uuid %s). Docker refuses to start without this file.\n' "$uuid" >"$BQ_DATA_MARKER"
  log "wrote $BQ_DATA_MARKER"
fi
install -d -m 755 "$BQ_DATA/storage" "$BQ_DATA/backups"

findmnt "$BQ_DATA"
df -h "$BQ_DATA"
