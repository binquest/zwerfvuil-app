-- RLS, privileges, nearby_bins, report moderation and storage policies.
-- Run with: npm run db:test
-- Everything happens in one transaction that is rolled back.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(42);

-- ---------------------------------------------------------------------------
-- Fixtures (as postgres)
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.test', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.test', 'authenticated', 'authenticated'),
  ('33333333-3333-3333-3333-333333333333', 'admin@example.test', 'authenticated', 'authenticated');
update profiles set is_admin = true where id = '33333333-3333-3333-3333-333333333333';

-- Test bins around Null Island, far away from imported data.
insert into bins (osm_type, osm_id, geom, status, eligible) values
  ('node', 900000000000101, st_project('SRID=4326;POINT(0 0)'::geography, 10, 0), 'active', true),
  ('node', 900000000000102, st_project('SRID=4326;POINT(0 0)'::geography, 100, radians(90)), 'active', false),
  ('node', 900000000000103, st_project('SRID=4326;POINT(0 0)'::geography, 2000, 0), 'active', true),
  ('node', 900000000000104, st_project('SRID=4326;POINT(0 0)'::geography, 5, 0), 'removed', true);

insert into checkins (user_id, bin_id, photo_path, user_geom, accuracy_m, distance_m) values
  ('11111111-1111-1111-1111-111111111111', (select id from bins where osm_id = 900000000000101),
   '11111111-1111-1111-1111-111111111111/a.jpg', 'SRID=4326;POINT(0 0)', 5, 10),
  ('22222222-2222-2222-2222-222222222222', (select id from bins where osm_id = 900000000000101),
   '22222222-2222-2222-2222-222222222222/b.jpg', 'SRID=4326;POINT(0 0)', 5, 10);

select is(
  (select display_name from profiles where id = '11111111-1111-1111-1111-111111111111'),
  null,
  'a profile is created for every new auth user, without a name from the e-mail address'
);
select is(
  (select points from profiles where id = '11111111-1111-1111-1111-111111111111'),
  0,
  'new profiles start with 0 points'
);

-- The names the onboarding would ask for.
update profiles set display_name = case id
    when '11111111-1111-1111-1111-111111111111' then 'alice'
    when '22222222-2222-2222-2222-222222222222' then 'bob'
    else 'admin' end
where id in ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
             '33333333-3333-3333-3333-333333333333');

-- Noise: another user's activity, as in a dev database with real data.
-- Every count and pick above and below must stay scoped to the test users.
insert into auth.users (id, email, aud, role) values
  ('44444444-4444-4444-4444-444444444444', 'noise@example.test', 'authenticated', 'authenticated');
insert into checkins (user_id, bin_id, photo_path, user_geom, accuracy_m, distance_m)
select '44444444-4444-4444-4444-444444444444', (select id from bins where osm_id = 900000000000101), '44444444-4444-4444-4444-444444444444/c.jpg', 'SRID=4326;POINT(0 0)', 5, 1
from generate_series(1, 3);
insert into storage.objects (bucket_id, name) values
  ('report-photos', '44444444-4444-4444-4444-444444444444/n.jpg');
insert into bin_reports (user_id, geom, photo_path) values
  ('44444444-4444-4444-4444-444444444444', 'SRID=4326;POINT(0 0)', '44444444-4444-4444-4444-444444444444/n.jpg');

-- ---------------------------------------------------------------------------
-- anon
-- ---------------------------------------------------------------------------

set local role anon;
select throws_ok($$ select * from bins $$, '42501', null, 'anon cannot read bins');
select throws_ok($$ select * from nearby_bins(0, 0, 100) $$, '42501', null, 'anon cannot call nearby_bins');
select throws_ok($$ select * from profiles $$, '42501', null, 'anon cannot read profiles');
reset role;

-- ---------------------------------------------------------------------------
-- alice (regular user)
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

select is((select count(*)::int from bins where osm_id between 900000000000101 and 900000000000104), 4,
  'users can read bins');
select throws_ok($$ insert into bins (osm_type, osm_id, geom) values ('node', 1, 'SRID=4326;POINT(0 0)') $$,
  '42501', null, 'users cannot insert bins');
select throws_ok($$ update bins set eligible = true $$, '42501', null, 'users cannot update bins');

-- nearby_bins
select results_eq(
  $$ select b.osm_id from nearby_bins(0, 0, 150) n join bins b on b.id = n.id order by n.distance_m $$,
  $$ values (900000000000101::bigint), (900000000000102::bigint) $$,
  'nearby_bins returns active bins within the radius, nearest first'
);
select ok(
  (select bool_and(abs(n.distance_m - case b.osm_id when 900000000000101 then 10 else 100 end) < 0.01)
   from nearby_bins(0, 0, 150) n join bins b on b.id = n.id),
  'nearby_bins distances are correct to the centimetre'
);
select is(
  (select array_agg(n.eligible order by n.distance_m) from nearby_bins(0, 0, 150) n),
  array[true, false],
  'nearby_bins returns the eligible flag'
);
select is((select count(*)::int from nearby_bins(0, 0, 9)), 0, 'nearby_bins skips removed bins');
select throws_ok($$ select * from nearby_bins(0, 0, 6000) $$, '22023', null, 'nearby_bins rejects a radius above 5000 m');
select throws_ok($$ select * from nearby_bins(95, 0, 100) $$, '22023', null, 'nearby_bins rejects invalid coordinates');

-- profiles
select is((select count(*)::int from profiles), 1, 'users only see their own profile');
select throws_ok($$ update profiles set points = 1000 where id = auth.uid() $$, '42501', null,
  'users cannot change their points');
select throws_ok($$ update profiles set is_admin = true where id = auth.uid() $$, '42501', null,
  'users cannot make themselves admin');
select throws_ok($$ update profiles set display_name = 'Alice' where id = auth.uid() $$, '42501', null,
  'users cannot write their display name directly');
select is(set_my_name('Alice'), 'Alice', 'they change it through set_my_name');

-- checkins
select is((select count(*)::int from checkins), 1, 'users only see their own check-ins');
select throws_ok(
  $$ insert into checkins (user_id, bin_id, photo_path, user_geom, accuracy_m, distance_m)
     values (auth.uid(), 1, 'x.jpg', 'SRID=4326;POINT(0 0)', 1, 1) $$,
  '42501', null, 'users cannot create check-ins directly');
select throws_ok($$ update checkins set status = 'approved' $$, '42501', null, 'users cannot approve check-ins');
select throws_ok($$ delete from checkins $$, '42501', null, 'users cannot delete check-ins');

-- storage
select lives_ok(
  $$ insert into storage.objects (bucket_id, name) values ('report-photos', '11111111-1111-1111-1111-111111111111/r1.jpg') $$,
  'users can upload a report photo to their own folder');
select throws_ok(
  $$ insert into storage.objects (bucket_id, name) values ('report-photos', '22222222-2222-2222-2222-222222222222/r1.jpg') $$,
  '42501', null, 'users cannot upload into another user''s folder');
select throws_ok(
  $$ insert into storage.objects (bucket_id, name) values ('checkin-photos', '11111111-1111-1111-1111-111111111111/c.jpg') $$,
  '42501', null, 'users cannot upload check-in photos directly');

-- bin_reports
select lives_ok(
  $$ insert into bin_reports (geom, photo_path, note)
     values ('SRID=4326;POINT(0.001 0.001)', '11111111-1111-1111-1111-111111111111/r1.jpg', 'Nieuwe vuilbak') $$,
  'users can report a missing bin with their own photo');
select throws_ok(
  $$ insert into bin_reports (geom, photo_path) values ('SRID=4326;POINT(0 0)', '11111111-1111-1111-1111-111111111111/missing.jpg') $$,
  '42501', null, 'a report needs an uploaded photo');
select throws_ok(
  $$ insert into bin_reports (geom, photo_path, status) values ('SRID=4326;POINT(0 0)', '11111111-1111-1111-1111-111111111111/r1.jpg', 'approved') $$,
  '42501', null, 'users cannot set the report status');
select throws_ok(
  $$ insert into bin_reports (user_id, geom, photo_path) values ('22222222-2222-2222-2222-222222222222', 'SRID=4326;POINT(0 0)', '11111111-1111-1111-1111-111111111111/r1.jpg') $$,
  '42501', null, 'users cannot report on behalf of someone else');
select throws_ok(
  $$ select review_bin_report((select id from bin_reports limit 1), true) $$,
  '42501', null, 'users cannot review reports');
select throws_ok($$ update bin_reports set status = 'approved' $$, '42501', null, 'users cannot update reports');

reset role;

-- ---------------------------------------------------------------------------
-- bob (another regular user)
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);

select is((select count(*)::int from bin_reports), 0, 'users cannot see other users'' reports');
select is((select count(*)::int from storage.objects where bucket_id = 'report-photos'), 0,
  'users cannot see other users'' report photos');
select is((select display_name from profiles where id = auth.uid()), 'bob',
  'the other user''s display name was not changed');

reset role;

-- ---------------------------------------------------------------------------
-- admin
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);

select is((select count(*)::int from checkins where user_id in ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222')), 2, 'admins see all check-ins');
select is((select count(*)::int from storage.objects where bucket_id = 'report-photos'
                                  and name like '11111111-1111-1111-1111-111111111111/%'), 1,
  'admins can read report photos');
select throws_ok($$ update checkins set status = 'approved' $$, '42501', null,
  'admins cannot update check-ins directly either');

select is(
  (select r.status from review_bin_report((select id from bin_reports where user_id = '11111111-1111-1111-1111-111111111111'), true) r),
  'approved',
  'admins can approve a report'
);
select ok(
  exists (
    select 1 from bin_reports r join bins b on b.id = r.bin_id
    where r.user_id = '11111111-1111-1111-1111-111111111111' and b.source = 'user' and b.status = 'active' and b.eligible
      and st_equals(b.geom::geometry, r.geom::geometry)
  ),
  'approving a report creates an active user bin at the reported location'
);
select throws_ok(
  $$ select review_bin_report((select id from bin_reports where user_id = '11111111-1111-1111-1111-111111111111'), false) $$,
  '55000', null, 'a report can only be reviewed once');
select throws_ok(
  $$ select review_bin_report(gen_random_uuid(), true) $$,
  'P0002', null, 'reviewing an unknown report fails');

reset role;

select * from finish();
rollback;
