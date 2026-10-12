# Zwerfvuil Gent (MVP)

Raap zwerfvuil op, gooi het in een officiële openbare vuilbak en verdien punten.
De vuilbakken komen uit OpenStreetMap (`amenity=waste_basket`). Deze MVP dekt
alleen de testregio rond de Oude Houtlei in Gent (+600 m).

| Map | Inhoud |
|---|---|
| `app/` | Expo-app (TypeScript, Expo Router), draait in Expo Go (SDK 57) |
| `supabase/` | Migraties, edge function `submit-checkin`, e-mailtemplate, database- en functietests |
| `scripts/osm/` | Testregio bepalen, Belgium-PBF downloaden, vuilbakken extraheren |
| `scripts/import-bins/` | `data/bins.geojson` importeren in de database |
| `scripts/seed-admin/` | Een account admin maken op basis van een e-mailadres |
| `config/region.json` | De testregio (gedeeld door scripts en app) |
| `infra/staging/` | Scripts en config voor de staging-VM op de homeserver (zie `docs/STAGING.md`) |
| `docs/PRE-BETA.md` | Wat nog moet gebeuren voor er echte gebruikers bij komen |
| `docs/STAGING.md` | Runbook van de staging-omgeving |

## In het kort (eerste keer)

Alle commando's draai je vanuit de root van de repo, in PowerShell (zie de
stappen hieronder voor details en WSL).

```powershell
npm install
npm --prefix app install
py -m venv .venv
.venv\Scripts\python -m pip install -r scripts\requirements.txt
Copy-Item .env.example .env
Copy-Item supabase\functions\.env.example supabase\functions\.env
Copy-Item app\.env.example app\.env.local
npm run db:start
.venv\Scripts\python scripts\osm\osm_bins.py all
.venv\Scripts\python scripts\import-bins\import_bins.py
.venv\Scripts\python scripts\seed-admin\seed_admin.py --email jij@voorbeeld.be
cd app
npx expo start --clear
```

Vul vóór `npx expo start` eerst `app/.env.local` in (stap 6). De `Copy-Item`-regels
zijn alleen voor de eerste keer: ze overschrijven bestaande bestanden.

## Vereisten

- Windows met PowerShell (of WSL), Docker Desktop (draaiend), Node.js 20+,
  Python 3.12+ (op Windows via `py`)
- Op de iPhone: Expo Go (SDK 57); voor testen op straat ook Tailscale

## 1. Installeren

```powershell
npm install
npm --prefix app install
py -m venv .venv
.venv\Scripts\python -m pip install -r scripts\requirements.txt
```

`npm install` in de root installeert de Supabase CLI en Deno (vaste versies in
`package.json`); je hoeft niets globaal te installeren.

In WSL: `python3 -m venv .venv && .venv/bin/pip install -r scripts/requirements.txt`,
en gebruik daarna overal `.venv/bin/python` in plaats van `.venv\Scripts\python`.

## 2. Configuratie

Er zijn drie configuratiebestanden. Ze staan alle drie in `.gitignore`; in git
staan alleen de `.example`-versies met placeholders.

| Bestand | Voor | Voorbeeld |
|---|---|---|
| `.env` | de Python-scripts (`ADMIN_EMAIL`, `DATABASE_URL`, `OSM_CONTACT`) | `.env.example` |
| `supabase/functions/.env` | de edge functions (`ALLOW_FAKE_LOCATION`) | `supabase/functions/.env.example` |
| `app/.env.local` | de app (Supabase-URL, publishable key, Metro-host) | `app/.env.example` |

```powershell
Copy-Item .env.example .env
Copy-Item supabase\functions\.env.example supabase\functions\.env
Copy-Item app\.env.example app\.env.local
```

Doe dit alleen de eerste keer: `Copy-Item` overschrijft een bestaand bestand.
Zet je e-mailadres alleen in `.env` (of geef het mee met `--email`), nooit in
een bestand dat in git komt.

## 3. Supabase starten en migreren

```bash
npm run db:start
```

De eerste keer downloadt dit de Docker-images en past het alle migraties uit
`supabase/migrations/` toe. Daarna:

| Wat | Hoe |
|---|---|
| Studio (database bekijken) | http://127.0.0.1:54323 |
| Mailpit (inlogcodes) | http://127.0.0.1:54324 |
| Nieuwe migraties toepassen, data behouden | `npm run supabase -- migration up` |
| Database opnieuw opbouwen (alle data weg) | `npm run db:reset`, daarna stap 4 en 5 opnieuw |
| Na een wijziging in `supabase/functions/.env` of `supabase/config.toml` | `npm run db:stop` en `npm run db:start` |
| Status, URL's en keys | `npm run supabase -- status` |

## 4. OSM-vuilbakken importeren

```powershell
.venv\Scripts\python scripts\osm\osm_bins.py all
.venv\Scripts\python scripts\import-bins\import_bins.py
```

- `osm_bins.py all` haalt de testregio op via Nominatim (gecachet in
  `config/region.json`), downloadt `belgium-latest.osm.pbf` van Geofabrik naar
  `data/` (opnieuw na 7 dagen) en schrijft `data/bins.geojson`.
- `import_bins.py` doet in één transactie een upsert op `(osm_type, osm_id)` en
  zet vuilbakken die uit OSM verdwenen zijn op `removed`. Met `--dry-run` zie je
  wat er zou veranderen zonder iets op te slaan.

## 5. Admin-gebruiker

```powershell
.venv\Scripts\python scripts\seed-admin\seed_admin.py --email jij@voorbeeld.be
```

Of zet `ADMIN_EMAIL=...` in `.env` en draai het script zonder `--email`.

- Bestaat het account nog niet, dan maakt het script het aan (bevestigd, zonder
  wachtwoord). Meld je daarna in de app aan met dat adres; de code van 6 cijfers
  staat in Mailpit.
- Het script kan veilig opnieuw draaien. In de uitvoer wordt het adres
  gemaskeerd (`ji*@voorbeeld.be`).
- Admin-rechten intrekken: voeg `--revoke` toe.
- Na `npm run db:reset` moet je het script opnieuw draaien.

Beide scripts werken standaard alleen op de lokale database. Voor de
staging-omgeving: `--target staging` (zie `docs/STAGING.md`).

## 6. App starten in Expo Go

Vul `app/.env.local` in:

```
EXPO_PUBLIC_SUPABASE_URL=http://<PC_HOST>:54321
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable key>
REACT_NATIVE_PACKAGER_HOSTNAME=<PC_HOST>
```

- De publishable key vind je met `npm run supabase -- status` ("Publishable").
- `<PC_HOST>` is het adres waarop je iPhone je pc bereikt:
  - **zelfde wifi**: het LAN-IP van je pc (`ipconfig`, "IPv4 Address" van de
    wifi-adapter);
  - **mobiele data**: het Tailscale-IP (zie hieronder).
- Het moet `.env.local` zijn: Expo leest `REACT_NATIVE_PACKAGER_HOSTNAME` alleen
  uit `.local`-bestanden.

```powershell
cd app
npx expo start --clear
```

Scan de QR-code met de camera van je iPhone. Expo zet de waarden uit
`.env.local` vast in de app: herstart na een wijziging altijd met `--clear`.

**Firewall op wifi.** Windows Firewall moet poort 54321 (Supabase) en 8081
(Metro) toelaten op het netwerk van je wifi. Kijk welk profiel dat netwerk heeft:

```powershell
Get-NetConnectionProfile | Select-Object InterfaceAlias, NetworkCategory
```

Docker Desktop en Node.js krijgen bij installatie meestal toegang op
"Openbaar"; staat je wifi op "Privé" en lukt de verbinding niet, voeg dan (in
PowerShell als administrator) een regel toe voor je lokale netwerk:

```powershell
New-NetFirewallRule -DisplayName "Zwerfvuil dev via LAN" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 54321,54324,8081 -RemoteAddress LocalSubnet -Profile Private
```

## Testen op straat via Tailscale

Met Tailscale bereikt je iPhone je pc ook via mobiele data, zonder poorten open
te zetten naar het internet.

1. **Tailscale op pc en iPhone**: installeer Tailscale op beide, log in met
   hetzelfde account en zet de verbinding aan. Op de pc:

   ```powershell
   tailscale status
   tailscale ip -4
   ```

   `tailscale status` mag niet "Tailscale is stopped" tonen. `tailscale ip -4` geeft
   het Tailscale-IP van je pc (`100.x.y.z`), hieronder `<TAILSCALE_IP>`.

2. **Firewall** (eenmalig, PowerShell als administrator). Windows ziet het
   Tailscale-netwerk als "Privé", terwijl Docker Desktop vaak alleen toegang
   heeft op "Openbaar". Deze regel laat Supabase (54321), Mailpit (54324) en
   Metro (8081) alleen toe vanaf je eigen Tailscale-apparaten:

   ```powershell
   New-NetFirewallRule -DisplayName "Zwerfvuil dev via Tailscale" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 54321,54324,8081 -InterfaceAlias Tailscale -RemoteAddress 100.64.0.0/10 -Profile Private
   ```

   Verwijderen kan later met `Remove-NetFirewallRule -DisplayName "Zwerfvuil dev via Tailscale"`.

3. **App-config**: zet in `app/.env.local` beide adressen op het Tailscale-IP:

   ```
   EXPO_PUBLIC_SUPABASE_URL=http://<TAILSCALE_IP>:54321
   REACT_NATIVE_PACKAGER_HOSTNAME=<TAILSCALE_IP>
   ```

4. **Controleren vanaf de iPhone** (Tailscale aan, wifi uit), in Safari:
   - `http://<TAILSCALE_IP>:54321/rest/v1/` → een JSON-foutmelding over een
     ontbrekende API key betekent: bereikbaar.
   - `http://<TAILSCALE_IP>:8081/status` → `packager-status:running`.

5. **Starten**: `cd app` en `npx expo start --clear`, scan de QR-code. Expo Go
   laadt de app via het Tailscale-IP.

Tips:

- Meld je thuis één keer aan; de sessie blijft bewaard, zodat je op straat geen
  code nodig hebt. Heb je toch een code nodig: Mailpit staat op
  `http://<TAILSCALE_IP>:54324`.
- Thuis op wifi kan je gewoon via Tailscale blijven werken; overschakelen naar het
  LAN-IP is niet nodig.
- `tailscale status` toont of de iPhone `direct` of via een relay (`relay "…"`)
  verbonden is. Op mobiele data is dat vaak een relay (DERP): dat werkt, maar met
  meer vertraging (~100 ms). `tailscale ping <iphone-naam>` meet die vertraging.

## Dev: nep-locatie (thuis testen)

1. Zet `ALLOW_FAKE_LOCATION=true` in `supabase/functions/.env` en herstart
   Supabase (`npm run db:stop` en `npm run db:start`).
2. In de app (alleen in dev): houd het infovak bovenaan de kaart 1,5 seconde
   ingedrukt. Tik daarna op de kaart om je locatie te kiezen.
3. Zet het daarna terug op `false`. De server negeert de vlag sowieso als Supabase
   niet lokaal draait.

Ook de database moet als lokaal gemarkeerd zijn; `npm run db:reset` doet dat via
`supabase/seed.sql`. Wil je je data houden (na het binnenhalen van de migratie
`environment_guard` met `npm run supabase -- migration up`), voer dan eenmalig deze
regel uit in Studio (SQL Editor) of psql:

```sql
insert into private.app_environment (name) values ('local') on conflict (singleton) do update set name = excluded.name, updated_at = now();
```

## Tests en controles

```bash
npm run db:test
npm run db:lint
npm run test:functions
npm run functions:check
npm run test:functions:integration
npm --prefix app run typecheck
npm --prefix app run lint
npm --prefix app test
```

```powershell
.venv\Scripts\python -m unittest discover -s scripts
.venv\Scripts\python -m unittest discover -s scripts/osm
.venv\Scripts\python -m unittest discover -s scripts/import-bins
.venv\Scripts\python -m unittest discover -s scripts/seed-admin
.venv\Scripts\python -m unittest discover -s infra/staging
```

`db:test`, `test:functions:integration` en de import- en seed-tests hebben een
draaiende Supabase nodig. De integratietests maken tijdelijke accounts en data
aan (`@example.test`) en ruimen die zelf op. Met `CHECKIN_API_URL=http://<host>:54321`
stuurt de check-in-test zijn requests via een ander adres, bijvoorbeeld je
Tailscale-IP.

## Problemen oplossen

| Probleem | Oplossing |
|---|---|
| De app toont "App niet geconfigureerd" | `app/.env.local` ontbreekt of bevat nog placeholders; vul het in en start met `npx expo start --clear` |
| `expo start` meldt "Refused to load personal environment variables" | `REACT_NATIVE_PACKAGER_HOSTNAME` staat in `app/.env`; verplaats alles naar `app/.env.local` |
| Expo Go laadt niet of de app krijgt geen verbinding | Open de controle-URL's uit de Tailscale-stappen in Safari; controleer de firewall, `tailscale status` en `<PC_HOST>` in `app/.env.local` |
| Geen inlogcode ontvangen | Lokaal gaan mails naar Mailpit (poort 54324), niet naar je echte mailbox; per account kan er maximaal 1 mail per seconde vertrekken |
| Inworp mislukt | De melding zegt wat er mis is (netwerk, timeout, serverfout, weigering). In dev staat elke poging als `[submit-checkin] {...}` in de Metro-console |
| Na `npm run db:reset` is alles leeg | Importeer opnieuw (stap 4) en maak jezelf opnieuw admin (stap 5) |
| Poorten 54321–54327 bezet | `npm run db:stop`, of stop een ander Supabase-project |

## Data en licentie

Vuilbakdata © OpenStreetMap contributors, beschikbaar onder de
[Open Database License](https://www.openstreetmap.org/copyright).
