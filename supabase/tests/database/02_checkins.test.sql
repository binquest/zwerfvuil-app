-- record_checkin rules, review_checkin and eligible_override.
-- Run with: npm run db:test

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(37);

-- No quests (phase 6) in this test: no quest rewards, no chest.
update quest_templates set active = false;

-- The economy before phase 3: no discovery chips, so the points below stay
-- as they were (12_discoveries covers discoveries).
update game_config set value = '0' where key = 'discovery_chips';

-- ---------------------------------------------------------------------------
-- Fixtures (as postgres)
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.test', 'authenticated', 'authenticated'),
  ('33333333-3333-3333-3333-333333333333', 'admin@example.test', 'authenticated', 'authenticated');
update profiles set is_admin = true where id = '33333333-3333-3333-3333-333333333333';

-- Bins around Null Island, far away from imported data. b7 is 1 km east.
insert into bins (osm_type, osm_id, geom, status, eligible, eligible_override) values
  ('node', 900000000000201, 'SRID=4326;POINT(0 0)', 'active', true, null),
  ('node', 900000000000202, st_project('SRID=4326;POINT(0 0)'::geography, 200, radians(90)), 'active', true, null),
  ('node', 900000000000203, st_project('SRID=4326;POINT(0 0)'::geography, 400, radians(90)), 'removed', true, null),
  ('node', 900000000000204, st_project('SRID=4326;POINT(0 0)'::geography, 600, radians(90)), 'active', false, null),
  ('node', 900000000000205, st_project('SRID=4326;POINT(0 0)'::geography, 800, radians(90)), 'active', false, true),
  ('node', 900000000000206, st_project('SRID=4326;POINT(0 0)'::geography, 0.001, 0), 'active', true, false),
  ('node', 900000000000207, st_project('SRID=4326;POINT(0 0)'::geography, 1000, radians(90)), 'active', true, null);

-- A position `meters` north of the bin with the given osm_id.
create function pg_temp.near(osm bigint, meters double precision)
returns table (lat double precision, lon double precision)
language sql as $$
  select st_y(p::geometry), st_x(p::geometry)
  from (select st_project(b.geom, meters, 0) p from public.bins b where b.osm_id = osm) s;
$$;

create function pg_temp.bin(osm bigint) returns bigint language sql as $$
  select id from public.bins where osm_id = osm;
$$;

-- Calls record_checkin for alice, `meters` from the bin.
create function pg_temp.checkin(osm bigint, meters double precision)
returns table (ok boolean, reason text, checkin_id uuid, distance_m double precision, retry_after_s integer)
language sql as $$
  select r.ok, r.reason, r.checkin_id, r.distance_m, r.retry_after_s from pg_temp.near(osm, meters) n,
    lateral public.record_checkin(gen_random_uuid(), '11111111-1111-1111-1111-111111111111',
      pg_temp.bin(osm), n.lat, n.lon, 5, false, false,
      '11111111-1111-1111-1111-111111111111/x.jpg') r;
$$;

-- Noise: another user's activity, as in a dev database with real data.
-- Every count and pick above and below must stay scoped to the test users.
insert into auth.users (id, email, aud, role) values
  ('44444444-4444-4444-4444-444444444444', 'noise@example.test', 'authenticated', 'authenticated');
insert into checkins (user_id, bin_id, photo_path, user_geom, accuracy_m, distance_m)
select '44444444-4444-4444-4444-444444444444', (select id from bins where osm_id = 900000000000207), '44444444-4444-4444-4444-444444444444/c.jpg', 'SRID=4326;POINT(0 0)', 5, 1
from generate_series(1, 3);
insert into storage.objects (bucket_id, name) values
  ('report-photos', '44444444-4444-4444-4444-444444444444/n.jpg');
insert into bin_reports (user_id, geom, photo_path) values
  ('44444444-4444-4444-4444-444444444444', 'SRID=4326;POINT(0 0)', '44444444-4444-4444-4444-444444444444/n.jpg');

-- ---------------------------------------------------------------------------
-- Who may call record_checkin
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select throws_ok(
  $$ select * from record_checkin(gen_random_uuid(), auth.uid(), 1, 0, 0, 5, false, false, 'x.jpg') $$,
  '42501', null, 'users cannot call record_checkin directly');
reset role;

set local role anon;
select throws_ok(
  $$ select * from record_checkin(gen_random_uuid(), gen_random_uuid(), 1, 0, 0, 5, false, false, 'x.jpg') $$,
  '42501', null, 'anon cannot call record_checkin');
reset role;

-- ---------------------------------------------------------------------------
-- Rules (as postgres; the service role is granted execute)
-- ---------------------------------------------------------------------------

select ok(has_function_privilege('service_role',
  'public.record_checkin(uuid, uuid, bigint, double precision, double precision, real, boolean, boolean, text)', 'execute'),
  'the service role can call record_checkin');

select is((select row(ok, reason) from pg_temp.checkin(900000000000201, 24))::text, '(t,)',
  'a check-in 24 m from an eligible bin is accepted');
select ok(
  (select abs(c.distance_m - 24) < 0.01 and c.status = 'pending'
          and not exists (select 1 from point_transactions t where t.checkin_id = c.id and t.status = 'granted')
          and not c.is_fake_location and not c.is_mocked
   from checkins c where c.bin_id = pg_temp.bin(900000000000201)),
  'the check-in is stored as pending, without points, with the server-side distance');

select is((select reason from pg_temp.checkin(900000000000201, 5)), 'cooldown',
  'a second check-in at the same bin within 10 minutes is refused');
select ok((select retry_after_s between 590 and 600 from pg_temp.checkin(900000000000201, 5)),
  'the cooldown reports the seconds until the next allowed check-in');

select is((select row(ok, reason) from pg_temp.checkin(900000000000202, 25.5))::text, '(f,too_far)',
  'a check-in 25.5 m from the bin is refused');
select ok((select abs(distance_m - 25.5) < 0.01 from pg_temp.checkin(900000000000202, 25.5)),
  'too_far reports the distance');
select is((select reason from pg_temp.checkin(900000000000202, 10)), null,
  'the cooldown is per bin: another bin is accepted');

select is((select reason from pg_temp.checkin(900000000000203, 1)), 'bin_inactive', 'removed bins are refused');
select is((select reason from pg_temp.checkin(900000000000204, 1)), 'bin_not_eligible', 'ineligible bins are refused');
select is((select reason from pg_temp.checkin(900000000000205, 1)), null,
  'eligible_override = true makes an ineligible bin eligible');
select is((select reason from pg_temp.checkin(900000000000206, 1)), 'bin_not_eligible',
  'eligible_override = false makes an eligible bin ineligible');
select is(
  (select reason from record_checkin(gen_random_uuid(), '11111111-1111-1111-1111-111111111111',
     -1, 0, 0, 5, false, false, 'x.jpg')),
  'bin_not_found', 'unknown bins are refused');
select throws_ok(
  $$ select * from record_checkin(gen_random_uuid(), '11111111-1111-1111-1111-111111111111', 1, 91, 0, 5, false, false, 'x.jpg') $$,
  '22023', null, 'invalid coordinates are an error');

update checkins set created_at = now() - interval '11 minutes' where bin_id = pg_temp.bin(900000000000201);
select is((select reason from pg_temp.checkin(900000000000201, 5)), null,
  'after 10 minutes the same bin is accepted again');

-- Daily limit: top alice up to 20 check-ins today (at the start of the day).
insert into checkins (user_id, bin_id, photo_path, user_geom, accuracy_m, distance_m, created_at)
select '11111111-1111-1111-1111-111111111111', pg_temp.bin(900000000000201), 'f.jpg',
       'SRID=4326;POINT(0 0)', 5, 1, local_day_start(now())
from generate_series(1, 20 - (select count(*)::int from checkins
                              where user_id = '11111111-1111-1111-1111-111111111111' and created_at >= local_day_start(now())));
select is((select count(*)::int from checkins where user_id = '11111111-1111-1111-1111-111111111111' and created_at >= local_day_start(now())), 20,
  'alice has 20 check-ins today');
select is((select reason from pg_temp.checkin(900000000000207, 1)), 'daily_limit',
  'the 21st check-in of the day is refused');
select ok((select retry_after_s between 1 and 90000 from pg_temp.checkin(900000000000207, 1)),
  'daily_limit reports the seconds until midnight in Gent');

update checkins set created_at = local_day_start(now()) - interval '1 hour' where photo_path = 'f.jpg';
select is((select reason from pg_temp.checkin(900000000000207, 1)), null,
  'check-ins from yesterday do not count towards the daily limit');

-- ---------------------------------------------------------------------------
-- eligible_override
-- ---------------------------------------------------------------------------

select is(
  (select array_agg(eligible_effective order by osm_id) from bins where osm_id between 900000000000204 and 900000000000206),
  array[false, true, false],
  'eligible_effective = coalesce(eligible_override, eligible)');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select is(
  (select array_agg(n.eligible order by n.distance_m) from nearby_bins(0, 0, 900) n),
  array[true, false, true, false, true],
  'nearby_bins returns the effective eligibility');
select throws_ok($$ update bins set eligible_override = true $$, '42501', null,
  'users cannot set eligible_override');
reset role;

-- ---------------------------------------------------------------------------
-- review_checkin
-- ---------------------------------------------------------------------------

select set_config('test.first', (select id::text from checkins where bin_id = pg_temp.bin(900000000000202)), true);
select set_config('test.second', (select id::text from checkins where bin_id = pg_temp.bin(900000000000205)), true);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select throws_ok($$ select review_checkin(current_setting('test.first')::uuid, true) $$, '42501', null,
  'users cannot review check-ins');
reset role;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
select is(
  (select row(r.status, r.reviewed_by)::text from review_checkin(current_setting('test.first')::uuid, true) r),
  '(approved,33333333-3333-3333-3333-333333333333)',
  'admins can approve a check-in');
select is(
  (select sum(t.amount)::int from point_transactions t
   where t.checkin_id = current_setting('test.first')::uuid and t.status = 'granted'),
  11, 'approval grants its points in the ledger (10 x1.1 for a one-week streak)');
select throws_ok($$ select review_checkin(current_setting('test.first')::uuid, false) $$, '55000', null,
  'a check-in can only be reviewed once');
select is((select r.status from review_checkin(current_setting('test.second')::uuid, false) r), 'rejected',
  'admins can reject a check-in');
select is(
  (select string_agg(t.status, ',') from point_transactions t where t.checkin_id = current_setting('test.second')::uuid),
  'revoked', 'a rejection revokes its points');
select throws_ok($$ select review_checkin(gen_random_uuid(), true) $$, 'P0002', null,
  'reviewing an unknown check-in fails');
select throws_ok($$ select review_checkin(current_setting('test.first')::uuid, null) $$, '22023', null,
  'approve must not be null');
reset role;

select is((select points from profiles where id = '11111111-1111-1111-1111-111111111111'), 11,
  'only the approved check-in added points to the profile');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select is((select points from profiles where id = auth.uid()), 11, 'users see their points');
select is(
  (select array_agg(status order by status) from checkins where id in (current_setting('test.first')::uuid, current_setting('test.second')::uuid)),
  array['approved', 'rejected'],
  'users see the review outcome of their check-ins');
reset role;

select throws_ok(
  $$ update checkins set status = 'approved' where photo_path = 'f.jpg' $$,
  '23514', null, 'decided check-ins must have reviewed_at');

select is_empty($$ select * from private.check_points_invariant() $$, 'every profile equals its ledger');

select * from finish();
rollback;
