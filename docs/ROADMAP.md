# Roadmap: meerdere steden

**Status:** plan, nog niet bouwen.
**Moment:** na de straattest en de staging-omgeving, vóór de beta.

De MVP kent één testregio: een bbox van 600 m rond de Oude Houtlei, met
vuilbakken uit één bron (OpenStreetMap). Voor meerdere steden moet de data-aanvoer
een apart, uitbreidbaar deel worden, met echte stadsgrenzen en meerdere bronnen per
stad.

## 1. `/pipeline` als apart deel

De OSM- en importscripts verhuizen van `scripts/` naar `/pipeline`:

```
pipeline/
  sources/            één adapter per bron
    osm/              amenity=waste_basket uit de Geofabrik-PBF (nu scripts/osm)
    ivago/            vuilbakken van IVAGO (Gent)
    opendata/         generieke adapter voor open stadsdata (GeoJSON, CSV, WFS)
  regions/            één config per stad
    gent.json
  load/               upsert in de database (nu scripts/import-bins)
  common/             .env, local-only guard, logging (nu scripts/devenv.py)
  tests/
```

- Elke adapter levert hetzelfde tussenformaat: een GeoJSON FeatureCollection met per
  feature `source`, `source_id`, de attributen van de bron, `fetched_at` en de licentie.
  `load/` kent alleen dat formaat, geen bronspecifieke details.
- `scripts/` blijft voor ontwikkeltools zoals `seed-admin`.
- Een adapter mag pas gebouwd worden als de beschikbaarheid en de licentie van de bron
  bevestigd zijn (zie open vragen).

## 2. Regio's met echte gemeentegrenzen

Een config per stad in `pipeline/regions/`, bijvoorbeeld `gent.json`:

- `id` (slug, bv. `gent`), naam, en de OSM-relatie van de gemeentegrens
  (`boundary=administrative`, `admin_level=8` voor Belgische gemeenten);
- welke bronnen actief zijn, met hun instellingen en bronprioriteit;
- de attributieteksten per bron.

De grens komt als polygoon uit de OSM-data (via pyosmium area assembly uit dezelfde
PBF), niet meer als bbox met buffer. De pipeline schrijft de regio's in een tabel
`regions` in de database. Een vuilbak hoort bij een regio als de grens hem bevat.

## 3. Databaseschema

- Nieuwe tabel `regions` (`id`, `name`, `boundary geography(MultiPolygon)`, `active`).
- **`bins.region_id`**: foreign key naar `regions`, eerst nullable, na de backfill voor
  Gent `not null`. De import bepaalt de regio met `ST_Covers(boundary, geom)`.
- De sleutel `(osm_type, osm_id)` wordt algemeen: `(source, source_id)`, met
  `source` in `osm`, `ivago`, `opendata:<dataset>` en `user`. Bestaande OSM-rijen krijgen
  `source_id = '<osm_type>/<osm_id>'`.
- "Verdwenen uit de bron" geldt per (regio, bron): een import zet alleen vuilbakken van
  dezelfde bron en regio op `removed`.
- `nearby_bins` houdt dezelfde API, met een optionele regiofilter.
- Meldingen van ontbrekende vuilbakken worden server-side geweigerd buiten een actieve
  regio (lost het punt in `docs/PRE-BETA.md` op).

## 4. Dubbels tussen bronnen

Heeft een stad meerdere bronnen, dan staat dezelfde fysieke vuilbak vaak in elk van
die bronnen. In de app moet het één vuilbak zijn.

- `bins` wordt de tabel van **fysieke** vuilbakken. Een nieuwe tabel
  `bin_source_records` (`source`, `source_id`, `geom`, `attributes`, `fetched_at`,
  `bin_id`) bewaart wat elke bron zegt. Check-ins blijven naar `bins.id` verwijzen, dus
  ze blijven geldig als een bron verandert.
- **Matchen:** een bronrecord wordt aan een bestaande vuilbak gekoppeld als er precies
  één kandidaat ligt binnen een drempel (startwaarde 5–8 m, per bron af te stellen naar
  de nauwkeurigheid van die bron) en de attributen niet botsen.
- **Twijfelgevallen** (twee kandidaten, of een afstand tussen de drempel en ~15 m) worden
  niet automatisch samengevoegd maar komen in een reviewlijst voor admins.
- **Bronprioriteit** per regio bepaalt welke bron de positie en status levert (bv. de
  stadsdienst boven OSM); de attributen worden samengevoegd.
- Een fysieke vuilbak gaat pas op `removed` als al zijn bronrecords verdwenen zijn, of als
  de bron met de hoogste prioriteit hem als verwijderd meldt.
- Door gebruikers gemelde vuilbakken worden met dezelfde matching tegen de bronnen
  gecontroleerd.
- Elke import rapporteert: gekoppeld, nieuw, twijfelgeval, verwijderd.

## 5. Harde grens tussen `/pipeline` en `/app`

- `/pipeline` importeert niets uit `/app`, en `/app` niets uit `/pipeline`. Ze praten
  **alleen via het databaseschema**: de migraties in `supabase/`, tabellen en RPC's.
- Gevolg: `config/region.json` wordt nu door zowel de scripts als de app gebruikt (via
  `watchFolders` in Metro). Dat verdwijnt: de app haalt regio's, grenzen en attributie
  uit de database.
- Aparte afhankelijkheden: Python-requirements voor de pipeline, npm voor de app.
- De pipeline schrijft met een eigen databaserol (bv. `pipeline_writer`) met alleen de
  nodige rechten, niet als `postgres`. De app blijft via RLS lezen.
- Afdwingen in CI: een controle die faalt als code in `pipeline/` naar `app/` verwijst of
  omgekeerd.

## 6. Licenties en attributie

- Per bron de licentie vastleggen (ODbL voor OSM; de licenties van IVAGO en de open
  stadsdata nog te bepalen) en in de app per regio en bron de juiste attributie tonen.
- Het combineren van OSM-data met andere bronnen maakt een afgeleide database: check de
  share-alike-verplichtingen van de ODbL vóór de beta (zie ook `docs/PRE-BETA.md`).

## 7. Volgorde

1. Migratie: `regions`, `bins.region_id`, `(source, source_id)`; backfill voor Gent.
2. Scripts verhuizen naar `/pipeline` zonder gedragswijziging; alle tests groen.
3. Regioconfig en gemeentegrens uit OSM; de bbox-buffer verdwijnt.
4. App: regio's en attributie uit de database; `config/region.json` uit de app.
5. Grenscontrole tussen `/pipeline` en `/app` in CI.
6. Adapters voor IVAGO en open stadsdata (na bevestiging van data en licentie).
7. Dubbels filteren, met reviewlijst voor twijfelgevallen.

## Open vragen

- Biedt IVAGO een dataset of API met de openbare vuilbakken? Onder welke licentie, en hoe
  vaak wordt die bijgewerkt?
- Welke open stadsdata bestaat er per stad over openbare vuilbakken?
- Welke steden komen na Gent?
- Blijft de kleine testregio rond de Oude Houtlei bestaan voor straattests, of wordt het
  meteen heel Gent?
- Welke dubbel-drempel past bij elke bron (nauwkeurigheid van hun coördinaten)?
