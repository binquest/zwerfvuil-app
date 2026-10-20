-- Game config: the values of the old constants, the validation of every
-- write, the points that follow the config, and who can read or write it.
-- Run with: npm run db:test

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(40);

-- No quests (phase 6) in this test: no quest rewards, no chest.
update quest_templates set active = false;

-- The economy before phase 3: no discovery chips, so the points below stay
-- as they were (12_discoveries covers discoveries).
update game_config set value = '0' where key = 'discovery_chips';

insert into auth.users (id, email, aud, role) values
  ('91000000-0000-0000-0000-000000000001', 'cfg-user@example.test', 'authenticated', 'authenticated'),
  ('91000000-0000-0000-0000-000000000002', 'cfg-admin@example.test', 'authenticated', 'authenticated');
update profiles set is_admin = true where id = '91000000-0000-0000-0000-000000000002';

insert into private.app_environment (name) values ('local')
on conflict (singleton) do update set name = excluded.name;

insert into bins (osm_type, osm_id, geom, status, eligible) values
  ('node', 900000000000901, 'SRID=4326;POINT(0 0)', 'active', true),
  ('node', 900000000000902, st_project('SRID=4326;POINT(0 0)'::geography, 200, radians(90)), 'active', true),
  ('node', 900000000000903, st_project('SRID=4326;POINT(0 0)'::geography, 400, radians(90)), 'active', true);

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
create function pg_temp.checkin(who uuid, osm bigint, fake boolean default false)
returns table (ok boolean, checkin_id uuid, point_stages integer[], points_total integer, bonus_question jsonb,
               is_test boolean)
language sql as $$
  select r.ok, r.checkin_id, pg_temp.score_stages(r.score), (r.score->>'total')::integer, r.bonus_question,
         r.is_test
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
-- 1. The values of the old constants
-- ---------------------------------------------------------------------------

select is(
  (select jsonb_object_agg(c.key, c.value) from game_config c
   where c.key in ('checkin_base_chips', 'streak_multiplier', 'streak_max_steps', 'bonus_question_points')),
  '{"checkin_base_chips": 10, "streak_multiplier": 1.1, "streak_max_steps": 8, "bonus_question_points": 5}'::jsonb,
  'game_config holds the old constants: base 10, x1.1 per week, at most 8 steps, bonus 5');
select is_empty($$ select c.key from game_config c where not exists (
  select 1 from private.game_config_rules r where r.key = c.key) $$, 'every key has a rule');
select is_empty($$ select r.key from private.game_config_rules r where not exists (
  select 1 from game_config c where c.key = r.key) $$, 'every rule has a value');
select is(private.cfg('streak_multiplier'), '1.1'::jsonb, 'private.cfg reads a value');
select throws_ok($$ select private.cfg('no_such_key') $$, 'P0002', null, 'private.cfg refuses a missing key');
select is(pg_temp.score_stages(private.checkin_score(8)), array[10, 11, 12, 13, 15, 16, 18, 19, 21],
  'the point stages are the same as with the old constants');
select is(pg_temp.score_stages(private.checkin_score(30)), pg_temp.score_stages(private.checkin_score(8)), 'still capped at 8 stages');

-- ---------------------------------------------------------------------------
-- 2. Validation: a wrong value never gets in
-- ---------------------------------------------------------------------------

select throws_ok($$ update game_config set value = '"10"' where key = 'checkin_base_chips' $$, '23514', null,
  'a number as text is refused');
select throws_ok($$ update game_config set value = 'null' where key = 'checkin_base_chips' $$, '23514', null,
  'a JSON null is refused');
select throws_ok($$ update game_config set value = 'true' where key = 'bonus_question_points' $$, '23514', null,
  'a boolean is refused');
select throws_ok($$ update game_config set value = '[10]' where key = 'checkin_base_chips' $$, '23514', null,
  'an array is refused');
select throws_ok($$ update game_config set value = '10.5' where key = 'checkin_base_chips' $$, '23514', null,
  'a fraction is refused for a whole-number key');
select throws_ok($$ update game_config set value = '0' where key = 'checkin_base_chips' $$, '23514', null,
  'a value below the range is refused');
select throws_ok($$ update game_config set value = '11' where key = 'streak_multiplier' $$, '23514', null,
  'a typo (11 instead of 1.1) is refused: above the range');
select throws_ok($$ update game_config set value = '-1' where key = 'streak_max_steps' $$, '23514', null,
  'a negative number of steps is refused');
select throws_ok($$ insert into game_config (key, value, description) values ('base_chips', '10', 'typo') $$,
  '23514', null, 'an unknown key is refused');
select throws_ok($$ update game_config set key = 'base_chips' where key = 'checkin_base_chips' $$, '23514', null,
  'a key cannot be renamed');
select throws_ok($$ delete from game_config where key = 'streak_multiplier' $$, '23514', null,
  'a key in use cannot be deleted');
select throws_ok($$ truncate game_config $$, '23514', null, 'the table cannot be truncated');
select is((select value from game_config where key = 'checkin_base_chips'), '10'::jsonb,
  'after all refusals the value is unchanged');

select lives_ok($$ update game_config set value = '1.15' where key = 'streak_multiplier' $$,
  'a value within the range is accepted');
select is((select updated_at from game_config where key = 'streak_multiplier'), now(), 'updated_at follows the change');
select lives_ok($$ update game_config set value = '1.10' where key = 'streak_multiplier' $$,
  'and back (1.10 is the same number as 1.1)');
select is(pg_temp.score_stages(private.checkin_score(8)), array[10, 11, 12, 13, 15, 16, 18, 19, 21], 'same stages again');

-- ---------------------------------------------------------------------------
-- 3. The points follow the config; amounts already made stay frozen
-- ---------------------------------------------------------------------------

update game_config set value = '12' where key = 'checkin_base_chips';
update game_config set value = '1.2' where key = 'streak_multiplier';
update game_config set value = '2' where key = 'streak_max_steps';
update game_config set value = '7' where key = 'bonus_question_points';

select is(pg_temp.score_stages(private.checkin_score(5)), array[12, 14, 17], 'the stages use base, multiplier and maximum from the config');

create temp table c1 as select * from pg_temp.checkin('91000000-0000-0000-0000-000000000001', 900000000000901);
create temp table c2 as select * from pg_temp.checkin('91000000-0000-0000-0000-000000000001', 900000000000902);
select set_config('test.c1', (select checkin_id::text from c1), true);
select set_config('test.c2', (select checkin_id::text from c2), true);
select set_config('test.c2a', (select bonus_question->'options'->0->>'key' from c2), true);

select is((select row(ok, point_stages, points_total)::text from c1), '(t,"{12,14}",14)',
  'record_checkin uses the config: 12 x 1.2 = 14 for a first week');
select is((select (bonus_question->>'points')::int from c1), 7, 'the bonus question carries its points from the config');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"91000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select is(answer_bonus_question(current_setting('test.c1')::uuid, 'full'), 7, 'answer_bonus_question gives the config points');
select is(answer_bonus_question(current_setting('test.c2')::uuid, current_setting('test.c2a')), 7, 'also for the second check-in');
reset role;

select is(pg_temp.rows_of(current_setting('test.c1')::uuid), 'bonus:7:pending,checkin:14:pending',
  'the ledger rows carry the config amounts, pending');

-- Back to the old constants: what was made stays.
update game_config set value = '10' where key = 'checkin_base_chips';
update game_config set value = '1.1' where key = 'streak_multiplier';
update game_config set value = '8' where key = 'streak_max_steps';
update game_config set value = '5' where key = 'bonus_question_points';

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"91000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
select review_checkin(current_setting('test.c1')::uuid, true);
select review_checkin(current_setting('test.c2')::uuid, false, 'Foto onduidelijk');
reset role;

select is(pg_temp.rows_of(current_setting('test.c1')::uuid), 'bonus:7:granted,checkin:14:granted',
  'approved after a config change: the frozen amounts are granted');
select is((select points from profiles where id = '91000000-0000-0000-0000-000000000001'), 21,
  'the profile gets the frozen 14 + 7');
select is(pg_temp.rows_of(current_setting('test.c2')::uuid), 'bonus:7:revoked,checkin:14:revoked',
  'a rejection revokes the rewards, bonus included');

-- A test check-in (fake location, admin on local): base and streak from the
-- config, only test points, nothing for the real points.
create temp table t1 as select * from pg_temp.checkin('91000000-0000-0000-0000-000000000002', 900000000000903, true);
select is((select row(ok, is_test, points_total)::text from t1), '(t,t,11)',
  'a test check-in uses the config too (10 x 1.1)');
select is(pg_temp.rows_of((select checkin_id from t1)), 'checkin:11:pending:test', 'its row is a test row');
select is((select row(points, test_points)::text from profiles where id = '91000000-0000-0000-0000-000000000002'), '(0,0)',
  'a pending test check-in counts nowhere');

-- ---------------------------------------------------------------------------
-- 4. Users can neither read nor write the config
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"91000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
select throws_ok($$ select * from game_config $$, '42501', null, 'not even an admin reads game_config directly');
select throws_ok($$ update game_config set value = '100' where key = 'checkin_base_chips' $$, '42501', null,
  'users cannot change the config');
select throws_ok($$ select private.cfg('checkin_base_chips') $$, '42501', null, 'users cannot call private.cfg');
reset role;

select is_empty($$ select * from private.check_points_invariant() $$, 'every profile equals its ledger');

select * from finish();
rollback;
