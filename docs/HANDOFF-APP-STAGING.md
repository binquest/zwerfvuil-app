# Overdracht: hoe de app met de staging-server praat

Hoe de iOS-apps gebouwd en bijgewerkt worden zodat ze verbinden met de
staging-server op de homeserver (`binquest-staging`, via Tailscale), en wat je moet
weten om dat over te nemen. Stand: 15 oktober 2026.

Dit is een samenvatting met verwijzingen. De details staan in `docs/STAGING.md`
(server, IPA, Dev-modus, cofounder-gids), `README.md` (lokale setup, stap 6
"Zwerfvuil Dev op je iPhone") en `docs/PRE-BETA.md` (wat nog niet goed genoeg is
voor echte gebruikers).

Echte namen, IP-adressen en keys staan nergens in git. Hieronder:
`<tailnet>` is de naam van het tailnet (de ts.net-naam), `<TAILSCALE_IP_VM>` het
Tailscale-IP van de VM.

## In één beeld

De API (voor beide apps):

```
iPhone: "Zwerfvuil Gent" en/of "Zwerfvuil Dev", Tailscale-app aan
   |
   |  HTTPS naar https://binquest-staging.<tailnet>.ts.net
   |  (MagicDNS-naam, via WireGuard over het tailnet, nooit via het internet)
   v
binquest-staging: Debian 13-VM op Proxmox, thuis op het LAN
   |  nftables: op tailscale0 alleen tcp/443 open
   |
   |  tailscale serve: TLS met een certificaat van Tailscale, alleen 4 paden
   |    /auth/v1  /rest/v1  /storage/v1  /functions/v1
   v
http://127.0.0.1:8000: Envoy (API-gateway van self-hosted Supabase in Docker)
   |
   v
Auth (GoTrue) · PostgREST · Storage · Edge functions (submit-checkin) · Postgres
```

Nieuwe JavaScript (alleen Zwerfvuil Dev):

```
pc: npm --prefix app run update:dev    (bundel met het staging-profiel)
   |
   |  eas update, kanaal "dev", runtimeversie 1
   v
Expo: u.expo.dev (EAS-project @binquest/zwerfvuil-app)
   |
   |  bij het openen van de app (over het internet, geen Tailscale nodig)
   v
iPhone: "Zwerfvuil Dev" herstart met de nieuwe JavaScript
```

Alles buiten die vier paden (Studio, `/pg`, `/analytics`, `/graphql`, realtime)
geeft via het tailnet 404. Studio, Postgres en Mailpit bereik je alleen via een
SSH-tunnel vanaf het LAN. Tailscale Funnel (publiceren naar het internet) staat
uit en mag niet aan.

## Twee app-builds, één server

Er zijn twee iOS-builds. **Allebei** zijn Release-builds tegen de staging-server en
staan naast elkaar op de iPhone. Getest wordt in **Zwerfvuil Dev**: die krijgt
nieuwe JavaScript zonder nieuwe IPA. Metro, Expo Go en een development build
(`expo-dev-client`) worden niet meer gebruikt.

| | Staging-app | Zwerfvuil Dev |
|---|---|---|
| Naam, bundle-ID | Zwerfvuil Gent, `be.zwerfvuil.app` | Zwerfvuil Dev, `be.zwerfvuil.app.dev` |
| Backend | staging-VM: `https://binquest-staging.<tailnet>.ts.net` | dezelfde staging-VM |
| JavaScript | in de IPA (Release, Hermes), vast | in de IPA, daarna **EAS Update** op kanaal `dev` |
| Nieuwe JavaScript | nieuwe IPA | `npm --prefix app run update:dev -- "<wat er veranderd is>"` |
| Nieuwe IPA nodig | bij elke wijziging | alleen bij native wijzigingen (zie "Wanneer een nieuwe IPA") |
| Workflow | `.github/workflows/ios-staging.yml`, tag `ios-staging-*` | `.github/workflows/ios-dev.yml`, tag `ios-dev-*` |
| Configuratie | GitHub-omgeving `staging` (2 secrets) | dezelfde 2 secrets; EAS-project en runtimeversie in `app/app.config.ts` |
| http toegelaten | nee, alleen https | nee, alleen https |
| Dev-modus | ja, voor admins (server beslist) | ja, voor admins (server beslist) |

Beide IPA's zijn **ongesigneerd**: er is geen Apple Developer Program. Elke tester
signeert de IPA zelf in een sideload-app, met een eigen (reseller)certificaat. Er
staat geen Apple-certificaat, profiel of wachtwoord op GitHub.

De code van beide builds staat op `ios26-redesign` (vertakt van `step-6-staging`,
dat erin zit), met een PR naar `main`.

## Hoe het serveradres in de app komt

Er is geen configuratie die de app tijdens het draaien ophaalt. Het adres en de key
worden **bij het bundelen in de JavaScript gezet**: in de IPA, en bij Zwerfvuil Dev
ook in elke EAS Update. Ander serveradres = nieuwe IPA (en nieuwe updates).

1. **De app leest twee publieke waarden** in `app/src/lib/env.ts`:
   - `EXPO_PUBLIC_SUPABASE_URL`, voor staging `https://binquest-staging.<tailnet>.ts.net`;
   - `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, de publishable key (`sb_publishable_…`)
     van staging. Die is publiek van aard, want ze zit in elke build.

   Daarnaast is er `EXPO_PUBLIC_APP_ENV=staging`. Daarmee weigert de app een URL
   zonder `https://` en toont ze een foutmelding in plaats van te verbinden.
   `app/src/lib/supabase.ts` maakt de Supabase-client met die URL en key, en
   `app/src/lib/api.ts` roept `<URL>/functions/v1/submit-checkin` aan.
2. **Het staging-profiel**, `app/scripts/staging.mjs`, draait elk commando met:
   - de waarden uit `app/staging.env.local` (gitignored; voorbeeld in
     `app/staging.env.example`);
   - `EXPO_PUBLIC_APP_ENV=staging`;
   - `EXPO_NO_DOTENV=1`. Expo laadt dan geen enkel `.env`-bestand, dus de lokale
     dev-waarden uit `app/.env.local` kunnen nooit in een staging-build of update
     belanden.

   Het controleert ook dat de URL `https://<naam>.<tailnet>.ts.net` is en de key een
   publishable key, en het toont geen waarden.
3. **In GitHub Actions** (`ios-staging.yml` en `ios-dev.yml`, dezelfde stappen):
   1. De omgeving `staging` heeft twee secrets, `EXPO_PUBLIC_SUPABASE_URL` en
      `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Je zet ze vanaf de pc met
      `node app/scripts/github-secrets.mjs` (leest `staging.env.local`, stuurt via
      stdin, toont niets).
   2. De workflow schrijft ze naar `app/staging.env.local` op de runner.
   3. `npm run check:staging-bundle` exporteert de bundel met het staging-profiel en
      controleert:
      - dat de staging-URL en -key erin staan;
      - dat er geen lokale waarden, geen nep-locatie-toggle en geen Mailpit-hint in
        zitten.
   4. `expo prebuild` en `xcodebuild archive` (Release) draaien **onder
      `staging.mjs`**. De JavaScript wordt pas tijdens `xcodebuild` gebundeld, dus ook
      die stap moet de staging-waarden zien. Voor Zwerfvuil Dev zet de workflow
      daarnaast `APP_VARIANT=development`: `app/app.config.ts` maakt dan de naam, het
      bundle-ID, de runtimeversie en de EAS Update-instellingen.
   5. De gebouwde app wordt nog eens gecontroleerd:
      - het juiste bundle-ID, geen profiel, geen handtekening;
      - dezelfde bundelcontrole op `main.jsbundle`;
      - staging: icoon en splash in `Assets.car`;
      - Zwerfvuil Dev: EAS Update aan, URL `https://u.expo.dev/…`, kanaal `dev`, een
        runtimeversie, Liquid Glass niet uitgeschakeld, geen microfoontoestemming.
   6. Het artifact is `ZwerfvuilGent-staging-unsigned-<run>.ipa` of
      `ZwerfvuilDev-unsigned-<run>.ipa`, 7 dagen bewaard.
4. **Een EAS Update voor Zwerfvuil Dev** (`app/scripts/update-dev.mjs`, via
   `npm run update:dev`) doet hetzelfde op de pc:
   1. de bundel exporteren met het staging-profiel en `APP_VARIANT=development`
      (naar `app/dist-update/`);
   2. die export controleren met `check-staging-bundle`;
   3. precies die export publiceren: `eas update --skip-bundler --channel dev
      --environment preview`. De omgeving `preview` op EAS heeft geen variabelen;
      de waarden komen uit `staging.env.local`.

> EAS wordt alleen voor updates gebruikt, niet om te bouwen: de IPA's komen uit
> GitHub Actions. De profielen in `app/eas.json` en de EAS-omgeving `preview`
> dienen alleen voor `eas update`.

## Zwerfvuil Dev bijwerken (EAS Update)

```powershell
npm --prefix app run update:dev -- "wat er veranderd is"
```

- **Eenmalig** op de pc: `npx eas-cli login` (Expo-organisatie `binquest`).
- **Op de iPhone:** open de app. Bij het openen kijkt ze naar een update
  (`checkAutomatically: ON_LOAD`) en downloadt die op de achtergrond; zodra die
  binnen is, vraagt ze om te herstarten. Profiel → "Zoek naar updates" doet hetzelfde
  met de hand, en Profiel → App → Versie toont welke update draait. Desnoods: app
  twee keer volledig sluiten en openen.
- **Een update terugdraaien:** zet de vorige commit terug (of check die uit) en
  publiceer opnieuw met `update:dev`. De laatst gepubliceerde update op `dev` wint.
- **Let op:** een update staat op de servers van Expo, met de staging-URL en de
  publishable key erin. Die staan ook in elke IPA, en de URL werkt alleen op het
  tailnet. Updates zijn niet ondertekend: zie `docs/PRE-BETA.md`.

### Wanneer een nieuwe IPA

Een update bereikt alleen apps met **dezelfde runtimeversie** (`DEV_RUNTIME_VERSION`
in `app/app.config.ts`, nu `1`). Die zet je met de hand. Verhoog hem en bouw een
nieuwe Zwerfvuil Dev-IPA bij elke native wijziging:

- een package met native code toevoegen of bijwerken (lockfile);
- een config-plugin, `app/app.json` of `app/app.config.ts` wijzigen.

Alleen JavaScript, geluiden of afbeeldingen veranderen (zoals de puntenonthulling)?
Dan volstaat `update:dev`.

## De serverkant: hoe de VM bereikbaar is

Alles wat de VM verandert, staat als script in `infra/staging/vm/` en draait vanaf
de pc met `.venv\Scripts\python infra\staging\stagingctl.py run vm/<script>.sh`.
Elk script mag opnieuw gedraaid worden.

| Onderdeel | Script / bestand | Wat het doet |
|---|---|---|
| Tailscale | `vm/60-tailscale.sh` | Officiële apt-repo, `--hostname=binquest-staging`, `--accept-dns=false` (DNS blijft die van het LAN), `--accept-routes=false` (de VM zit zelf op het LAN). Key expiry staat uit (admin console). |
| HTTPS-publicatie | `vm/75-tailscale-serve.sh` | `tailscale serve --https=443 --set-path=<pad>` voor de vier API-paden, naar `http://127.0.0.1:8000<pad>`. Certificaat van Tailscale. Faalt als Funnel ergens aan staat. |
| Firewall | `files/etc/bq/firewall.nft` | Op `tailscale0` alleen tcp/443. udp/41641 voor directe WireGuard-verbindingen. SSH (22) alleen vanaf het LAN, nooit via `tailscale0`. |
| Supabase | `vm/70-supabase.sh` | Self-hosted Supabase in Docker (gepind op upstream-commit `ff80bb1`), Envoy-gateway op `127.0.0.1:8000`, nieuwe `sb_`-keys. Docker-poorten alleen op `127.0.0.1`. |
| Deployen | `stagingctl.py migrate --apply`, `stagingctl.py deploy` (`vm/80-deploy.sh`) | Migraties via `supabase db push` door een SSH-tunnel; daarna staat de database gemarkeerd als `staging`. Edge functions en mailtemplates; de functions draaien met `APP_ENV=staging`. Een nep-locatie mag alleen in Dev-modus, voor admins. |
| Overzicht | `stagingctl.py status` | Toont onder meer de serve-configuratie en `funnel: off`. Verandert niets. |

Waarom Tailscale serve en geen eigen domein of reverse proxy:

- De app krijgt **echte HTTPS** (iOS eist dat in Release), zonder open poorten naar
  het internet en zonder eigen certificaat.
- Alleen wie op het tailnet zit, of de node gedeeld kreeg, bereikt de API.
- Studio en de database blijven volledig van het tailnet af.

## Een nieuwe IPA bouwen

1. Zijn de URL of de key veranderd? Pas dan `app/staging.env.local` aan en draai
   `node scripts/github-secrets.mjs` in de map `app`.
2. Voor Zwerfvuil Dev met native wijzigingen: verhoog eerst `DEV_RUNTIME_VERSION`.
3. Start de build met een tag op de commit die je wilt bouwen:

   ```powershell
   git tag ios-dev-20261015-1200
   git push origin ios-dev-20261015-1200
   ```

   Voor de staging-app: `ios-staging-<yyyymmdd-hhmm>`. `workflow_dispatch` werkt pas
   als de workflow op `main` staat.
4. Een build duurt 15 à 18 minuten en kost evenveel van de ongeveer 200 gratis
   macOS-minuten per maand. `binquest` staat op GitHub Free zonder betaalmethode: is
   het tegoed op, dan blokkeren de builds tot de volgende maand.
5. Download de IPA: GitHub → Actions → de run → Artifacts. Signeer hem in de
   sideload-app en installeer hem. Daarna kunnen updates met dezelfde runtimeversie
   erop.

## Op de iPhone

- **Tailscale-app aan**, ingelogd op het tailnet. Wie geen lid is (de cofounder),
  krijgt de node `binquest-staging` gedeeld. Een tailnet-ACL beperkt gedeelde
  gebruikers (`autogroup:shared`) tot tcp/443 op deze node: zie `docs/STAGING.md`,
  "Tailnet-ACL voor gedeelde gebruikers". Controleer of die ACL al actief is.
- De iPhone vindt `binquest-staging.<tailnet>.ts.net` via MagicDNS in de
  Tailscale-app. Zonder Tailscale lost de naam niet op en kan de app de server niet
  bereiken. EAS Updates komen wel binnen zonder Tailscale: die komen van Expo.
- **Inloggen** gebeurt met een code per e-mail. Staging verstuurt nog geen echte
  mail: de codes komen in Mailpit op de VM, alleen via de SSH-tunnel leesbaar
  (`stagingctl.py tunnel`, dan `http://localhost:58025`). Wie geen SSH heeft, krijgt
  de code doorgegeven. Later komt Brevo (zie `docs/PRE-BETA.md`).
- **Admins** vinden in de app Beheer → Dev-modus: de puntenonthulling bekijken (met
  metingen), een reeks forceren, een testlocatie kiezen, testdata resetten. Zie
  `docs/STAGING.md`, "Dev-modus".

## Controleren en problemen oplossen

Is de API bereikbaar? Vanaf een toestel op het tailnet:

```powershell
curl.exe -s -o NUL -w "%{http_code}" https://binquest-staging.<tailnet>.ts.net/rest/v1/
```

- Een HTTP-code van Supabase (bv. 401, want er gaat geen API key mee): bereikbaar.
- Een timeout: Tailscale staat uit, de node is niet (meer) gedeeld, of de VM draait
  niet.
- Een 404 op een van de vier paden: de serve-configuratie klopt niet. Draai
  `vm/75-tailscale-serve.sh` opnieuw.

| Probleem | Oorzaak en oplossing |
|---|---|
| App: "Kan geen verbinding maken", of laden blijft hangen | Tailscale op de iPhone staat uit, of de gedeelde node is niet aanvaard. |
| App toont een configuratiefout | De build of update kreeg geen of een verkeerde URL of key. Controleer `staging.env.local` en de secrets van de omgeving `staging`. |
| Zwerfvuil Dev krijgt een update niet | De runtimeversie van de update verschilt van die in de IPA (native wijziging: nieuwe IPA nodig), of de app is nog niet opnieuw gestart. Profiel → "Zoek naar updates"; Profiel → App → Versie toont wat draait. |
| Zwerfvuil Dev crasht na een update | expo-updates valt bij een crash bij het opstarten terug op de vorige update. Publiceer daarna de vorige commit opnieuw met `update:dev`. |
| App opent niet meer | Het certificaat van de sideload-app is ingetrokken. Signeer opnieuw. |
| Geen inlogcode | Normaal op staging: de code staat in Mailpit (via de tunnel). |
| Alles werkte, nu niet meer na een tailnet-wijziging | Is de ts.net-naam veranderd (tailnet of hostname hernoemd)? Pas `staging.env.local` en de secrets aan, bouw nieuwe IPA's en publiceer een update: de URL zit vast in de JavaScript. |

## Wanneer je iets moet aanpassen

| Verandering | Wat te doen |
|---|---|
| ts.net-naam of publishable key verandert | `app/staging.env.local`, dan `node scripts/github-secrets.mjs`, dan nieuwe IPA's |
| Schermen, punten-onthulling, geluiden (alleen JavaScript of assets) | `npm --prefix app run update:dev -- "…"` |
| Een package met native code, een config-plugin, `app.json`/`app.config.ts` | `DEV_RUNTIME_VERSION` verhogen, nieuwe Zwerfvuil Dev-IPA |
| De app heeft een extra API-pad nodig (bv. realtime) | Voeg het toe aan `PATHS` in `vm/75-tailscale-serve.sh` en draai het script opnieuw. Doe dat bewust: elk pad is bereikbaar voor wie op het tailnet zit. |
| Nieuwe tester | Node delen in de Tailscale admin console (ACL actief?), IPA en sideload-certificaat. Zie de cofounder-gids in `docs/STAGING.md`. |
| Naar echte gebruikers | Zie `docs/PRE-BETA.md`: gehoste Supabase, Apple Developer Program (TestFlight), echte mail, ondertekende updates. Tailscale is alleen voor staging bedoeld. |

## Waar de geheimen staan (niet in git)

| Wat | Waar |
|---|---|
| Staging-URL en publishable key (pc) | `app/staging.env.local` (gitignored) |
| Dezelfde twee voor de builds | GitHub → `binquest/zwerfvuil-app` → Settings → Environments → `staging` |
| EAS-login voor updates | `npx eas-cli login` op de pc (account in de Expo-organisatie `binquest`). Het EAS-project-ID in `app/app.config.ts` is geen geheim. |
| Alle Supabase-secrets van staging | Op de VM in `/opt/binquest/secrets/supabase.env` (chmod 600). Uitlezen met `ssh binquest-staging "sudo bq-secret <NAAM>"`, in je eigen terminal. |
| SSH-toegang tot de VM | Alias `binquest-staging` in `~/.ssh/config` op de pc, eigen key. Alleen vanaf het LAN. |
| LAN-bereik voor de scripts | `infra/staging/.env` (gitignored) |

## Bestanden

| Bestand | Rol |
|---|---|
| `app/src/lib/env.ts` | Leest URL, key en `APP_ENV`; weigert http op staging |
| `app/src/lib/supabase.ts`, `app/src/lib/api.ts` | Supabase-client en de aanroep van `submit-checkin` |
| `app/scripts/staging.mjs` | Staging-profiel: waarden uit `staging.env.local`, geen `.env`, validatie |
| `app/scripts/update-dev.mjs` | `npm run update:dev`: exporteren, controleren en als EAS Update publiceren (kanaal `dev`) |
| `app/scripts/check-staging-bundle.mjs` | Controleert de bundel: staging-config wel, dev-config en nep-locatie niet |
| `app/scripts/github-secrets.mjs` | Zet de twee secrets in de GitHub-omgeving `staging` |
| `app/scripts/check-ios-assets.mjs` | Controleert icoon en splash na de prebuild |
| `app/app.json`, `app/app.config.ts` | App-config; `app.config.ts` maakt met `APP_VARIANT=development` Zwerfvuil Dev (naam, bundle-ID, runtimeversie, EAS Update) |
| `app/src/components/UpdatePrompt.tsx` | Vraagt om te herstarten als een update binnen is; "Zoek naar updates" in Profiel |
| `.github/workflows/ios-staging.yml` | Bouwt de ongesigneerde staging-IPA |
| `.github/workflows/ios-dev.yml` | Bouwt de ongesigneerde Zwerfvuil Dev-IPA (Release, staging, EAS Update) |
| `infra/staging/vm/60-tailscale.sh` | Tailscale op de VM |
| `infra/staging/vm/75-tailscale-serve.sh` | Publiceert de vier API-paden via HTTPS op het tailnet |
| `infra/staging/files/etc/bq/firewall.nft` | Firewall van de VM |
| `infra/staging/stagingctl.py` | Scripts draaien, status, SSH-tunnel |
| `docs/STAGING.md` | Volledige runbook van de VM, de IPA's, Dev-modus en de cofounder-gids |
