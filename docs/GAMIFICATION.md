# Gamification: van check-in-tool naar game

> **Status:** goedgekeurd op 15 oktober 2026, met aanpassingen (zie "Besluiten" in hoofdstuk 9).
> Fase 1a t/m 7 bouwen we nu, één fase per sessie, en dan stoppen we. Fase 8–10 bouwen we pas na een
> test met echte spelers. De stand van zaken staat onderaan, in "Overdracht".
> Het ontwerp is door twee onafhankelijke reviews gegaan (server en app). Hun bevindingen zijn
> verwerkt, o.a. de lock-volgorde, de rechten op `private`, toasts boven native modals, exacte
> getallen in de onthulling en veilige EAS Updates.

## Context

binquest (repo `zwerfvuil-app`) werkt: foto + gps bij een vuilbak, manuele moderatie, punten met
een weekreeks, een bonusvraag en een Balatro-achtige onthulling. Het voelt nog als een
check-in-tool. Doel: een game met de gewoontelus van Duolingo en de "juice" van Balatro, voor zo
hoog mogelijke retentie, waarbij elke spelmechaniek data oplevert voor de stad (waar vuilbakken
ontbreken, vol zitten of weinig gebruikt worden).

Vaste grenzen: de server rekent alles uit; één puntenboekhouding; meteen tonen, pas toekennen bij
goedkeuring; afstelbaar zonder app-update; testdata gescheiden; anti-cheat onaangetast; geen
betaalde willekeur; toegankelijk en native. Werkwijze uit `CLAUDE.md`: één fase per branch, zelf
verifiëren, kort verslag, wachten op akkoord; staging alleen via `infra/staging/`.

---

## 1. Wat er is en wat verandert

| Bestaat (bouw hierop) | Verandert |
|---|---|
| `record_checkin` (regels, reeks, bonusvraag, testvlag), `review_checkin`, `answer_bonus_question` | Score als chips × mult uit config; punten in een ledger; spelfeiten (ontdekking, mijlpaal, quest, badge, kist) in dezelfde transactie bijgewerkt; afwijzen of herroepen draait alles terug |
| `profiles.points` / `test_points` en `checkins.points_awarded` worden direct opgehoogd | `profiles.points` en `test_points` volgen uit `point_transactions` (som van `granted`); `points_awarded` verdwijnt |
| Puntconstanten in SQL en `app/src/lib/points.ts` | `game_config` + catalogustabellen; de app leest `game_catalog()` |
| Onthulling: tellen → reeks → slam → bonus, gemixte soundtrack op een audioklok | De stappen en tussentotalen komen van de server (`score.steps`): basis, ontdekking, reeks, premie; daarna vieringen. Zelfde engine, nieuwe geluiden |
| Tabs Kaart · Profiel · Beheer | Kaart · Vandaag · Profiel · Beheer; Collectie en Ranglijst vanuit Vandaag en Profiel |
| Ranglijst: naam en punten | + avatar en level (pijltjes t.o.v. vorige week: fase 9) |
| Dev-modus: onthulling, reeks forceren, testlocatie, reset | + preview van elke nieuwe viering |
| Geen gebruiksdata | Eventlog met wachtrij in `expo-sqlite`; analyseviews en export in fase 10 |

---

## 2. Datamodel

### 2.1 Drie ideeën die alles dragen

1. **Eén ledger.** Elk punt is een rij in `point_transactions` met een bron en een status
   (`pending` → `granted`, of `revoked`). `profiles.points` en `test_points` volgen daaruit; niemand
   schrijft ze nog rechtstreeks.
2. **Twee zekerheden.** Elk spelfeit wordt geëvalueerd over *voorlopige* feiten (alle niet-afgewezen
   check-ins, meldingen, bonusantwoorden) en over *zekere* feiten (alleen goedgekeurde). Klopt de
   regel zeker → `granted`; alleen voorlopig → `pending` (de viering mag meteen); niet meer →
   `revoked`. Eén regel voor principe 3, en een afwijzing draait vanzelf alles terug.
3. **Afleiden en bijwerken.** Na elke check-in, beoordeling, bonusantwoord, melding of herroeping
   rekent `private.refresh_game_state(user)` alle spelfeiten van die gebruiker opnieuw uit en past
   alleen aan wat afwijkt: hooguit enkele honderden rijen; quests, kisten en weken van de laatste 14
   dagen (een herroeping rekent alles). Omdat het altijd de volledige stand is, herstelt een volgende
   refresh wat ooit misliep. Bedragen worden bevroren op het moment dat een beloning ontstaat; een
   config-wijziging raakt alleen nieuwe beloningen.

**Testdata: geen aparte testwereld.** Testinworpen uit Dev-modus (testlocatie of geforceerde reeks)
blijven werken zoals nu: een score van basis + reeks, hun punten naar `test_points`, gemarkeerd als
TEST in Beheer, weg na een reset. Ze maken geen spelfeiten (geen ontdekking, mijlpaal, quest, kist,
badge of bevriezer) en tellen in geen enkele evaluatie mee: overal één filter `not is_test`. De
spellogica testen we met pgTAP- en integratietests, elke viering met een Dev-preview, en de echte
keten op staging met een apart, gewoon testaccount dat echte inworpen doet in de testregio. Zie
hoofdstuk 9 voor de afweging.

### 2.2 Puntenledger

`public.point_transactions`

| Kolom | |
|---|---|
| `id` bigint identity, `user_id` → `profiles` (on delete cascade), `is_test` | |
| `source` | `checkin`, `bonus`, `discovery`, `bounty`, `milestone`, `quest`, `weekly`, `chest`, `adjustment` |
| `reward_key` | stabiele sleutel (`checkin:<id>`, `milestone:20`, `quest:<id>`, `chest:<id>` …), `unique (user_id, is_test, reward_key)` |
| `amount` | ≠ 0, bevroren |
| `status` | `pending`, `granted`, `revoked` |
| `checkin_id` → `checkins` (on delete cascade) | alleen bij beloningen die volledig van één check-in afhangen (`checkin`, `bonus`, `discovery`, `bounty`) |
| `anchor_checkin_id` → `checkins` (on delete set null) | bij mijlpaal, quest, kist, badge, weekuitdaging: de check-in die ze deed ontstaan (analyse); hun status volgt uit tellingen |
| `earned_at` | wanneer de actie gebeurde (weekranglijst) |
| `created_at`, `granted_at`, `revoked_at`, `revoke_reason`, `details` jsonb | |

Indexen op `checkin_id`, (`user_id`, `status`) en `earned_at` (alleen `granted`).

- **Projectie vanuit `checkins`.** Een trigger op `checkins` (after insert/update van status, score,
  bonus, testvlag; security definer; neemt geen locks, wijzigt `checkins` niet, start geen refresh)
  houdt de rijen van die check-in gelijk met zijn status en bevroren score (`points_earned`,
  `bonus_points`, `score`). Zo blijven alle paden consistent: `record_checkin`, `review_checkin`, het
  bonusantwoord, herroepen, en ook een insert in een test of in Studio. Rijen met bedrag 0 bestaan
  niet.
- **Profielpunten via delta's.** Een trigger op `point_transactions` past `points` en `test_points`
  aan met het verschil (oud → nieuw `granted`-bedrag), niet met een nieuwe som: een som verliest
  updates bij gelijktijdige schrijvers. `private.check_points_invariant()` vergelijkt elk profiel met
  zijn ledger; elke test roept hem aan. Alle `points = points + …` in `review_checkin`,
  `answer_bonus_question` en `reset_dev_test_data` verdwijnen in dezelfde migratie. De controle
  `points >= 0` vervalt: de ledger is de waarheid, en een herroeping mag nooit falen.
- **`checkins.points_awarded` verdwijnt** (met zijn controle): het was een tweede boekhouding. De
  punten van één check-in = de `granted` rijen met dat `checkin_id`.
- **Opnieuw verdiend.** Een beloning die vervalt en later opnieuw verdiend wordt (bv. mijlpaal 20),
  hergebruikt haar rij (`revoked` → `pending` → `granted`): nieuw anker, `revoked_*` leeg, bevroren
  bedrag blijft. Een kist die opnieuw klaar is, houdt haar eerdere trekking. Wordt een avatar uit de
  kist herroepen terwijl iemand hem draagt, dan krijgt die de standaardavatar.
- Correcties door een admin: `adjust_points(user, amount, reason)` (rij `adjustment`).

**Migratie van de bestaande punten** (één transactie):
1. Snapshot van `points`/`test_points` per profiel; controle dat elke goedgekeurde check-in
   `points_awarded = points_earned + bonus_points` heeft.
2. Ledger opbouwen met dezelfde projectie (`private.sync_checkin_ledger` voor elke check-in):
   approved → `granted` (`granted_at = reviewed_at`), pending → `pending`, rejected → `revoked`.
3. Verschillen met de snapshot (bv. een wijziging in Studio) worden een `adjustment` met reden
   "migratie" én een melding in de uitvoer; op staging verwachten we er 0.
4. Daarna moet `check_points_invariant()` leeg zijn en elk profiel gelijk aan de snapshot, anders
   faalt de migratie. Pas dan verdwijnt `points_awarded`.
5. `review_checkin`, `answer_bonus_question`, `reset_dev_test_data` en `leaderboard` gebruiken
   voortaan de ledger. **Weekranglijst** = alle `granted` punten met `earned_at` deze week: naast
   inworpen nu ook quests en mijlpalen (een bewuste verandering).

### 2.3 Config en catalogus

| Tabel | Inhoud |
|---|---|
| `game_config` (key, value jsonb, description) | alle getallen uit hoofdstuk 3, en de regio (bbox) voor tellers en premies |
| `levels` (level, min_points, title) | curve en titels |
| `milestones` (threshold, points, freezes, badge_key, avatar_key) | 10, 20, … met sprongen bij 50 en 100 |
| `badges` (key, name, description, symbol, rarity, rule, secret, sort, active) | |
| `avatars` (key, name, rarity, unlock_type, unlock_param, sort, active, placeholder_symbol, placeholder_color) | unlock: `default`, `level`, `milestone`, `badge`, `quest`, `chest` |
| `quest_templates` (key, period day/week, slot easy/medium/hard, title, rule, target, reward_points, reward_freezes, weight, active) | |
| `chest_rewards` (key, kind points/freeze/avatar, amount, weight, active) | de kansen, ook zichtbaar in de app |
| `bonus_questions` | bestaat al |

- Lezen alleen via `game_catalog()` (één antwoord, geheime badges gemaskeerd); de tabellen zelf zijn
  niet rechtstreeks leesbaar, zoals `bonus_questions` nu. Schrijven: migraties of Studio.
- Een trigger valideert `game_config` (type en bereik per sleutel): een tikfout in Studio mag nooit
  alle check-ins breken.
- `private.cfg(key)` in SQL. Geen getallen of teksten van quests, badges en levels in de app;
  `BASE_POINTS` e.d. in `points.ts` verdwijnen.
- Regels gebruiken een vaste set types (`count` over check-ins/ontdekkingen/bonusantwoorden/meldingen
  met filters zoals nieuw/premie/uur, `distinct_far_bins`, `active_days`, `streak_weeks`). Nieuwe
  badge of quest van een bestaand type = één rij; een nieuw type = een migratie.
- Anti-cheatregels (25 m, cooldown, daglimiet, nauwkeurigheid) blijven bewust constanten.

### 2.4 Spelfeiten per gebruiker

RLS: lees eigen rijen, admins alles; geen schrijfrechten voor clients (alleen functies). Geen
`is_test`: testinworpen maken geen spelfeiten.

| Tabel | Sleutel, kolommen |
|---|---|
| `discoveries` | (user, bin → bins on delete cascade); `checkin_id` = eerste niet-afgewezen check-in, status pending/confirmed/revoked, `discovered_at`, `first_counted_at` |
| `user_milestones` | (user, threshold); status, `reached_at`, anker |
| `user_badges` | (user, badge_key); status, `earned_at`, anker |
| `user_avatars` | (user, avatar_key); unlocks uit kist en quest. Unlocks via standaard/level/mijlpaal/badge worden berekend |
| `user_quests` | (user, period, period_start, slot); template, target, bevroren beloning, voortgang voorlopig/zeker, `completed_at` |
| `daily_chests` | (user, day); locked/ready/opened, de getrokken beloning (één keer, bewaard) |
| `streak_freezes` | user, bron, status pending/available/revoked, `earned_at` |
| `bounty_bins` | (day, bin_id → bins on delete cascade); mult, selectiescore. Iedereen ziet dezelfde premies (fase 8) |
| `private.game_errors` | fouten uit de spellogica, voor admins |

- **Bevriezers:** max 2 in bezit op het moment van verdienen (bij 2 trekt de kist geen bevriezer, en
  een mijlpaal-bevriezer vervalt met "bevriezers vol"). Het *gebruik* wordt niet opgeslagen maar
  afgeleid: `streak_weeks` loopt de weken af en dicht een gat alleen als er genoeg beschikbare
  bevriezers zijn die vóór dat gat verdiend werden; een bevroren week telt niet mee (de mult stijgt
  niet). Zo blijft `streak_weeks` een leesfunctie, ook voor `my_streak`.
- **Meldingen van ontbrekende vuilbakken** (directe insert door de client) krijgen een trigger die
  de refresh start.
- Profielen krijgen `avatar_key`, `onboarded_at`, `results_seen_at`, `moments_seen_at`,
  `last_seen_level`. `handle_new_user` vult de naam niet meer in uit het e-mailadres (PRE-BETA-punt).
- Check-ins krijgen `score` jsonb (de bevroren stappen), `review_reason`, `revoked_at`, `revoked_by`.
  Herroepen = status `rejected` met `revoked_at`: geen nieuwe statuswaarde en geen nieuwe controles
  nodig; de analyse onderscheidt ze via `revoked_at`.

### 2.5 Eventlog

`public.app_events`: `id` uuid (gemaakt door de client, voor idempotentie), `user_id` → profiles
(on delete cascade), `session_id`, `name`, `props` jsonb, `client_ts`, `server_ts`, `app_version`,
`update_id`, `platform`, `is_test`. Indexen op (`user_id`, `server_ts`) en (`name`, `server_ts`).

`log_events(events jsonb, client jsonb)` valideert de hele batch in één set-gebaseerde query (geen
subtransactie per rij):
- max 100 events per batch; `props` een object van max 2 KB en 20 sleutels; `client_ts` max 30 dagen
  oud en max 1 dag in de toekomst;
- naam moet in `event_names` staan (whitelist; een nieuw event = één rij in een migratie);
- sleutels die naar een locatie ruiken (`lat`, `lon`, `latitude`, `longitude`, `geom`, `coords`, …)
  worden geweigerd;
- 600 events per gebruiker per uur; `on conflict (id) do nothing` voor herhaalde batches;
- `is_test` (events uit Dev-previews) alleen als de client het vraagt én `dev_mode_allowed()`;
- antwoord `{accepted, dropped, rate_limited}`; afgekeurde rijen laten de batch niet falen.

Gebruikers lezen niets, admins wel. Wissen met het account via de cascade. Bewaartermijn: fase 10.

### 2.6 RPC's

Security definer met vaste `search_path`; na elke drop-and-recreate opnieuw de rechten en
`notify pgrst, 'reload schema'`. Interne functies in schema `private` (niet via de API).
`record_checkin` wordt ook security definer (alleen de service role mag hem aanroepen): de service
role heeft geen rechten op `private`.

| RPC | Wie | Wat |
|---|---|---|
| `record_checkin` (zelfde parameters) | service role | + score, ledger, spelfeiten; extra kolommen `score`, `game` |
| `review_checkin(id, approve, reason default null)` | admin | ledger + refresh. Opnieuw aangemaakt i.p.v. overladen (PostgREST kan anders niet kiezen) |
| `revoke_checkin(id, reason)` | admin | goedgekeurde check-in alsnog afwijzen; alles erachter valt terug (PRE-BETA-punt) |
| `adjust_points(user, amount, reason)`, `repair_game_state(user)` | admin | correctie; volledige refresh |
| `approved_checkins(max_rows)` | admin | de laatst goedgekeurde inworpen met hun punten, voor Herroepen (fase 1a) |
| `answer_bonus_question` | gebruiker | rij `bonus` + refresh; geeft nog altijd een getal terug |
| `game_catalog()` | aangemeld | config, levels, badges, avatars, quests, mijlpalen, kistkansen |
| `my_game_state()` | aangemeld | punten (granted/pending), level, reeks + dagbolletjes + bevriezers, ontdekt/totaal + volgende mijlpaal, quests, kist, weekuitdaging, aantal ongeziene momenten. `volatile`: maakt lui de quests van vandaag aan |
| `my_collection()`, `my_badges()`, `my_avatars()` | aangemeld | met status en ontgrendelhint |
| `complete_onboarding(name, avatar_key)`, `set_my_avatar(key)` | aangemeld | alleen ontgrendelde avatars |
| `my_unseen()`, `mark_seen(kind, until)` | aangemeld | *beslissingen* (goedgekeurd/afgewezen, punten per bron, level voor/na) en *momenten* (ontdekking, mijlpaal, quest, kist klaar, badge, bevriezer) sinds het vorige bezoek. Zo gaat geen viering verloren als de app sneuvelt of een quest pas door het bonusantwoord af is |
| `open_daily_chest(day)` | aangemeld | trekt één keer, bewaart, geeft de beloning |
| `leaderboard(period, max_rows, include_test)` | aangemeld | + `avatar_key`, `level`, `title` |
| `log_events(events, client)` | aangemeld | 2.5 |
| Fase 8–10: `heatmap(period, layer)`, `my_week_recap(week)`, `leaderboard.movement` | aangemeld | zie de fases |

**Geen compatibiliteitslaag.** De cofounder stapt over op Zwerfvuil Dev; de oude staging-IPA "Zwerfvuil
Gent" (met vaste JavaScript) wordt niet meer ondersteund. Een nieuwe staging-IPA uit `main` werkt wel.
Per fase rollen server en app samen uit: eerst de migratie, meteen daarna `update:dev`. De ingebouwde
JavaScript van de Zwerfvuil Dev-IPA (bij een nieuwe installatie, tot de update binnen is) toont bij
een onbekend antwoord gewoon een bevestiging zonder onthulling.

### 2.7 Een check-in, van foto tot goedkeuring

`record_checkin`:
1. Alle bestaande controles ongewijzigd.
2. Insert; quests van vandaag lui aanmaken; reeks berekenen (met bevriezers).
3. `private.checkin_score()`: ontdekking? (geen eerdere niet-afgewezen, echte check-in van deze
   gebruiker bij deze vuilbak) premie vandaag? (fase 8) → `score` met stappen en tussentotalen. De
   projectie maakt de ledgerrijen `checkin` = round(10·m), `discovery` = round(15·m) − checkin,
   `bounty` = totaal − round(15·m) (m = reeksmultiplier), samen exact het totaal. Een testinworp
   krijgt alleen basis + reeks, zoals nu.
4. Bonusvraag aanbieden (ongewijzigd; punten uit config).
5. `refresh_game_state(user)` in een `begin … exception`-blok (niet voor testinworpen): een fout in de
   spellogica laat een geldige check-in nooit mislukken (fout → `private.game_errors`, `game` = null;
   de volgende refresh herstelt). Hetzelfde in `review_checkin`, `revoke_checkin` en het
   bonusantwoord: spelfouten blokkeren nooit de moderatie.
6. Terug: `score` + `game` (wat er nieuw is).

`submit-checkin` geeft dat door. Vanaf fase 2 vervangt `score` het oude `points`-object (voorbeeld:
4 weken reeks, ontdekking, en een premie uit fase 8):

```json
{
  "checkin_id": "…", "status": "pending", "distance_m": 6.2, "message": "…",
  "score": {
    "steps": [
      { "kind": "base",      "label": "BASIS",     "chips": 10, "mult": 1,    "total": 10 },
      { "kind": "discovery", "label": "NIEUW",     "chips": 15, "mult": 1,    "total": 15, "add": 5 },
      { "kind": "streak",    "label": "REEKS",     "weeks": 4, "per_week": 1.1,
        "stages": [{ "mult": 1.1, "total": 17 }, { "mult": 1.21, "total": 18 },
                   { "mult": 1.331, "total": 20 }, { "mult": 1.4641, "total": 22 }] },
      { "kind": "bounty",    "label": "PREMIE ×2", "chips": 15, "mult": 2.9282, "total": 44, "factor": 2 }
    ],
    "total": 44, "streak_extended": true
  },
  "game": {
    "discovery": { "bin_id": 58, "ordinal": 12, "discovered": 12, "total_bins": 120 },
    "milestone": null,
    "quests": [{ "id": "…", "title": "…", "progress": 1, "target": 1, "completed_now": true, "reward": 10 }],
    "chest_ready": false,
    "badges": [{ "key": "early_bird", "status": "pending" }]
  },
  "bonus_question": { "key": "bin_fullness", "prompt": "…", "options": [], "points": 5 },
  "is_test": false
}
```

### 2.8 Afwijzen en herroepen

| Bij afwijzing of herroeping van check-in C | Gevolg |
|---|---|
| ledgerrijen van C (`checkin`, `bonus`, `discovery`, `bounty`) | `revoked` |
| ontdekking van vuilbak B | gaat naar de volgende niet-afgewezen check-in bij B (zonder ontdekkingspunten: die waren bevroren in C), anders `revoked` |
| mijlpalen | herteld; onder de drempel → `revoked` |
| quests, weekuitdaging, kist van die dag/week | herteld; niet meer volledig → beloning `revoked`, ook een bevriezer of avatar uit die kist |
| badges | herberekend |
| bevriezers | `revoked`; een brug die daarop steunde, vervalt en de reeks wordt herberekend (eerdere punten blijven) |
| level | volgt de punten; kan dalen, zonder viering |

Bij goedkeuring gaat alles wat nu zeker klopt naar `granted`. Punten van latere check-ins worden niet
herrekend (zoals nu, staat al in PRE-BETA).

### 2.9 Gelijktijdigheid en snelheid

- **Eén lock-volgorde overal:** eerst de advisory lock per gebruiker (`'checkins:' || user_id`,
  dezelfde als `record_checkin`), dan (fase 8) de lock voor de premies van de dag, dan pas rijen
  (`for update`). `review_checkin`, `revoke_checkin` en het bonusantwoord lezen dus eerst zonder lock
  de `user_id` van de check-in (die verandert nooit), nemen de gebruikerslock, en locken dan de rij.
  Anders kan een refresh die naar een oudere check-in verwijst (foreign key) een deadlock geven met
  een beoordeling van die check-in.
- De refresh wijzigt nooit `checkins`.
- Doel: `record_checkin` < 50 ms, gemeten in de integratietest; een Deno-test stuurt een beoordeling
  en een inworp van dezelfde gebruiker tegelijk.

---

## 3. Puntenekonomie

### Formule

```
chips  = basis 10 + ontdekking 5 (alleen bij een ontdekking)
mult   = 1,1^min(reeksweken, 8) × premie 2 (alleen bij een premie-vuilbak, fase 8)
inworp = round(chips × mult)                       ledger: checkin + discovery + bounty
daarna, plat: bonusvraag +5 · quest · weekuitdaging · kist · mijlpaal
```

Ontdekken en premies worden eigen stappen in de onthulling, de reeks blijft de grote vermenigvuldiger
van de gewoonte. Platte beloningen staan los van de som, zodat één inworp nooit absurd hoog uitvalt:
maximum (10 + 5) × 2,14 × 2 = 64. In de goedkeuringsviering staan de punten per bron ná de mult
(bv. "+7 ontdekking" bij ×1,46).

### Startwaarden (`game_config`)

| Sleutel | Start |
|---|---|
| Basis / ontdekking (chips) | 10 / +5 |
| Reeks | ×1,1 per week, max 8 stappen (×2,14) |
| Bonusvraag | +5 |
| Mijlpaal | elke 10 ontdekkingen +50; bij 50: +150 en een bevriezer; bij 100: +300 en een avatar; alle vuilbakken van de regio: badge |
| Quests | makkelijk +5 · gemiddeld +10 · moeilijk +15 (alle 3 = +30) |
| Weekuitdaging | +40 |
| Dagkist (gewicht) | 5 pt (30) · 10 pt (30) · 15 pt (15) · 25 pt (8) · bevriezer (8, niet bij 2 in bezit) · avatar (4); gemiddeld ±11 pt |
| Bevriezers | max 2 in bezit |
| Meldingen | max 1 per dag; stil 21:00–09:00; reeks zondag 17:00; quest-herinnering 18:00 (te kiezen 9–20 u) |
| Levels | `10 × (L−1)^2,6`, afgerond op 5, 20 levels |
| Fase 8–10 | premie ×2, 5 vuilbakken per dag binnen de regio, data van 30 dagen, ≥ 100 m uit elkaar, niet 2 dagen na elkaar; heatmap k = 3 gebruikers per vuilbak per periode, 5 klassen; ruwe events 13 maanden |

### Verwachte punten per week

Aannames: casual = 1,5 inworpen per week (op ±1,3 dagen), actief = 10 per week (elke dag). Ontdekking
per inworp: casual 60 % (week 1–4) → 40 % → 20 %, actief 50 % → 30 % → 10 % (120 vuilbakken).
Premie (fase 8): 5 % / 12 % van de inworpen. Bonusvraag 80 % beantwoord. Casual haalt ±1,5 quest per
speeldag en zelden de kist; actief haalt alle 3 quests op 6 van de 7 dagen.

| Bron | Casual wk 1 | wk 4 | wk 8 | Actief wk 1 | wk 4 | wk 8 |
|---|---:|---:|---:|---:|---:|---:|
| Inworpen (chips × mult) | 23 | 30 | 41 | 154 | 205 | 276 |
| Bonusvragen | 6 | 6 | 6 | 40 | 40 | 40 |
| Quests | 22 | 22 | 22 | 195 | 195 | 195 |
| Dagkist | 1 | 1 | 1 | 66 | 66 | 66 |
| Weekuitdaging | 10 | 10 | 10 | 40 | 40 | 40 |
| Mijlpalen | 5 | 5 | 3 | 25 | 25 | 15 |
| **Totaal** | **±66** | **±73** | **±82** | **±520** | **±571** | **±632** |

Zonder premies (tot fase 8) liggen de inworpen ±5 % (casual) en ±12 % (actief) lager. Na 12 weken:
casual ±900, actief ±7.000. Quests en kist zijn bij een actieve speler ±40 % van de punten: ze belonen
variatie (nieuwe vuilbakken, bonusvragen, later premies), net de data die we willen.

**Levels** (L = level, drempel in punten):

| L | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 12 | 15 | 20 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| punten | 10 | 60 | 175 | 370 | 655 | 1.055 | 1.575 | 2.230 | 3.025 | 5.100 | 9.550 | 21.125 |
| casual | 1e inworp | wk 1 | wk 3 | wk 6 | wk 10 | wk 14 | wk 20 | wk 28 | wk 37 | | | |
| actief | dag 1 | dag 1 | dag 3 | dag 5 | wk 2 | wk 2 | wk 3 | wk 5 | wk 6 | wk 9 | wk 16 | wk 34 |

Titels (in `levels`, aanpasbaar), bv.: 1 Wegwerp-rookie · 2 Blikjesbuddy · 3 Peukenpikker ·
4 Stoepridder · 5 Papiertjesprof · 6 Buurtbezem · 7 Pleinpatrouille · 8 Leiewachter ·
10 Straatheld · 13 Afvalalchemist · 16 Netheidsninja · 19 Afvallegende · 20 Vuilbakkoning.

**Vouchers (besloten, nog niet gebouwd):** loten op basis van punten, afgetopt op **150 punten per
week**. Een actieve speler heeft dan ±1,8× de kans van een casual speler, i.p.v. ±7,7× bij een lot per
punt. Zo telt regelmaat meer dan grinden. Vouchers negeren testpunten (`test_points`, `is_test`).

### Startinhoud (rijen in de catalogus, aanpasbaar)

**Dagquests** (per dag één uit elk vak, gewogen, deterministisch per gebruiker en dag):

| Vak | Quest | Regel |
|---|---|---|
| makkelijk +5 | Doe een inworp · Beantwoord een bonusvraag · Gooi weg bij een vuilbak waar je al eens was | `count` checkins / bonusantwoorden / herbezoek ≥ 1 |
| gemiddeld +10 | Gooi iets weg bij een vuilbak die je nog niet ontdekte (alleen als er nog zijn) · Doe 2 inworpen · Doe een inworp vóór 10 uur | nieuw ≥ 1 / checkins ≥ 2 / uur < 10 |
| moeilijk +15 | 2 inworpen bij vuilbakken minstens 200 m uit elkaar · Meld een ontbrekende vuilbak (laag gewicht) · Inworp bij een premie-vuilbak (fase 8) | `distinct_far_bins` / meldingen ≥ 1 / premie ≥ 1 |

**Weekuitdaging** (+40): inworpen op 4 verschillende dagen · ontdek 5 nieuwe vuilbakken · beantwoord
5 bonusvragen · 2 inworpen bij premie-vuilbakken (fase 8).

**Badges:** Eerste inworp · Ontdekker 10 / 50 / 100 · Reeks van 4 / 8 weken · Nieuwsgierig (25
bonusvragen) · Kaartmaker (goedgekeurde melding van een ontbrekende vuilbak) · Vroege vogel (vóór
8 u) · Nachtuil (na 22 u) · Heel de buurt (alle vuilbakken van de testregio, legendarisch) ·
Questheld (30 quests, fase 6) · Premiejager (5 premie-inworpen, fase 8).

**Avatars** (placeholders tot de tekeningen er zijn, zie `docs/AVATARS.md`): 4 standaard (spruit,
vos, zon, berg), 3 via level (bloem 5, bliksem 8, eik 12), 2 via mijlpaal (haas 50, schildpad 100),
1 via badge (merel, Vroege vogel), 2 alleen uit de kist (maan episch, regenboog legendarisch). De
mascotte Zwerfie (onboarding, lege schermen) is geen avatar die een speler kan dragen (fase 4).

---

## 4. De uitgebreide onthulling

De server stuurt `score.steps` met per stap het afgeronde tussentotaal (en per reeksweek een eigen
stap): de app speelt exact die getallen af en de slam landt altijd op `score.total`; de app rekent
niets na met eigen constanten. Elke stap heeft een `kind` en een `label`: een onbekend `kind` speelt de
app af als generieke stap met dat label en een bestaand geluid, dus een nieuwe bonussoort vraagt geen
app-update. Zonder `score` toont de app een gewone bevestiging. Tijdlijn, mix en audioklok blijven
(`timeline.ts`, `mix.ts`, `playback.ts`).

| # | Stap (wanneer) | Beeld | Geluid (* = nieuw) | Haptiek | Reduce Motion |
|---|---|---|---|---|---|
| 1 | Chips en mult komen in | CHIPS- en MULT-chip poppen | — | — | fade |
| 2 | Basis tellen | CHIPS 0 → 10 | `tick_0..4` | selection (om de 2) | zelfde tellen |
| 3 | Ontdekking | banner "Nieuwe vuilbak ontdekt! · #58 · 12/120" valt in, CHIPS +5, vonkjes | `discover_fanfare`*, `chip_add`* | medium | banner fade, geen vonkjes |
| 4 | Aanloop | — | `riser` | — | zelfde |
| 5 | Reeks (per week, max 8) | MULT ×1,1 … ×2,14, schudden, flits, gloed | `mult_1..8` (blijft op 8), `transient`, `heat_loop` | light → heavy + rigid | geen schudden, flits of gloed |
| 6 | Premie (fase 8) | gouden stempel "PREMIE ×2" slaat op MULT, MULT verdubbelt | `bounty_hit`* (muntakkoord) | heavy + rigid | stempel fade |
| 7 | Totaal | hit-stop, CHIPS × MULT = TOTAAL slam, deeltjes, "wacht op goedkeuring" eronder | `total_chord` | heavy, success | geen deeltjes, schaal ≤ 1,05 |
| 8 | Reeks verlengd (eerste inworp van de week) | vlam groeit, "Reeks verlengd · 5 weken" | `flame_whoosh`* | light | vlam staat stil |
| 9 | Bonusvraag | sheet | — | — | zelfde |
| 10 | +5 | chip vliegt naar het totaal | `whoosh_up`, `bonus_tick_1..5`, `bonus_land` | selection, success | geen boog |
| 11 | Vieringen erna, in volgorde | mijlpaal (volledig scherm, confetti), quest voltooid, kist klaar, badge: een eigen reeks in het scherm, geen algemene toasts | `milestone_fanfare`*, `quest_ding`* | success (mijlpaal), light | geen confetti; fade |

Geluid, zonder extra hapering:
- Nieuwe geluiden uit `generate-sfx.mjs` (zelfde synthese, C-pentatonisch, ook `chest_rattle`,
  `chest_open`, `levelup_fanfare`, `approve_chime`). Geen nieuwe losse spelers (die blokkeerden de
  hoofdthread tot 150 ms): elke viering krijgt een gemixte soundtrack, een derde `Soundtrack` voor
  vieringen, voorbereid tijdens de bonusvraag zoals nu de +5. De kist mixt het schudden bij het openen
  van het scherm en de beloning terwijl `open_daily_chest` loopt.
- De verwachte tijdlijn wordt al gemixt tijdens het uploaden (reeks en ontdekking weet de app
  vooraf). Alleen de samples die een tijdlijn nodig heeft worden gedecodeerd; "klaar" hangt alleen
  van de samples af en een mislukte init wordt opnieuw geprobeerd. De cachesleutel van een mix bevat
  een hash van de geluidsbestanden, zodat een update met nieuwe WAV's geen oude mix afspeelt.
- Zonder mijlpaal blijft alles onder ±6 s.

Overslaan, achtergrond en toegankelijkheid:
- De eindstand komt uit de tijdlijn zelf (`endState(events)`), niet uit handwerk; een test bewijst
  dat overslaan op elk moment dezelfde eindstand geeft als uitspelen. De vieringen erna zijn elk apart
  over te slaan.
- Gaat de app midden in een onthulling naar de achtergrond, dan eindigt ze stil op de eindstand
  (de audioklok loopt anders door en alles zou tegelijk afgaan).
- Met VoiceOver begint de onthulling op de eindstand en volgt één samenvatting
  ("44 punten, wacht op goedkeuring. Nieuwe vuilbak ontdekt."), in de wachtrij van VoiceOver.
- Getal, MULT en banner worden aparte gememoiseerde componenten: een tik in het tellen hertekent
  niet het hele scherm.

**`checkin_point_stages`** verdwijnt in fase 2: `private.checkin_score()` vervangt hem, en zijn
asserties in test 06 verhuizen naar `11_scoring`.

---

## 5. Schermen en navigatie

**Tabs:** Kaart · Vandaag · Profiel · Beheer (admins). Kaart blijft het starttab (daar gebeurt de
actie). Vandaag krijgt een tab-badge "1" als de kist klaarstaat. Native tabs, geen schuifanimatie.

```
src/app/
  _layout.tsx                 Stack: login | onboarding | (tabs) + modale schermen
  login.tsx
  onboarding/                 naam, avatar                                                 nieuw
  onboarding-preview.tsx      dezelfde schermen zonder guard, voor Dev-modus                nieuw
  (tabs)/(map)/index.tsx
  (tabs)/(today)/index.tsx, leaderboard.tsx, collection.tsx                               nieuw
  (tabs)/(profile)/profile.tsx, settings.tsx, leaderboard.tsx, collection.tsx              settings, collection nieuw
  (tabs)/(admin)/admin.tsx, dev-mode.tsx
  bin/[id].tsx, avatar-picker.tsx                           formSheet
  camera.tsx, reveal.tsx, celebrate.tsx, chest.tsx          fullScreenModal
```

- Ranglijst en Collectie: één scherm in `src/screens/`, als dunne route in beide stacks; links
  bevatten altijd de groep (`/(today)/leaderboard`) en elk scherm zet zijn eigen header. "Toon op de
  kaart" gaat eerst naar `/(tabs)/(map)` en vraagt via `BinsProvider` om die vuilbak te tonen.
- **Onboarding-guard** met drie toestanden: profiel onbekend → splash; `onboarded_at` leeg →
  onboarding; profiel niet te laden (offline) → gewoon de app (nooit vastzitten in onboarding).
- **Wat er verschijnt bij het openen** loopt via één wachtrij (`MomentsPresenter`), in deze volgorde:
  onboarding, update klaar, goedkeuringsviering, gemiste momenten, vraag om meldingen, kist klaar
  (later ook het weekoverzicht). Er verschijnt alleen iets op een tab-scherm zonder open modal
  (`useSegments`). Een warme start telt alleen bij achtergrond → actief (niet na Control Center of
  een toestemmingsvraag). `mark_seen` pas als de viering gesloten wordt.
- **Toasts** boven native modals: `ToastProvider` is alleen een wachtrij; de tabs en elk modaal scherm
  hebben een eigen `<ToastViewport/>` en de bovenste toont de toast. In de onthulling en de vieringen
  geen algemene toasts.
- **Eerste keer uitleg:** reeks, quests en kist krijgen een eenmalige uitlegkaart (`FirstTimeTip`) de
  eerste keer dat ze op Vandaag verschijnen; onthouden per toestel (`localStorage`, al geïnstalleerd
  via `expo-sqlite`). Getallen in die uitleg komen uit de catalogus.

**Design: native shell, game-hart.** `theme.ts` wordt `theme/` (zelfde import `@/theme`): bestaande
semantische kleuren en tekststijlen, plus `game.ts` (zonder imports, zodat Jest hem kan laden) met
game-tokens: kleuren als licht/donker-paren (in Reanimated altijd eerst omgezet naar een vaste
waarde), donkere spelvlakken (chips-blauw, mult-ramp, goud, bonusgroen), zeldzaamheid (gewoon grijs ·
zeldzaam blauw · episch paars · legendarisch goud), cijfers (SF Pro Rounded, black, tabular-nums,
`maxFontSizeMultiplier`), dikke radius en "lip" voor knoppen, motion-presets. De vaste kleuren in
`reveal.tsx` en `useRevealMotion.ts` verhuizen daarheen. Gedeelde componenten in
`src/components/game/`: `ChunkyButton`, `GameNumber` (rollend), `ProgressBar`, `ProgressRing`
(SwiftUI `Gauge` met vaste maat en `scaleEffect`; vroeg prototypen), `DayDots`, `StreakFlame`,
`Confetti`, `Avatar`, `BadgeTile`, `QuestRow`, `PendingTag` ("wacht op goedkeuring"), `FirstTimeTip`.
Eén `useReduceMotion`-hook voor alles; lussende animaties (vlam, glans) pauzeren als hun scherm niet
in beeld is (CSS-keyframes van Reanimated negeren Reduce Motion zelf). Profiel en Ranglijst worden
React Native (avatars, raster, vaste eigen rij); Instellingen en Dev-modus blijven
SwiftUI-formulieren.

Per scherm:

- **Kaart.** Bovenpaneel: "Dichtstbijzijnde vuilbak · 18 m" + "34/120 ontdekt" met balk naar de
  volgende mijlpaal. Pins: ontdekt = groen met vuilbak; niet ontdekt = gedimd met "?". Onder: knop
  "Inworp registreren". Rechts: locatie, testlocatie. (Fase 8: gouden premie-pins met aftelchip en
  een heatmaplaag.)
- **Vuilbak-sheet.** + "Ontdekt op 12 okt · 3 inworpen" of "Nog niet ontdekt".
- **Onthulling.** Hoofdstuk 4.
- **Vandaag** (scroll, grote titel): 1) reekskaart: vlam, "5 weken · ×1,61", 7 dagbolletjes ma–zo
  (gevuld = goedgekeurd, ring = wacht, vandaag omcirkeld), "Deze week telt al" of oranje "Reeks in
  gevaar · nog 2 dagen" (vanaf vrijdag), bevriezers; 2) drie dagquests met balk, beloning en klokje
  als ze wachten; 3) dagkist: dicht (2/3) → glanzend "Open je kist" → geopend (+15 · wacht);
  4) weekuitdaging met dagen te gaan; 5) "3 inworpen wachten · +64 voorlopig"; 6) Ranglijst,
  Collectie. De eerste keer staat bij reeks, quests en kist een korte uitlegkaart.
- **Kist** (volledig scherm): kist in het midden; tik → schudden in drie golven, tikjes, glans →
  springt open → beloningskaart in de zeldzaamheidskleur, rollend getal, "wacht op goedkeuring".
  Link "Kansen" toont de gewichten uit `chest_rewards`.
- **Collectie.** "34/120 ontdekt" + balk naar de volgende mijlpaal; filter Alle/Ontdekt/Nog niet;
  raster van 4: ontdekt = kaart met #58, datum, "3×"; wacht = met klokje; niet ontdekt = silhouet
  "#59 ???". Tik → vuilbak op de kaart.
- **Ranglijst.** Deze week/Altijd; rij = plaats (medaille top 3), avatar, naam + "Lv 7 ·
  Stoepridder", punten; eigen rij altijd zichtbaar (vast onderaan als ze buiten beeld valt).
- **Profiel.** Avatar (tik = kiezer), naam, level + titel, ring naar het volgende level; punten
  (rollend) + "+64 wacht op goedkeuring"; statistieken (ontdekt, inworpen, langste reeks,
  bonusvragen); badges in een raster van 3 (vergrendeld = silhouet, tik = uitleg); Collectie,
  Ranglijst; historiek met "+16", "+16 · wacht", "afgewezen". Tandwiel → Instellingen.
- **Instellingen** (SwiftUI-formulier): naam, e-mail; meldingen (aan/uit per soort, uur van de
  quest-herinnering); testpunten (Dev); versie, updates; afmelden.
- **Avatar-kiezer** (sheet): raster; vergrendeld = silhouet met slot en "Hoe ontgrendel je dit?
  Bereik level 5".
- **Onboarding** (eerste login, en één keer voor bestaande accounts): naam ("zichtbaar op de
  ranglijst", met de mascotte) → avatar (standaardset) → de kaart. Geen uitlegpagina's.
- **Goedkeuringsviering** (bij openen, als er sinds het vorige bezoek beslist is): "Goedgekeurd!",
  totaal rolt van oud naar nieuw, chips per bron (+33 inworpen, +7 ontdekking, +50 mijlpaal, +10
  quest), bevestigde badges en avatars, eventueel een level-up met de nieuwe titel; afgewezen
  inworpen rustig in een apart blok met de reden, zonder viering.
- **Mijlpaal / level-up** (`celebrate.tsx`): groot getal ("20 vuilbakken ontdekt" of "Level 8 ·
  Leiewachter"), confetti, beloningen met "wacht op goedkeuring" waar nodig.
- **Beheer.** Per inworp ook de vlaggen NIEUW (ontdekking) en "mijlpaal 20 hangt hiervan af";
  afwijzen met een optionele reden (foto onduidelijk · geen vuilbak · dubbel of misbruik · andere);
  segment "Goedgekeurd" met Herroepen (reden verplicht).
- **Dev-modus.** Nieuwe sectie "Vieringen bekijken": onthulling met ontdekking/reeks verlengd (en
  later premie), mijlpaal (drempel kiezen), level-up, kist (beloning kiezen), goedkeuring (aantallen
  kiezen), quest voltooid, badge, uitlegkaarten, onboarding (via de preview-route), testmelding over
  5 s. Schrijft niets.

---

## 6. Eventtaxonomie

Gemeenschappelijk (kolommen): `user_id`, `session_id`, `client_ts`, `server_ts`, `app_version`,
`update_id`, `platform`, `is_test`. Nooit locaties in `props`; `bin_id` mag (vuilbakken zijn
publiek). Komt volledig in `docs/ANALYTICS.md`.

| Event | Wanneer | Props |
|---|---|---|
| `app_open` | start of terug uit de achtergrond | `kind` cold/warm |
| `session_start` / `session_end` | nieuwe sessie (koud of > 30 min weg) / verstuurd zodra vaststaat dat de vorige sessie voorbij is | — / `duration_s` |
| `app_background` | naar de achtergrond | `foreground_s` |
| `screen_view` | routewissel (uit `useSegments`) | `screen` (routenaam zonder parameters) |
| `map_bin_tap` | tik op een pin | `bin_id`, `discovered` |
| `checkin_flow_start` | "Inworp registreren" | `bin_id`, `distance_bucket` |
| `camera_opened` / `photo_taken` | camera / foto | `mode` checkin/report; `retake` |
| `checkin_submitted` / `checkin_result` | versturen / antwoord | `bin_id`, `upload_kb` / `ok`, `reason`, `duration_ms` |
| `reveal_shown` / `reveal_skipped` | onthulling / overslaan | `total`, `discovery`, `streak_weeks`, `preview` / `step` |
| `bonus_question_answered` | antwoord of overslaan | `question_key`, `answered`, `response_ms` (op 100 ms) |
| `discovery_shown`, `milestone_shown`, `level_up_shown`, `badge_shown` | viering getoond | `ordinal` / `threshold` / `level` / `badge_key`, `status` |
| `approval_shown` | goedkeuringsviering | `approved`, `rejected`, `points` |
| `quest_viewed` / `quest_completed` | quests zichtbaar / voltooid getoond | `open`, `done` / `template_key`, `period` |
| `chest_opened` | kist geopend | `reward_kind`, `amount` |
| `tip_shown` | eenmalige uitleg getoond | `tip` streak/quests/chest |
| `avatar_changed` | avatar bewaard | `avatar_key`, `from` onboarding/profile |
| `onboarding_step` / `onboarding_completed` | stap / klaar | `step` name/avatar / — |
| `collection_viewed` | collectie open | `discovered`, `total` |
| `notification_permission` | na de vraag | `status`, `prompt` pre/system |
| `notification_scheduled` / `notification_opened` | gepland / geopend | `type`, `in_hours` / `type` |
| `leaderboard_viewed` | ranglijst of periode | `period` |
| `report_flow_start` / `report_submitted` | melding ontbrekende vuilbak | — / `ok` |
| Fase 8–9 | `heatmap_toggled` (`on`, `period`, `layer`), `recap_shown` / `recap_shared` (`week`), `bounty` in `map_bin_tap` en `reveal_shown` | |

**Client** (`src/analytics/`): getypte `track(name, props)`; events eerst in een geheugenbuffer, dan in
batches naar een wachtrij in `expo-sqlite` (eigen bestand, async API), elk met de `user_id` van dat
moment; alleen events van de huidige gebruiker worden verstuurd (wisselen van account op staging).
Versturen elke ±30 s, bij naar de achtergrond gaan en bij de volgende start; niet tijdens een
onthulling of viering. Een 2xx wist de batch; opnieuw proberen alleen bij netwerkfouten, 5xx en 401,
met backoff. Max 5.000 events en 30 dagen in de wachtrij. Nooit blokkerend, nooit een crash. Een
Jest-test houdt de namen in TS en `docs/ANALYTICS.md` gelijk; een integratietest die van de whitelist
in de database.

---

## 7. Fases

**Fase 1a t/m 7 bouwen we nu, één fase per sessie, en dan stoppen we.** Fase 8–10 komen pas na een test met
echte spelers; wat we in die test leren, kan ze nog veranderen.

Tegenover de voorgestelde volgorde: de onthulling gaat eerst over op serverstappen, zonder dat je iets
ziet veranderen (fase 2), met een meting op je iPhone voor er nieuwe stappen bijkomen; de oude fase 3
is gesplitst (identiteit, dan progressie) en de goedkeuringsviering komt al in fase 5 (level-ups
gebeuren pas bij goedkeuring, en "pending → goedgekeurd" is de ruggengraat van het spel); lokale
meldingen komen direct na Vandaag; en fase 1 is gesplitst in 1a (ledger) en 1b (config en
eventlog). Er is geen nieuwe IPA nodig: alles gaat als EAS Update.

**Elke fase:** branch `gamification/<nr>-<naam>` vanaf `main`; nieuwe migraties als nieuwe bestanden;
pgTAP voor elke nieuwe functie en RLS-regel (altijd ook: testinworpen maken geen spelfeiten en tellen
niet mee, en een afwijzing draait beloningen terug) en `check_points_invariant()` aan het einde;
Deno-tests voor `submit-checkin`; Jest voor de app-logica; `db:test`, `db:lint`, `test:functions`,
`functions:check`, `test:functions:integration`, app `typecheck`, `lint`, `test`, `test:scripts`,
`check:staging-bundle` groen. Echte run lokaal, dan staging: backup (`sudo systemctl start
bq-backup`), `stagingctl.py migrate`, `migrate --apply`, `deploy` als de functie veranderde, de drie
checks, meteen daarna `npm --prefix app run update:dev`. Dev-modus-preview van elke nieuwe viering.
`docs/GAMIFICATION.md`, `docs/ANALYTICS.md` en `docs/PRE-BETA.md` bijwerken. Kort verslag (wat, hoe
getest, wat jij op de iPhone test) en wachten op akkoord.

**Bestaande tests.** `01`–`07` blijven groen, maar niet allemaal ongewijzigd:
- `points_awarded` verdwijnt (fase 1a): de asserties op die kolom in 02, 06 en 07 lezen de punten van
  een check-in voortaan uit de ledger, en de controle op `points_awarded` bij pending (02) vervalt;
- `checkin_point_stages` verdwijnt (fase 2): die asserties in 06 verhuizen naar `11_scoring`;
- ontdekkingschips (fase 3) veranderen de verwachte punten in 02, 06 en 07 (bv. 11 → 17): die tests
  zetten binnen hun transactie de oude economie vast via `game_config`;
- zonder naam uit het e-mailadres (fase 4) geven de fixtures in 01, 06 en 07 hun accounts een naam.

Elke aanpassing staat in het verslag van die fase.

### Fase 1a — Puntenledger (`gamification/1a-ledger`)
- Server: `point_transactions` + projectie- en deltatriggers + `check_points_invariant()`; migratie
  van de punten met snapshot en controle, daarna `points_awarded` weg; `review_checkin(id, approve,
  reason)`, `revoke_checkin`, `adjust_points`, `answer_bonus_question`, `reset_dev_test_data` en
  `leaderboard` op de ledger, met de lock-volgorde van 2.9; `record_checkin` security definer;
  `point_transactions` in de tabellenlijst van `vm/check-restore.sh`.
- App: historiek uit de ledger met "wacht op goedkeuring"; Beheer: afwijsreden en segment
  "Goedgekeurd" met Herroepen.
- **Veilige updates:** Reanimated 4.7.1, worklets 0.13.0 en gesture-handler 3.3.0 zitten nu alleen
  als peer in de lockfile. Ze komen met exact die versies in `package.json` (geen native wijziging,
  en in `expo.install.exclude`), en `update:dev` weigert te publiceren als de native versies afwijken
  van een vastgelegde lijst voor runtime 1. Zo kan geen update JavaScript sturen die niet bij de IPA
  past.
- Docs: in `HANDOFF-APP-STAGING.md` en `STAGING.md`: de oude staging-IPA wordt niet meer ondersteund.
- Tests: `00_schema_guard` (elke tabel in `public` heeft RLS en geen schrijfrechten voor
  anon/authenticated buiten een lijst; elke nieuwe functie is ingetrokken voor public/anon),
  `08_points_ledger` (migratie = snapshot op een fixture met pending/approved/rejected/test/
  bonus-na-goedkeuring; goedkeuren, afwijzen, herroepen, opnieuw verdienen; gebruikers schrijven de
  ledger niet; ranglijst; reset; een check-in als `service_role`); de aanpassingen aan 02, 06 en 07
  (`points_awarded` → ledger); Deno: herroepen, en beoordeling + inworp tegelijk (geen deadlock).
- Klaar als: op staging zijn de punten voor en na de migratie identiek (query in het verslag);
  herroepen verlaagt de punten; `update:dev` weigert bij een versieverschil.

### Fase 1b — Config en eventlog (`gamification/1b-config-events`)
- Server: `game_config` + validatie + `private.cfg`; `checkin_point_stages`, `record_checkin` en
  `answer_bonus_question` lezen hun getallen uit config (zelfde uitkomst); `app_events`,
  `event_names`, `log_events`.
- App: `src/analytics/` met de events die al bestaan (app_open … reveal, bonus, ranglijst).
- Docs: `docs/ANALYTICS.md` met de taxonomie uit hoofdstuk 6.
- Tests: `09_game_config` (waarden = de oude constanten; validatie weigert foute waarden; niet
  leesbaar of schrijfbaar voor gebruikers), `10_app_events` (whitelist, groottes, rate limit,
  idempotent, locatiesleutels, testvlag, RLS, cascade); Deno: integratie events; Jest: wachtrij
  (batches, per gebruiker, backoff, plafond, gooit nooit), sessies, namen = `ANALYTICS.md`.
- Klaar als: een foute waarde in `game_config` wordt geweigerd; events van de iPhone komen binnen
  (telling per naam).

### Fase 2 — Onthulling op serverstappen (`gamification/2-onthulling`)
- Server: `private.checkin_score` met de stappen basis en reeks (ontdekking 0: dezelfde getallen als
  nu); `record_checkin` geeft `score` terug; `submit-checkin` stuurt `score` i.p.v. `points`;
  `checkin_point_stages` weg.
- App: `buildRevealTimeline` uit stappen; `endState`; achtergrond- en VoiceOver-gedrag;
  geluidspijplijn (alleen nodige samples, hash in de cachesleutel, readiness op samples, mix tijdens
  het uploaden, derde soundtrack voor vieringen); `theme/` + game-tokens; basiscomponenten
  (`GameNumber`, `ChunkyButton`, `ProgressBar`, `PendingTag`, `ProgressRing`-prototype);
  `ToastViewport`; skelet van de `MomentsPresenter`.
- Tests: `11_scoring` (stappen en tussentotalen uit config, testinworpen alleen basis + reeks, de
  oude asserties uit 06); Jest bewijst dat basis + reeks uit `score.steps` exact dezelfde events en
  dezelfde mixsleutel geven als vandaag, en dat overslaan = uitspelen; Deno: `score` doorgegeven.
- Klaar als: je ziet en hoort geen verschil, en de metingen in de Dev-preview (UI-hapering ≤ 17 ms,
  beeld↔geluid ≤ 16 ms) zijn minstens even goed.

### Fase 3 — Ontdekken: ontdekkingen, mijlpalen, collectie (`gamification/3-ontdekken`)
- Server: ontdekkingschips aan; `discoveries`, `milestones` + `user_milestones`,
  `refresh_game_state`, `my_collection`, `my_game_state` (v1), `my_unseen`/`mark_seen` (momenten),
  `game` in het antwoord.
- App: ontdekkingsstap en banner; mijlpaalviering met confetti; nieuwe geluiden; kaart met
  ontdekt/niet-ontdekt en teller; Collectie; gemiste momenten via de presenter; Dev-previews.
- Tests: `12_discoveries` (eerste niet-afgewezen; afwijzing verschuift of laat vervallen; mijlpaal
  pending/granted/revoked en opnieuw verdiend; testinworpen maken geen ontdekking; refresh twee keer =
  niets; ledgerdelen = totaal); 02/06/07 met vastgezette oude economie; integratie: eerste inworp =
  ontdekking, tweede niet, afwijzen haalt ze weg; Jest: tijdlijn (volgorde, geluiden, Reduce Motion,
  onbekende stap), parsers.
- Klaar als: een eerste inworp bij een nieuwe vuilbak toont de banner en +5 chips; de 10e ontdekking
  toont "+50 · wacht op goedkeuring"; na afwijzen klopt de collectie; met Reduce Motion niets dat
  schudt of vliegt.

### Fase 4 — Identiteit: onboarding, avatars, levels, profiel (`gamification/4-identiteit`)
- Server: `avatars` (12 placeholders), `levels`, profielkolommen, `complete_onboarding`,
  `set_my_avatar`, `my_avatars`, `handle_new_user` zonder e-mailnaam, `leaderboard` met avatar en
  level.
- App: onboarding (naam, avatar, kaart) met drie-toestandenguard en preview-route; `Avatar` (PNG of
  placeholder: gekleurde cirkel met SF Symbol; silhouet via `tintColor`; onbekende sleutel →
  placeholder); `app/scripts/avatars.mjs` maakt de `require`-map en kleine thumbnails uit
  `app/assets/avatars/*.png` (een test faalt als die achterloopt); avatar-kiezer; Profiel en
  Ranglijst in React Native; Instellingen. `docs/AVATARS.md`: PNG 512 × 512 met transparantie, max
  200 KB, bestand `<key>.png`, script draaien, eventueel een rij in `avatars`, `update:dev`.
- Tests: `13_identity` (onboarding valideert; vergrendelde avatar weigeren; level-unlocks; geen
  e-mailnaam; RLS); Jest: avatar-map, levelvoortgang, guard; script-test.
- Klaar als: nieuw account → naam → avatar → kaart; bestaande accounts zien dat één keer; offline
  starten blijft werken; een PNG toevoegen + script + update toont de tekening.

### Fase 5 — Progressie: badges en goedkeuringsviering (`gamification/5-progressie`)
- Server: `badges`, `user_badges` (regels in de refresh), `my_badges`, beslissingen in `my_unseen`
  (tot het tijdstip van het antwoord, geen race met een beoordeling ertussen), level-up via
  `last_seen_level`.
- App: badgeraster en uitleg; goedkeuringsviering via de presenter (koude en warme start); level-up;
  Dev-previews.
- Tests: `14_badges` (elk regeltype, pending/granted/revoked, testinworpen tellen niet), `15_unseen`;
  integratie: goedkeuren → ongezien → gezien; Jest: viering-tijdlijn, presenter-volgorde.
- Klaar als: na een goedkeuring toont de app bij het openen "Goedgekeurd! +16" met het nieuwe totaal
  en eventueel het nieuwe level; afwijzingen rustig met reden; niets verschijnt boven de camera of
  een onthulling.

### Fase 6 — Vandaag: quests, kist, dagbolletjes, bevriezer (`gamification/6-vandaag`)
- Server: `quest_templates` (dag en week), `user_quests` (3 per dag, deterministisch via
  `hashtextextended(user, dag, vak)`, met voorwaarden zoals "er zijn nog niet-ontdekte vuilbakken"),
  weekuitdaging, `daily_chests` + `chest_rewards` + `open_daily_chest` (kisten van de laatste 7 dagen
  te openen), `streak_freezes` en het afgeleide gebruik in `streak_weeks`, `my_game_state` v2.
- App: tab Vandaag + dubbele routes; Vandaag-scherm met eenmalige uitleg bij reeks, quests en kist;
  kist-scherm; reekskaart met dagbolletjes, gevaar en bevriezers; quest-momenten na de onthulling;
  tab-badge; Dev-previews.
- Tests: `16_quests_chest_freeze` (zelfde gebruiker en dag = zelfde quests; voortgang voorlopig en
  zeker; afwijzing draait quest en kist terug; kist trekt één keer (met `setseed`); kansen uit de
  tabel, geen bevriezer bij 2 in bezit; bevriezer alleen bij een volledig gat en telt niet mee;
  testinworpen tellen niet); Jest: view-models, dagbolletjes, gevaar vanaf vrijdag, uitleg één keer.
- Klaar als: quests lopen meteen op na een inworp (ook via het bonusantwoord); 3/3 → kist met een
  serverbeloning; afwijzen zet de quest terug; een gemiste week met bevriezer houdt de reeks.

### Fase 7 — Meldingen (`gamification/7-meldingen`)
- App: planner (puur, getest): reeks in gevaar (zondag 17:00 als er deze week nog niets is),
  quest-herinnering (eigen uur 9–20), kist klaar; max 1 per dag, stil 21–9, per soort uit te zetten,
  minder na 3 genegeerde (eigen planning + `getPresentedNotificationsAsync`). Opnieuw gepland na een
  verse `my_game_state` (bij elke opening en na elke inworp; offline blijft de vorige planning),
  met `DATE`-triggers. `setNotificationHandler` voor meldingen terwijl de app open is; een tik opent
  het juiste scherm, ook bij een koude start (`getLastNotificationResponse`). Toestemming pas na de
  eerste geslaagde inworp, via de presenter, met eerst een eigen uitleg. Geen nieuwe IPA:
  `expo-notifications` zit in de build en de config-plugin is voor lokale iOS-meldingen niet nodig.
- Tests: Jest: planner (max 1 per dag, stille uren, prioriteit, uit-schakelaars, terugschakelen).
- Klaar als: een testmelding uit Dev-modus komt binnen en opent het juiste scherm; zonder inworp deze
  week staat er een melding klaar voor zondag 17:00 en verdwijnt die na een inworp.

**Hier stoppen we.** Daarna een test met echte spelers. Vóór die test: de privacypunten uit PRE-BETA
die over events en spelfeiten gaan (privacyverklaring, toestemming). Tijdens de test kijken we met
losse queries in Studio; de analyseviews komen in fase 10.

### Fase 8 — Kaart voor de stad: premies en heatmap (na de spelerstest)
- Server: `bounty_bins`, `ensure_bounties` (lui, met lock: de vuilbakken in de regio met de minste
  echte, niet-afgewezen check-ins en bonusantwoorden in 30 dagen, ≥ 100 m uit elkaar, gelijkspel
  deterministisch per dag), premiestap in `checkin_score`, premie-quest en -badge, vlag in Beheer.
  `heatmap(period, layer)`: goedgekeurde, echte check-ins per **vuilbak** (publieke locaties, nooit
  gebruikerslocaties), alleen vuilbakken met ≥ 3 verschillende gebruikers in die periode, waarden in 5
  klassen (geen exacte tellingen, zodat perioden niet van elkaar af te trekken zijn); week/30
  dagen/altijd. Admins: laag `full` (aandeel "vol" bij `bin_fullness`) en `shortage` (score uit
  `walk_distance`, `find_ease`, `extra_bin`) uit `bin_need_answers`, met minstens 3 antwoorden per
  vuilbak.
- App: gouden pins, aftelchip, sheet; premiestap in de onthulling; teaser in Vandaag; laagknop en
  periodekeuze; `Circle`-overlays rond de vuilbakken (de `Heatmap`-component van react-native-maps
  werkt alleen met Google Maps, bevestigd in hun docs), sequentiële kleuren, legende; admin-lagen;
  Dev-previews (ook de heatmap met voorbeelddata).
- Tests: `17_bounties` (minste data, alleen regio, geen testdata, stabiel per dag, afstand, ×2 alleen
  die dag, cooldown/daglimiet/afstand blijven gelden; testvuilbakken bij Null Island vallen buiten de
  regio), `18_heatmap` (k, klassen, geen testdata, perioden, admin-lagen geweigerd voor gebruikers);
  Jest: aftelklok, premiestap, kleurschaal.

### Fase 9 — Weekoverzicht en ranglijst (na de spelerstest)
- Server: `my_week_recap`; `leaderboard.movement`: "deze week" t.o.v. de eindstand van vorige week,
  "altijd" t.o.v. de stand bij het begin van deze week.
- App: weekoverzicht via de presenter (maandag); delen **als tekst** via `Share` (of voorlopig niet
  delen). Geen afbeelding, geen `react-native-view-shot`, geen nieuwe IPA of runtime. Pijltjes in de
  ranglijst.
- Docs: ontwerp voor remote push (APNs-key, tabel met device-tokens, melding bij goedkeuring en bij
  ingehaald worden) in PRE-BETA; Duolingo-leagues (vanaf ±100 wekelijkse spelers) in ROADMAP.
- Tests: pgTAP `19_recap_leaderboard`; Jest: weekoverzicht.

### Fase 10 — Analyse (na de spelerstest)
- Server: schema `analytics` (geen API-toegang), `analytics.excluded_users` (staf en testaccounts),
  views: DAU/WAU/MAU, cohortretentie D1/D7/D30 en per week, check-in-funnel, gebruik per vuilbak
  (inworpen, unieke gebruikers, uur/weekdag, volheid), tekortzones, effect van features (voltooide
  quests; melding → inworp binnen 2 u), punten per bron, wachttijd tot goedkeuring;
  `analytics.apply_event_retention()` (ruwe events > 13 maanden → dagtellingen, dan wissen). Het
  automatisch plannen ervan (pg_cron of een timer op de VM) gaat naar PRE-BETA.
- Script: `scripts/analytics-export/export_analytics.py` (venv, `--target staging` via `devenv.py`
  zoals de andere scripts), elke view naar CSV en Parquet in `data/exports/<datum>/` (gitignored).
- Tests: `20_analytics` (geen testdata of staf, retentie, rechten); unittest voor het script.
- Docs: `ANALYTICS.md` volledig, `GAMIFICATION.md` eindversie, `README.md` (export), `PRE-BETA.md`.

---

## 8. Risico's en maatregelen

| Risico | Maatregel |
|---|---|
| **Vals spelen** (meer beloning = meer reden om gps te vervalsen) | Elke beloning hangt aan moderatie (pending tot goedkeuring); cooldown, daglimiet, afstand en nep-locatieregels ongewijzigd; quests, kist en bevriezers alleen via echte, beoordeelde acties; bedragen en loten alleen op de server, één keer getrokken; Beheer toont NIEUW en mijlpaal-afhankelijkheid; herroepen draait alles terug. PRE-BETA: dubbele foto's herkennen (perceptuele hash), App Attest |
| **Werkdruk moderatie** | ±10 s per beoordeling: 50 spelers (10 actief) ≈ 23 per dag ≈ 4 min; 500 spelers ≈ 40 min per dag. Beheer sneller (vlaggen, redenen met één tik); wachtrijgrootte en wachttijd tot goedkeuring meten (die wachttijd is ook de vertraagde beloning: doel < 24 u). PRE-BETA: steekproeven bij vertrouwde gebruikers, meerdere moderatoren |
| **Meldingsmoeheid** | Opt-in na de eerste succesvolle inworp, max 1 per dag, stille uren, per soort uit te zetten, minder na 3 genegeerde; open-ratio per soort meten |
| **Privacy** | Geen locaties in events; ranglijst toont alleen naam, avatar, level; wissen met het account; later heatmap per publieke vuilbak, k ≥ 3, in klassen, en een bewaartermijn van 13 maanden. Vóór de spelerstest: privacyverklaring (events, spelfeiten) en toestemming voor gebruiksanalyse (PRE-BETA) |
| **Kansspel** | De kist is gratis, verdiend met echte acties, alleen punten/bevriezers/cosmetica, kansen zichtbaar; nooit iets te koop |
| **Een update die crasht** | Native versies vastgepind en gecontroleerd door `update:dev` (fase 1a); terugrollen = vorige update opnieuw publiceren |
| **Complexiteit** | Eén evaluatiemodel (twee zekerheden + volledige refresh) met invarianttests; geen aparte testwereld; spelfouten breken nooit een check-in of een beoordeling; `private.game_errors` + `repair_game_state` |

---

## 9. Besluiten en aannames

**Besluiten (15 oktober 2026):**
- Fase 1a t/m 7 bouwen we nu, één fase per sessie, en dan stoppen we. Fase 8–10 pas na een test met
  echte spelers.
- Geen nieuwe IPA: het weekoverzicht wordt gedeeld als tekst via `Share` (of voorlopig niet); geen
  `react-native-view-shot`, geen runtime 2.
- De cofounder stapt over op Zwerfvuil Dev: geen compatibiliteitslaag voor de oude staging-IPA
  (geen oud `points`-object, geen `points_awarded`, geen `checkin_point_stages`, API's mogen breken).
- Vouchers komen later, met loten op basis van punten afgetopt op 150 per week; nu niet bouwen.
- Onboarding: alleen naam en avatar, dan de kaart. Reeks, quests en kist krijgen een eenmalige uitleg
  bij hun eerste verschijning.

**Aannames (zelf gekozen):**
- **Geen testwereld per spelfeit**, want dat geeft de minste code: geen `is_test` in elke speltabel,
  geen dubbele evaluatie (echt en echt + test), geen "delta"-logica, en de reset blijft zoals hij is.
  Testinworpen maken geen spelfeiten; de logica zit in pgTAP- en integratietests, elke viering in een
  Dev-preview, en de echte keten testen we op staging met een apart, gewoon testaccount dat echte
  inworpen doet (dat account komt later in `analytics.excluded_users`). Wat we opgeven: spelfeiten
  op staging zien zonder echt te stappen.
- Ontdekking = eerste niet-afgewezen check-in van een gebruiker bij een vuilbak; "#58" is het
  vuilbaknummer (`bins.id`, zoals nu in de app), "12/120" de teller van de regio.
- "2 inworpen in verschillende straten" wordt "2 inworpen bij vuilbakken minstens 200 m uit elkaar":
  er zijn geen straatnamen in de data.
- Dagquests resetten om 00:00 Europe/Brussels; de weekuitdaging op maandag.
- Een bevroren week houdt de reeks heel maar telt niet mee (de mult stijgt niet).
- Level-ups ontstaan alleen door goedgekeurde punten en worden gevierd in de goedkeuringsviering.
- De weekranglijst telt voortaan alle goedgekeurde punten van die week (ook quests en mijlpalen).
- Admins spelen mee op de ranglijst; voor productcijfers sluiten we staf en testaccounts uit via
  `analytics.excluded_users`.
- Geen nieuwe edge functions: alles via RPC's (de deploy-scripts blijven gelijk).
- Teksten zeggen zo weinig mogelijk de appnaam; waar nodig de huidige naam van de build.
- Fase 8–10: premies voor iedereen dezelfde, 5 per dag in de regio; de heatmap per vuilbak i.p.v. per
  hexagon (in de testregio staat er per cel van ±60 m toch maar één vuilbak, en vuilbaklocaties zijn
  publiek).

**Open vragen:** geen.

---

## Bestanden en hergebruik

- Server: nieuwe migraties per fase in `supabase/migrations/`; `supabase/functions/submit-checkin/handler.ts`
  (+ types) en `rules.ts`; tests `supabase/tests/database/00_…16_*.test.sql` (en de aanpassingen aan
  01, 02, 06, 07), `supabase/functions/tests/handler.test.ts`, `submit-checkin.integration.ts`, nieuw
  `events.integration.ts`; `infra/staging/vm/check-restore.sh` (tabellenlijst).
- App: `src/feedback/reveal/timeline.ts`, `tuning.ts`, `useRevealMotion.ts`, `src/app/reveal.tsx`;
  `src/feedback/sfx/soundtrack.ts`, `engine.ts`, `mix.ts`, `sources.ts` en `scripts/generate-sfx.mjs`;
  `src/lib/points.ts`, `api.ts`, `checkin.ts`, `reveal.ts`; `src/theme.ts` → `src/theme/`;
  `src/app/_layout.tsx` en `(tabs)/_layout.tsx` + de nieuwe routes; nieuwe providers
  (`GameProvider` voor catalogus en spelstaat, `AnalyticsProvider`, `ToastProvider`,
  `MomentsPresenter`); `src/analytics/`, `src/game/`, `src/screens/`, `src/components/game/`;
  `app/package.json` en `app/scripts/update-dev.mjs` (versiecontrole).
- Hergebruik: `countSteps` (`lib/reveal.ts`), `runTimeline`/`playTimeline`, `mixTimeline`/`Soundtrack`,
  `fireHaptic`, `useSyncState`, `GlassPanel`, `EmptyState`, `MapPin` (varianten), SQL
  `local_day_start`/`local_week_start`, `dev_mode_allowed_for`, `app_environment`, `streak_weeks`
  (uitgebreid), view `bin_need_answers`, `stagingctl.py migrate/deploy`, `update:dev`.
- Docs: `docs/GAMIFICATION.md` (dit plan), `docs/ANALYTICS.md`, `docs/AVATARS.md`, `docs/PRE-BETA.md`,
  `docs/HANDOFF-APP-STAGING.md`, `docs/STAGING.md`, later `docs/ROADMAP.md` en `README.md`.

## Verificatie

Per fase: alle tests en controles uit "Elke fase" groen; een echte lokale run (lokale Supabase,
integratietests, en voor UI: export + bundelcontrole); dan staging met backup, migratie, deploy en de
checks (`check-supabase`, `check-auth`, `check-fake-location`), een EAS Update, en op de iPhone: de
Dev-modus-preview van elke nieuwe viering, één echte inworp met het testaccount door de hele keten
(onthulling → beheer → goedkeuringsviering), Reduce Motion aan, stil-schakelaar, en in fase 1a een
vergelijking van de punten en in fase 1b van de eventtellingen in Studio.

---

## Overdracht

Stand op 19 oktober 2026: fase 1a, 1b, 2, 3 en 4 zijn af en gemerged in `main` (PR #2 t/m #6); fase 3
en 4 staan op staging en als EAS Update op `dev`, en zijn op de iPhone gecontroleerd.

- Af: dit plan; fase 1a (puntenledger); fase 1b (config en eventlog), lokaal.
  - Server (`20261015120000_points_ledger.sql`): `point_transactions` met de projectie vanuit
    `checkins` en de deltatrigger naar `profiles`; `private.check_points_invariant()`; de migratie
    van de punten als `private.migrate_points_to_ledger()` (snapshot, projectie, `adjustment`
    "migratie" voor verschillen, faalt bij een verschil); `points_awarded` en `points >= 0` weg;
    `review_checkin(id, approve, reason)`, `revoke_checkin`, `adjust_points`, `approved_checkins`;
    bonusantwoord, reset en ranglijst op de ledger met de lock-volgorde van 2.9; `record_checkin`
    security definer; `point_transactions` in `check-restore.sh`.
  - App: historiek uit de ledger (`src/lib/history.ts`) met "Wacht op goedkeuring", reden en
    "Herroepen"; onder de punten "+N wacht op goedkeuring"; Beheer met afwijsreden en de tab
    "Goedgekeurd" met Herroepen; Reanimated, worklets en gesture-handler vast in `package.json`;
    `update:dev` weigert bij een native verschil met `app/native-versions.json`.
  - Tests: `00_schema_guard`, `08_points_ledger`, aangepaste 02/06/07 (punten uit de ledger, de
    controle op `points_awarded` bij pending weg, invariant aan het einde); Deno: herroepen en 5
    rondes beoordeling + inworp tegelijk; Jest `history.test.ts`; `native-versions.test.mjs`.
- Kleine keuzes buiten het plan:
  - extra RPC `approved_checkins(max_rows)` voor de tab "Goedgekeurd";
  - een trigger weigert elke rechtstreekse wijziging van `profiles.points`/`test_points`, ook door
    `postgres` in Studio: correcties alleen via `adjust_points`;
  - `set_updated_at()` is niet meer uitvoerbaar voor de API-rollen, zodat `00_schema_guard` geen
    uitzonderingen nodig heeft;
  - de historiek filtert op de eigen gebruiker (door RLS zag een admin daar alle inworpen);
  - redenen: drie vaste redenen, een eigen tekst of (bij afwijzen) geen; de tekst staat in
    `checkins.review_reason`, de ledger bewaart `checkin_rejected` of `checkin_revoked`;
  - `granted_at` blijft staan op een herroepen rij (wanneer ze toegekend was).
- Staging (15 oktober): backup gemaakt, `20261015120000_points_ledger.sql` toegepast (de functie is
  niet veranderd: geen `deploy`). Telling voor en na identiek: 2 profielen, 0 echte punten,
  48 testpunten, dezelfde hash over (id, punten, testpunten); in de ledger 33 + 15 = 48 toegekende
  testpunten, 0 correcties "migratie", invariant leeg, `points_awarded` weg. `check-supabase`,
  `check-auth` en `check-fake-location` geslaagd. EAS Update op `dev` (runtime 1): update-groep
  `fb4c523e-9c9a-4666-8b76-1ab4a5ab5963` (commit 218a673).
- iPhone (15 oktober): historiek, afwijzen met reden en herroepen werken.

**Fase 1b (config en eventlog)**
- Server (`20261015140000_config_and_events.sql`): `game_config` met `private.game_config_rules`
  (soort en bereik per sleutel) en een trigger die foute waarden, onbekende sleutels, hernoemen,
  wissen van een gebruikte sleutel en `truncate` weigert; `private.cfg(key)`. Sleutels:
  `checkin_base_chips` 10, `streak_multiplier` 1.1, `streak_max_steps` 8, `bonus_question_points` 5.
  `checkin_point_stages` (nu `stable`, security definer), `record_checkin` en `answer_bonus_question`
  lezen ze; zelfde punten als voorheen. `event_names` (whitelist, 17 events), `app_events`,
  `log_events(events, client)`.
- Functie: `submit-checkin` geeft `bonus_question.points` van de database door (`BONUS_POINTS` weg
  uit `rules.ts`): na de migratie ook `stagingctl.py deploy`.
- App: `src/analytics/` (`track`, sessies, wachtrij in `analytics.db`, `AnalyticsTracker` in de
  root-layout); events in kaart, camera, `submitCheckin`, onthulling, bonusvraag, ranglijst en
  melding. Docs: `docs/ANALYTICS.md`.
- Tests: `09_game_config` (40), `10_app_events` (38); Deno `events.integration.ts` (in
  `test:functions:integration`), `handler.test.ts` met `points: 7` (doorgeven i.p.v. constante);
  Jest `analytics/__tests__` (wachtrij, sessies, props, namen = `ANALYTICS.md`). 01–08 ongewijzigd.
- Kleine keuzes buiten het plan:
  - de regels per sleutel in een tabel (`private.game_config_rules`) i.p.v. in de trigger: een nieuwe
    sleutel = een regel en een rij; een sleutel afschaffen = eerst zijn regel wissen;
  - `bonus_question.points` komt uit de config bij het aanbieden, het bedrag zelf bij het antwoord
    (dan ontstaat de beloning); `STREAK_MULTIPLIER` blijft tot fase 2 een label in de functie en de
    app;
  - `log_events`: `is_test` per event (een batch kan previews en gewone events mengen); props plat met
    snake_case-sleutels (zo is de locatiecontrole volledig); meer dan 100 events = fout (400), de app
    wist zo'n batch; een al opgeslagen `id` telt als `accepted`; rare `client`-velden worden leeg of
    ingekort, nooit een fout; `event_names.active` om een event af te schaffen, met een foreign key
    vanuit `app_events`;
  - de events van 1b: ook `report_flow_start`/`report_submitted` (de melding bestaat al); `discovered`
    in `map_bin_tap` pas in fase 3; `checkin_submitted`/`checkin_result` in `submitCheckin`
    (`api.ts`), waar grootte en duur bekend zijn;
  - een sessie hoort bij één gebruiker: aanmelden start er een, afmelden sluit ze af;
  - tijdens de onthulling wordt niets weggeschreven of verstuurd (`holdAnalytics`);
  - opnieuw proberen strikt bij 0, 5xx en 401 (ook 429 wordt gewist);
  - `game_config`, `event_names`, `app_events` en `private.game_config_rules` in `check-restore.sh`.
- Staging (15 oktober): backup `postgres-20261015-171955.dump`; `20261015140000_config_and_events.sql`
  toegepast. Telling voor en na identiek: 2 profielen, 0 echte en 32 testpunten, dezelfde hash over
  (id, punten, testpunten), check-ins 2 goedgekeurd en 2 afgewezen, ledger 0/32, invariant leeg,
  `checkin_point_stages(8)` = {10, …, 21}. `game_config` heeft de oude waarden; een foute waarde (`11`
  voor `streak_multiplier`) wordt geweigerd. 17 actieve events, 0 rijen in `app_events`. `deploy`
  (functie met `bonus_question.points` uit de database), `check-supabase`, `check-auth` en
  `check-fake-location` geslaagd. EAS Update op `dev` (runtime 1): update-groep
  `779e0248-bf06-4116-9a09-5bb252cb1230` (commit 29e486e).
- iPhone (15 oktober): inworp, bonusvraag, ranglijst, Dev-preview en achtergrond. In `app_events`
  67 events van 1 gebruiker in 2 sessies, 14 namen: `screen_view` 37, `leaderboard_viewed` 5,
  `map_bin_tap` 5, `app_open` 4, `app_background` 4, `session_start` 2, `reveal_shown` 2 (1 test),
  `bonus_question_answered` 2 (1 test), `session_end` 1 (322 s, bij de volgende koude start),
  `checkin_flow_start`, `camera_opened`, `photo_taken`, `checkin_submitted` (547 KB), `checkin_result`
  (ok, 383 ms) elk 1. Tijdens de onthulling werd niets verstuurd. Gevonden en opgelost: bij een koude
  start kwam 70 ms een `screen_view` "tabs" vóór "map" (de tab-layout zonder tab); `screenName` geeft
  daar nu `root` en dat wordt niet gelogd. Die correctie staat op `dev` als update-groep
  `43a20bc9-7e3b-4199-ae00-7c4094942176` (commit b8eb582).
**Fase 2 (onthulling op serverstappen)**
- Server (`20261015160000_checkin_score.sql`): `private.checkin_score(streak)` maakt `{steps, total}`
  uit `game_config`: `base` (`chips`, `mult` 1, `total`) en `streak` (`weeks`, `per_week`, `stages`
  met per week `mult` en het afgeronde tussentotaal); zelfde punten als voorheen. `record_checkin`
  geeft `score` terug i.p.v. `point_stages`/`points_total` (opnieuw aangemaakt, rechten terug) en
  bewaart `score.total` als `points_earned`; `checkin_point_stages` is weg. Nieuw: `game_catalog()`
  (aangemeld) met `{config}`.
- Functie: `submit-checkin` stuurt `score` zoals de database hem maakt (een onbruikbare score →
  `null` en een fout in de log); het `points`-object en `STREAK_MULTIPLIER` zijn weg. Na de migratie
  dus ook `stagingctl.py deploy`.
- App: `src/lib/score.ts` (parser; een onbekende stap blijft bewaard met label en totaal);
  `buildRevealTimeline({score})` speelt de stappen van de server en de slam landt op `score.total`;
  `src/feedback/reveal/state.ts` met `applyRevealEvent`/`endState`: overslaan, naar de achtergrond
  gaan en VoiceOver eindigen allemaal op de eindstand van de tijdlijn (achtergrond stil; VoiceOver
  zonder animatie, met een succes-haptiek en één samenvatting in de wachtrij). Getal, chips en MULT
  zijn gememoiseerde componenten op een eigen store: een tik hertekent alleen het getal.
  Geluid: alleen de samples van een tijdlijn worden gedecodeerd (elk één keer, een mislukte opnieuw);
  "klaar" = die samples, binnen 800 ms; de bestandsnaam van een mix bevat een hash van de
  geluidsbestanden; een mislukte `initSfx` begint de volgende keer opnieuw; de camera mixt en laadt
  de verwachte onthulling tijdens het uploaden; `celebrationSoundtrack` als derde speler.
  `src/theme/` (`index.ts` + `game.ts` met speltokens; de vaste kleuren van de onthulling staan daar
  nu), `useReduceMotion`/`useScreenReader`, `src/components/game/` (`GameNumber`, `ChunkyButton`,
  `ProgressBar`, `PendingTag`, `ProgressRing`-prototype), `ToastProvider` + `ToastViewport` (tabs,
  camera, onthulling houdt vast), skelet van de `MomentsPresenter` (`src/game/moments.ts`, nog geen
  bronnen). Profiel en Dev-modus lezen hun getallen uit `game_catalog()`; `BASE_POINTS`,
  `STREAK_MULTIPLIER`, `MAX_STAGES` en `pointStages` zijn weg uit `points.ts`.
- Dev-modus: de preview bouwt zijn score met `previewScore` uit de config; nieuw "Componenten
  bekijken" en "Testtoast tonen".
- Tests: `11_scoring` (32: stappen en tussentotalen, config, `record_checkin`, testinworp alleen
  basis + reeks, afwijzing draait terug, `game_catalog`, invariant); de 6 asserties op
  `checkin_point_stages` uit 06 verhuisden naar 11 (06: 54 → 48); 06, 07 en 09 lezen `point_stages`
  en `points_total` via een hulpfunctie uit `score`; samen 414. Deno: score doorgegeven (ook
  onbekende stappen), onbruikbare score, integratie met de score-JSON en `game_catalog`. Jest 204:
  `golden.test.ts` bewijst voor 176 gevallen (4 basissen × 0–10 weken × Reduce Motion × bonusvraag)
  dat de tijdlijn uit `score.steps` exact dezelfde events en dezelfde mixsleutel geeft als vóór fase
  2 (vingerafdrukken in `__fixtures__/reveal-v1.json`, gemaakt op 6609a29), ook vanuit de
  server-JSON zelf; `state.test.ts` bewijst dat overslaan op elk moment = uitspelen.
- Kleine keuzes buiten het plan:
  - `mult` per stap is de exacte multiplier (1.331, niet 1.33): zo zijn de events identiek aan
    vroeger; de app rondt af voor het label. De vingerafdrukken vergelijken getallen tot op 9
    decimalen (1,1³ is in JavaScript 1.3310000000000004);
  - de reeksstap staat er altijd, ook bij 0 weken (lege `stages`), met de hele reeks in `weeks` en
    `per_week` (voor "×1,1 per week"); `streak_extended` en `checkins.score` (bevroren stappen) komen
    pas met de vlam (fase 3) en de ledgersplitsing;
  - `game_catalog()` v1 (alleen `config`), zodat de labels in profiel en Dev-modus van de server
    komen; later komen levels, badges enz. erbij;
  - een stap van een onbekend soort speelt nog niet af (fase 3: generieke stap), maar de slam landt
    wel op het totaal;
  - `TOP_STAGE = 8` in `tuning.ts`: er zijn 8 `mult_N`-geluiden en de MULT-kleur loopt tot stap 8; een
    langer maximum in `game_config` blijft daar op de top;
  - achtergrond = `AppState` `background` (Control Center niet); `reveal_skipped` alleen bij een tik;
  - een bonusvraag zonder `points` wordt niet getoond (de terugval op 5 is weg);
  - de verwachte onthulling tijdens het uploaden komt uit `my_streak` (bij het openen van de camera),
    de config en de Dev-reeks; klopt ze niet, dan mixt de onthulling gewoon zelf;
  - toasts: geen eigen viewport in de vuilbak-sheet (de toast verschijnt erboven op de tabs); de
    `UpdatePrompt` zit nog niet in de wachtrij van de presenter.
- Staging (15 oktober): backup `postgres-20261015-182008.dump`; `20261015160000_checkin_score.sql`
  toegepast. Telling voor en na identiek: 2 profielen, 0 echte en 48 testpunten, dezelfde hash over
  (id, punten, testpunten), check-ins 3 goedgekeurd en 2 afgewezen, ledger 0/48, invariant leeg.
  `checkin_point_stages` weg, `record_checkin` met `score` (alleen voor de service role),
  `game_catalog()` voor aangemelde gebruikers, `checkin_score(3)` = 10, 11, 12, 13. `deploy`,
  `check-supabase`, `check-auth` en `check-fake-location` geslaagd. EAS Update op `dev` (runtime 1):
  update-groep `383b73e9-4f4c-45ea-ae26-18da7d25d94f` (commit a7aab85).
- Nog te controleren op de iPhone (na `update:dev`): Dev-preview zonder en met reeks (0, 3, 8, 10
  weken), met Reduce Motion en zonder geluid: zelfde beeld, geluid en haptiek als voorheen; de
  metingen onderaan (UI-blokkade ≤ 17 ms, beeld↔geluid ≤ 16 ms); naar de achtergrond tijdens een
  onthulling (stil op de eindstand); VoiceOver (eindstand + samenvatting); een echte inworp (de
  meting toont "mix uit cache" als de verwachte onthulling klopte); Componenten (ring scherp op
  44/72/120 pt, rollend getal, knop, balk) en een testtoast, ook terwijl de camera open is.

**Fase 3 (ontdekken: ontdekkingen, mijlpalen, collectie)**
- Server (`20261015180000_discoveries.sql`):
  - `game_config`: `discovery_chips` 5 (0 = de economie van vóór fase 3) en de regio als
    `region_west/south/east/north` (de bbox van `config/region.json`), elk met een regel.
  - Catalogus `milestones` (10, 20, … 150; +50, bij 50 +150, bij 100 +300); spelfeiten `discoveries`
    (pending/confirmed/revoked) en `user_milestones` (pending/granted/revoked, bevroren punten, anker),
    RLS eigen rijen/admins, geen schrijfrechten; `private.game_errors`; `profiles.moments_seen_at`.
  - `private.checkin_score(weeks, discovery, streak_extended)`: stap `discovery` (`chips` 15, `add` 5)
    vóór de reeks, de reeks op 15 chips, `streak_extended` en `parts` (`checkin` = round(10·m),
    `discovery` = totaal − checkin). `checkins.score` bewaart de score (controle: `total` =
    `points_earned`); de projectie maakt de ledgerrijen uit `parts` (ook `bounty` voor fase 8).
  - `private.refresh_game_state(user)`: ontdekkingen (eerste niet-afgewezen echte inworp per vuilbak;
    confirmed zodra er een goedgekeurde is; verschuift of vervalt bij afwijzen), mijlpalen (granted
    over confirmed, pending over alle niet-vervallen ontdekkingen, anders revoked; opnieuw verdiend =
    dezelfde rij en bevroren bedrag) en hun ledgerrijen `milestone:<drempel>`. Past alleen aan wat
    afwijkt en geeft het aantal gewijzigde rijen terug (tweede keer 0). `record_checkin` (niet voor
    testinworpen), `review_checkin`, `revoke_checkin` en het bonusantwoord roepen hem aan via
    `refresh_game_state_safely` (fout → `game_errors`, de inworp of beoordeling gaat door).
  - `record_checkin` geeft `game` terug: `discovery` {bin_id, ordinal, discovered, total_bins, status},
    `milestone` (de hoogste die in deze transactie bereikt werd) en `as_of`. Nieuwe RPC's:
    `my_collection()`, `my_game_state()` v1, `my_unseen()`, `mark_seen('moments', until)`,
    `repair_game_state(user)` (admin); `game_catalog()` met `milestones`. Events `discovery_shown`,
    `milestone_shown`, `collection_viewed`. De migratie rekent de spelstand van bestaande gebruikers uit
    (oude inworpen: ontdekkingen zonder punten; niets als gemist moment).
- Functie: `submit-checkin` geeft `game` door (alleen een object, anders `null`). Na de migratie dus
  ook `stagingctl.py deploy`.
- App:
  - Onthulling: de tijdlijn speelt de stappen in de volgorde van de server. Ontdekking: banner
    "Nieuwe vuilbak ontdekt! · #58 · 12/120" valt in met `discover_fanfare` en een medium haptiek,
    dan CHIPS +5 met `chip_add` en een pop, vonkjes; een onbekende stap speelt met zijn label, zijn
    totaal en `chip_add`; na de slam bij de eerste inworp van de week de vlam ("Reeks verlengd · 4
    weken", `flame_whoosh`). Reduce Motion: banner, label en vlam alleen fade, geen vonkjes, geen
    schudden, pop ≤ 1,05. Overslaan, achtergrond en VoiceOver eindigen op dezelfde eindstand
    (banner, vlam en label inbegrepen); VoiceOver zegt ook "Nieuwe vuilbak ontdekt." en "Reeks
    verlengd".
  - Na "Klaar": een mijlpaal opent `celebrate.tsx` (fullScreenModal, confetti op het akkoord van
    `milestone_fanfare`, "+50 · wacht op goedkeuring", `<ToastViewport hold />`, analytics op pauze);
    daarna (of zonder mijlpaal meteen) `mark_seen` tot `as_of`.
  - `GameProvider` (`my_game_state` + `my_collection`, opnieuw bij terug naar de voorgrond en na elke
    inworp). Kaart: niet-ontdekte vuilbakken gedimd met "?", teller "34/120 ontdekt" met balk naar de
    volgende mijlpaal; vuilbak-sheet "Ontdekt: 12 okt. · 3 inworpen" of "Nog niet ontdekt".
    Collectie (`src/screens/CollectionScreen.tsx`, route `/(profile)/collection`, knop in Profiel):
    teller, balk, filter Alle/Ontdekt/Nog niet, raster van 4; tik → de vuilbak op de kaart
    (`BinsProvider.showOnMap`).
  - Gemiste momenten: `MissedMoments` is de eerste bron van de `MomentsPresenter` (`my_unseen` bij een
    koude en warme start; bij het tonen opnieuw gevraagd) en opent `celebrate.tsx` met de ontdekkingen
    en de hoogste mijlpaal.
  - Geluid: `discover_fanfare`, `chip_add`, `flame_whoosh`, `milestone_fanfare` uit `generate-sfx.mjs`.
    De camera mixt tijdens het uploaden de verwachte onthulling met ontdekking en vlam.
  - Dev-modus: in "Onthulling bekijken" schakelaars voor ontdekking, vlam, een onbekende stap
    ("PREMIE ×2") en een mijlpaal erna; nieuwe sectie "Vieringen bekijken" (mijlpaal kiezen, al
    toegekend, gemiste momenten). Schrijft niets en markeert niets als gezien.
- Tests: `12_discoveries` (62: catalogus, score en ledgerdelen, eerste niet-afgewezen inworp,
  testinworpen maken niets, afwijzen verschuift of laat vervallen, opnieuw ontdekt, mijlpaal
  pending/granted/revoked en opnieuw verdiend met bevroren bedrag, refresh twee keer = 0, collectie,
  spelstand, gemiste momenten, rechten, een fout in de spellogica breekt de inworp niet, invarianten);
  02, 06, 07, 08 en 09 zetten binnen hun transactie `discovery_chips` op 0; 09 vergelijkt alleen de
  vier oude sleutels; 10 kent de nieuwe events; 11 met `streak_extended` en `parts` en een ontdekking
  in `record_checkin`. Samen 476. Deno: `game` doorgegeven (handler 35); integratie: eerste inworp =
  ontdekking met `game`, `my_unseen`/`mark_seen`, tweede inworp bij dezelfde vuilbak niet, afwijzen
  schuift door en haalt weg, `my_game_state`. Jest 248: tijdlijn (volgorde, geluiden, Reduce Motion,
  onbekende stap, vlam, < 6 s), eindstand na overslaan, parsers (`game`, spelstand, collectie, gemist),
  viering, confetti; `golden.test.ts` ongewijzigd groen.
- Kleine keuzes buiten het plan:
  - de ledgersplitsing staat in de score zelf (`parts`), zodat de projectie geen formule herhaalt;
  - de collectie = de vuilbakken van de regio plus wat de gebruiker erbuiten ontdekte (de teller kan
    nooit boven 100 % gaan); mijlpalen tellen alle ontdekkingen;
  - `checkin_id` van een ontdekking verdwijnt met haar inworp (cascade; de volgende refresh maakt ze
    opnieuw); een vervallen ontdekking of mijlpaal houdt haar rij;
  - `game.milestone` is enkelvoudig (de hoogste); een moment telt vanaf `discovered_at` (de inworp) of
    `reached_at` (bereikt, ook opnieuw);
  - `my_game_state` v1 is nog `stable` (pas `volatile` met de quests in fase 6);
  - `streak_extended` is altijd `false` voor testinworpen; bij de eerste week zegt de vlam "Reeks
    gestart";
  - `discovery_shown` en `milestone_shown` hebben ook `source` (reveal/missed); `map_bin_tap.discovered`
    is `false` zolang de collectie niet geladen is;
  - nog niet gebouwd uit hoofdstuk 5: de vlaggen NIEUW en "mijlpaal hangt hiervan af" in Beheer, en de
    trigger op meldingen (die heeft pas zin met quests en badges).
- Staging (15 oktober): backup `postgres-20261015-192553.dump`; `20261015180000_discoveries.sql`
  toegepast. Telling voor en na identiek: 2 profielen, 0 echte en 64 testpunten, dezelfde hash over
  (id, punten, testpunten), check-ins 4 goedgekeurd en 3 afgewezen (allemaal test), ledger 8 toegekende
  testrijen (64), invariant leeg. Geen echte inworpen, dus 0 ontdekkingen en 0 mijlpalen na de migratie.
  `discovery_chips` 5 en de regio in `game_config`, 15 mijlpalen (10–150), 20 actieve events,
  `checkin_score(4, true, true)` = 22 met delen 15 + 7; `record_checkin` met `game` (alleen voor de
  service role), de nieuwe RPC's voor aangemelde gebruikers, RLS op de nieuwe tabellen. `deploy`,
  `check-supabase`, `check-auth` en `check-fake-location` geslaagd. EAS Update op `dev` (runtime 1):
  update-groep `dbecea12-cb73-411d-aa12-36fbec0d3a6c` (commit 7e7cf98).
- Visuele herziening van de onthulling (na de eerste iPhone-check, 15 oktober): de eindstand met
  ontdekking was rommelig (zes accentkleuren, vier soorten kaders, vijf tekstgroottes) en de zware
  preview (ontdekking, 6 weken, premie) haalde "UI-thread: blokkade ≤ 31 ms" (criterium ≤ 17 ms).
  - Twee bakken met een vaste kleur, zoals in Balatro: PUNTEN (blauw, alles wat optelt) × MULT (de
    oranje → magenta schaal, alles wat vermenigvuldigt). Al het andere is een tijdelijke pop-up boven
    de bakken die in een bak (of het totaal) vliegt en verdwijnt: de ontdekking (goud) stuurt haar +5
    naar PUNTEN en krimpt tot de contextregel; de vlam is een korte beat bij MULT vóór de reeks (niet
    meer na de slam); een onbekende stap vliegt in MULT als zijn `mult` verandert (PREMIE ×2: ×1,77 →
    ×3,54), in PUNTEN als zijn `chips` veranderen, anders in het totaal; "+5 BONUSVRAAG" valt in het
    totaal, dat daarna "TOTAAL · MET BONUSVRAAG" heet.
  - Eindstand: kopje, PUNTEN × MULT, het totaal met "TOTAAL", één neutrale contextregel met kleine
    iconen ("#58 ONTDEKT · 12/120 · REEKS 6 WEKEN") en de knoppen, op één as met vaste afstanden.
    Geel alleen voor nieuw (ontdekking, mijlpaal), groen alleen voor Klaar; de achtergrond is neutraal
    donker. Drie groottes (`playType` in `theme/game.ts`: totaal, waarde, label), alle labels in één
    kapitaalstijl, één badgevorm (`shapes.badgeHeight`/`badgeRadius`).
  - Performance: alles wat de onthulling toont (pop-ups, iconen, contextregel, vonkjes) wordt met het
    scherm gemount en is onzichtbaar tot zijn event; tijdens het afspelen ontstaat geen native view meer
    (vroeger mountten de vlamrij met `SymbolView` en het label van de onbekende stap tijdens de slam).
    De deeltjes zijn gememoiseerd. Nog te meten op de iPhone met "Zware preview" in Dev-modus.
  - Events: `discovery`, `chipPop`, `step` en `flame` zijn vervangen door `popupIn`, `popupOut`, `bins`
    en `binPop`; `bonusChip` heeft `fly` en staat er nu ook met Reduce Motion (de pop-up vervaagt dan).
    Basis + reeks zonder ontdekking of vlam is byte-gelijk gebleven (`golden.test.ts` ongewijzigd groen).
    Onbekende stappen bewaren in de parser ook `chips` en `mult`; de server moet die meesturen (fase 8).
  - Dev-modus: knop "Zware preview (ontdekking, 6 weken, premie, bonusvraag)"; de premie verdubbelt nu
    de multiplier zoals in fase 8.
  - EAS Update op `dev` (runtime 1): update-groep `2328472f-9e93-496a-a38c-0ddb67f39165` (commit 3c6e524);
    alleen de app veranderde (geen migratie, geen `deploy`).
- iPhone (19 oktober): alles in orde, ook de herziene onthulling en de zware preview. Gecontroleerd
  waren de punten hieronder.
- Op de iPhone gecontroleerd (na `update:dev`): Dev-preview met ontdekking, vlam, onbekende stap
  en mijlpaal, met en zonder Reduce Motion en geluid; "Vieringen bekijken"; een echte eerste inworp
  bij een nieuwe vuilbak (banner, +5 chips, pin wordt groen, teller +1); een tweede inworp daar (geen
  banner); na afwijzen in Beheer klopt de collectie; de app sluiten tijdens een onthulling met
  ontdekking en opnieuw openen (gemist moment); de 10e ontdekking toont "+50 · wacht op goedkeuring".
- Gemerged in `main` als PR #5 (19 oktober).

**Fase 4 (identiteit: onboarding, avatars, levels, profiel)**
- Server (`20261019120000_identity.sql`):
  - Catalogus `levels` (20, `10 × (L−1)^2,6` afgerond op 5, met titels) en `avatars` (12, met
    `placeholder_symbol`/`placeholder_color`; een controle per soort ontgrendeling op `unlock_param`),
    niet rechtstreeks leesbaar. `private.level_of(punten)` geeft level en volgend level; het level volgt
    altijd de toegekende echte punten.
  - Ontgrendelen wordt berekend (`private.avatar_states`): standaard altijd; level over de toegekende
    punten (`pending` als de punten die nog wachten het level halen); mijlpaal uit `user_milestones`
    (pending/granted); badge, quest en kist blijven vergrendeld tot fase 5 en 6. Hints uit
    `private.avatar_hint` ("Bereik level 5", "Ontdek 50 vuilbakken", …).
  - Profielen: `avatar_key` (→ `avatars`, null = standaardavatar spruit), `onboarded_at`,
    `last_seen_level` (bestaande profielen op hun huidige level). `handle_new_user` vult geen naam meer in.
    Clients schrijven `profiles` niet meer rechtstreeks: `complete_onboarding(name, avatar_key)`,
    `set_my_name(name)` en `set_my_avatar(key)`, met één naamregel (`private.clean_name`: spaties
    samengevoegd, 2–24 tekens, geen stuurtekens) en de gebruikerslock voor de controle.
  - De refresh (en `adjust_points`) zet een gedragen avatar die niet meer ontgrendeld is terug op de
    standaardavatar (`private.refresh_avatar`, telt mee in de gewijzigde rijen).
  - `my_avatars()`; `game_catalog()` met `levels` en `avatars`; `my_game_state()` met `level` en `stats`
    (inworpen, bonusvragen, langste reeks); `leaderboard()` met `avatar_key`, `level`, `title` (opnieuw
    aangemaakt, rechten terug). Events `avatar_changed`, `onboarding_step`, `onboarding_completed`.
    `levels` en `avatars` in `check-restore.sh`.
- Functie: niet veranderd (geen `deploy` nodig).
- App:
  - Guard in de root-layout (`src/game/onboarding.ts`): sessie of profiel onbekend → splash (de native
    splash blijft staan, hoogstens 8 s); `onboarded_at` leeg → onboarding; profiel niet geladen (fout of
    na 5 s) → de app. Komt het profiel later toch binnen zonder onboarding, dan wisselt de app pas op een
    tab-scherm zonder modal. De `MomentsPresenter` staat uit tijdens de onboarding en tot het profiel
    bekend is.
  - Onboarding (`src/screens/OnboardingFlow.tsx`, route `onboarding`, preview `onboarding-preview` in
    Dev-modus) met de teksten van het prototype: naam ("Hoe mogen we je noemen?", met Zwerfie), dan
    "Kies je reisgenoot." met de ontgrendelde avatars, "Vos gaat met je mee.", "Op ontdekking →",
    "← Naam aanpassen". Bestaande accounts zien ze één keer, met hun naam ingevuld.
  - `Avatar` (PNG uit `src/game/avatarImages.ts` op een cirkel in de avatarkleur, anders het SF Symbol;
    silhouet via `tintColor`; onbekende sleutel → neutrale placeholder; thumbnail tot 64 pt) en
    `AvatarGrid`. `app/scripts/avatars.mjs` (`npm run avatars`): controleert de PNG's (512 × 512,
    transparante hoeken, ≤ 200 KB, `<key>.png`), maakt thumbnails van 192 × 192 en de require-map met
    een hash per tekening. `docs/AVATARS.md` voor wie tekent.
  - Avatar-kiezer (`avatar-picker`, formSheet): raster, vergrendeld = silhouet met slot, tik = bovenaan
    met "Hoe ontgrendel je dit?" en de hint, "Kies Vos".
  - Profiel en Ranglijst in React Native (`src/screens/ProfileScreen.tsx`, `LeaderboardScreen.tsx`):
    avatar in de levelring (tik = kiezer), naam, "Level 3 · Peukenpikker", "Nog 115 punten tot level 4",
    rollende punten met "+N wacht op goedkeuring", statistieken, Collectie en Ranglijst, historiek.
    Ranglijst: medaille top 3, avatar, naam met "Lv 7 · Stoepridder", punten; de eigen rij vast onderaan
    als ze buiten beeld valt. Instellingen (`(profile)/settings`, SwiftUI-formulier via het tandwiel):
    naam wijzigen, e-mail, testpunten (Dev), versie en updates, afmelden.
- Tests: `13_identity` (65: catalogus en curve, nieuw account zonder naam, geen rechtstreekse
  schrijfrechten, onboarding valideert naam en avatar, `set_my_name`/`set_my_avatar`, level-unlock
  pending → granted, herroepen verlaagt het level en zet de avatar terug, testpunten ontgrendelen niets,
  mijlpaal-unlock, inactieve avatar, ranglijst, rechten, invarianten). Fixtures van 01, 04, 06, 07 en 08
  krijgen een naam; 00 kent `profiles.display_name:UPDATE` niet meer; 01 test `set_my_name` i.p.v. een
  directe update; 10 kent de nieuwe events; 12 vergelijkt `my_game_state` zonder `level` en `stats`.
  Samen 541. Deno: `otp-login` verwacht geen naam, events met de drie nieuwe voorbeelden. Jest 281:
  avatar-map = de PNG's in de map, `resolveAvatar`, `levelProgress`, guard en naamregel, parsers.
  `avatars.test.mjs` (7) in `test:scripts`. Echte run: een test-PNG in de map, script, staging-export
  met tekening en thumbnail in de bundel, daarna weer weggehaald.
- Kleine keuzes buiten het plan:
  - Zwerfie is de mascotte en geen van de twaalf: een gids die iedereen kan dragen, vult de ranglijst
    met hetzelfde gezicht. De twaalf zijn de reisgenoten van het prototype: eerst de zes van de
    cofounder (spruit, vos, zon, berg standaard; bloem en bliksem via level), aangevuld met eik, haas,
    schildpad, merel, maan en regenboog;
  - de tabel met drempels in hoofdstuk 3 had 9.545 en 21.115 voor level 15 en 20; de formule geeft 9.550
    en 21.125 (tabel verbeterd);
  - titels voor de levels die het plan open liet: 9 Scheldespeurder, 11 Blikvanger, 12
    Kringloopkampioen, 14 Stadsveger, 15 Stoepsheriff, 17 Opruimorakel, 18 Buurtbaron;
  - de mijlpaal-avatar staat in `avatars.unlock_param`, niet ook in `milestones.avatar_key`; `user_avatars`
    komt pas met de kist (fase 6);
  - een level-avatar is `pending` zolang de punten die nog wachten het level halen (dragen kan pas na
    goedkeuring); de ranglijst toont het level van de echte punten, ook met testdata aan;
  - `set_my_name` is nieuw (de naam wijzigen kon vroeger rechtstreeks); `adjust_points` kijkt ook de
    avatar na;
  - `my_game_state` heeft `stats` voor het profiel; "Reeks nu" staat er nog bij tot Vandaag (fase 6);
  - de onboarding is één route met twee stappen (geen map `onboarding/`); de preview logt
    `onboarding_step` als `is_test` en bewaart niets;
  - de onboarding toont het silhouet van de eerste avatar tot je kiest;
  - de naam in de onboarding staat al ingevuld bij bestaande accounts (vaak het deel van het e-mailadres);
  - de getypte routes van Expo Router worden lokaal gemaakt met `startTypescriptTypeGenerationAsync` (geen
    dev-server nodig).
- Staging (19 oktober): backup `postgres-20261019-174648.dump`; `20261019120000_identity.sql` toegepast
  (staat in `supabase_migrations.schema_migrations`). Telling voor en na identiek: 2 profielen, 0 echte
  en 128 testpunten, dezelfde hash over (id, punten, testpunten), check-ins 8 goedgekeurd en 4 afgewezen
  (allemaal test), ledger 16 toegekende testrijen (128), invariant leeg; een refresh van beide profielen
  verandert niets. 20 levels (5 = 370, 15 = 9.550, 20 = 21.125), 12 actieve avatars, `game_catalog` met
  `levels` en `avatars`, de nieuwe RPC's alleen voor aangemelde gebruikers, geen rechtstreekse
  naamwijziging meer, RLS op `levels` en `avatars`, 23 actieve events. Beide profielen houden hun naam,
  hebben nog geen avatar en geen onboarding (die zien ze één keer na de update) en staan op level 1. De
  functie veranderde niet (geen `deploy`). `check-supabase`, `check-auth` en `check-fake-location`
  geslaagd. EAS Update op `dev` (runtime 1): update-groep `e245d229-9285-4799-a507-54fa018040f2` (commit 8848ff0).
- iPhone (19 oktober): alles in orde. Gecontroleerd (na `update:dev`): de onboarding één keer bij het openen, met je naam
  ingevuld (naam → avatar → kaart; daarna niet meer); "Onboarding tonen" in Dev-modus (Zwerfie, teksten,
  foutmelding bij één teken, "← Naam aanpassen", "Vos gaat met je mee."); offline starten (de app opent
  na hoogstens 5 s); het profiel (avatar in de levelring: scherp en de juiste dikte, level en titel,
  "Nog N punten", rollende punten, statistieken, historiek, tandwiel → Instellingen met naam wijzigen en
  afmelden); de avatar-kiezer (sheet leesbaar op het glas, silhouetten met slot, "Hoe ontgrendel je
  dit?", een andere standaardavatar kiezen → profiel en ranglijst); de ranglijst (avatar, "Lv 1 ·
  Wegwerp-rookie", medailles, "Testdata tonen"); Reduce Motion en donkere modus. De vaste eigen rij
  onderaan is pas te zien met meer spelers dan op één scherm passen.
- Gemerged in `main` als PR #6 (19 oktober).

**Fase 5 (progressie: badges en goedkeuringsviering)**, op `gamification/5-progressie`
- Deel 1, server (`20261019180000_progression.sql`), af en lokaal getest:
  - Catalogus `badges` (11: de badges van hoofdstuk 3 zonder Questheld en Premiejager, die komen met
    hun regeltype in fase 6 en 8) met een `rule` van een vast type, gecontroleerd door
    `private.badge_rule_ok`: `count` over `checkins` (met `hour_from`/`hour_before` in de tijd van
    Gent, over middernacht als from > before), `discoveries`, `bonus_answers` of `reports`;
    `streak_weeks` (de langste reeks); `region_complete`. Vroege vogel = 5–8 u, Nachtuil = 22–5 u
    (geheim).
  - Spelfeit `user_badges` (pending/granted/revoked, `earned_at` = het moment, `granted_at` alleen bij
    granted, anker), RLS eigen rijen/admins. De refresh rekent elke actieve badge uit over de twee
    zekerheden (`private.badge_progress`), na de mijlpalen en vóór de avatar. Meldingen van
    ontbrekende vuilbakken starten nu de refresh (trigger bij insert en beoordeling).
  - Badge-avatar: `avatar_states` volgt de badge (granted = unlocked, pending = pending), de refresh
    neemt de merel af als de badge vervalt; `avatar_hint` haalt de naam uit `badges`.
  - `record_checkin` geeft `game.badges` (bereikt in deze inworp); momenten hebben nu ook `badge`
    (volgorde: tijd, dan ontdekking, mijlpaal, badge); `game_catalog()` met `badges` (geheime
    gemaskeerd); `my_badges()` met status locked/pending/granted, `earned_at` en `progress`/`target`.
  - Beslissingen: `profiles.results_seen_at`; `my_unseen()` geeft `results` (goedgekeurd en
    afgewezen met reden en `revoked`, aantallen, `gained` en `by_source`, `points_before`/`after`,
    `level_before` = `last_seen_level`/`level_after`/`level_title`, toegekende badges, ontgrendelde
    avatars); `mark_seen('results', until)` zet `results_seen_at` en `last_seen_level` = het level van
    de punten op dat tijdstip (`private.points_at`). Geen race: `my_unseen` neemt de gebruikerslock
    en leest `as_of` daarna; `review_checkin`, `revoke_checkin` en de refresh stempelen met
    `clock_timestamp()` na diezelfde lock.
  - Events `approval_shown`, `level_up_shown`, `badge_shown` (ook in `events.ts` en `ANALYTICS.md`);
    `badges` en `user_badges` in `check-restore.sh`. De functie veranderde niet (geen `deploy`).
  - Tests: `14_badges` (47), `15_unseen` (24); 10 kent de nieuwe events; 12 en 13 zetten de badges
    uit (anders hangt het antwoord van het uur af) en 12 verwacht `badges: []` in `game` en kent
    `mark_seen('results')`. Samen 612. Integratie: goedkeuren → `my_unseen` met de beslissing,
    +22 per bron, level 1 → 2 en Eerste inworp → `mark_seen('results')` → niets meer; herroepen →
    rustig met reden.
- Deel 2, app, af en getest (geen nieuwe route, geen native wijziging):
  - `src/game/badges.ts` (parsers voor `my_badges` en badgenieuws, statusregel "Nog 13 te gaan ·
    12/25") en `src/game/approval.ts` (`parseResults`, `hasResults`, koptekst "Goedgekeurd! +16",
    chips per bron "+33 inworpen", regels voor level en afwijzing, de blokken van het scherm, hun
    tijdlijn en verzonnen resultaten voor de Dev-preview). `parseUnseen` leest badge-momenten en
    `results`, `parseCheckinGame` de badges.
  - Goedkeuringsviering: `MissedMoments` zet uit één `my_unseen` een `approval`- en/of
    `missed`-moment in de wachtrij (`unseenMomentKinds`; de presenter toont `approval` eerst), bij
    koude en warme start; vlak voor het tonen vraagt het opnieuw en kijkt het of er nog steeds geen
    camera, onthulling of sheet open is (anders niets, het komt terug bij de volgende start).
    `celebrate.tsx` heeft nu drie soorten: `reveal` (mijlpaal en/of badges na de onthulling),
    `missed` (met badges) en `approval` (`ApprovalBody`: kop, totaal rolt van oud naar nieuw, chips
    per bron in PUNTEN-blauw, level-up in goud met `levelup_fanfare` en confetti, bevestigde badges,
    ontgrendelde avatars, afwijzingen rustig onderaan met reden; alles gemount bij het openen, één
    gedeelde waarde laat de blokken na elkaar invallen). Een level-up zonder beslissing is dezelfde
    viering met het level als kop. Sluiten = `mark_seen('results', as_of)`.
  - Profiel: "Badges · 4 van 11" met een raster van 3 (`BadgeGrid`, `BadgeIcon`: symbool op een
    cirkel in de zeldzaamheidskleur, vergrendeld = silhouet, wacht = klokje); tik = uitleg erboven
    (naam, hoe je hem verdient, datum, "wacht op goedkeuring" of voortgang).
  - Geluiden `approve_chime` (ook voor een badge zonder mijlpaal) en `levelup_fanfare` uit
    `generate-sfx.mjs`. Events `approval_shown`, `level_up_shown`, `badge_shown` (bron
    reveal/missed/approval).
  - Dev-modus, "Vieringen bekijken": "Daarna een badge" bij de onthulling, "Badge tonen", gemiste
    momenten met een badge, "Goedkeuring tonen" (aantallen goedgekeurd 0–5 en afgewezen 0–3, met
    level-up, met badge en avatar) en "Alleen een level-up tonen". Schrijft niets.
  - Tests: Jest 310 (`approval.test.ts`: parser, kop, chips, samenvatting, blokken, tijdlijn met
    Reduce Motion, alleen afwijzingen, alleen level-up, preview; `badges.test.ts`; presenter-volgorde
    in `moments.test.ts`; badges in `discoveries`, `checkin` en `celebration`); `test:scripts` 28
    (de twee geluiden in de lijst en hun lengte).
- Kleine keuzes buiten het plan:
  - geen Questheld en Premiejager: hun regeltypes komen met fase 6 en 8;
  - badges geven geen punten (geen ledgerrij); de "+16" is alles wat sinds het vorige bezoek
    toegekend werd, ook een mijlpaal;
  - Nachtuil is de geheime badge; Vroege vogel telt van 5 tot 8 u (niet vanaf middernacht);
  - de goedkeuringsviering toont alleen echte inworpen; testinworpen zijn nooit een beslissing;
  - een badge die tegelijk als gemist moment en als bevestigd in de goedkeuring staat, kan twee
    keer verschijnen (eerst bevestigd, dan bij de gemiste momenten);
  - het totaal gebruikt `playType.total` (vijf cijfers op 75 %).
- Nog te doen: verslag en akkoord, dan de staging-uitrol (migratie `20261019180000_progression.sql`,
  geen `deploy` nodig, `update:dev`).
