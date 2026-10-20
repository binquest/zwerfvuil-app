-- The points ledger: the migration of existing points, the projection of
-- check-ins, approve/reject/revoke, earning again, adjustments, who reads and
-- writes the ledger, the leaderboard. Run with: npm run db:test

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(65);

-- No quests (phase 6) in this test: no quest rewards, no chest.
update quest_templates set active = false;

-- The economy before phase 3: no discovery chips, so the points below stay
-- as they were (12_discoveries covers discoveries).
update game_config set value = '0' where key = 'discovery_chips';

-- The rows of one check-in (or user), compact.
create function pg_temp.rows_of(c uuid) returns text language sql as $$
  select string_agg(t.source || ':' || t.amount || ':' || t.status, ',' order by t.source)
  from public.point_transactions t where t.checkin_id = c;
$$;

create function pg_temp.pts(u uuid) returns text language sql as $$
  select row(p.points, p.test_points)::text from public.profiles p where p.id = u;
$$;

insert into bins (osm_type, osm_id, geom, status, eligible) values
  ('node', 900000000000801, 'SRID=4326;POINT(0 0)', 'active', true),
  ('node', 900000000000802, st_project('SRID=4326;POINT(0 0)'::geography, 200, radians(90)), 'active', true),
  ('node', 900000000000803, st_project('SRID=4326;POINT(0 0)'::geography, 400, radians(90)), 'active', true);

-- ---------------------------------------------------------------------------
-- 1. The migration: a database from before the ledger, where profile points
--    are the truth. Simulated by switching off the ledger triggers, building
--    the old state, and emptying the ledger (also any rows of a dev database).
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, aud, role) values
  ('81000000-0000-0000-0000-000000000001', 'm1@example.test', 'authenticated', 'authenticated'),
  ('81000000-0000-0000-0000-000000000002', 'm2@example.test', 'authenticated', 'authenticated'),
  ('81000000-0000-0000-0000-000000000003', 'm3@example.test', 'authenticated', 'authenticated');

alter table checkins disable trigger checkins_sync_ledger;
alter table profiles disable trigger profiles_points_follow_ledger;
alter table point_transactions disable trigger point_transactions_apply_delta;
delete from point_transactions;
alter table point_transactions enable trigger point_transactions_apply_delta;

-- m1: pending with an answered bonus, approved, approved with a bonus answered
-- after approval. m2: rejected, plus 7 points from an edit in Studio. m3: an
-- approved test check-in with its bonus.
insert into checkins (id, user_id, bin_id, photo_path, user_geom, accuracy_m, distance_m,
                      status, reviewed_at, points_earned, bonus_points, is_test, created_at)
select v.id::uuid, v.u::uuid, pg_temp_bin.id, 'm.jpg', 'SRID=4326;POINT(0 0)', 5, 1,
       v.s, case when v.s = 'pending' then null else timestamptz '2026-10-14 12:00+02' end,
       v.earned, v.bonus, v.test, timestamptz '2026-10-13 12:00+02'
from (values
  ('8c000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000001', 'pending', 11, 5, false),
  ('8c000000-0000-0000-0000-000000000002', '81000000-0000-0000-0000-000000000001', 'approved', 11, 0, false),
  ('8c000000-0000-0000-0000-000000000003', '81000000-0000-0000-0000-000000000001', 'approved', 11, 5, false),
  ('8c000000-0000-0000-0000-000000000004', '81000000-0000-0000-0000-000000000002', 'rejected', 11, 0, false),
  ('8c000000-0000-0000-0000-000000000005', '81000000-0000-0000-0000-000000000003', 'approved', 16, 5, true)
) v(id, u, s, earned, bonus, test)
cross join lateral (select b.id from bins b where b.osm_id = 900000000000801) pg_temp_bin;
update profiles set points = 27 where id = '81000000-0000-0000-0000-000000000001';
update profiles set points = 7 where id = '81000000-0000-0000-0000-000000000002';
update profiles set test_points = 21 where id = '81000000-0000-0000-0000-000000000003';
alter table checkins enable trigger checkins_sync_ledger;

select lives_ok($$ select private.migrate_points_to_ledger() $$, 'the migration runs on the old state');
alter table profiles enable trigger profiles_points_follow_ledger;

select is(
  array[pg_temp.pts('81000000-0000-0000-0000-000000000001'), pg_temp.pts('81000000-0000-0000-0000-000000000002'),
        pg_temp.pts('81000000-0000-0000-0000-000000000003')],
  array['(27,0)', '(7,0)', '(0,21)'], 'every profile keeps exactly its points');
select is(
  array[pg_temp.rows_of('8c000000-0000-0000-0000-000000000001'), pg_temp.rows_of('8c000000-0000-0000-0000-000000000002'),
        pg_temp.rows_of('8c000000-0000-0000-0000-000000000003'), pg_temp.rows_of('8c000000-0000-0000-0000-000000000004'),
        pg_temp.rows_of('8c000000-0000-0000-0000-000000000005')],
  array['bonus:5:pending,checkin:11:pending', 'checkin:11:granted', 'bonus:5:granted,checkin:11:granted',
        'checkin:11:revoked', 'bonus:5:granted,checkin:16:granted'],
  'pending -> pending, approved -> granted (with a late bonus), rejected -> revoked');
select is(
  (select bool_and(t.granted_at = timestamptz '2026-10-14 12:00+02' and t.earned_at = timestamptz '2026-10-13 12:00+02')
   from point_transactions t where t.status = 'granted' and t.checkin_id::text like '8c000000-%'),
  true, 'granted_at is the review time, earned_at the check-in time');
select is(
  (select bool_and(t.is_test) from point_transactions t where t.checkin_id = '8c000000-0000-0000-0000-000000000005'),
  true, 'test check-ins give test rows');
select is(
  (select string_agg(t.source || ':' || t.amount || ':' || t.status || ':' || t.reward_key || ':' || (t.details->>'reason'), ',')
   from point_transactions t where t.user_id = '81000000-0000-0000-0000-000000000002' and t.checkin_id is null),
  'adjustment:7:granted:adjustment:migration:migratie', 'a difference with the snapshot becomes an adjustment');
select is_empty($$ select * from private.check_points_invariant() $$, 'after the migration every profile equals its ledger');
select throws_ok($$ select private.migrate_points_to_ledger() $$, '55000', null, 'the migration refuses a ledger that is not empty');

-- ---------------------------------------------------------------------------
-- 2. A check-in by the service role, as submit-checkin does
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.test', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.test', 'authenticated', 'authenticated'),
  ('33333333-3333-3333-3333-333333333333', 'admin@example.test', 'authenticated', 'authenticated');
-- A name for every test account: since phase 4 a new account gets none from
-- its e-mail address (the onboarding asks for one).
update profiles p set display_name = split_part(u.email, '@', 1)
from auth.users u where u.id = p.id and u.email like '%@example.test' and p.display_name is null;
update profiles set is_admin = true where id = '33333333-3333-3333-3333-333333333333';

set local role service_role;
select is(
  (select r.ok from bins b,
     lateral record_checkin('c1000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', b.id,
       st_y(st_project(b.geom, 5, 0)::geometry), st_x(st_project(b.geom, 5, 0)::geometry),
       5, false, false, '11111111-1111-1111-1111-111111111111/1.jpg') r
   where b.osm_id = 900000000000801),
  true, 'the service role records a check-in (record_checkin is security definer)');
select ok(
  (select r.ok from bins b,
     lateral record_checkin('c1000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', b.id,
       st_y(st_project(b.geom, 5, 0)::geometry), st_x(st_project(b.geom, 5, 0)::geometry),
       5, false, false, '11111111-1111-1111-1111-111111111111/2.jpg') r
   where b.osm_id = 900000000000802)
  and
  (select r.ok from bins b,
     lateral record_checkin('c1000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', b.id,
       st_y(st_project(b.geom, 5, 0)::geometry), st_x(st_project(b.geom, 5, 0)::geometry),
       5, false, false, '11111111-1111-1111-1111-111111111111/3.jpg') r
   where b.osm_id = 900000000000803),
  'and two more');
select throws_ok($$ select * from private.check_points_invariant() $$, '42501', null,
  'the service role cannot reach schema private');
reset role;

select is(pg_temp.rows_of('c1000000-0000-0000-0000-000000000001'), 'checkin:11:pending',
  'a new check-in has a pending row with its frozen points');
select is((select reward_key from point_transactions where checkin_id = 'c1000000-0000-0000-0000-000000000001'),
  'checkin:c1000000-0000-0000-0000-000000000001', 'with a stable reward key');
select is(pg_temp.pts('11111111-1111-1111-1111-111111111111'), '(0,0)', 'pending points do not count yet');

-- ---------------------------------------------------------------------------
-- 3. Users read their own rows and write nothing
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select is((select count(*)::int from point_transactions), 3, 'alice reads her own three rows');
select is((select count(*)::int from point_transactions where user_id <> auth.uid()), 0, 'and nobody else''s');
select throws_ok(
  $$ insert into point_transactions (user_id, source, reward_key, amount, status, granted_at)
     values (auth.uid(), 'adjustment', 'adjustment:x', 1000, 'granted', now()) $$,
  '42501', null, 'users cannot insert ledger rows');
select throws_ok($$ update point_transactions set amount = 1000 $$, '42501', null, 'users cannot change ledger rows');
select throws_ok($$ delete from point_transactions $$, '42501', null, 'users cannot delete ledger rows');
select throws_ok($$ select adjust_points(auth.uid(), 1000, 'gift') $$, '42501', null, 'users cannot adjust points');
select throws_ok($$ select review_checkin('c1000000-0000-0000-0000-000000000001', true) $$, '42501', null,
  'users cannot review');
select throws_ok($$ select revoke_checkin('c1000000-0000-0000-0000-000000000001', 'x') $$, '42501', null,
  'users cannot revoke');
select throws_ok($$ select * from approved_checkins() $$, '42501', null, 'users cannot list approved check-ins');
reset role;

set local role anon;
select throws_ok($$ select count(*) from point_transactions $$, '42501', null, 'anon cannot read the ledger');
reset role;

-- ---------------------------------------------------------------------------
-- 4. Approve, answer late, reject with a reason
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
select throws_ok($$ select review_checkin('c1000000-0000-0000-0000-000000000001', true, 'Mooi') $$, '22023', null,
  'a reason is only for rejections');
select throws_ok($$ select review_checkin('c1000000-0000-0000-0000-000000000002', false, repeat('x', 201)) $$, '22023', null,
  'a reason is at most 200 characters');
select is((select status from review_checkin('c1000000-0000-0000-0000-000000000001', true)), 'approved', 'admin approves c1');
select is(
  (select row(status, review_reason)::text from review_checkin('c1000000-0000-0000-0000-000000000002', false, '  Foto onduidelijk ')),
  '(rejected,"Foto onduidelijk")', 'admin rejects c2 with a (trimmed) reason');
select is((select count(*)::int from point_transactions where user_id = '11111111-1111-1111-1111-111111111111'), 3,
  'admins read other users'' rows');
reset role;

select is(pg_temp.rows_of('c1000000-0000-0000-0000-000000000001'), 'checkin:11:granted', 'approval grants the row');
select is(
  (select row(status, revoke_reason)::text from point_transactions where checkin_id = 'c1000000-0000-0000-0000-000000000002'),
  '(revoked,checkin_rejected)', 'a rejection revokes the row');
select is(pg_temp.pts('11111111-1111-1111-1111-111111111111'), '(11,0)', 'only the approved check-in counts');

update bonus_answers set shown_at = clock_timestamp() - interval '3 seconds'
 where checkin_id = 'c1000000-0000-0000-0000-000000000001';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select is(answer_bonus_question('c1000000-0000-0000-0000-000000000001', 'empty'), 5,
  'alice answers c1''s question after approval');
reset role;
select is(pg_temp.rows_of('c1000000-0000-0000-0000-000000000001'), 'bonus:5:granted,checkin:11:granted',
  'a bonus after approval is granted right away');
select is(pg_temp.pts('11111111-1111-1111-1111-111111111111'), '(16,0)', 'and counts');

-- ---------------------------------------------------------------------------
-- 5. Revoke
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
select is(
  (select row(id, points)::text from approved_checkins() where id = 'c1000000-0000-0000-0000-000000000001'),
  '(c1000000-0000-0000-0000-000000000001,16)', 'approved_checkins lists c1 with its granted points');
select throws_ok($$ select revoke_checkin('c1000000-0000-0000-0000-000000000001', '  ') $$, '22023', null,
  'revoking needs a reason');
select throws_ok($$ select revoke_checkin('c1000000-0000-0000-0000-000000000003', 'Dubbel') $$, '55000', null,
  'a pending check-in cannot be revoked');
select throws_ok($$ select revoke_checkin(gen_random_uuid(), 'Dubbel') $$, 'P0002', null, 'an unknown check-in cannot be revoked');
select is(
  (select row(status, review_reason, revoked_at is not null, revoked_by, reviewed_at is not null)::text
   from revoke_checkin('c1000000-0000-0000-0000-000000000001', 'Dubbel of misbruik')),
  '(rejected,"Dubbel of misbruik",t,33333333-3333-3333-3333-333333333333,t)',
  'revoking rejects the check-in, keeps the approval time and records who and why');
select throws_ok($$ select revoke_checkin('c1000000-0000-0000-0000-000000000001', 'Dubbel') $$, '55000', null,
  'a check-in can be revoked once');
select is((select count(*)::int from approved_checkins() where id = 'c1000000-0000-0000-0000-000000000001'), 0,
  'a revoked check-in leaves the approved list');
reset role;

select is(pg_temp.rows_of('c1000000-0000-0000-0000-000000000001'), 'bonus:5:revoked,checkin:11:revoked',
  'revoking revokes the check-in and its bonus');
select is(
  (select bool_and(revoke_reason = 'checkin_revoked' and granted_at is not null and revoked_at is not null)
   from point_transactions where checkin_id = 'c1000000-0000-0000-0000-000000000001'),
  true, 'the rows say why and keep when they were granted');
select is(pg_temp.pts('11111111-1111-1111-1111-111111111111'), '(0,0)', 'revoking lowers the points');

-- ---------------------------------------------------------------------------
-- 6. Earning again reuses the rows; rows of 0 points do not exist
-- ---------------------------------------------------------------------------

create temp table c1_rows as
  select id, source from point_transactions where checkin_id = 'c1000000-0000-0000-0000-000000000001';

-- An admin puts it back in Studio: pending, then approved again.
update checkins set status = 'pending', reviewed_at = null, reviewed_by = null,
                    review_reason = null, revoked_at = null, revoked_by = null
 where id = 'c1000000-0000-0000-0000-000000000001';
select is(
  (select bool_and(status = 'pending' and granted_at is null and revoked_at is null and revoke_reason is null)
   from point_transactions where checkin_id = 'c1000000-0000-0000-0000-000000000001'),
  true, 'revoked -> pending clears the grant and the revocation');
update checkins set status = 'approved', reviewed_at = now() where id = 'c1000000-0000-0000-0000-000000000001';
select is(pg_temp.rows_of('c1000000-0000-0000-0000-000000000001'), 'bonus:5:granted,checkin:11:granted',
  'pending -> granted again');
select set_eq(
  $$ select id, source from point_transactions where checkin_id = 'c1000000-0000-0000-0000-000000000001' $$,
  $$ select id, source from c1_rows $$,
  'with the same rows');
select is(pg_temp.pts('11111111-1111-1111-1111-111111111111'), '(16,0)', 'and the points are back');

update checkins set bonus_points = 0 where id = 'c1000000-0000-0000-0000-000000000001';
select is(pg_temp.rows_of('c1000000-0000-0000-0000-000000000001'), 'checkin:11:granted', 'a bonus of 0 has no row');
select is(pg_temp.pts('11111111-1111-1111-1111-111111111111'), '(11,0)', 'and its points are gone');
update checkins set bonus_points = 5 where id = 'c1000000-0000-0000-0000-000000000001';

-- ---------------------------------------------------------------------------
-- 7. Adjustments and the guard on profile points
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
select throws_ok($$ select adjust_points('22222222-2222-2222-2222-222222222222', 0, 'x') $$, '22023', null,
  'an adjustment is not 0');
select throws_ok($$ select adjust_points('22222222-2222-2222-2222-222222222222', 20, ' ') $$, '22023', null,
  'an adjustment needs a reason');
select throws_ok($$ select adjust_points(gen_random_uuid(), 20, 'x') $$, 'P0002', null, 'an unknown user cannot be adjusted');
select is(
  (select row(source, amount, status, is_test, details->>'reason', details->>'by')::text
   from adjust_points('22222222-2222-2222-2222-222222222222', 20, 'Compensatie')),
  '(adjustment,20,granted,f,Compensatie,33333333-3333-3333-3333-333333333333)',
  'an admin adjusts bob''s points: a granted row with the reason and who did it');
reset role;
select is(pg_temp.pts('22222222-2222-2222-2222-222222222222'), '(20,0)', 'the adjustment counts');

select throws_ok($$ update profiles set points = 1000 where id = '22222222-2222-2222-2222-222222222222' $$, '42501', null,
  'profile points cannot be written directly, not even by the owner');

-- ---------------------------------------------------------------------------
-- 8. Leaderboard: this week = granted points earned this week
-- ---------------------------------------------------------------------------

-- An approved check-in of alice from last week.
insert into checkins (user_id, bin_id, photo_path, user_geom, accuracy_m, distance_m, created_at,
                      status, reviewed_at, points_earned)
select '11111111-1111-1111-1111-111111111111', b.id, 'old.jpg', 'SRID=4326;POINT(0 0)', 5, 1,
       local_week_start(now()) - interval '2 days', 'approved', now(), 12
from bins b where b.osm_id = 900000000000802;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select is((select points from leaderboard('all') where is_me), 28, 'all time: everything granted (16 + 12)');
select is((select points from leaderboard('week') where is_me), 16,
  'this week: only what was earned this week (c1 with its bonus)');
select is((select points from leaderboard('week') where display_name = 'bob'), 20, 'adjustments count in the week they are made');
reset role;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
select is((select amount from adjust_points('22222222-2222-2222-2222-222222222222', -30, 'Correctie')), -30,
  'a negative adjustment');
reset role;
select is(pg_temp.pts('22222222-2222-2222-2222-222222222222'), '(-10,0)', 'points may go below 0: the ledger is the truth');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select is((select count(*)::int from leaderboard('week') where is_me), 0, 'users below 0 are left out');
reset role;

-- ---------------------------------------------------------------------------
-- 9. Account deletion removes the ledger
-- ---------------------------------------------------------------------------

delete from auth.users where id = '22222222-2222-2222-2222-222222222222';
select is((select count(*)::int from point_transactions where user_id = '22222222-2222-2222-2222-222222222222'), 0,
  'deleting an account deletes its ledger rows');

select is_empty($$ select * from private.check_points_invariant() $$, 'every profile equals its ledger');

select * from finish();
rollback;
