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
| `config/region.json` | De testregio (gedeeld door scripts en app) |
| `docs/PRE-BETA.md` | Wat nog moet gebeuren voor er echte gebruikers bij komen |

## Vereisten

- Windows met PowerShell (of WSL), Docker Desktop, Node.js 20+, Python 3.12+
- Op de iPhone: Expo Go (SDK 57)

Alle commando's hieronder draai je vanuit de root van de repo, tenzij anders vermeld.

## 1. Installeren

```bash
npm install
```

```bash
npm --prefix app install
```

Python-omgeving voor de scripts (PowerShell):

```powershell
py -m venv .venv
.venv\Scripts\python -m pip install -r scripts\requirements.txt
```

In WSL: `python3 -m venv .venv && .venv/bin/pip install -r scripts/requirements.txt`
(en gebruik daarna `.venv/bin/python` in plaats van `.venv\Scripts\python`).

## 2. Supabase starten

Kopieer eerst de env van de edge functions (de dev-escape staat daarin standaard uit):

```powershell
Copy-Item supabase\functions\.env.example supabase\functions\.env
```

```bash
npm run db:start
```

De eerste keer downloadt dit de Docker-images. Bij de eerste start worden de
migraties toegepast. Daarna:

- Studio: http://127.0.0.1:54323
- Mailpit (inlogcodes): http://127.0.0.1:54324
- `npm run db:reset` bouwt de database opnieuw op (alle data weg, importeer daarna opnieuw)
- Na een wijziging in `supabase/functions/.env` of `supabase/config.toml`: `npm run db:stop` en `npm run db:start`

## 3. OSM-vuilbakken importeren

```powershell
.venv\Scripts\python scripts\osm\osm_bins.py all
.venv\Scripts\python scripts\import-bins\import_bins.py
```

Het eerste script haalt de regio op (gecachet in `config/region.json`), downloadt
`belgium-latest.osm.pbf` (gecachet 7 dagen) en schrijft `data/bins.geojson`. Het
tweede doet een upsert en zet uit OSM verdwenen vuilbakken op `removed`.

## 4. Admin-gebruiker

Meld je eerst één keer aan in de app (stap 5), zodat je account bestaat. Maak het
daarna admin in Studio → SQL editor:

```sql
update public.profiles set is_admin = true
where id = (select id from auth.users where email = 'jij@voorbeeld.be');
```

## 5. App starten in Expo Go

```powershell
Copy-Item app\.env.example app\.env.local
```

Vul in `app/.env.local` in:

- `EXPO_PUBLIC_SUPABASE_URL=http://<PC_HOST>:54321`
- `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`: de "Publishable" key uit `npm run supabase -- status`
- `REACT_NATIVE_PACKAGER_HOSTNAME=<PC_HOST>`

`<PC_HOST>` is het adres waarop je iPhone je pc bereikt: het LAN-IP (zelfde wifi,
zie `ipconfig`) of het Tailscale-IP (mobiele data, zie hieronder). Het moet
`.env.local` zijn: Expo leest `REACT_NATIVE_PACKAGER_HOSTNAME` alleen uit
`.local`-bestanden.

```bash
cd app
npx expo start --clear
```

Scan de QR-code met de camera van je iPhone. Inloggen gaat met een code van 6
cijfers per e-mail; lokaal komt die mail in Mailpit (zie hierboven).

De firewall moet poort 54321 (Supabase) en 8081 (Metro) toelaten op het netwerk
dat je gebruikt; zie het firewallcommando hieronder.

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

2. **Firewall** (eenmalig, PowerShell als administrator). Docker Desktop krijgt
   bij installatie vaak alleen toegang op "openbare" netwerken, terwijl Windows het
   Tailscale-netwerk als "privé" ziet. Deze regel laat Supabase (54321), Mailpit
   (54324) en Metro (8081) alleen toe vanaf je eigen Tailscale-apparaten:

   ```powershell
   New-NetFirewallRule -DisplayName "Zwerfvuil dev via Tailscale" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 54321,54324,8081 -InterfaceAlias Tailscale -RemoteAddress 100.64.0.0/10 -Profile Private
   ```

   Verwijderen kan later met `Remove-NetFirewallRule -DisplayName "Zwerfvuil dev via Tailscale"`.

3. **App-config**: zet in `app/.env.local` beide adressen op het Tailscale-IP:

   ```
   EXPO_PUBLIC_SUPABASE_URL=http://<TAILSCALE_IP>:54321
   REACT_NATIVE_PACKAGER_HOSTNAME=<TAILSCALE_IP>
   ```

   Expo zet `EXPO_PUBLIC_*` vast in de bundel: herstart na een wijziging met
   `npx expo start --clear`.

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
- Terug naar wifi thuis kan via Tailscale gewoon verder; overschakelen naar het
  LAN-IP is niet nodig.

## Dev: nep-locatie (thuis testen)

1. Zet `ALLOW_FAKE_LOCATION=true` in `supabase/functions/.env` en herstart
   Supabase (`npm run db:stop` en `npm run db:start`).
2. In de app (alleen in dev): houd het infovak bovenaan de kaart 1,5 seconde
   ingedrukt. Tik daarna op de kaart om je locatie te kiezen.
3. Zet het daarna terug op `false`. De server negeert de vlag sowieso als Supabase
   niet lokaal draait.

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
.venv\Scripts\python -m unittest discover -s scripts/osm
.venv\Scripts\python -m unittest discover -s scripts/import-bins
```

`db:test`, `test:functions:integration` en de import-tests hebben een draaiende
Supabase nodig. De integratietests maken tijdelijke gebruikers en data aan en
ruimen die zelf op.

## Data en licentie

Vuilbakdata © OpenStreetMap contributors, beschikbaar onder de
[Open Database License](https://www.openstreetmap.org/copyright).
