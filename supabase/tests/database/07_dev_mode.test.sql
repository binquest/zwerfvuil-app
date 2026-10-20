-- Dev mode: admin only, own account only, local/staging only, test data kept
-- apart, every action audited. Run with: npm run db:test

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(63);

-- No quests (phase 6) in this test: no quest rewards, no chest.
update quest_templates set active = false;

-- The economy before phase 3: no discovery chips, so the points below stay
-- as they were (12_discoveries covers discoveries).
update game_config set value = '0' where key = 'discovery_chips';

-- ---------------------------------------------------------------------------
-- Fixtures (as postgres): alice (user), admin A (me), admin B (another admin)
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.test', 'authenticated', 'authenticated'),
  ('33333333-3333-3333-3333-333333333333', 'admina@example.test', 'authenticated', 'authenticated'),
  ('77777777-7777-7777-7777-777777777777', 'adminb@example.test', 'authenticated', 'authenticated');
-- A name for every test account: since phase 4 a new account gets none from
-- its e-mail address (the onboarding asks for one).
update profiles p set display_name = split_part(u.email, '@', 1)
from auth.users u where u.id = p.id and u.email like '%@example.test' and p.display_name is null;
update profiles set is_admin = true
 where id in ('33333333-3333-3333-3333-333333333333', '77777777-7777-7777-7777-777777777777');

insert into private.app_environment (name) values ('staging')
on conflict (singleton) do update set name = excluded.name;

insert into bins (osm_type, osm_id, geom, status, eligible) values
  ('node', 900000000000701, 'SRID=4326;POINT(0 0)', 'active', true),
  ('node', 900000000000702, st_project('SRID=4326;POINT(0 0)'::geography, 200, radians(90)), 'active', true),
  ('node', 900000000000703, st_project('SRID=4326;POINT(0 0)'::geography, 400, radians(90)), 'active', true),
  ('node', 900000000000704, st_project('SRID=4326;POINT(0 0)'::geography, 600, radians(90)), 'active', true);

-- The running totals of a score: the base, then every streak stage (what
-- record_checkin returned as point_stages before phase 2).
create function pg_temp.score_stages(s jsonb) returns integer[] language sql as $$
  select array[(s #>> '{steps,0,total}')::integer] || array(
    select (x.stage->>'total')::integer
    from jsonb_array_elements(s->'steps') st(step),
      lateral jsonb_array_elements(st.step->'stages') with ordinality x(stage, i)
    where st.step->>'kind' = 'streak' order by x.i);
$$;

-- record_checkin for `who`, 5 m north of the bin, real or fake location.
create function pg_temp.checkin(who uuid, osm bigint, fake boolean)
returns table (ok boolean, reason text, checkin_id uuid, streak_weeks integer, point_stages integer[],
               points_total integer, is_test boolean)
language sql as $$
  select r.ok, r.reason, r.checkin_id, r.streak_weeks, pg_temp.score_stages(r.score),
         (r.score->>'total')::integer, r.is_test
  from public.bins b,
    lateral public.record_checkin(gen_random_uuid(), who, b.id,
      st_y(st_project(b.geom, 5, 0)::geometry), st_x(st_project(b.geom, 5, 0)::geometry),
      5, false, fake, who::text || '/' || gen_random_uuid()::text || '.jpg') r
  where b.osm_id = osm;
$$;

create function pg_temp.alice() returns uuid language sql as $$ select '11111111-1111-1111-1111-111111111111'::uuid $$;
create function pg_temp.me() returns uuid language sql as $$ select '33333333-3333-3333-3333-333333333333'::uuid $$;
create function pg_temp.other_admin() returns uuid language sql as $$ select '77777777-7777-7777-7777-777777777777'::uuid $$;

-- Answers the bonus question of a check-in as its owner, 3 s after showing it.
create function pg_temp.answer(id uuid) returns integer language plpgsql as $$
declare
  owner uuid;
  first_option text;
  points integer;
begin
  select a.user_id, q.options->0->>'key' into owner, first_option
  from public.bonus_answers a join public.bonus_questions q on q.key = a.question_key
  where a.checkin_id = id;
  update public.bonus_answers set shown_at = clock_timestamp() - interval '3 seconds' where checkin_id = id;
  perform set_config('request.jwt.claims', json_build_object('sub', owner, 'role', 'authenticated')::text, true);
  set local role authenticated;
  points := public.answer_bonus_question(id, first_option);
  reset role;
  return points;
end;
$$;

-- ---------------------------------------------------------------------------
-- A user who is not an admin is refused for every Dev mode action
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select is((select row(allowed, environment)::text from dev_mode_status()), '(f,)',
  'users: dev_mode_status says no and reveals nothing');
select is(dev_mode_allowed(), false, 'users: Dev mode is not allowed');
select throws_ok($$ select set_dev_streak_override(3) $$, '42501', null, 'users: no streak override');
select throws_ok($$ select * from reset_dev_test_data() $$, '42501', null, 'users: no reset');
select throws_ok($$ select * from leaderboard('all', 50, true) $$, '42501', null, 'users: no leaderboard with test data');
select is((select count(*)::int from dev_audit_log), 0, 'users cannot read the audit log');
select throws_ok($$ select * from dev_settings $$, '42501', null, 'users cannot read Dev mode settings');
select throws_ok($$ select * from streak_weeks(auth.uid(), current_date, true) $$, '42501', null,
  'users cannot compute streaks with test data');
reset role;
select is((select reason from pg_temp.checkin(pg_temp.alice(), 900000000000701, true)), 'fake_location_not_allowed',
  'users: a fake location is refused by the database');

-- ---------------------------------------------------------------------------
-- An admin on staging: override, test check-ins, test points
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
select is((select row(allowed, environment, streak_override, test_points, test_checkins)::text from dev_mode_status()),
  '(t,staging,,0,0)', 'admin on staging: Dev mode is available, nothing set yet');
select is(set_dev_streak_override(3), 3, 'admin: sets a streak override of 3 weeks');
select throws_ok($$ select set_dev_streak_override(53) $$, '22023', null, 'the override is at most 52 weeks');
reset role;

create temp table ta1 as select * from pg_temp.checkin(pg_temp.me(), 900000000000701, false);
create temp table ta2 as select * from pg_temp.checkin(pg_temp.me(), 900000000000702, true);
select set_config('test.ta1', (select checkin_id::text from ta1), true);
select set_config('test.ta2', (select checkin_id::text from ta2), true);

select is((select row(ok, is_test, streak_weeks, point_stages)::text from ta1), '(t,t,3,"{10,11,12,13}")',
  'with the override, a check-in at a real location is a test check-in with a 3-week streak');
select is((select row(ok, is_test, streak_weeks, points_total)::text from ta2), '(t,t,3,13)',
  'a fake location is a test check-in too');
select is((select bool_and(is_test) from bonus_answers where checkin_id in (select checkin_id from ta1 union select checkin_id from ta2)),
  true, 'the bonus answers of test check-ins are flagged as test');
select is(pg_temp.answer(current_setting('test.ta1')::uuid), 5, 'the bonus question of a test check-in can be answered');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
select is((select r.status from review_checkin(current_setting('test.ta1')::uuid, true) r), 'approved',
  'an admin approves a test check-in');
reset role;
select is(
  (select string_agg(source || ':' || amount || ':' || status || ':' || is_test, ',' order by source)
   from point_transactions where checkin_id = current_setting('test.ta1')::uuid),
  'bonus:5:granted:true,checkin:13:granted:true', 'its points (13 + 5) are granted as test rows in the ledger');
select is((select row(points, test_points)::text from profiles where id = pg_temp.me()), '(0,18)',
  'test points go to test_points, never to points');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
select is((select row(weeks, this_week)::text from my_streak()), '(0,f)', 'the real streak ignores test check-ins');
select is(set_dev_streak_override(null), null, 'admin: clears the override');
reset role;

-- A real check-in now: real streak (only this week), real points.
create temp table ra1 as select * from pg_temp.checkin(pg_temp.me(), 900000000000703, false);
select set_config('test.ra1', (select checkin_id::text from ra1), true);
select is((select row(ok, is_test, streak_weeks, points_total)::text from ra1), '(t,f,1,11)',
  'without override or fake location the check-in is real, with the real streak');
select is(pg_temp.answer(current_setting('test.ra1')::uuid), 5, 'and its bonus question is answered');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
select is((select r.status from review_checkin(current_setting('test.ra1')::uuid, true) r), 'approved',
  'the real check-in is approved (11 + 5)');
reset role;
select is((select row(points, test_points)::text from profiles where id = pg_temp.me()), '(16,18)',
  'real and test points are kept apart');

-- ---------------------------------------------------------------------------
-- Test data stays out of the leaderboard and the bin-need data
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
select is((select points from leaderboard('all') where is_me), 16, 'leaderboard, all time: only real points');
select is((select points from leaderboard('week') where is_me), 16, 'leaderboard, this week: only real check-ins');
select is((select points from leaderboard('all', 50, true) where is_me), 34, 'with test data (Dev mode): 16 + 18');
select is((select points from leaderboard('week', 50, true) where is_me), 34, 'this week with test data: 16 + 18');
select is((select array_agg(checkin_id) from bin_need_answers where checkin_id in (current_setting('test.ta1')::uuid, current_setting('test.ra1')::uuid)),
  array[current_setting('test.ra1')::uuid], 'bin_need_answers has the real answer, not the test answer');
select is((select is_test from pending_checkins() where id = current_setting('test.ta2')::uuid), true,
  'the admin queue marks test check-ins');
reset role;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select is((select points from leaderboard('all') where display_name = 'admina'), 16,
  'other users see only the real points too');
select is((select count(*)::int from bin_need_answers), 0, 'users cannot read the bin-need data');
reset role;

-- ---------------------------------------------------------------------------
-- Refused in production (and old overrides are ignored there)
-- ---------------------------------------------------------------------------

update private.app_environment set name = 'production';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
select is((select allowed from dev_mode_status()), false, 'production: Dev mode is not available to admins');
select throws_ok($$ select set_dev_streak_override(2) $$, '42501', null, 'production: no streak override');
select throws_ok($$ select * from reset_dev_test_data() $$, '42501', null, 'production: no reset');
select throws_ok($$ select * from leaderboard('all', 50, true) $$, '42501', null, 'production: no test data in the leaderboard');
reset role;
select is((select reason from pg_temp.checkin(pg_temp.me(), 900000000000704, true)), 'fake_location_not_allowed',
  'production: an admin''s fake location is refused');
update dev_settings set streak_override = 5 where user_id = pg_temp.me();
select is((select row(ok, is_test, streak_weeks)::text from pg_temp.checkin(pg_temp.me(), 900000000000704, false)), '(t,f,1)',
  'production: a stored override is ignored, the check-in is real');
update private.app_environment set name = 'staging';

-- ---------------------------------------------------------------------------
-- Reset removes only my own test data
-- ---------------------------------------------------------------------------

-- Admin B's test data and alice's real check-in must survive my reset.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"77777777-7777-7777-7777-777777777777","role":"authenticated"}', true);
select is(set_dev_streak_override(2), 2, 'admin B sets an override');
reset role;
select is((select is_test from pg_temp.checkin(pg_temp.other_admin(), 900000000000701, true)), true,
  'admin B makes a test check-in');
select is((select is_test from pg_temp.checkin(pg_temp.alice(), 900000000000702, false)), false,
  'alice makes a real check-in');

create temp table before_reset as
  select (select count(*) from checkins where user_id = pg_temp.other_admin() and is_test) as b_test,
         (select count(*) from checkins where user_id = pg_temp.alice()) as alice_all,
         (select count(*) from checkins where user_id = pg_temp.me() and not is_test) as my_real;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
create temp table reset_result as select * from reset_dev_test_data();
reset role;

select is((select deleted_checkins from reset_result), 2, 'reset removes my two test check-ins');
select is((select cardinality(photo_paths) from reset_result), 2, 'and returns their photo paths for the app to delete');
select is((select count(*)::int from checkins where user_id = pg_temp.me() and is_test), 0, 'none of my test check-ins remain');
select is((select count(*)::int from checkins where user_id = pg_temp.me() and not is_test), (select my_real::int from before_reset),
  'my real check-ins remain');
select is((select count(*)::int from bonus_answers where checkin_id in (current_setting('test.ta1')::uuid, current_setting('test.ta2')::uuid)), 0,
  'the bonus answers of my test check-ins are gone');
select is((select count(*)::int from bonus_answers where checkin_id = current_setting('test.ra1')::uuid), 1,
  'the bonus answer of my real check-in remains');
select is((select row(points, test_points)::text from profiles where id = pg_temp.me()), '(16,0)',
  'my test points are 0, my real points are untouched');
select is((select count(*)::int from point_transactions where user_id = pg_temp.me() and is_test), 0,
  'my test rows are gone from the ledger');
select is((select count(*)::int from dev_settings where user_id = pg_temp.me()), 0, 'my override is cleared');
select is((select count(*)::int from checkins where user_id = pg_temp.other_admin() and is_test), (select b_test::int from before_reset),
  'admin B''s test check-ins remain');
select is((select streak_override from dev_settings where user_id = pg_temp.other_admin()), 2, 'admin B''s override remains');
select is((select count(*)::int from checkins where user_id = pg_temp.alice()), (select alice_all::int from before_reset),
  'alice''s check-ins remain');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
select is((select points from leaderboard('all', 50, true) where is_me), 16, 'after the reset my test points are gone from the leaderboard');
reset role;

-- ---------------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------------

select is(
  (select array_agg(action order by id) from dev_audit_log where user_id = pg_temp.me()),
  array['streak_override', 'test_checkin', 'test_checkin', 'streak_override', 'reset'],
  'every Dev mode action of mine is logged, in order');
select is(
  (select row(details->>'deleted_checkins', environment)::text from dev_audit_log where user_id = pg_temp.me() and action = 'reset'),
  '(2,staging)', 'the reset entry records what it removed and where');
select is(
  (select details->>'fake_location' from dev_audit_log
    where user_id = pg_temp.me() and action = 'test_checkin' and details->>'checkin_id' = current_setting('test.ta2')),
  'true', 'a fake check-in is logged as such');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
select ok((select count(*) >= 5 from dev_audit_log), 'admins can read the audit log');
select throws_ok($$ insert into dev_audit_log (user_id, action) values (auth.uid(), 'reset') $$, '42501', null,
  'nobody writes the audit log directly');
select throws_ok($$ update profiles set test_points = 100 where id = auth.uid() $$, '42501', null,
  'test points cannot be set directly');
reset role;

select throws_ok($$ update profiles set test_points = 100 where id = pg_temp.me() $$, '42501', null,
  'not even by the database owner: points follow the ledger');
select is_empty($$ select * from private.check_points_invariant() $$, 'every profile equals its ledger');

select * from finish();
rollback;
