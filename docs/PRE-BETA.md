# Voor er echte gebruikers bij komen

Keuzes die voor de MVP (één tester, lokale Supabase, Expo Go) volstaan, maar niet
voor echte gebruikers. Wordt aangevuld telkens zo'n keuze gemaakt wordt.

## Moderatie en punten

- [ ] **Admins mogen hun eigen check-ins niet goedkeuren.** `review_checkin` laat
  nu toe dat een admin zijn eigen check-in goedkeurt (handig om alleen te testen).
  Weiger in `review_checkin` als `checkin.user_id = auth.uid()`, en hetzelfde in
  `review_bin_report` voor eigen meldingen.
- [ ] **Goedkeuringen kunnen niet teruggedraaid worden.** Een fraude die later
  ontdekt wordt, kan geen punten meer kosten. Voorzie een admin-actie die een
  goedgekeurde check-in herroept en de punten aftrekt, met reden.
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
- [ ] `display_name` wordt nu afgeleid van het deel vóór de `@` van het
  e-mailadres en is zichtbaar voor admins. Laat gebruikers zelf een naam kiezen.
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
- [ ] **Staging-builds hangen af van het gratis tegoed van GitHub Actions**
  (ongeveer 200 macOS-minuten per maand, zonder betaalmethode: daarna geblokkeerd).
- [ ] **Development build / store build** (EAS) in plaats van Expo Go, zodat de
  eigen toestemmingsteksten uit `app.json` gebruikt worden. De verborgen
  nep-locatie-toggle bestaat alleen in dev (`__DEV__`); `npm --prefix app run
  check:staging-bundle` bewijst dat voor de staging-bundel. Voeg dezelfde controle
  toe voor de productiebuild (eigen profiel, eigen URL).
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

## Licentie (ODbL)

- [ ] De `bins`-tabel is afgeleid van OpenStreetMap. De attributie staat in de app;
  check de share-alike-verplichtingen van de ODbL als de database (of een
  afgeleide) publiek gebruikt of gedeeld wordt. Overweeg goedgekeurde meldingen
  terug te geven aan OSM.
