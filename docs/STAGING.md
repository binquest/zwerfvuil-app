# Staging (`binquest-staging`)

Een staging-omgeving die 24/7 draait op de homeserver, zodat we kunnen testen
zonder dat een pc aan staat. De lokale Supabase op de pc blijft de
dev-omgeving.

- Alles wat op de VM gebeurt, staat als script of configbestand in
  `infra/staging/`. Zo kan de VM altijd opnieuw opgebouwd worden.
- Secrets staan alleen op de VM, nooit in git of op de pc.
- Machine-specifieke waarden (IP-adressen, LAN-bereik) staan alleen in
  `infra/staging/.env` (gitignored).

> Dit runbook wordt per fase aangevuld. Nu beschreven: de VM zelf (fase 1),
> Supabase (fase 2), deployen (fase 3), backups (fase 4), het staging-profiel van
> de app en de IPA-build (fase 5). Het delen van de node wordt in fase 6 getest.

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
| `vm/70-supabase.sh` | Supabase self-hosted: upstream ophalen, secrets genereren (alleen de eerste keer), images, `bq-supabase.service` starten |
| `vm/75-tailscale-serve.sh` | De API publiceren op het tailnet via `tailscale serve` |
| `vm/check-supabase.sh` | Smoketest van de stack (alleen lezen, ruimt zijn testbucket op) |
| `vm/80-deploy.sh` | Edge functions en e-mailtemplates installeren (via `stagingctl.py deploy`) |
| `vm/check-auth.sh` | Login met code via Mailpit en weigering van een nep-locatie (ruimt zijn testaccount op) |
| `vm/check-fake-location.sh` | Bewijst dat `submit-checkin` niet start met `ALLOW_FAKE_LOCATION` |
| `vm/cleanup-test-accounts.sh` | Verwijdert testaccounts (`…@example.test`) via de Auth admin-API |
| `vm/85-backup.sh` | Nachtelijke database-dump (`bq-backup.timer`) installeren en meteen één backup maken |
| `vm/check-restore.sh` | Restore-test van de nieuwste dump in een wegwerpcontainer |

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
| 22/tcp | `LAN_CIDR`, niet via `tailscale0` | SSH, alleen vanaf het LAN. Van buitenaf kom je binnen via de Tailscale subnet router: die doet SNAT naar zijn eigen LAN-adres, dat binnen `LAN_CIDR` valt |
| 443/tcp | `tailscale0` | `tailscale serve` (de API, vanaf fase 2) |
| 41641/udp | overal | directe WireGuard-verbindingen van Tailscale (die komen binnen op de LAN-interface, niet op `tailscale0`) |

- SSH via het Tailscale-IP van de VM werkt dus **niet**, ook niet voor jezelf.
  Zo kan iemand met wie de node gedeeld is nooit aan SSH. Gebruik het LAN-IP
  (de alias `binquest-staging`).
- De tabellen van Docker en Tailscale blijven ongemoeid. Een pakket dat deze
  tabel weigert, komt er niet door, ook als Docker of Tailscale het elders
  toelaat. Dat is nodig: Tailscale zet in zijn eigen chain
  `iifname "tailscale0" accept`. Getest: via het Tailscale-IP zijn 22 en een
  testpoort dicht en is alleen 443 bereikbaar.
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

## Supabase

De officiële self-hosted setup (`docker/` uit
[supabase/supabase](https://github.com/supabase/supabase)), niet `supabase start`.
Vastgepind op de commit in `infra/staging/files/opt/binquest/compose/SUPABASE_REF`:
nu `ff80bb1` (30 september 2026, de laatste commit op `docker/`, na release
0.8.2). De upstream-bestanden worden nooit aangepast; al onze wijzigingen staan
in `docker-compose.bq.yml`.

### Op de VM

| Pad | Wat |
|---|---|
| `/opt/binquest/upstream` | sparse checkout van `supabase/supabase` (alleen `docker/`), op `SUPABASE_REF` |
| `/opt/binquest/compose` | `docker-compose.bq.yml`, `settings.env` (zonder secrets), `host.env` (de ts.net-URL), `SUPABASE_REF` |
| `/opt/binquest/secrets/supabase.env` | alle secrets (root, chmod 600) |
| `/opt/binquest/data/db` | Postgres-data (systeemschijf) |
| `/opt/binquest/functions` | edge functions: de upstream-router `main` plus onze functies |
| `/srv/bq-data/storage` | Storage: de foto's (dataschijf) |
| `/usr/local/sbin/bq-compose` | `docker compose` met alle bestanden en env-files hierboven |

`bq-supabase.service` start de stack (en wacht tot alles gezond is), en vereist,
net als Docker, de dataschijf. Getest: zonder schijf faalt de start; na een reboot
start alles vanzelf.

### Services

| Service | | Waarom |
|---|---|---|
| db, auth, rest, storage, functions | aan | de app gebruikt ze |
| api-gw (Envoy) | aan | de API-gateway; upstream gebruikt sinds kort Envoy in plaats van Kong |
| studio, meta | aan | Studio (meta is de database-API van Studio) |
| analytics (Logflare), vector | aan | logs in Studio; ze staan in de database `_supabase` |
| realtime | **uit** | de app gebruikt geen realtime-kanalen |
| imgproxy | **uit** | geen beeldtransformaties, alleen signed URL's naar de originele foto |
| supavisor (pooler) | **uit** | geen connection pooling nodig; Postgres staat rechtstreeks op `127.0.0.1:5432` |

Samen gebruiken ze ongeveer 1,5 GB RAM (Logflare ~0,5 GB).

### API-keys

Zoals bij de lokale Supabase CLI zijn de nieuwe keys actief: `sb_publishable_…`
(voor de app) en `sb_secret_…` (server en scripts). Envoy vertaalt ze naar
ES256-JWT's. De oude anon- en service-role-JWT's (HS256) werken ook; de edge
functions gebruiken `SUPABASE_SERVICE_ROLE_KEY`. Auth tekent sessies met de
ES256-key; de andere services controleren met `JWT_JWKS`.

### Bereikbaarheid

| Wat | Waar | Voor wie |
|---|---|---|
| API | `https://binquest-staging.<tailnet>.ts.net`, alleen `/auth/v1`, `/rest/v1`, `/storage/v1`, `/functions/v1` | het tailnet (en later wie de node gedeeld krijgt) |
| Studio en logs | `http://localhost:58000` via de tunnel, gebruiker `binquest` | alleen via SSH |
| Postgres | `localhost:55432` via de tunnel, gebruiker `postgres` | alleen via SSH |
| Mailpit (inlogcodes) | `http://localhost:58025` via de tunnel | alleen via SSH |

Alle andere paden (Studio op `/`, `/pg`, `/analytics`, `/graphql`, realtime) geven
via het tailnet 404. Docker publiceert alleen `127.0.0.1:8000` (gateway) en
`127.0.0.1:5432` (Postgres); `70-supabase.sh` weigert elke andere binding.

Getest vanaf de pc:

- Via `https://…ts.net` werken de vier API-paden; `/`, `/project/default`,
  `/api/platform/profile`, `/pg`, `/analytics`, `/graphql`, `/realtime`, `/auth`,
  `/rest` en varianten zoals `/auth/v1x` geven 404, ook met path traversal
  (`/rest/v1/../../pg/…`, `%2e%2e`, `%2f`).
- Op het LAN-IP is alleen 22 open; op het Tailscale-IP alleen 443. 3000, 4000, 5000,
  5432, 6543, 8000, 8080, 8443, 9000, 9999 en 10000 zijn op beide dicht.
- `tailscale serve` stuurt identiteitsheaders mee (`Tailscale-User-Login`, met
  het e-mailadres); die komen niet in de logs van Logflare terecht.

De tunnel (laat het venster open, stoppen met Ctrl+C):

```powershell
.venv\Scripts\python infra\staging\stagingctl.py tunnel
```

### Inloggen in Studio

1. Open de tunnel in een apart venster (hierboven) en laat het open.
2. In een tweede venster, in de root van de repo:

   ```powershell
   .venv\Scripts\python infra\staging\stagingctl.py studio-login
   ```

   Dat toont de gebruikersnaam (`binquest`) en zet het wachtwoord op je
   klembord. Het wachtwoord verschijnt nergens: niet in de terminal, niet als
   argument van een proces (het gaat via stdin naar `Set-Clipboard`).
3. Open `http://localhost:58000`, vul de gebruikersnaam in en plak het
   wachtwoord met Ctrl+V.
4. Na **60 seconden** wordt het klembord weer leeggemaakt, maar alleen als het
   wachtwoord er dan nog op staat (een proces op de achtergrond vergelijkt een
   hash; heb je intussen iets anders gekopieerd, dan blijft dat staan). Langer of
   nooit wissen: `--clear-after 300` of `--clear-after 0`.

Let op: staat de klembordgeschiedenis van Windows aan (Win+V), dan bewaart Windows
daar een kopie. Verwijder die daar, of zet de geschiedenis uit
(Instellingen → Systeem → Klembord). De browser kan het wachtwoord ook
onthouden voor `localhost:58000`.

### Secrets

- `70-supabase.sh` maakt `/opt/binquest/secrets/supabase.env` één keer aan met
  `openssl rand` en (voor de ES256-sleutels) Node in een container zonder
  netwerk. Het script toont geen enkele waarde, controleert dat er geen enkele
  upstream-default overblijft, en overschrijft een bestaand bestand nooit.
- Een waarde opzoeken doe je **zelf, in je eigen terminal** (niet in een chat),
  bv. het Studio-wachtwoord:

  ```powershell
  ssh binquest-staging "sudo bq-secret DASHBOARD_PASSWORD"
  ```

  `bq-secret` (alleen root) is ook wat de scripts op de pc gebruiken; zij houden
  de waarde in het geheugen en tonen ze niet.

- Secrets vervangen gaat niet door het bestand te wissen: `POSTGRES_PASSWORD`
  wordt alleen gebruikt bij het aanmaken van de database (daarna:
  `utils/db-passwd.sh` van upstream), en nieuwe JWT-keys maken alle sessies en de
  key in de app ongeldig.

### Beheer

| Wat | Commando |
|---|---|
| Overzicht (containers, geheugen, schijven) | `.venv\Scripts\python infra\staging\stagingctl.py status` |
| Smoketest | `.venv\Scripts\python infra\staging\stagingctl.py run vm/check-supabase.sh` |
| Herstarten | `ssh binquest-staging "sudo systemctl restart bq-supabase"` |
| Logs van één service | `ssh binquest-staging "sudo bq-compose logs --tail 100 auth"` (of in Studio: Logs) |
| Containers | `ssh binquest-staging "sudo bq-compose ps"` |

Start en stop de stack met `systemctl`, niet met `bq-compose up/down`, zodat de
controle op de dataschijf altijd geldt.

## Deployen

Alles gaat vanaf de pc, vanuit de root van de repo. Volgorde bij een nieuwe
versie: migraties, dan functions en templates, dan de controles.

### Migraties

```powershell
.venv\Scripts\python infra\staging\stagingctl.py migrate
.venv\Scripts\python infra\staging\stagingctl.py migrate --apply
```

- Zonder `--apply` toont het alleen welke migraties uit `supabase/migrations`
  nog niet op staging staan (`supabase db push --dry-run`).
- Het script opent zelf een SSH-tunnel naar Postgres (op een vrije poort), leest
  het wachtwoord via `bq-secret` en geeft het aan de CLI via `PGPASSWORD`, niet
  in de URL. Binnen de tunnel is de verbinding onversleuteld (`sslmode=disable`);
  de tunnel zelf is versleuteld.
- Het weigert een database die zich als iets anders dan `staging` meldt.
- Na `--apply` markeert het de database als `staging` (`private.app_environment`).
- `supabase/seed.sql` gaat nooit naar staging (`db push` neemt geen seeds mee).

### Edge functions en e-mailtemplates

```powershell
.venv\Scripts\python infra\staging\stagingctl.py deploy
```

- Kopieert `supabase/functions/submit-checkin`, `supabase/functions/_shared` en
  `supabase/templates` naar de VM (`vm/80-deploy.sh`).
- De upstream-router van de functions gebruikt één import map voor alle functies
  (`/opt/binquest/functions/deno.jsonc`), niet de `deno.json` per functie zoals
  lokaal. Het script bouwt die opnieuw op uit de upstream-imports en die van elke
  functie, en faalt als een naam naar twee verschillende versies wijst.
- Het controleert dat de functions-container `APP_ENV=staging` heeft en geen
  `ALLOW_FAKE_LOCATION`, dat Auth de template kan laden, en dat `submit-checkin`
  zelf antwoordt.

### Nep-locatie: op staging altijd uit

Drie lagen, elk getest:

1. `APP_ENV=staging` staat in `docker-compose.bq.yml` voor de functions-container.
   Dan staat de nep-locatie uit, en met `ALLOW_FAKE_LOCATION` (welke waarde ook)
   weigert de functie te starten (`vm/check-fake-location.sh`).
2. Een check-in met `fake_location=true` krijgt 403 `fake_location_not_allowed`
   (`vm/check-auth.sh`).
3. De database (`private.app_environment = 'staging'`) laat `record_checkin`
   geen nep-locatie opslaan, ook niet als de functie het toch zou doorlaten
   (`vm/check-auth.sh` roept `record_checkin` rechtstreeks aan: fout `42501`).

### Controles na een deploy

```powershell
.venv\Scripts\python infra\staging\stagingctl.py run vm/check-supabase.sh
.venv\Scripts\python infra\staging\stagingctl.py run vm/check-auth.sh
.venv\Scripts\python infra\staging\stagingctl.py run vm/check-fake-location.sh
```

### Scripts tegen staging (OSM-import, admin)

De scripts in `scripts/` werken standaard alleen lokaal en weigeren elke database
die zich als `staging` of `production` meldt, ook via een tunnel op `127.0.0.1`.
Staging alleen met `--target staging`: het script opent **zelf** een tunnel (op
vrije poorten, los van `stagingctl.py tunnel`), toont wat het gaat doen, vraagt
om `staging` te typen (`--yes` slaat dat over) en sluit de tunnel aan het einde.
Een apart tunnelvenster is alleen nodig voor Studio, Postgres-tools en Mailpit.

```powershell
.venv\Scripts\python scripts\import-bins\import_bins.py --target staging --dry-run
.venv\Scripts\python scripts\import-bins\import_bins.py --target staging
.venv\Scripts\python scripts\seed-admin\seed_admin.py --target staging --email jij@voorbeeld.be
```

Na het aanmaken van je admin-account meld je je in de app aan met dat adres; de
code staat in Mailpit (`http://localhost:58025`, via `stagingctl.py tunnel`).

Stand na de eerste deploy (12 oktober 2026): 9 migraties, database gemarkeerd als
`staging`, 120 vuilbakken uit `data/bins.geojson` (119 geschikt).

## Mail

- Tot er een domein en een SMTP-provider is (gekozen: Brevo), gaan alle mails
  naar **Mailpit** op de VM: niets verlaat de VM. De web-UI staat alleen op
  `127.0.0.1:8025` en is dus alleen via de tunnel bereikbaar.
- Auth gebruikt dezelfde template en hetzelfde onderwerp als lokaal
  (`supabase/templates/otp-code.html`, "Je inlogcode voor Zwerfvuil Gent"),
  6 cijfers, 1 uur geldig. GoTrue laadt templates alleen via een URL; daarom
  serveert een kleine container (`mail-templates`, busybox httpd, zonder poorten)
  `/opt/binquest/templates` binnen het Docker-netwerk.
- Gevolg: wie geen SSH-toegang heeft (bv. de cofounder), kan de inlogcode niet
  zelf lezen. Tot er echte mail is, geef jij de code door uit Mailpit.

## App: staging-profiel

Een staging-build van de app praat met `https://binquest-staging.<tailnet>.ts.net`
(alleen bereikbaar met Tailscale aan) en heeft bundle-ID `be.zwerfvuil.app`.

### Configuratie

Eenmalig, in de map `app`:

```powershell
Copy-Item staging.env.example staging.env.local
```

en vul de twee waarden in; je vindt ze zo (in je eigen terminal):

```powershell
ssh binquest-staging "tailscale status --json | jq -r .Self.DNSName"
ssh binquest-staging "sudo bq-secret SUPABASE_PUBLISHABLE_KEY"
```

`staging.env.local` staat in `.gitignore`. De publishable key is publiek van aard
(hij zit in elke build), de ts.net-naam houden we toch uit git.

- `app/scripts/staging.mjs` draait een commando met die waarden, zet
  `EXPO_PUBLIC_APP_ENV=staging` en zet het laden van `.env`-bestanden uit
  (`EXPO_NO_DOTENV=1`): je lokale dev-instellingen uit `.env.local` kunnen zo nooit
  in een staging-build belanden. Het controleert dat de URL `https://…ts.net` is en
  de key een publishable key.
- Met `APP_ENV=staging` weigert de app een URL zonder `https://`.
- `app/eas.json` heeft een buildprofiel `staging` (Release, interne distributie,
  EAS-omgeving `preview`) voor als de IPA via EAS gebouwd wordt; de URL en key
  komen dan uit de EAS-omgevingsvariabelen, niet uit git.

### De nep-locatie zit niet in de build

Alle code van de verborgen nep-locatie-toggle (long-press, badge, paarse marker,
het verzoekveld `fake_location`, de dev-labels in admin en profiel) staat achter een
letterlijke `__DEV__`. Een release-export vervangt die door `false` en laat de code
weg. Controle:

```powershell
npm --prefix app run check:staging-bundle
```

Dat exporteert de iOS-bundel met het staging-profiel (`dist-staging`, gitignored) en
doorzoekt hem:

- geen teksten van de toggle, geen `fake_location` (de kolomnaam `is_fake_location`
  in de geschiedenis mag), geen `ALLOW_FAKE_LOCATION`, geen Mailpit-hint;
- de staging-URL en -key staan erin, de URL en key uit `.env.local` niet;
- gewone app-teksten worden wel gevonden (de controle leest de echte bundel).

Resultaat (12 oktober 2026): alle controles slagen. Tegenproef: dezelfde export met
`--dev` (waar `__DEV__` blijft) faalt op 8 controles. De `·` in "DEV · nep-locatie"
wordt in de bundel geëscapet; daarom zoekt de controle ook op ASCII-stukken van de
teksten.

## IPA bouwen (GitHub Actions)

`.github/workflows/ios-staging.yml` bouwt een **ongesigneerde** `.ipa` van de app
met het staging-profiel, op een macOS-runner van GitHub (`macos-26`). Iedereen
signeert die IPA zelf op de eigen iPhone, met het eigen certificaat in een
sideload-app. Er staat geen Apple-certificaat, profiel of wachtwoord op GitHub.

### Wat de workflow doet

1. `npm ci`, en de staging-configuratie uit de GitHub-omgeving `staging` (secrets
   `EXPO_PUBLIC_SUPABASE_URL` en `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`), met
   dezelfde controle als op de pc (`scripts/staging.mjs`).
2. `npm run check:staging-bundle`: geen nep-locatie-toggle, geen dev-config.
3. `expo prebuild --platform ios` (met CocoaPods), met een controle dat het
   gegenereerde project ons icoon en onze splash over het volledige scherm heeft
   (`scripts/check-ios-assets.mjs`); dan `xcodebuild archive` **zonder** code
   signing (`CODE_SIGNING_ALLOWED=NO`).
4. Controle van de gebouwde app: bundle-ID `be.zwerfvuil.app`, geen
   provisioning profile, geen handtekening, dezelfde bundelcontrole op de
   `main.jsbundle` (Hermes) in de app, en het icoon (`AppIcon`) en de splash in
   `Assets.car`. Zonder icoon of splash faalt de build.
5. De `.app` in `Payload/`, gezipt als `ZwerfvuilGent-staging-unsigned-<run>.ipa`,
   als artifact **zonder** extra zip (je downloadt meteen de `.ipa`), 7 dagen
   bewaard. Bij een fout: het volledige `xcodebuild`-log, 3 dagen.

### Een build starten

`workflow_dispatch` (de knop "Run workflow") werkt pas als de workflow op `main`
staat. Tot dan, en ook daarna, start je een build met een tag, op de commit die je
wilt bouwen:

```powershell
git tag ios-staging-20261013-1200
git push origin ios-staging-20261013-1200
```

Volgen: GitHub → Actions → "iOS staging IPA (unsigned)", of
`gh run list --repo binquest/zwerfvuil-app --event push --limit 5` (met `--workflow
ios-staging.yml` zodra de workflow op `main` staat). Duur van een build: wordt ingevuld na de
eerste build.

### De IPA downloaden

- GitHub → Actions → de run → onderaan **Artifacts** →
  `ZwerfvuilGent-staging-unsigned-<run>.ipa`. Dat kan ook in Safari op de iPhone
  (ingelogd op GitHub); de IPA komt dan in Bestanden.
- Of op de pc: `gh run download <run-id> --repo binquest/zwerfvuil-app`.

### Secrets bijwerken

Na een wijziging van de staging-URL of de publishable key (bv. nieuwe secrets op de
VM): pas `app/staging.env.local` aan en draai in de map `app`:

```powershell
node scripts/github-secrets.mjs
```

Dat zet beide secrets in de omgeving `staging` via stdin (nooit als argument,
nooit getoond); bestaat de omgeving niet, dan maakt het haar aan (zonder
beschermingsregels).

### Verbruik controleren

`binquest` staat op GitHub Free zonder betaalmethode: elke maand ongeveer
**200 macOS-minuten gratis** (2.000 minuten, en een macOS-minuut kost ongeveer
tien keer zoveel als een Linux-minuut). Is dat op, dan **blokkeert** GitHub
nieuwe builds tot de volgende maand; er komt geen factuur.

- In de browser: organisatie `binquest` → Settings → Billing and licensing →
  **Usage**, filter op Actions.
- Met `gh` (verbruik per dag en SKU, `actions_macos` is de iOS-build):

  ```powershell
  gh api "organizations/binquest/settings/billing/usage" --jq ".usageItems[] | [.date, .sku, .quantity, .unitType] | @tsv"
  ```

- Per build (gefactureerde tijd in milliseconden, onder `MACOS`):

  ```powershell
  gh run list --repo binquest/zwerfvuil-app --event push --limit 5
  gh api "repos/binquest/zwerfvuil-app/actions/runs/<run-id>/timing" --jq ".billable"
  ```

### Gids voor de cofounder

Je krijgt een eigen certificaat (bij een reseller) en signeert dezelfde
ongesigneerde IPA zelf. Wat je nodig hebt: een iPhone, de Tailscale-app, je
sideload-app met je eigen certificaat, en een e-mailadres om mee in te loggen.

1. **De gedeelde node accepteren.** Je krijgt van ons een uitnodiging per e-mail
   om de machine `binquest-staging` te delen. Open de link, meld je aan bij
   Tailscale (een eigen account, gratis) en aanvaard de uitnodiging. Je ziet alleen
   deze ene machine, en kunt alleen de app-API bereiken (HTTPS); SSH, Studio en de
   database niet.
2. **Tailscale op je iPhone.** Installeer Tailscale uit de App Store, meld je aan
   met hetzelfde account en zet de VPN aan. Laat Tailscale aanstaan zolang je de
   app gebruikt: zonder Tailscale kan de app de server niet bereiken.
3. **De IPA downloaden.** Heb je toegang tot de GitHub-repo: Actions →
   "iOS staging IPA (unsigned)" → de laatste geslaagde run → Artifacts →
   `ZwerfvuilGent-staging-unsigned-<nummer>.ipa` (in Safari op je iPhone komt hij
   in Bestanden). Zonder toegang: vraag ons de IPA. Een artifact verdwijnt na 7
   dagen.
4. **Signeren en installeren.** Open de IPA in je sideload-app (importeren vanuit
   Bestanden), kies je eigen certificaat (`.p12` en `.mobileprovision`), signeer en
   installeer. Vraagt iOS om de ontwikkelaar te vertrouwen: Instellingen →
   Algemeen → VPN en apparaatbeheer. Mag de bundle-ID niet blijven, laat je
   sideload-app hem aanpassen; dat heeft geen invloed op de app.
5. **Inloggen.** Open "Zwerfvuil Gent", vul je e-mailadres in en vraag een code.
   Die mail komt (nog) niet in je mailbox: staging verstuurt geen echte mail. Laat
   het ons weten; wij lezen de code van 6 cijfers in Mailpit en sturen hem door. Hij
   blijft 1 uur geldig. Daarna blijf je ingelogd.

Problemen:

| Probleem | Oplossing |
|---|---|
| "Kan geen verbinding maken" of laden blijft hangen | Staat Tailscale aan (VPN-icoon bovenaan)? Is de gedeelde node nog aanvaard? |
| De app opent niet meer | Je certificaat is waarschijnlijk ingetrokken: signeer opnieuw met een geldig certificaat |
| Nieuwe versie | Download de nieuwe IPA, signeer en installeer hem over de oude heen; je blijft ingelogd |

## Supabase updaten

1. Lees in `docker/CHANGELOG.md` van upstream wat er veranderd is, vooral regels
   met "requires … update" en wijzigingen aan `docker-compose.yml`.
2. Maak een Proxmox-snapshot van de VM (of minstens een database-dump).
3. Zet de nieuwe commit in `SUPABASE_REF`, commit, en draai `70-supabase.sh`:
   dat checkt de commit uit, haalt de images en maakt de gewijzigde containers
   opnieuw aan.
4. Draai `check-supabase.sh`.

## Tailscale

- De VM staat op het tailnet als `binquest-staging`, met `--accept-dns=false`
  (DNS blijft die van het LAN) en `--accept-routes=false` (de VM zit zelf op het
  LAN en mag dat niet via de subnet router routeren). Key expiry staat uit.
- `tailscale serve` (`vm/75-tailscale-serve.sh`) publiceert alleen de API-paden
  op `https://binquest-staging.<tailnet>.ts.net`, met een certificaat van
  Tailscale. De eerste keer moet Serve voor het tailnet aangezet worden: het
  script toont dan een URL (`login.tailscale.com/f/serve?node=…`); open die, zet
  Serve aan en draai het script opnieuw.
- **Funnel blijft uit** (publiceren naar het internet). De node heeft het
  Funnel-recht niet in de tailnet-policy, en `75-tailscale-serve.sh` faalt als
  het toch Funnel op een poort vindt (voor en na het instellen). `status` toont
  `funnel: off`. Zet nooit `tailscale funnel` aan voor deze node.
- De ts.net-naam staat in de publieke Certificate Transparency-logs (zo werken
  HTTPS-certificaten); de naam zelf geeft geen toegang.

### Tailnet-ACL voor gedeelde gebruikers

Wie de node gedeeld krijgt (bv. de cofounder), valt onder `autogroup:shared`.
Een regel met `"src": ["*"]` geldt ook voor hen, dus vervang die door
`autogroup:member` en geef gedeelde gebruikers alleen 443 op deze node. In de
Tailscale admin console → Access controls (`<TAILSCALE_IP_VM>`: `tailscale ip -4`
op de VM):

```jsonc
{
  "hosts": {
    "binquest-staging": "<TAILSCALE_IP_VM>",
  },
  "grants": [
    // Eigen leden: alles, zoals het standaardbeleid.
    {"src": ["autogroup:member"], "dst": ["*"], "ip": ["*"]},
    // Gedeelde gebruikers: alleen HTTPS naar staging.
    {"src": ["autogroup:shared"], "dst": ["binquest-staging"], "ip": ["tcp:443"]},
  ],
}
```

Gebruikt je policy nog `acls` in plaats van `grants`, dan is het equivalent
`{"action": "accept", "src": ["autogroup:shared"], "dst": ["binquest-staging:443"]}`,
en wordt de bestaande regel met `"src": ["*"]` `"src": ["autogroup:member"]`.
Heb je getagde toestellen die zelf verbindingen moeten openen, voeg dan ook
`autogroup:tagged` toe als bron. Een getagd toestel kan niet gedeeld worden; laat
`binquest-staging` dus ongetagd. Ook zonder deze ACL kunnen gedeelde gebruikers
niet aan SSH (de firewall laat 22 op `tailscale0` niet toe).

## Updates en reboots

- **Automatisch**: Debian-security-updates. De pakketlijsten worden om 02:00
  vernieuwd (+ max. 30 min), de updates om 04:00 geïnstalleerd. Heeft een update
  een reboot nodig (bv. een nieuwe kernel, `/run/reboot-required`), dan herstart
  de VM om **04:30**, na de database-backup van 03:30. Zonder zo'n update geen
  reboot. Duurt de upgrade tot na 04:30, dan volgt de reboot de nacht erna.
- Getest: met `/run/reboot-required` plant `unattended-upgrade` een reboot om
  04:30 in (`/run/systemd/shutdown/scheduled`); `sudo shutdown -c` annuleert hem.
  Na een reboot komen firewall, dataschijf, Docker en Tailscale vanzelf terug.
- **Met de hand**: alle andere updates, Docker en Tailscale:

  ```powershell
  ssh binquest-staging "sudo apt-get update && sudo apt-get -y full-upgrade"
  ```

- `stagingctl.py status` meldt "reboot needed" als er een nieuwere kernel
  geïnstalleerd is dan er draait. Meteen herstarten:
  `ssh binquest-staging "sudo systemctl reboot"`.

## Database-backups

| | |
|---|---|
| Wat | `pg_dump` van de database `postgres` (alle schema's: public, private, auth, storage, migraties), als `supabase_admin`, custom format. Niet: de logs (`_supabase`) en de foto's zelf |
| Wanneer | elke nacht om **03:30** (`bq-backup.timer`), vóór de updates (04:00) en de eventuele reboot (04:30). Was de VM uit, dan bij de volgende boot |
| Waar | `/srv/bq-data/backups/pg/postgres-<datum>-<tijd>.dump` met een `.sha256` ernaast, op de dataschijf (de HDD) |
| Bewaren | 7 dagen (vandaag en de 6 dagen ervoor); de nieuwste dump wordt nooit verwijderd |
| Rechten | map `700`, bestanden `600`, alleen root: de dumps bevatten persoonsgegevens (e-mailadressen, locaties) |

- Een dump wordt eerst als `.partial` geschreven en pas hernoemd als
  `pg_restore --list` hem kan lezen; een mislukte backup laat de unit falen
  (`stagingctl.py status` toont "last run").
- Met de hand een backup maken: `ssh binquest-staging "sudo systemctl start bq-backup"`.
- Getest: de retentie (nepdumps van 3, 6,5, 7,5 en 10 dagen: alleen die van 7,5 en
  10 dagen verdwenen) en de controlesommen.

### Restore-test

```powershell
.venv\Scripts\python infra\staging\stagingctl.py run vm/check-restore.sh
```

Het script controleert de `.sha256`, start een wegwerpcontainer van hetzelfde
`supabase/postgres`-image als de live database, met dezelfde init-scripts
(rollen, webhooks, jwt, …) maar een eigen wachtwoord, zonder netwerk en met de data
in het geheugen. Daarin zet het de dump terug (`pg_restore --clean --if-exists`),
vergelijkt het per tabel het aantal rijen met de live database, en verwijdert het
de container. De live database wordt alleen gelezen.

Resultaat op 12 oktober 2026 (dump `postgres-20261012-170145.dump`, 524 KB):
0 fouten van `pg_restore`, en alle tabellen gelijk:

| Tabel | Live | Teruggezet |
|---|---|---|
| `public.bins` | 120 | 120 |
| `public.profiles` | 1 | 1 |
| `public.checkins` | 0 | 0 |
| `public.bin_reports` | 0 | 0 |
| `private.app_environment` | 1 (`staging`) | 1 (`staging`) |
| `auth.users` / `auth.identities` | 1 / 1 | 1 / 1 |
| `storage.buckets` / `storage.objects` | 2 / 0 | 2 / 0 |
| `supabase_migrations.schema_migrations` | 9 | 9 |

Een eerste poging zonder de init-scripts van de stack gaf 7 fouten (de rol
`supabase_functions_admin` ontbrak); daarom neemt het script de init-mounts van de
live container over.

Draai de test opnieuw na een Supabase-update, en af en toe met echte data.

### Echt terugzetten

Niet uitgevoerd op de live database; de restore-test hierboven doet hetzelfde op
een verse database van hetzelfde image.

1. Kies de dump en controleer hem:
   `ssh binquest-staging "sudo bash -c 'cd /srv/bq-data/backups/pg && sha256sum -c postgres-<…>.dump.sha256'"`.
2. Op de VM (`ssh binquest-staging`), eerst nog een dump van de huidige stand:
   `sudo systemctl start bq-backup`.
3. Stop alles behalve de database:
   `sudo bq-compose stop api-gw auth rest storage functions meta studio analytics vector mailpit mail-templates`.
4. Zet terug:
   `sudo bash -c 'docker exec -i supabase-db pg_restore -U supabase_admin -d postgres --clean --if-exists < /srv/bq-data/backups/pg/postgres-<…>.dump'`.
5. `sudo systemctl restart bq-supabase`, daarna `check-supabase.sh` en `check-auth.sh`.

De foto's zitten niet in de dump: `storage.objects` verwijst naar bestanden in
`/srv/bq-data/storage`. Na het terugzetten van een oudere dump kunnen er foto's
zijn zonder rij (nieuwer dan de dump). Bij een volledig nieuwe VM: eerst de VM en
Supabase opbouwen met de **oude secrets** uit de vzdump (`/opt/binquest/secrets`),
dan de dump terugzetten en `/srv/bq-data/storage` terugplaatsen; met nieuwe secrets
werken bestaande sessies en de key in de app niet meer.

### Alles op één schijf

De dataschijf (foto's én dumps) is één virtueel bestand op één fysieke HDD
(`media1tb-vzdump`), zonder tweede kopie: de vzdump van de VM sluit die schijf uit
en komt op dezelfde HDD terecht. Gaat de HDD stuk, dan zijn de foto's weg; van de
database blijft de live kopie op de SSD (en de vzdump, als die elders staat).

## Backups van de VM (vzdump)

- De VM zit in het vzdump-schema van Proxmox. Alleen de systeemschijf gaat mee;
  de dataschijf staat op Backup uit (die krijgt in fase 4 eigen database-dumps).
- **Die vzdump is de enige kopie van de secrets buiten de VM.** Alles in
  `/opt/binquest` (de gegenereerde keys, wachtwoorden en `.env` van Supabase)
  bestaat alleen op de VM en in die vzdump. Gaan beide verloren, dan moeten alle
  secrets opnieuw gegenereerd worden, en zijn alle bestaande sessies en de
  anon-key in de app ongeldig.
- Dankzij de QEMU guest agent bevriest vzdump het bestandssysteem tijdens de
  snapshot, zodat ook de Postgres-data op de systeemschijf consistent is.
