-- private.app_environment and the fake-location guard in record_checkin.
-- Run with: npm run db:test

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(10);

insert into auth.users (id, email, aud, role) values
  ('55555555-5555-5555-5555-555555555555', 'env@example.test', 'authenticated', 'authenticated');
insert into bins (osm_type, osm_id, geom, status, eligible, eligible_override) values
  ('node', 900000000000501, 'SRID=4326;POINT(0 0)', 'active', true, null);

-- A check-in exactly at the test bin, real or fake.
create function pg_temp.checkin(fake boolean)
returns table (ok boolean, reason text, checkin_id uuid, distance_m double precision, retry_after_s integer)
language sql as $$
  select * from public.record_checkin(gen_random_uuid(), '55555555-5555-5555-5555-555555555555',
    (select id from public.bins where osm_id = 900000000000501), 0, 0, 5, false, fake,
    '55555555-5555-5555-5555-555555555555/x.jpg');
$$;

-- ---------------------------------------------------------------------------
-- The marker
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ insert into private.app_environment (name) values ('elsewhere') $$,
  '23514', null, 'only local, staging and production are valid'
);
select throws_ok(
  $$ insert into private.app_environment (singleton, name) values (false, 'local') $$,
  '23514', null, 'there is only one row'
);

set local role authenticated;
select throws_ok($$ select public.app_environment() $$, '42501', null, 'users cannot call app_environment()');
select throws_ok($$ select * from private.app_environment $$, '42501', null, 'users cannot read the marker');
reset role;

-- ---------------------------------------------------------------------------
-- record_checkin with each environment
-- ---------------------------------------------------------------------------

delete from private.app_environment;
select throws_ok($$ select * from pg_temp.checkin(true) $$, '42501', null,
  'no marker: a fake location is refused');

insert into private.app_environment (name) values ('staging');
select throws_ok($$ select * from pg_temp.checkin(true) $$, '42501', null,
  'staging: a fake location is refused');
select is((select ok from pg_temp.checkin(false)), true, 'staging: a real location is still accepted');

update private.app_environment set name = 'production';
select throws_ok($$ select * from pg_temp.checkin(true) $$, '42501', null,
  'production: a fake location is refused');

update private.app_environment set name = 'local';
delete from checkins where user_id = '55555555-5555-5555-5555-555555555555';
select is((select ok from pg_temp.checkin(true)), true, 'local: a fake location is accepted');
select is(
  (select is_fake_location from checkins where user_id = '55555555-5555-5555-5555-555555555555'),
  true, 'local: the check-in is flagged as fake'
);

select * from finish();
rollback;
