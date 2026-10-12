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
  keys; `ALLOW_FAKE_LOCATION` nooit zetten (de functie negeert het al als
  `SUPABASE_URL` niet lokaal is).
- [ ] **Development build / store build** (EAS) in plaats van Expo Go, zodat de
  eigen toestemmingsteksten uit `app.json` gebruikt worden. De verborgen
  nep-locatie-toggle bestaat alleen in dev (`__DEV__`); controleer dat in de
  productiebuild.
- [ ] **CORS**: `submit-checkin` antwoordt met `Access-Control-Allow-Origin: *`.
  Beperk dit als er geen webversie komt.
- [ ] **OSM-import plannen en bewaken**: de import draait nu manueel. De import
  weigert al lege bestanden en het verwijderen van meer dan 50% van de
  vuilbakken; voeg een planning en meldingen toe.

## Licentie (ODbL)

- [ ] De `bins`-tabel is afgeleid van OpenStreetMap. De attributie staat in de app;
  check de share-alike-verplichtingen van de ODbL als de database (of een
  afgeleide) publiek gebruikt of gedeeld wordt. Overweeg goedgekeurde meldingen
  terug te geven aan OSM.
