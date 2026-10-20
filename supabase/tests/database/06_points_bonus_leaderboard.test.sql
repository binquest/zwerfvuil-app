-- Streak points, bonus questions, my_streak and the leaderboard.
-- Run with: npm run db:test

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(48);

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
  ('22222222-2222-2222-2222-222222222222', 'bob@example.test', 'authenticated', 'authenticated'),
  ('33333333-3333-3333-3333-333333333333', 'admin@example.test', 'authenticated', 'authenticated'),
  ('55555555-5555-5555-5555-555555555555', 'carol@example.test', 'authenticated', 'authenticated');
-- A name for every test account: since phase 4 a new account gets none from
-- its e-mail address (the onboarding asks for one).
update profiles p set display_name = split_part(u.email, '@', 1)
from auth.users u where u.id = p.id and u.email like '%@example.test' and p.display_name is null;
update profiles set is_admin = true where id = '33333333-3333-3333-3333-333333333333';

-- Bins around Null Island, far away from imported data.
insert into bins (osm_type, osm_id, geom, status, eligible) values
  ('node', 900000000000601, 'SRID=4326;POINT(0 0)', 'active', true),
  ('node', 900000000000602, st_project('SRID=4326;POINT(0 0)'::geography, 200, radians(90)), 'active', true),
  ('node', 900000000000603, st_project('SRID=4326;POINT(0 0)'::geography, 400, radians(90)), 'active', true);

create function pg_temp.bin(osm bigint) returns bigint language sql as $$
  select id from public.bins where osm_id = osm;
$$;

-- The running totals of a score: the base, then every streak stage (what
-- record_checkin returned as point_stages before phase 2).
create function pg_temp.score_stages(s jsonb) returns integer[] language sql as $$
  select array[(s #>> '{steps,0,total}')::integer] || array(
    select (x.stage->>'total')::integer
    from jsonb_array_elements(s->'steps') st(step),
      lateral jsonb_array_elements(st.step->'stages') with ordinality x(stage, i)
    where st.step->>'kind' = 'streak' order by x.i);
$$;

-- record_checkin for `who`, 5 m north of the bin.
create function pg_temp.checkin(who uuid, osm bigint)
returns table (ok boolean, reason text, checkin_id uuid, distance_m double precision, retry_after_s integer,
               streak_weeks integer, point_stages integer[], points_total integer, bonus_question jsonb)
language sql as $$
  select r.ok, r.reason, r.checkin_id, r.distance_m, r.retry_after_s, r.streak_weeks, pg_temp.score_stages(r.score),
         (r.score->>'total')::integer, r.bonus_question
  from public.bins b,
    lateral public.record_checkin(gen_random_uuid(), who, b.id,
      st_y(st_project(b.geom, 5, 0)::geometry), st_x(st_project(b.geom, 5, 0)::geometry),
      5, false, false, who::text || '/x.jpg') r
  where b.osm_id = osm;
$$;

-- Monday noon (Gent) `weeks_ago` weeks before this week.
create function pg_temp.week_noon(weeks_ago integer) returns timestamptz language sql as $$
  select ((date_trunc('week', now() at time zone 'Europe/Brussels')::date - weeks_ago * 7) + time '12:00')
         at time zone 'Europe/Brussels';
$$;

create function pg_temp.this_week() returns date language sql as $$
  select date_trunc('week', now() at time zone 'Europe/Brussels')::date;
$$;

-- Carol's history: last week and the week before, the week before that only a
-- rejected check-in, and one more four weeks ago.
insert into checkins (user_id, bin_id, photo_path, user_geom, accuracy_m, distance_m, created_at, status, reviewed_at)
select '55555555-5555-5555-5555-555555555555', pg_temp.bin(900000000000602), 'h.jpg', 'SRID=4326;POINT(0 0)', 5, 1,
       pg_temp.week_noon(w), s, case when s = 'pending' then null else now() end
from (values (1, 'pending'), (2, 'approved'), (3, 'rejected'), (4, 'pending')) v(w, s);

-- Noise: another user's activity, as in a dev database with real data.
insert into auth.users (id, email, aud, role) values
  ('44444444-4444-4444-4444-444444444444', 'noise@example.test', 'authenticated', 'authenticated');
insert into checkins (user_id, bin_id, photo_path, user_geom, accuracy_m, distance_m)
select '44444444-4444-4444-4444-444444444444', pg_temp.bin(900000000000601), '44444444-4444-4444-4444-444444444444/c.jpg',
       'SRID=4326;POINT(0 0)', 5, 1
from generate_series(1, 3);

-- ---------------------------------------------------------------------------
-- Streaks
-- ---------------------------------------------------------------------------

select is(streak_weeks('55555555-5555-5555-5555-555555555555', pg_temp.this_week()), 0,
  'no check-in this week: no streak ending this week');
select is(streak_weeks('55555555-5555-5555-5555-555555555555', pg_temp.this_week() - 7), 2,
  'a rejected-only week breaks the streak');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated"}', true);
select is((select row(weeks, this_week)::text from my_streak()), '(2,f)',
  'my_streak keeps last week''s streak alive this week');
select throws_ok($$ select streak_weeks(auth.uid(), current_date) $$, '42501', null,
  'users cannot call streak_weeks for anyone');
reset role;

create temp table rc as select * from pg_temp.checkin('55555555-5555-5555-5555-555555555555', 900000000000601);
select set_config('test.rc', (select checkin_id::text from rc), true);
select is(
  (select row(ok, streak_weeks, point_stages, points_total)::text from rc),
  '(t,3,"{10,11,12,13}",13)',
  'a check-in this week extends the streak to 3 weeks: three x1.1 stages');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated"}', true);
select is((select row(weeks, this_week)::text from my_streak()), '(3,t)', 'my_streak counts this week');
reset role;

-- ---------------------------------------------------------------------------
-- record_checkin: points and the bonus question
-- ---------------------------------------------------------------------------

create temp table r1 as select * from pg_temp.checkin('11111111-1111-1111-1111-111111111111', 900000000000601);
create temp table r2 as select * from pg_temp.checkin('11111111-1111-1111-1111-111111111111', 900000000000602);
create temp table r3 as select * from pg_temp.checkin('11111111-1111-1111-1111-111111111111', 900000000000603);
create temp table rb as select * from pg_temp.checkin('22222222-2222-2222-2222-222222222222', 900000000000601);
select set_config('test.r1', (select checkin_id::text from r1), true);
select set_config('test.r2', (select checkin_id::text from r2), true);
select set_config('test.r3', (select checkin_id::text from r3), true);
select set_config('test.rb', (select checkin_id::text from rb), true);

select is((select row(ok, streak_weeks, point_stages, points_total)::text from r1), '(t,1,"{10,11}",11)',
  'a first check-in: streak of 1 week, 11 points');
select is(
  (select row(c.streak_weeks, c.points_earned, c.bonus_points, c.status,
              (select string_agg(t.source || ':' || t.amount || ':' || t.status, ',')
               from point_transactions t where t.checkin_id = c.id))::text
   from checkins c join r1 on r1.checkin_id = c.id),
  '(1,11,0,pending,checkin:11:pending)',
  'the check-in stores its streak and earned points; the ledger has them pending');
select is((select bonus_question->>'key' from r1), 'bin_fullness', 'the first bonus question is the first in order');
select is((select bonus_question->>'prompt' from r1), 'Hoe vol zat de vuilbak?', 'the question comes with its prompt');
select is((select jsonb_array_length(bonus_question->'options') from r1), 3, 'and its three options');
select is((select array[r2.bonus_question->>'key', r3.bonus_question->>'key'] from r2, r3),
  array['find_ease', 'walk_distance'], 'the next check-ins rotate to the questions not offered yet');
select is((select bonus_question->>'key' from rb), 'bin_fullness', 'rotation is per user');
select ok(
  (select a.bin_id = pg_temp.bin(900000000000601)
          and st_distance(a.user_geom, st_project(b.geom, 5, 0)) < 0.01
          and a.offered_at is not null and a.shown_at is null and a.answered_at is null
   from bonus_answers a join r1 on r1.checkin_id = a.checkin_id join bins b on b.id = a.bin_id),
  'the offer stores the bin, the user''s location and the time');

-- ---------------------------------------------------------------------------
-- Who can see answers
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select is((select count(*)::int from bonus_answers), 0, 'users cannot read bonus answers, not even their own');
select throws_ok($$ select * from bonus_questions $$, '42501', null, 'users cannot read the question table directly');
reset role;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
select ok((select count(*) >= 5 from bonus_answers), 'admins can read the answers');
reset role;

-- ---------------------------------------------------------------------------
-- Answering
-- ---------------------------------------------------------------------------

-- Bob cannot touch alice's question.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select lives_ok($$ select mark_bonus_question_shown(current_setting('test.r1')::uuid) $$, 'marking someone else''s question is a no-op');
select throws_ok($$ select answer_bonus_question(current_setting('test.r1')::uuid, 'full') $$, 'P0002', null,
  'users cannot answer someone else''s question');
reset role;
select is((select shown_at from bonus_answers a join r1 using (checkin_id)), null, 'bob did not mark it shown');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select lives_ok($$ select mark_bonus_question_shown(current_setting('test.r1')::uuid) $$, 'alice marks her question shown');
reset role;
select isnt((select shown_at from bonus_answers a join r1 using (checkin_id)), null, 'shown_at is set');

-- Answered 3 seconds after it appeared.
update bonus_answers set shown_at = clock_timestamp() - interval '3 seconds' where checkin_id = current_setting('test.r1')::uuid;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select throws_ok($$ select answer_bonus_question(current_setting('test.r1')::uuid, 'overflowing') $$, '22023', null,
  'only the options of the question are accepted');
select is(answer_bonus_question(current_setting('test.r1')::uuid, 'full'), 5, 'a valid answer earns 5 points');
select throws_ok($$ select answer_bonus_question(current_setting('test.r1')::uuid, 'half') $$, '55000', null,
  'a question can only be answered once');
reset role;
select is(
  (select row(a.answer_key, a.is_suspicious, a.response_ms >= 3000)::text from bonus_answers a join r1 using (checkin_id)),
  '(full,f,t)', 'the answer is stored with its response time, not flagged');
select is((select bonus_points from checkins c join r1 on r1.checkin_id = c.id), 5, 'the check-in carries the bonus');

-- Answered right after it appeared, and answered without ever being shown.
update bonus_answers set shown_at = clock_timestamp() where checkin_id = current_setting('test.r2')::uuid;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select is(answer_bonus_question(current_setting('test.r2')::uuid, 'some'), 5, 'a fast answer still earns the bonus');
reset role;
select is((select is_suspicious from bonus_answers a join r2 using (checkin_id)), true,
  'an answer within 1.2 s is flagged');

-- ---------------------------------------------------------------------------
-- Points on approval, late answers, rejected and expired check-ins
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
select is((select r.status from review_checkin(current_setting('test.r1')::uuid, true) r), 'approved',
  'admins approve a check-in with an answered bonus question');
select is((select r.status from review_checkin(current_setting('test.r3')::uuid, true) r), 'approved',
  'and one whose question is still open');
select is((select status from review_checkin(current_setting('test.rb')::uuid, false)), 'rejected', 'bob''s check-in is rejected');
select is(
  (select row(p.points_earned, p.bonus_points, p.bonus_suspicious)::text from pending_checkins() p
   where p.id = current_setting('test.r2')::uuid),
  '(11,5,t)', 'the admin queue shows the points and the suspicious flag');
select is((select sum(amount)::int from point_transactions
           where checkin_id = current_setting('test.r1')::uuid and status = 'granted'), 16,
  'approval grants the earned points plus the bonus (11 + 5)');
select is((select sum(amount)::int from point_transactions
           where checkin_id = current_setting('test.r3')::uuid and status = 'granted'), 11,
  'approval before the answer grants the earned points');
reset role;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select is(answer_bonus_question(current_setting('test.r3')::uuid, 'lt50'), 5, 'a question can be answered after approval');
reset role;
select is((select sum(t.amount)::int from point_transactions t join r3 using (checkin_id) where t.status = 'granted'), 16,
  'answering after approval grants the bonus right away');
select is((select is_suspicious from bonus_answers a join r3 using (checkin_id)), true,
  'an answer never marked shown is flagged');
select is((select points from profiles where id = '11111111-1111-1111-1111-111111111111'), 32,
  'alice''s profile has both approved check-ins with their bonuses');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select throws_ok($$ select answer_bonus_question(current_setting('test.rb')::uuid, 'full') $$, '55000', null,
  'the question of a rejected check-in cannot be answered');
reset role;

update bonus_answers set offered_at = now() - interval '2 hours'
 where user_id = '55555555-5555-5555-5555-555555555555';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated"}', true);
select throws_ok($$ select answer_bonus_question(current_setting('test.rc')::uuid, 'full') $$, '55000', null,
  'a question older than an hour has expired');
reset role;

-- ---------------------------------------------------------------------------
-- Leaderboard
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select is((select row(display_name, points)::text from leaderboard('all') where is_me), '(alice,32)',
  'all time: alice sees her own row by display name');
select is((select row(display_name, points)::text from leaderboard('week') where is_me), '(alice,32)',
  'this week: the approved points of this week''s check-ins');
select is((select count(*)::int from leaderboard('all') where display_name = 'bob'), 0,
  'users without points are left out');
select ok((select count(*) <= 2 and bool_or(is_me) from leaderboard('all', 1)),
  'max_rows limits the list but always includes the caller');
select throws_ok($$ select * from leaderboard('month') $$, '22023', null, 'only week and all are valid periods');
reset role;

set local role anon;
select throws_ok($$ select * from leaderboard('all') $$, '42501', null, 'anon cannot see the leaderboard');
reset role;

select is_empty($$ select * from private.check_points_invariant() $$, 'every profile equals its ledger');

select * from finish();
rollback;
