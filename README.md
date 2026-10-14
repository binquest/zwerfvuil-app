# Zwerfvuil Gent (MVP)

Raap zwerfvuil op, gooi het in een officiële openbare vuilbak en verdien punten.
De vuilbakken komen uit OpenStreetMap (`amenity=waste_basket`). Deze MVP dekt
alleen de testregio rond de Oude Houtlei in Gent (+600 m).

| Map | Inhoud |
|---|---|
| `app/` | Expo-app (TypeScript, Expo Router, SDK 57, native iOS 26-UI), op de iPhone als "Zwerfvuil Dev" tegen staging |
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
```

De lokale Supabase is voor de tests en scripts. De app op je iPhone ("Zwerfvuil
Dev") praat met de staging-server en krijgt nieuwe versies als update (stap 6).
De `Copy-Item`-regels zijn alleen voor de eerste keer: ze overschrijven bestaande
bestanden.

## Vereisten

- Windows met PowerShell (of WSL), Docker Desktop (draaiend), Node.js 20+,
  Python 3.12+ (op Windows via `py`)
- Op de iPhone: "Zwerfvuil Dev" (stap 6), een sideload-app met je eigen
  certificaat, en Tailscale (de staging-server staat op het tailnet)

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

Er zijn vier configuratiebestanden. Ze staan alle vier in `.gitignore`; in git
staan alleen de `.example`-versies met placeholders.

| Bestand | Voor | Voorbeeld |
|---|---|---|
| `.env` | de Python-scripts (`ADMIN_EMAIL`, `DATABASE_URL`, `OSM_CONTACT`) | `.env.example` |
| `supabase/functions/.env` | de edge functions (`ALLOW_FAKE_LOCATION`) | `supabase/functions/.env.example` |
| `app/.env.local` | de app (Supabase-URL, publishable key, Metro-host) | `app/.env.example` |
| `app/staging.env.local` | staging-builds van de app (zie `docs/STAGING.md`) | `app/staging.env.example` |

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

## 6. Zwerfvuil Dev op je iPhone

"Zwerfvuil Dev" (`be.zwerfvuil.app.dev`) is een **Release-build** van de app tegen de
**staging-server** (`docs/STAGING.md`), naast de staging-app "Zwerfvuil Gent". Er is
geen Metro of pc nodig: nieuwe JavaScript komt als **EAS Update** (kanaal `dev`).
Een nieuwe IPA is alleen nodig als de native code verandert.

Waarom zo: zonder Apple Developer Program bouwt GitHub Actions een ongesigneerde
IPA die je zelf signeert (zoals de staging-IPA), en dat kost telkens ongeveer 15 van
de ongeveer 200 gratis macOS-minuten per maand. Met EAS Update kost een
schermwijziging geen build.

### Eenmalig: de IPA

1. `app/app.config.ts` bevat het EAS-project (`EAS_OWNER`, `EAS_PROJECT_ID`, via
   `npx eas-cli init`) en de runtimeversie (`DEV_RUNTIME_VERSION`).
2. Start de build met een tag (de staging-URL en -key komen uit de GitHub-omgeving
   `staging`, zoals bij de staging-IPA):

   ```powershell
   git tag ios-dev-<yyyymmdd-hhmm>
   git push origin ios-dev-<yyyymmdd-hhmm>
   ```

3. GitHub → Actions → "iOS dev IPA (unsigned, staging + EAS Update)" → Artifacts:
   `ZwerfvuilDev-unsigned-<run>.ipa`. Signeer en installeer hem in je sideload-app.

### Een nieuwe versie sturen (update)

```powershell
npm --prefix app run update:dev -- "wat er veranderd is"
```

Dat exporteert de bundel met het staging-profiel (`app/staging.env.local`), controleert
hem (`check-staging-bundle`) en publiceert precies die export. Eenmalig nodig:
`npx eas-cli login`. Op de iPhone: open de app; zodra de update binnen is, vraagt ze om
te herstarten (of Profiel → "Zoek naar updates"). Profiel → App → Versie toont welke
update draait.

Let op: een update gaat naar de servers van Expo, met de staging-URL en de
publishable key erin (die staan ook in elke IPA; de URL werkt alleen op het tailnet).

### Wanneer een nieuwe IPA

Bij elke wijziging aan native code: een package met native code, een config-plugin,
`app.json` of `app.config.ts`. Verhoog dan eerst `DEV_RUNTIME_VERSION`: updates gaan
alleen naar apps met dezelfde runtimeversie.

### Lokaal

De iOS-UI (SwiftUI via `@expo/ui`, Liquid Glass, native tabs) draait alleen in een
echte iOS-build; Expo Go en Metro worden niet meer gebruikt. De lokale Supabase is
voor de database- en functietests en de scripts. Wil je toch met Metro tegen de
lokale Supabase werken, dan heb je een development build met `expo-dev-client`
nodig (zie commit `46faef6` voor die opzet en het Tailscale-stuk van deze README in
die versie).

## Dev-modus (testen zonder rond te lopen)

Admins op local of staging vinden in de app **Beheer → Dev-modus**: de
puntenonthulling bekijken, een reeks forceren, een testlocatie op de kaart kiezen,
hun testdata resetten, en testdata in de ranglijst tonen. Alles wat Dev-modus doet
is testdata en wordt gelogd; de server weigert het voor gewone gebruikers en in
productie. Details en waarom het veilig is: `docs/STAGING.md`, "Dev-modus".

Het oude `ALLOW_FAKE_LOCATION` is afgeschaft: haal het uit
`supabase/functions/.env` als het er nog staat. Lokaal moet de database als `local`
gemarkeerd zijn; `npm run db:reset` doet dat via `supabase/seed.sql`. Wil je je data
houden, voer dan eenmalig uit (Studio of psql):

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
npm --prefix app run test:scripts
npm --prefix app run check:staging-bundle
npm --prefix app run doctor
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

## App-icoon en splash

Alle iconen en de splash komen uit één bronbeeld: `app/assets/icon-source.png`
(vierkant, effen achtergrond, witte figuur). Na een nieuw bronbeeld, in de map `app`:

```powershell
node scripts/icons.mjs --preview $env:TEMP\icon-preview
```

Het script sampelt de kleuren, schrijft alle bestanden in `app/assets` en print de
kleuren voor `app.json`. De figuur wordt nergens gecentreerd: de compositie van het
bronbeeld blijft (de vuilbak staat afgesneden in de hoek). Waar meer te zien is dan
het bronbeeld (Android bij parallax, de iOS-splash op hoge schermen), loopt de
vuilbak door langs zijn randen; zijn die niet recht, dan zegt het script dat.
Bekijk de previews voor je commit.

- **iOS**: `icon.png`; splash `splash-ios.png` over het volledige scherm. Het script
  faalt als het deksel en het handvat niet op elk iPhone-scherm volledig zichtbaar
  zijn. De splash gebruikt `enableFullScreenImage_legacy` (zie `docs/PRE-BETA.md`).
- **Android**: adaptive icon (foreground, background, monochrome). De splash is het
  icoon als afgerond vierkant, gecentreerd op donkergroen: Android 12+ toont bij
  het opstarten alleen een gecentreerd icoon.

De IPA-workflow controleert na de prebuild en na de build dat icoon en splash de
onze zijn (`app/scripts/check-ios-assets.mjs`).

## Problemen oplossen

| Probleem | Oplossing |
|---|---|
| De app toont "App niet geconfigureerd" | De build of update kreeg geen of een verkeerde staging-URL of -key: controleer `app/staging.env.local` (updates) of de GitHub-omgeving `staging` (IPA) |
| "Zwerfvuil Dev" bereikt de server niet | Tailscale op de iPhone staat uit, of de staging-VM draait niet (zie `docs/STAGING.md`, "Bereikbaarheid") |
| Een update komt niet aan | Open de app opnieuw of kies Profiel → "Zoek naar updates". Komt ze nooit: verschilt de runtimeversie van de IPA (`DEV_RUNTIME_VERSION`)? |
| Geen inlogcode ontvangen | Op staging gaan mails naar Mailpit op de VM (via de tunnel), lokaal naar Mailpit op poort 54324; per account maximaal 1 mail per seconde |
| Inworp mislukt | De melding zegt wat er mis is (netwerk, timeout, serverfout, weigering) |
| Na `npm run db:reset` is alles leeg | Importeer opnieuw (stap 4) en maak jezelf opnieuw admin (stap 5) |
| Poorten 54321–54327 bezet | `npm run db:stop`, of stop een ander Supabase-project |

## Data en licentie

Vuilbakdata © OpenStreetMap contributors, beschikbaar onder de
[Open Database License](https://www.openstreetmap.org/copyright).
