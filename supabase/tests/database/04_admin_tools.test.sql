-- set_bin_eligibility, pending_checkins and pending_bin_reports.
-- Run with: npm run db:test

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(17);

insert into auth.users (id, email, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.test', 'authenticated', 'authenticated'),
  ('33333333-3333-3333-3333-333333333333', 'admin@example.test', 'authenticated', 'authenticated');
update profiles set is_admin = true where id = '33333333-3333-3333-3333-333333333333';

insert into bins (osm_type, osm_id, geom, eligible) values
  ('node', 900000000000401, 'SRID=4326;POINT(0 0)', true),
  ('node', 900000000000402, st_project('SRID=4326;POINT(0 0)'::geography, 500, radians(90)), false);
select set_config('test.b1', (select id::text from bins where osm_id = 900000000000401), true);
select set_config('test.b2', (select id::text from bins where osm_id = 900000000000402), true);

insert into checkins (user_id, bin_id, photo_path, user_geom, accuracy_m, distance_m) values
  ('11111111-1111-1111-1111-111111111111', current_setting('test.b1')::bigint,
   '11111111-1111-1111-1111-111111111111/c.jpg', st_project('SRID=4326;POINT(0 0)'::geography, 12, 0), 6, 12);
insert into bin_reports (user_id, geom, photo_path, note) values
  ('11111111-1111-1111-1111-111111111111', st_project('SRID=4326;POINT(0 0)'::geography, 30, 0),
   '11111111-1111-1111-1111-111111111111/r.jpg', 'Bij de bushalte');

-- regular user ---------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select throws_ok($$ select * from set_bin_eligibility(current_setting('test.b1')::bigint, false) $$, '42501', null,
  'users cannot change bin eligibility');
select throws_ok($$ select * from pending_checkins() $$, '42501', null, 'users cannot list pending check-ins');
select throws_ok($$ select * from pending_bin_reports() $$, '42501', null, 'users cannot list pending reports');
reset role;

-- admin ----------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);

select is(
  (select row(r.eligible_override, r.eligible_effective)::text from set_bin_eligibility(current_setting('test.b1')::bigint, false) r),
  '(f,f)', 'excluding an eligible bin stores override = false');
select is(
  (select n.eligible from nearby_bins(0, 0, 10) n where n.id = current_setting('test.b1')::bigint),
  false, 'nearby_bins reflects the exclusion');
select is(
  (select row(r.eligible_override, r.eligible_effective)::text from set_bin_eligibility(current_setting('test.b1')::bigint, true) r),
  '(,t)', 're-admitting a bin that is eligible in OSM clears the override');
select is(
  (select row(r.eligible_override, r.eligible_effective)::text from set_bin_eligibility(current_setting('test.b2')::bigint, true) r),
  '(t,t)', 'admitting a bin that is ineligible in OSM stores override = true');
select is(
  (select row(r.eligible_override, r.eligible_effective)::text from set_bin_eligibility(current_setting('test.b2')::bigint, false) r),
  '(,f)', 'excluding it again clears the override');
select throws_ok($$ select * from set_bin_eligibility(-1, false) $$, 'P0002', null, 'unknown bins fail');
select throws_ok($$ select * from set_bin_eligibility(current_setting('test.b1')::bigint, null) $$, '22023', null,
  'eligible must not be null');

select is((select count(*)::int from pending_checkins()), 1, 'admins see pending check-ins');
select ok(
  (select c.display_name = 'alice' and c.bin_id = current_setting('test.b1')::bigint
          and abs(c.bin_latitude) < 1e-9 and abs(c.bin_longitude) < 1e-9
          and abs(c.latitude - 12 / 110574.3) < 1e-6 and c.photo_path like '%/c.jpg'
   from pending_checkins() c),
  'pending check-ins include the user, the bin and both locations');

select is((select count(*)::int from pending_bin_reports()), 1, 'admins see pending reports');
select ok(
  (select r.display_name = 'alice' and r.note = 'Bij de bushalte' and abs(r.nearest_bin_m - 30) < 0.01
   from pending_bin_reports() r),
  'pending reports include the note and the distance to the nearest active bin');

select lives_ok($$ select review_checkin((select id from pending_checkins() limit 1), true) $$,
  'admins can review the listed check-in');
select is((select count(*)::int from pending_checkins()), 0, 'reviewed check-ins leave the queue');
select lives_ok($$ select review_bin_report((select id from pending_bin_reports() limit 1), false) $$,
  'admins can review the listed report');

reset role;

select * from finish();
rollback;
