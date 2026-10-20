-- The score of a check-in (private.checkin_score): steps and running totals
-- from the config, the score in record_checkin, test check-ins with only base
-- and streak, a rejection that takes the points back, and game_catalog().
-- Since phase 3 the first real check-in at a bin is a discovery (see
-- 12_discoveries); every score carries streak_extended and its ledger parts.
-- The point stage assertions of 06 moved here with checkin_point_stages.
-- Run with: npm run db:test

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(32);

-- No quests (phase 6) in this test: no quest rewards, no chest.
update quest_templates set active = false;

insert into auth.users (id, email, aud, role) values
  ('b1000000-0000-0000-0000-000000000001', 'score-user@example.test', 'authenticated', 'authenticated'),
  ('b1000000-0000-0000-0000-000000000002', 'score-admin@example.test', 'authenticated', 'authenticated');
update profiles set is_admin = true where id = 'b1000000-0000-0000-0000-000000000002';

insert into private.app_environment (name) values ('local')
on conflict (singleton) do update set name = excluded.name;

insert into bins (osm_type, osm_id, geom, status, eligible) values
  ('node', 900000000001101, 'SRID=4326;POINT(0 0)', 'active', true),
  ('node', 900000000001102, st_project('SRID=4326;POINT(0 0)'::geography, 200, radians(90)), 'active', true);

-- The running totals of a score: the base, then every streak stage.
create function pg_temp.score_stages(s jsonb) returns integer[] language sql as $$
  select array[(s #>> '{steps,0,total}')::integer] || array(
    select (x.stage->>'total')::integer
    from jsonb_array_elements(s->'steps') st(step),
      lateral jsonb_array_elements(st.step->'stages') with ordinality x(stage, i)
    where st.step->>'kind' = 'streak' order by x.i);
$$;

-- record_checkin for `who`, 5 m north of the bin, real or fake location.
create function pg_temp.checkin(who uuid, osm bigint, fake boolean default false)
returns table (ok boolean, checkin_id uuid, streak_weeks integer, score jsonb, is_test boolean)
language sql as $$
  select r.ok, r.checkin_id, r.streak_weeks, r.score, r.is_test
  from public.bins b,
    lateral public.record_checkin(gen_random_uuid(), who, b.id,
      st_y(st_project(b.geom, 5, 0)::geometry), st_x(st_project(b.geom, 5, 0)::geometry),
      5, false, fake, who::text || '/x.jpg') r
  where b.osm_id = osm;
$$;

create function pg_temp.rows_of(c uuid) returns text language sql as $$
  select string_agg(t.source || ':' || t.amount || ':' || t.status || case when t.is_test then ':test' else '' end,
                    ',' order by t.source)
  from public.point_transactions t where t.checkin_id = c;
$$;

-- ---------------------------------------------------------------------------
-- 1. Steps and running totals (the old point stages)
-- ---------------------------------------------------------------------------

select is(private.checkin_score(0),
  '{"steps": [{"kind": "base", "label": "BASIS", "chips": 10, "mult": 1, "total": 10},
              {"kind": "streak", "label": "REEKS", "weeks": 0, "per_week": 1.1, "stages": []}],
    "total": 10, "streak_extended": false, "parts": {"checkin": 10}}'::jsonb,
  'no streak: the base of 10 and an empty streak step');
select is(private.checkin_score(3),
  '{"steps": [{"kind": "base", "label": "BASIS", "chips": 10, "mult": 1, "total": 10},
              {"kind": "streak", "label": "REEKS", "weeks": 3, "per_week": 1.1,
               "stages": [{"mult": 1.1, "total": 11}, {"mult": 1.21, "total": 12}, {"mult": 1.331, "total": 13}]}],
    "total": 13, "streak_extended": false, "parts": {"checkin": 13}}'::jsonb,
  'three weeks: one stage per week, each with its multiplier and running total');
select is(pg_temp.score_stages(private.checkin_score(0)), array[10], 'no streak: only the base of 10 points');
select is(pg_temp.score_stages(private.checkin_score(1)), array[10, 11], 'one streak week: one x1.1 stage');
select is(pg_temp.score_stages(private.checkin_score(2)), array[10, 11, 12], 'two streak weeks: x1.1 and x1.1 again');
select is(pg_temp.score_stages(private.checkin_score(8)), array[10, 11, 12, 13, 15, 16, 18, 19, 21],
  'eight weeks: round(10 * 1.1^k) for k = 0..8');
select is(private.checkin_score(30)->'steps'->1->'stages', private.checkin_score(8)->'steps'->1->'stages',
  'the multiplier is capped at 8 stages');
select is((select row(s->'steps'->1->>'weeks', s->>'total')::text from (select private.checkin_score(30) s) x), '(30,21)',
  'a capped streak keeps its whole length in weeks (the app shows the maximum)');
select is(private.checkin_score(-1), private.checkin_score(0), 'a negative streak counts as none');
select is(private.checkin_score(null), private.checkin_score(0), 'no streak at all counts as none');
select is(
  (select array_agg((x.stage->>'mult')::numeric order by x.i)
   from jsonb_array_elements(private.checkin_score(8)->'steps'->1->'stages') with ordinality x(stage, i)),
  array[1.1, 1.21, 1.331, 1.4641, 1.61051, 1.771561, 1.9487171, 2.14358881]::numeric[],
  'every stage carries its exact combined multiplier (the app rounds it for display)');
select is_empty($$
  select w, s.step from generate_series(0, 12) w,
    lateral jsonb_array_elements(private.checkin_score(w)->'steps') s(step)
  where coalesce(s.step->>'kind', '') = '' or coalesce(s.step->>'label', '') = ''
$$, 'every step has a kind and a label');
select is_empty($$
  select w from generate_series(0, 12) w
  where (private.checkin_score(w)->>'total')::integer
        <> (pg_temp.score_stages(private.checkin_score(w)))[array_length(pg_temp.score_stages(private.checkin_score(w)), 1)]
$$, 'the total is always the last running total');

-- ---------------------------------------------------------------------------
-- 2. The numbers come from the config
-- ---------------------------------------------------------------------------

update game_config set value = '12' where key = 'checkin_base_chips';
update game_config set value = '1.2' where key = 'streak_multiplier';
update game_config set value = '2' where key = 'streak_max_steps';

select is(private.checkin_score(5),
  '{"steps": [{"kind": "base", "label": "BASIS", "chips": 12, "mult": 1, "total": 12},
              {"kind": "streak", "label": "REEKS", "weeks": 5, "per_week": 1.2,
               "stages": [{"mult": 1.2, "total": 14}, {"mult": 1.44, "total": 17}]}],
    "total": 17, "streak_extended": false, "parts": {"checkin": 17}}'::jsonb,
  'base, multiplier and maximum from the config: 12, x1.2, two stages');
update game_config set value = '0' where key = 'streak_max_steps';
select is(pg_temp.score_stages(private.checkin_score(5)), array[12], 'a maximum of 0 steps: the streak multiplies nothing');

update game_config set value = '10' where key = 'checkin_base_chips';
update game_config set value = '1.1' where key = 'streak_multiplier';
update game_config set value = '8' where key = 'streak_max_steps';

-- ---------------------------------------------------------------------------
-- 3. record_checkin returns the score
-- ---------------------------------------------------------------------------

select hasnt_function('public', 'checkin_point_stages', array['integer'], 'checkin_point_stages is gone');
select is(
  (select 'score' = any (p.proargnames) from pg_proc p
   where p.oid = 'public.record_checkin(uuid, uuid, bigint, double precision, double precision, real, boolean, boolean, text)'::regprocedure),
  true, 'record_checkin has a score column');
select is(
  (select array['point_stages', 'points_total'] && p.proargnames from pg_proc p
   where p.oid = 'public.record_checkin(uuid, uuid, bigint, double precision, double precision, real, boolean, boolean, text)'::regprocedure),
  false, 'and no longer point_stages or points_total');

create temp table r1 as select * from pg_temp.checkin('b1000000-0000-0000-0000-000000000001', 900000000001101);
select set_config('test.r1', (select checkin_id::text from r1), true);
select is((select row(ok, streak_weeks, is_test)::text from r1), '(t,1,f)', 'a first real check-in: a streak of 1 week');
select is((select score from r1), private.checkin_score(1, true, true),
  'its score is checkin_score of its streak, with the discovery and the first check-in of the week');
select is(
  (select row(c.points_earned, pg_temp.rows_of(c.id))::text from checkins c where c.id = current_setting('test.r1')::uuid),
  '(17,"checkin:11:pending,discovery:6:pending")',
  'the check-in stores the score''s total (15 x1.1); the ledger has it pending, split into check-in and discovery');

-- A test check-in (admin on local, streak override): base and streak only,
-- test points only.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
select set_dev_streak_override(3);
reset role;
create temp table t1 as select * from pg_temp.checkin('b1000000-0000-0000-0000-000000000002', 900000000001102, true);
select set_config('test.t1', (select checkin_id::text from t1), true);
select is((select row(ok, streak_weeks, is_test)::text from t1), '(t,3,t)', 'a test check-in uses the override');
select is((select score from t1), private.checkin_score(3), 'and gets the score of that streak');
select is(
  (select array_agg(s.step->>'kind' order by s.i) from t1, jsonb_array_elements(t1.score->'steps') with ordinality s(step, i)),
  array['base', 'streak'], 'a test check-in has only the steps base and streak');
select is(pg_temp.rows_of((select checkin_id from t1)), 'checkin:13:pending:test', 'its points are a pending test row');

-- A rejection takes the points back.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
select review_checkin(current_setting('test.r1')::uuid, false, 'Foto onduidelijk');
select review_checkin(current_setting('test.t1')::uuid, false);
reset role;
select is(pg_temp.rows_of(current_setting('test.r1')::uuid), 'checkin:11:revoked,discovery:6:revoked',
  'a rejection revokes the check-in''s points');
select is(pg_temp.rows_of((select checkin_id from t1)), 'checkin:13:revoked:test', 'also for a test check-in');
select is((select row(points, test_points)::text from profiles where id = 'b1000000-0000-0000-0000-000000000001'), '(0,0)',
  'nothing counts after the rejection');

-- ---------------------------------------------------------------------------
-- 4. game_catalog and who may call what
-- ---------------------------------------------------------------------------

update game_config set value = '1.15' where key = 'streak_multiplier';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select is(game_catalog()->'config',
  '{"checkin_base_chips": 10, "streak_multiplier": 1.15, "streak_max_steps": 8, "bonus_question_points": 5,
    "discovery_chips": 5, "region_west": 3.708015, "region_south": 51.044642, "region_east": 3.725743,
    "region_north": 51.059883, "max_freezes": 2, "chest_open_days": 7}'::jsonb,
  'game_catalog gives signed-in users every number of the config, as it is now');
select throws_ok($$ select private.checkin_score(1) $$, '42501', null, 'users cannot call checkin_score');
reset role;
update game_config set value = '1.1' where key = 'streak_multiplier';

set local role anon;
select throws_ok($$ select game_catalog() $$, '42501', null, 'anon cannot read the catalog');
reset role;

select is_empty($$ select * from private.check_points_invariant() $$, 'every profile equals its ledger');

select * from finish();
rollback;
