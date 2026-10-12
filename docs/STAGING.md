# Staging (`binquest-staging`)

Een staging-omgeving die 24/7 draait op de homeserver, zodat we kunnen testen
zonder dat een pc aan staat. De lokale Supabase op de pc blijft de
dev-omgeving.

- Alles wat op de VM gebeurt, staat als script of configbestand in
  `infra/staging/`. Zo kan de VM altijd opnieuw opgebouwd worden.
- Secrets staan alleen op de VM, nooit in git of op de pc.
- Machine-specifieke waarden (IP-adressen, LAN-bereik) staan alleen in
  `infra/staging/.env` (gitignored).

> Dit runbook wordt per fase aangevuld. Nu beschreven: de VM zelf (fase 1).
> Supabase, deployen, backups, de app en het delen van de node volgen.

## Overzicht

| | |
|---|---|
| Host | Proxmox VE op de homeserver; de VM is het enige waar deze scripts aan komen |
| VM | Debian 13, 2 cores, 8 GB RAM (geen ballooning), hostname `binquest-staging` |
| Systeemschijf | 40 GB op `local-lvm` (interne SSD): OS, Docker, later Postgres |
| Dataschijf | 100 GB virtuele schijf op `media1tb-vzdump` (de HDD), Backup uit, gemount op `/srv/bq-data`: later foto's en database-dumps |
| Netwerk | LAN met DHCP-reservatie, plus Tailscale (`binquest-staging` op het tailnet) |
| Toegang | SSH met key, alleen gebruiker `deploy` (sudo zonder wachtwoord) |

## Toegang en scripts

Op de pc staat in `~/.ssh/config` een alias `binquest-staging` (gebruiker
`deploy`, eigen key). Kopieer eenmalig de config voor de scripts:

```powershell
Copy-Item infra\staging\.env.example infra\staging\.env
```

en vul `LAN_CIDR` in (het LAN van de VM, bv. `192.168.1.0/24`).

Scripts voor de VM staan in `infra/staging/vm/` en draaien vanaf de pc met:

```powershell
.venv\Scripts\python infra\staging\stagingctl.py run vm/<script>.sh
.venv\Scripts\python infra\staging\stagingctl.py status
```

`stagingctl.py` kopieert `infra/staging/vm` en `infra/staging/files` naar een
tijdelijke map op de VM, draait het script als root en ruimt daarna op. De
waarden uit `infra/staging/.env` krijgt het script als omgevingsvariabelen.
Alle scripts mogen opnieuw gedraaid worden: ze veranderen alleen wat afwijkt.
`status` toont een overzicht (updates, SSH, firewall, schijven, Docker,
Tailscale, luisterende poorten) en verandert niets.

## De VM opnieuw opbouwen

### In Proxmox (met de hand)

1. **Create VM**: naam `binquest-staging`, Start at boot aan. OS: Debian 13
   netinst-ISO. System: machine q35, SCSI controller VirtIO SCSI single, Qemu
   Agent aan. Disk: scsi0 op `local-lvm`, 40 GB, Discard, IO thread en SSD
   emulation aan. CPU: 2 cores, type `host`. Memory: 8192 MB, Ballooning uit.
   Network: `vmbr0`, VirtIO.
2. **Dataschijf**: Hardware → Add → Hard Disk: scsi1 op `media1tb-vzdump`,
   100 GB, qcow2, Discard en IO thread aan, **Backup uit**.
3. **Debian installeren**: root-wachtwoord leeg laten (dan krijgt de eerste
   gebruiker sudo), gebruiker `deploy` met een sterk wachtwoord (alleen voor de
   Proxmox-console), partitioneren op de schijf van **40 GB**, software alleen
   "SSH server" en "standard system utilities". De 100 GB-schijf blijft leeg.
4. **Key en sudo**: zet de publieke key in `~deploy/.ssh/authorized_keys` en
   maak `/etc/sudoers.d/90-deploy` met `deploy ALL=(ALL) NOPASSWD:ALL`
   (mode 440, controleren met `visudo -cf`).
5. **SSH-alias** in `~/.ssh/config` op de pc, en eenmalig `ssh binquest-staging`
   om de host key te aanvaarden.

### Met de scripts (in deze volgorde)

| Script | Wat |
|---|---|
| `vm/10-base.sh` | Alle updates, unattended-upgrades (alleen Debian-security, geen automatische reboot), tijdzone Europe/Brussels, QEMU guest agent |
| `vm/20-ssh.sh` | Alleen key-login, alleen `deploy`, geen root-login |
| `vm/30-firewall.sh` | nftables-firewall (zie hieronder) |
| `vm/40-datadisk.sh` | Dataschijf formatteren (alleen als ze helemaal leeg is) en mounten |
| `vm/50-docker.sh` | Docker Engine en compose uit de officiële repo van Docker |
| `vm/60-tailscale.sh` | Tailscale uit de officiële repo; de eerste keer toont het een login-URL |

`20-ssh.sh` en `30-firewall.sh` zetten een **rollback** klaar: na 5 minuten
wordt de wijziging teruggedraaid, tenzij je ze bevestigt. Open daarom na het
script een **nieuwe** SSH-sessie (`ssh binquest-staging true`) en bevestig pas
als die werkt:

```powershell
.venv\Scripts\python infra\staging\stagingctl.py run vm/20-ssh.sh confirm
.venv\Scripts\python infra\staging\stagingctl.py run vm/30-firewall.sh confirm
```

Bij `60-tailscale.sh`: open de getoonde URL, keur de node goed in de Tailscale
admin console en draai het script opnieuw om te controleren. Zet in de admin
console ook **key expiry uit** voor deze node.

## Firewall

`/etc/bq/firewall.nft` (uit `infra/staging/files/`) laadt via
`bq-firewall.service` één nftables-tabel, `inet bq_filter`. Inkomend is alles
dicht, behalve:

| Poort | Vanaf | Waarom |
|---|---|---|
| 22/tcp | `LAN_CIDR` | SSH vanaf het LAN. Logins vanaf de pc komen binnen vanaf de router (de Tailscale subnet router doet SNAT); die valt binnen `LAN_CIDR` |
| 22/tcp | `tailscale0` | SSH via het tailnet |
| 443/tcp | `tailscale0` | `tailscale serve` (de API, vanaf fase 2) |
| 41641/udp | overal | directe WireGuard-verbindingen van Tailscale |

- De tabellen van Docker en Tailscale blijven ongemoeid. Een pakket dat deze
  tabel weigert, komt er niet door, ook als Docker of Tailscale het elders
  toelaat.
- **Docker-poorten omzeilen deze firewall** (ze worden naar de container
  ge-DNAT voor de input-hook). Daarom staat in `/etc/docker/daemon.json`
  `"ip": "127.0.0.1"`: een gepubliceerde poort zonder IP luistert alleen lokaal.
  Publiceer nooit een poort op `0.0.0.0`.
- De standaard `nftables.service` is gemaskeerd: stoppen daarvan voert
  `nft flush ruleset` uit en zou ook de regels van Docker en Tailscale wissen.
- Regel aanpassen: wijzig `infra/staging/files/etc/bq/firewall.nft` en draai
  `30-firewall.sh` opnieuw (met rollback en `confirm`).
- Firewall tijdelijk uit (alleen bij problemen, via de Proxmox-console):
  `sudo systemctl stop bq-firewall`.

## Dataschijf

- ext4 met label `bq-data`, in `/etc/fstab` op UUID met `nofail`: de VM start
  ook als de schijf ontbreekt.
- Het lege mountpunt `/srv/bq-data` is immutable (`chattr +i`): zonder schijf
  kan daar niets geschreven worden, dus niets belandt per ongeluk op de
  systeemschijf.
- **Docker start niet zonder de schijf**: een drop-in
  (`docker.service.d/10-bq-data-disk.conf`) vereist de mount en het bestand
  `/srv/bq-data/.bq-data-disk`. Zonder Docker draait ook Supabase niet.
  Getest: schijf losgekoppeld → `Assertion failed on job for docker.service`,
  ook via socket-activatie.
- `40-datadisk.sh` formatteert alleen een schijf zonder partities en zonder
  enige signature, van 90 tot 110 GB, die niet de systeemschijf is. Een
  bestaande `bq-data`-schijf blijft altijd behouden.
- Schijf groter maken: in Proxmox vergroten, daarna op de VM
  `sudo resize2fs /dev/sdb` (er is geen partitietabel).

## Updates

- **Automatisch**: Debian-security-updates (unattended-upgrades, dagelijks).
  Geen automatische reboot.
- **Met de hand**: alle andere updates, Docker en Tailscale:

  ```powershell
  ssh binquest-staging "sudo apt-get update && sudo apt-get -y full-upgrade"
  ```

- `stagingctl.py status` meldt "reboot needed" als er een nieuwere kernel
  geïnstalleerd is dan er draait. Herstarten: `ssh binquest-staging "sudo systemctl reboot"`.
