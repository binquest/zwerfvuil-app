# Voor er echte gebruikers bij komen

Keuzes die voor de MVP (één tester, lokale Supabase, development build) volstaan, maar niet
voor echte gebruikers. Wordt aangevuld telkens zo'n keuze gemaakt wordt.

## Moderatie en punten

- [ ] **Admins mogen hun eigen check-ins niet goedkeuren.** `review_checkin` laat
  nu toe dat een admin zijn eigen check-in goedkeurt (handig om alleen te testen).
  Weiger in `review_checkin` als `checkin.user_id = auth.uid()`, en hetzelfde in
  `review_bin_report` voor eigen meldingen, `revoke_checkin` en `adjust_points`
  (een admin kan nu zijn eigen punten corrigeren; alleen `details.by` in de ledger
  legt vast wie).
- [x] **Goedkeuringen kunnen niet teruggedraaid worden.** Opgelost in gamification
  fase 1a: `revoke_checkin(id, reason)` en de tab "Goedgekeurd" in Beheer. Nog open:
  herroepen kan zonder termijn, en een herroeping ongedaan maken kan alleen in Studio
  (status en `revoked_*` terugzetten; de ledger volgt vanzelf).
- [ ] **Redenen zijn vrije tekst die de gebruiker ziet.** Afwijzen en herroepen
  gebruiken in de app drie vaste redenen of een eigen tekst (max. 200 tekens); de
  gebruiker ziet die in de historiek, net als de reden van een correctie. Voor echte
  gebruikers: een vaste lijst met nette, vriendelijke teksten (en geen interne
  notities in die tekst).
- [ ] **Punten kunnen negatief worden.** De controle `points >= 0` is weg (de ledger
  is de waarheid, en een herroeping mag nooit falen). Een negatieve correctie of een
  herroeping na een correctie kan een profiel onder 0 brengen; de ranglijst laat
  wie op 0 of lager staat weg, het profiel toont het getal.
- [ ] **Audit log.** Alleen `reviewed_by`/`reviewed_at` worden bewaard. Wijzigingen
  aan `eligible_override` (uitsluiten/toelaten) laten geen spoor na.
- [ ] **Admins beheren.** Admin worden of af gaat nu via `scripts/seed-admin`
  (alleen lokale database) of SQL. Er is geen manier om admins te zien of te
  beheren in de app, en het script maakt een ontbrekend account meteen bevestigd
  aan (zonder e-mailverificatie).

## Fraude en misbruik

- [ ] **Device-integriteit.** iOS meldt nooit of een locatie gesimuleerd is
  (`mocked` bestaat alleen op Android). Zonder App Attest / Play Integrity (buiten
  scope van de MVP) is gps-spoofing niet te detecteren; alleen de foto en de
  moderatie houden het tegen.
- [ ] **Rate limit op geweigerde pogingen.** De cooldown en de daglimiet tellen
  alleen opgeslagen check-ins. Geweigerde pogingen (te ver, mock, …) kunnen
  onbeperkt herhaald worden; elke poging uploadt en wist een foto. Voeg een limiet
  per gebruiker/IP toe op `submit-checkin`.
- [ ] **Meldingen buiten de testregio** worden alleen in de app geweigerd, niet op
  de server. Sla de regio op in de database en controleer ze in de insert-policy
  van `bin_reports`.
- [ ] **Concurrency-tests.** De advisory locks in `record_checkin` en de
  meldingslimiet zijn niet automatisch getest met parallelle requests.

## Netwerk en betrouwbaarheid

- [ ] **Geen wachtrij bij slecht bereik.** Mislukt het versturen (geen netwerk,
  timeout na 60 s), dan kan de gebruiker het opnieuw proberen zolang het
  camerascherm open is; sluit hij het, dan is de foto weg. Overweeg een lokale
  wachtrij die later verstuurt (met de locatie en tijd van de foto).
- [ ] **Idempotentie.** Komt een check-in wel aan maar gaat het antwoord verloren
  (timeout), dan krijgt "Opnieuw proberen" de cooldown-melding. Laat de app een
  check-in-id meesturen zodat de server een herhaalde poging herkent.
- [ ] **Uploadgrootte.** Foto's zijn na compressie ~130–450 KB (1280 px breed,
  JPEG 0,7). Meet dit op echte toestellen en stel een limiet in de app in, niet
  alleen op de server (5 MB).

## Opslag en opruimen

- [ ] **Wees-foto's.** Als `submit-checkin` crasht tussen upload en
  `record_checkin`, of als een melding faalt na de upload, blijft de foto staan.
  Gebruikers kunnen hun meldingsfoto's niet zelf wissen. Plan een opruimjob voor
  foto's zonder bijhorende rij.
- [ ] **Bewaartermijn** voor foto's en `checkins.user_geom` (exacte locaties)
  vastleggen en automatisch toepassen.

## Privacy (GDPR)

- [ ] Privacyverklaring: welke data (e-mail, locaties, foto's), waarom, hoe lang.
- [ ] Account en data verwijderen vanuit de app.
- [ ] `display_name` wordt afgeleid van het deel vóór de `@` van het
  e-mailadres en staat **op de ranglijst, zichtbaar voor iedereen**, zodra iemand
  punten heeft. Gebruikers kunnen hem wijzigen in Profiel, maar pas achteraf. Vraag
  een naam bij de eerste aanmelding, of begin met een neutrale naam.
- [ ] De sessie staat in `expo-sqlite`-localStorage (niet versleuteld). Overweeg
  versleutelde opslag voor het refresh token.

## Infrastructuur en configuratie

- [ ] **E-mail**: lokaal gaan inlogcodes naar Mailpit. Productie heeft een echte
  SMTP-provider nodig, de templates in `supabase/templates/` in het gehoste
  project, en bewust gekozen limieten (lokaal 1 mail per seconde per gebruiker;
  code 1 uur geldig, overweeg korter).
- [ ] **Gehoste Supabase met HTTPS** in plaats van HTTP over LAN/Tailscale; eigen
  keys; `ALLOW_FAKE_LOCATION` nooit zetten. Zet `APP_ENV=production` voor de
  functions (dan weigert `submit-checkin` te starten zolang `ALLOW_FAKE_LOCATION`
  bestaat) en markeer de database als `production` in `private.app_environment`
  (dan weigert `record_checkin` nep-locaties). Op staging is dat al zo.
- [ ] **Apple Developer Program (99 dollar per jaar) voor de beta.** Staging-builds
  zijn nu ongesigneerde IPA's die elke tester zelf signeert met een gekocht
  reseller-certificaat. Dat volstaat niet voor echte gebruikers: Apple trekt zulke
  certificaten in (de app start dan niet meer), elk toestel moet in het profiel
  staan, en het past niet bij Apples voorwaarden. Met een eigen
  Developer-Program-account: TestFlight voor de beta, App Attest tegen
  gps-spoofing en vervalste clients (zie "Device-integriteit"), en een
  certificaat dat van ons is.
- [ ] **`expo` en `jest-expo` staan in `expo.install.exclude`** (`app/package.json`),
  dus `expo install --check` en `expo-doctor` controleren hun versie niet meer.
  `expo` 57.0.28 en `jest-expo` 57.0.6 brengen `expo-modules-core` 57.0.22 mee,
  dat `react-native-worklets` 0.13 (via `expo-router`) niet aanvaardt; npm zet het
  dan genest en Jest vindt het niet meer. Probeer bij de volgende Expo-patch:
  haal beide uit `exclude`, `npx expo install --fix`, en controleer `npm test`
  en `npx --yes expo-doctor`.
- [ ] **De iOS-splash gebruikt `enableFullScreenImage_legacy`** van
  `expo-splash-screen`, volgens Expo een overgangsoptie die zal verdwijnen. De
  workflow faalt dan (`app/scripts/check-ios-assets.mjs`). Alternatieven: een
  eigen config-plugin voor het storyboard, of het gecentreerde icoon zoals op
  Android.
- [ ] **Staging-builds hangen af van het gratis tegoed van GitHub Actions**
  (ongeveer 200 macOS-minuten per maand, zonder betaalmethode: daarna geblokkeerd).
- [ ] **Store build** (EAS). Getest wordt nu met "Zwerfvuil Dev" (Release tegen
  staging, ongesigneerd via GitHub Actions, updates via EAS Update; README stap 6),
  met de eigen toestemmingsteksten uit `app.json`. Dev-modus zit in elke build en
  wordt door de server geweigerd in productie; `npm --prefix app run
  check:staging-bundle` bewijst dat de oude verborgen toggle en de dev-config niet in
  de bundel zitten. Voeg dezelfde controle toe voor de productiebuild (eigen
  profiel, eigen URL).
- [ ] **CORS**: `submit-checkin` antwoordt met `Access-Control-Allow-Origin: *`.
  Beperk dit als er geen webversie komt.
- [ ] **OSM-import plannen en bewaken**: de import draait nu manueel. De import
  weigert al lege bestanden en het verwijderen van meer dan 50% van de
  vuilbakken; voeg een planning en meldingen toe.

## Staging-VM (homeserver)

Zie `docs/STAGING.md`. Voor een wegwerpbare test-VM volstaat dit; een omgeving met
echte gebruikersdata vraagt meer.

- [ ] **`deploy` heeft sudo zonder wachtwoord.** Wie de SSH-key heeft, is root op de
  VM. Voor een omgeving met echte data: aparte rollen, of sudo met wachtwoord en
  alleen voor de nodige commando's.
- [ ] **Alleen Debian-security-updates gaan automatisch** (met een reboot om 04:30
  als dat nodig is). Docker, Tailscale en Debian-point-releases worden met de hand
  bijgewerkt; niemand krijgt een melding als daar een security-update voor klaarstaat.
- [ ] **Foto's en database-backups staan op één fysieke HDD, zonder tweede kopie.**
  De dataschijf van de VM (`/srv/bq-data`: Storage en de nachtelijke dumps) is één
  virtueel bestand op de HDD `media1tb-vzdump`; de vzdump sluit die schijf uit en
  staat op dezelfde HDD. Een defecte HDD = alle foto's weg. Nodig: een kopie op
  een ander toestel of offsite (versleuteld), en een geteste terugzetprocedure
  voor de foto's.
- [ ] **Database-dumps zijn niet versleuteld** en bevatten persoonsgegevens
  (e-mailadressen, locaties). Nu alleen beschermd door root-rechten op de VM.
- [ ] **De restore-test draait met de hand** (`vm/check-restore.sh`), niet
  automatisch; een backup die niet terug te zetten is, valt pas op bij die test.
- [ ] **Secrets hebben maar één kopie buiten de VM**: de vzdump van de VM, op de
  homeserver zelf. Voor een omgeving met echte data: een secrets-manager of een
  versleutelde kopie op een andere plek.
- [ ] **Geen monitoring of alerts**: valt de VM, de dataschijf of Docker uit, dan
  merkt niemand dat tot iemand test.
- [ ] **Supabase staat vast op een niet-uitgebrachte upstream-commit** (`ff80bb1`,
  na release 0.8.2) en wordt alleen met de hand bijgewerkt. Kies voor een omgeving
  met echte data een release, en volg de security-meldingen van de images.
- [ ] **Elke edge function krijgt de volledige container-omgeving**, ook
  `SUPABASE_DB_URL` (met het Postgres-wachtwoord), de service-role-key en het
  JWT-secret: zo werkt de upstream-router (`functions/main`). Elke functie heeft
  dus volledige databasetoegang; houd het aantal functies klein en review ze.
- [ ] **Secrets vervangen is niet gescript.** Een gelekte key vervangen vraagt
  handwerk (`utils/db-passwd.sh`, nieuwe JWT-keys, nieuwe app-build).
- [ ] **Logs (Logflare) hebben geen ingestelde bewaartermijn**; ze staan in de
  database `_supabase` op de systeemschijf. Volg de groei op, of stel een
  bewaartermijn in.
- [ ] **Staging verstuurt geen echte mail.** Inlogcodes komen in Mailpit, alleen
  via de SSH-tunnel leesbaar; testers zonder SSH-toegang krijgen hun code
  doorgegeven. Nodig: een domein, Brevo (gekozen) met SPF/DKIM, en de templates
  en limieten bewust instellen.
- [ ] **Het omgevingsmerkteken `private.app_environment` is één rij die elke
  databasebeheerder kan wijzigen.** Het beschermt tegen vergissingen (verkeerde
  database, verkeerde config), niet tegen iemand met `postgres`-rechten.

## App, punten en Dev-modus (oktober 2026)

- [ ] **Android.** De schermen gebruiken SwiftUI via `@expo/ui/swift-ui`; op
  Android crasht dat ("Unable to get view config"). Voor een Android-release:
  Jetpack Compose- of universele varianten van login, profiel, ranglijst,
  Dev-modus, bin-sheet en de knoppen.
- [ ] **Reeksen tellen inworpen die nog wachten.** Wordt een eerdere inworp later
  afgewezen of herroepen, dan worden de reeksen (en punten) van latere inworpen niet herrekend.
- [ ] **Een verdacht snel bonusantwoord krijgt toch +5** (alleen gemarkeerd, de
  admin ziet het). Beslis of dat zo blijft. `bin_need_answers` bevat verdachte
  antwoorden, met de vlag; filter ze in de analyse.
- [ ] **Puntenschaal.** Basis 10 en ×1,1 per week geven kleine sprongen (10 → max.
  21). Een grotere basis (bv. 100) maakt de onthulling sterker; het is één constante
  in `checkin_point_stages` (migratie) en `app/src/lib/points.ts`.
- [ ] **Vouchers bestaan nog niet.** Als ze komen: `is_test` en `test_points`
  negeren, met een test zoals `07_dev_mode.test.sql`.
- [ ] **EAS Update.** Updates zijn niet ondertekend (geen code signing in
  `expo-updates`) en de bundel staat op de servers van Expo, met de staging-URL en
  publishable key. Voor productie: code signing, en bewust kiezen tussen Expo en een
  eigen update-server.
- [ ] **Dev-modus in productie** weigert alleen als de productiedatabase als
  `production` gemarkeerd is (zie "Infrastructuur en configuratie"). Controleer dat
  bij het opzetten, en kijk `dev_audit_log` na.
- [ ] **Geluid van de onthulling draait op expo-audio** (`app/src/feedback/sfx/`):
  de app mixt alle geluiden van een onthulling in JS tot één WAV in de cache
  (maximaal 12 bestanden, ~0,3 MB per seconde geluid) en speelt die met één
  AVPlayer; beeld en haptiek volgen die op een audioklok. Losse AVPlayers per
  geluid blokkeerden de hoofdthread tot 150 ms. De spelers blijven geladen zodra
  de camera opent (met een actieve, mengende audiosessie). Dat is geen echte
  low-latency-audio-engine.
- [ ] **Reanimated staat vast op de versies van de IPA, niet op die van SDK 57.**
  `react-native-reanimated` 4.7.1, `react-native-worklets` 0.13.0 en
  `react-native-gesture-handler` 3.3.0 staan exact in `app/package.json` en in
  `expo.install.exclude` (fase 1a; de lockfile veranderde alleen van "peer" naar
  "dependency"). SDK 57 verwacht 4.5.x / 0.10.x: kijk daarnaar bij de volgende
  native build. `update:dev` weigert te publiceren als een native pakket afwijkt van
  `app/native-versions.json`. Is er op toestellen nog hoorbare jitter of
  vertraging, dan stap je over op `react-native-audio-api` (native: nieuwe IPA en
  runtimeversie). Meet ook het geheugen en de starttijd van de 35 players op een
  oudere iPhone.
- [ ] **`app/native-versions.json` wordt met de hand vastgelegd** (`npm run
  native:record`, in de commit van een nieuwe IPA, na het ophogen van
  `DEV_RUNTIME_VERSION`). De workflow `ios-dev.yml` controleert niet dat de IPA bij
  die lijst past. Laat de workflow de lijst zelf controleren (`npm run native:check`)
  voor hij bouwt.

## Licentie (ODbL)

- [ ] De `bins`-tabel is afgeleid van OpenStreetMap. De attributie staat in de app;
  check de share-alike-verplichtingen van de ODbL als de database (of een
  afgeleide) publiek gebruikt of gedeeld wordt. Overweeg goedgekeurde meldingen
  terug te geven aan OSM.
