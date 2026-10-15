#!/usr/bin/env bash
# Docker Engine and the compose plugin from Docker's official apt repository.
# Published ports default to 127.0.0.1 (daemon.json), and Docker requires the
# data disk (docker.service drop-in). Run 40-datadisk.sh first.
. "$(dirname "$0")/lib.sh"

DOCKER_KEY_FPR=9DC858229FC7DD38854AE2D88D81803C0EBFCD88

mountpoint -q "$BQ_DATA" && [ -f "$BQ_DATA_MARKER" ] || die "data disk not mounted; run 40-datadisk.sh first"

# Config first, so the daemon never runs with default settings.
install_file etc/docker/daemon.json 644
install_file etc/systemd/system/docker.service.d/10-bq-data-disk.conf 644
config_changed=$CHANGED

log "docker apt repository"
fetch_verified_key https://download.docker.com/linux/debian/gpg /etc/apt/keyrings/docker.asc "$DOCKER_KEY_FPR"
codename=$(. /etc/os-release && echo "$VERSION_CODENAME")
sources=$(mktemp)
cat >"$sources" <<EOF
# Managed by infra/staging (zwerfvuil-app).
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: $codename
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
EOF
cmp -s "$sources" /etc/apt/sources.list.d/docker.sources || install -m 644 "$sources" /etc/apt/sources.list.d/docker.sources
rm -f "$sources"

apt-get update -q
apt-get -q -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

systemctl daemon-reload
systemctl enable docker.service containerd.service >/dev/null
if [ "$config_changed" = 1 ] && systemctl is-active --quiet docker; then
  systemctl restart docker
else
  systemctl start docker
fi

echo "docker $(docker version --format '{{.Server.Version}}'), $(docker compose version)"
