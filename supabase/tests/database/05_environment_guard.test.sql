-- private.app_environment and the fake-location guard in record_checkin: a
-- fake location is a Dev mode feature, only for admins on local or staging.
-- Run with: npm run db:test

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(14);

insert into auth.users (id, email, aud, role) values
  ('55555555-5555-5555-5555-555555555555', 'env@example.test', 'authenticated', 'authenticated'),
  ('66666666-6666-6666-6666-666666666666', 'env-admin@example.test', 'authenticated', 'authenticated');
update profiles set is_admin = true where id = '66666666-6666-6666-6666-666666666666';
insert into bins (osm_type, osm_id, geom, status, eligible, eligible_override) values
  ('node', 900000000000501, 'SRID=4326;POINT(0 0)', 'active', true, null);

-- A check-in exactly at the test bin, real or fake, by `who`.
create function pg_temp.checkin(who uuid, fake boolean)
returns table (ok boolean, reason text, checkin_id uuid, is_test boolean)
language sql as $$
  select r.ok, r.reason, r.checkin_id, r.is_test
  from public.record_checkin(gen_random_uuid(), who,
    (select id from public.bins where osm_id = 900000000000501), 0, 0, 5, false, fake,
    who::text || '/x.jpg') r;
$$;

create function pg_temp.user_() returns uuid language sql as $$ select '55555555-5555-5555-5555-555555555555'::uuid $$;
create function pg_temp.admin_() returns uuid language sql as $$ select '66666666-6666-6666-6666-666666666666'::uuid $$;

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
select is((select reason from pg_temp.checkin(pg_temp.admin_(), true)), 'fake_location_not_allowed',
  'no marker: a fake location is refused, even for an admin');

insert into private.app_environment (name) values ('staging');
select is((select reason from pg_temp.checkin(pg_temp.user_(), true)), 'fake_location_not_allowed',
  'staging: a fake location from a user who is not an admin is refused');
select is((select row(ok, is_test)::text from pg_temp.checkin(pg_temp.user_(), false)), '(t,f)',
  'staging: a real location is accepted, not as a test');
select is((select row(ok, is_test)::text from pg_temp.checkin(pg_temp.admin_(), true)), '(t,t)',
  'staging: an admin''s fake location is accepted as a test check-in');
select is(
  (select row(is_fake_location, is_test)::text from checkins where user_id = pg_temp.admin_()),
  '(t,t)', 'staging: the check-in is flagged as fake and as test');

update private.app_environment set name = 'production';
delete from checkins where user_id in (pg_temp.user_(), pg_temp.admin_());
select is((select reason from pg_temp.checkin(pg_temp.admin_(), true)), 'fake_location_not_allowed',
  'production: an admin''s fake location is refused');
select is((select count(*)::int from checkins where user_id = pg_temp.admin_()), 0,
  'production: nothing is stored');

update private.app_environment set name = 'local';
select is((select reason from pg_temp.checkin(pg_temp.user_(), true)), 'fake_location_not_allowed',
  'local: a fake location from a user who is not an admin is refused');
select is((select row(ok, is_test)::text from pg_temp.checkin(pg_temp.admin_(), true)), '(t,t)',
  'local: an admin''s fake location is accepted as a test check-in');
select is((select count(*)::int from dev_audit_log where user_id = pg_temp.admin_() and action = 'test_checkin'), 2,
  'both accepted fake check-ins are in the audit log');

select * from finish();
rollback;
