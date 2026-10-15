-- Only runs on a local Supabase stack (supabase db reset), never on staging.
-- Data is loaded with scripts instead of seed SQL:
--   bins:  scripts/import-bins (from data/bins.geojson)
--   admin: see README

-- This database is a developer's local stack (see the environment_guard migration).
insert into private.app_environment (name) values ('local')
on conflict (singleton) do update set name = excluded.name, updated_at = now();
