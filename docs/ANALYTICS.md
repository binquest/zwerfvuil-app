# Gebruiksdata (eventlog)

Wat de app meet over het gebruik, hoe het naar de server gaat en hoe je een event toevoegt.
Ontwerp: `docs/GAMIFICATION.md` (2.5 en hoofdstuk 6). Gebouwd in fase 1b; analyseviews, export en
bewaartermijn volgen in fase 10.

## Principes

- **Nooit een locatie.** Geen coördinaten, adressen of gps-gegevens in een event. De server weigert
  sleutels die naar een locatie ruiken (`lat`, `lon`, `lng`, `latitude`, `longitude`, `geo`, `geom`,
  `coords`, `location`, `position`, `gps`, `address`, `altitude`, ook als deel van een sleutel zoals
  `user_lat`). `bin_id` mag: vuilbakken zijn publiek. Afstanden alleen in klassen
  (`distance_bucket`).
- **Alleen de gebruiker zelf.** Elk event hoort bij de aangemelde gebruiker van dat moment; zonder
  aanmelding wordt niets gemeten.
- **Gebruikers lezen niets**, admins alles (RLS). De events verdwijnen met het account (`on delete
  cascade`).
- **Testdata apart.** Events uit Dev-modus-previews hebben `is_test`; de server zet die vlag alleen
  voor admins op een lokale of staging-database (`dev_mode_allowed()`), anders wordt het een gewoon
  event.
- **Nooit blokkerend, nooit een crash.** `track()` schrijft alleen naar een geheugenbuffer; elke fout
  wordt ingeslikt (in development gelogd met `devLog`).

## Hoe het werkt

**App** (`app/src/analytics/`):

| Bestand | Wat |
|---|---|
| `events.ts` | de namen en props per event (getypt) |
| `index.ts` | `track(name, props, { isTest })`, `holdAnalytics()` |
| `AnalyticsTracker.tsx` | in de root-layout: koude start, aan- en afmelden, app-status, `screen_view`, timers |
| `session.ts` | sessies: nieuw bij een koude start, een aanmelding of na meer dan 30 min in de achtergrond |
| `queue.ts` | buffer → wachtrij → server: batches, per gebruiker, opnieuw proberen, plafond |
| `store.ts` | de wachtrij in een eigen SQLite-bestand (`analytics.db`, async API) |
| `wire.ts` | het formaat naar `log_events` (ook gebruikt door de Deno-integratietest) |
| `props.ts` | `distanceBucket`, `roundTo100`, `screenName` |

- Events gaan eerst naar een geheugenbuffer, elke 5 s in één transactie naar de wachtrij in SQLite,
  en elke 30 s, bij naar de achtergrond gaan en bij de volgende start naar de server.
- Een batch is max. 100 events van één gebruiker met dezelfde appversie en update. Alleen events van
  de huidige gebruiker worden verstuurd (wisselen van account op staging); de rest blijft wachten.
- Een 2xx-antwoord wist de batch. Alleen bij een netwerkfout, een 5xx of een 401 volgt een nieuwe
  poging, na 30 s, 1 min, 2 min … tot max. 30 min. Elk ander antwoord (bv. 400) kan nooit lukken: die
  batch wordt gewist.
- In de wachtrij: max. 5.000 events en max. 30 dagen oud (de oudste gaan eerst).
- Tijdens de onthulling (en later de vieringen) wordt niets weggeschreven of verstuurd
  (`holdAnalytics()`), zodat beeld en geluid niet haperen.
- De sessie overleeft een herstart (in `localStorage`), zodat de volgende start `session_end` van de
  vorige sessie kan sturen.

**Server** (`supabase/migrations/20261015140000_config_and_events.sql`):

- `public.event_names`: de whitelist (`name`, `description`, `active`).
- `public.app_events`: `id` (uuid van de app, voor idempotentie), `user_id`, `session_id`, `name`,
  `props`, `client_ts`, `server_ts`, `app_version`, `update_id`, `platform`, `is_test`. Indexen op
  (`user_id`, `server_ts`) en (`name`, `server_ts`).
- `log_events(events jsonb, client jsonb)` controleert de hele batch in één set-gebaseerde query en
  antwoordt `{accepted, dropped, rate_limited}`. Een afgekeurde rij laat de batch niet falen:
  - max. 100 events per batch (meer: fout 22023);
  - event: `{id, session_id, name, props, client_ts, is_test}`; `client`: `{app_version,
    update_id, platform}`;
  - naam in `event_names` en actief;
  - `props` een plat object (geen geneste objecten of lijsten), sleutels in snake_case (max. 40
    tekens), max. 20 sleutels en 2 KB, geen locatiesleutels;
  - `client_ts` ISO 8601, max. 30 dagen oud en max. 1 dag in de toekomst;
  - max. 600 events per gebruiker per uur (wat erover gaat telt als `rate_limited`);
  - hetzelfde `id` opnieuw wordt niet dubbel opgeslagen en telt als `accepted`.

## Gemeenschappelijke kolommen

Elk event heeft `user_id`, `session_id`, `client_ts` (klok van de telefoon), `server_ts`,
`app_version` (`expo.version`), `update_id` (de EAS Update, leeg zonder updates), `platform` en
`is_test`.

## Events

Deze tabel, `EVENT_NAMES` in `app/src/analytics/events.ts` en de actieve rijen van
`public.event_names` zijn altijd gelijk: een Jest-test vergelijkt de tabel met de app, de
Deno-integratietest de app met de database.

| Event | Wanneer | Props |
|---|---|---|
| `app_open` | start of terug uit de achtergrond | `kind` cold/warm |
| `session_start` | nieuwe sessie: koude start, aanmelding, of terug na > 30 min | — |
| `session_end` | zodra vaststaat dat de vorige sessie voorbij is (volgende start, afmelding, terug na > 30 min) | `duration_s` |
| `app_background` | naar de achtergrond | `foreground_s` |
| `screen_view` | ander scherm (`useSegments`) | `screen` (route zonder groepen of parameters, bv. `map`, `leaderboard`, `bin/[id]`) |
| `map_bin_tap` | tik op een pin | `bin_id` |
| `checkin_flow_start` | "Inworp registreren" | `bin_id`, `distance_bucket` (`0_10`, `10_25`, `25_50`, `50_plus`, `unknown`) |
| `camera_opened` | camera open | `mode` checkin/report |
| `photo_taken` | foto genomen | `mode`, `retake` |
| `checkin_submitted` | inworp verstuurd | `bin_id`, `upload_kb` |
| `checkin_result` | antwoord op de inworp | `ok`, `reason` (bv. `too_far`, `cooldown`, `network`), `duration_ms` |
| `reveal_shown` | onthulling start | `total`, `discovery`, `streak_weeks`, `preview` |
| `reveal_skipped` | onthulling overgeslagen | `step` (`base`, `streak_3`, …) |
| `bonus_question_answered` | bonusvraag beantwoord of overgeslagen | `question_key`, `answered`, `response_ms` (op 100 ms) |
| `leaderboard_viewed` | ranglijst geopend of andere periode | `period` week/all |
| `report_flow_start` | melding van een ontbrekende vuilbak gestart ("Foto nemen") | — |
| `report_submitted` | melding verstuurd | `ok` |

Opmerkingen:
- `discovery` in `reveal_shown` is tot fase 3 altijd `false`.
- Previews in Dev-modus (onthulling, bonusvraag) gaan als `is_test` mee.
- `checkin_submitted` en `checkin_result` komen uit `submitCheckin` (`app/src/lib/api.ts`), waar
  grootte en duur bekend zijn. Lukt het lezen van de foto niet, dan is er geen `checkin_submitted`.

## Gepland

Uit de taxonomie in `docs/GAMIFICATION.md` (hoofdstuk 6); elk event komt pas in de whitelist in de
fase die de functie bouwt.

| Event | Fase | Props |
|---|---|---|
| `discovered` in `map_bin_tap` | 3 | — |
| `discovery_shown`, `milestone_shown`, `level_up_shown`, `badge_shown` | 3–5 | `ordinal` / `threshold` / `level` / `badge_key`, `status` |
| `collection_viewed` | 3 | `discovered`, `total` |
| `avatar_changed`, `onboarding_step`, `onboarding_completed` | 4 | `avatar_key`, `from` / `step` / — |
| `approval_shown` | 5 | `approved`, `rejected`, `points` |
| `quest_viewed`, `quest_completed`, `chest_opened`, `tip_shown` | 6 | zie GAMIFICATION.md |
| `notification_permission`, `notification_scheduled`, `notification_opened` | 7 | zie GAMIFICATION.md |
| `heatmap_toggled`, `recap_shown`, `recap_shared`, `bounty` in `map_bin_tap` en `reveal_shown` | 8–9 | zie GAMIFICATION.md |

## Een event toevoegen

1. `app/src/analytics/events.ts`: de props in `EventProps` en de naam in `NAMES`.
2. Een nieuwe migratie: één rij in `public.event_names` (een event afschaffen: `active = false`, de
   rij blijft voor de historiek).
3. Deze tabel in "Events".
4. `track(...)` op de juiste plek; voor een preview in Dev-modus met `{ isTest: true }`.
5. Tests: `npm --prefix app test` (namen = deze tabel), `npm run db:test` (`10_app_events` kent de
   whitelist) en `npm run test:functions:integration` (app = database).
6. Uitrollen zoals elke fase: eerst de migratie, meteen daarna `update:dev`. Een event van een oudere
   app dat de server niet kent, wordt stil gedropt.

## Bekijken

In Studio of met `psql` als admin (gebruikers lezen niets). Telling per naam, zonder testevents:

```sql
select name, count(*) as events, count(distinct user_id) as users, max(server_ts) as last
from public.app_events
where not is_test and server_ts > now() - interval '1 day'
group by name
order by name;
```

Sessies per gebruiker en dag:

```sql
select user_id, (server_ts at time zone 'Europe/Brussels')::date as day, count(*) as sessions
from public.app_events
where name = 'session_start' and not is_test
group by 1, 2
order by 2 desc, 1;
```

## Nog niet

- Bewaartermijn (13 maanden ruw, daarna dagtellingen), analyseviews en export: fase 10.
- Staf en testaccounts uitsluiten (`analytics.excluded_users`): fase 10.
- Privacyverklaring en toestemming voor gebruiksanalyse: `docs/PRE-BETA.md`, vóór de spelerstest.
