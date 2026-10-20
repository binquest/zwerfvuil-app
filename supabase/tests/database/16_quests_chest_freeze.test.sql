-- Today (phase 6): the quest catalog and its rule check, handing out quests
-- (deterministic per user and day, with conditions), progress over the two
-- certainties right after a check-in and after a bonus answer, the daily
-- chest (ready at 3/3, drawn once with setseed, chances from the table, no
-- freeze with 2 in hand, kept when complete again), a rejection that takes
-- quest and chest back, the weekly challenge and a revocation older than 14
-- days, test check-ins that count for nothing, streak freezes (a missed week
-- bridged but not counted, only a full gap, the cap), Questheld, the chest
-- avatar, and who may read or write what.
-- Run with: npm run db:test

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(72);

-- ---------------------------------------------------------------------------
-- Fixtures (as postgres)
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, aud, role) values
  ('c1600000-0000-0000-0000-000000000001', 'today-alice@example.test', 'authenticated', 'authenticated'),
  ('c1600000-0000-0000-0000-000000000002', 'today-admin@example.test', 'authenticated', 'authenticated'),
  ('c1600000-0000-0000-0000-000000000003', 'today-bob@example.test', 'authenticated', 'authenticated'),
  ('c1600000-0000-0000-0000-000000000004', 'today-carol@example.test', 'authenticated', 'authenticated'),
  ('c1600000-0000-0000-0000-000000000005', 'today-carl@example.test', 'authenticated', 'authenticated'),
  ('c1600000-0000-0000-0000-000000000006', 'today-cleo@example.test', 'authenticated', 'authenticated'),
  ('c1600000-0000-0000-0000-000000000007', 'today-dave@example.test', 'authenticated', 'authenticated'),
  ('c1600000-0000-0000-0000-000000000008', 'today-erin@example.test', 'authenticated', 'authenticated'),
  ('c1600000-0000-0000-0000-000000000009', 'today-frank@example.test', 'authenticated', 'authenticated'),
  ('c1600000-0000-0000-0000-00000000000a', 'today-gina@example.test', 'authenticated', 'authenticated'),
  ('c1600000-0000-0000-0000-00000000000b', 'today-helen@example.test', 'authenticated', 'authenticated'),
  ('c1600000-0000-0000-0000-00000000000c', 'today-ivan@example.test', 'authenticated', 'authenticated');
update profiles set is_admin = true
 where id in ('c1600000-0000-0000-0000-000000000002', 'c1600000-0000-0000-0000-000000000009');

insert into private.app_environment (name) values ('local')
on conflict (singleton) do update set name = excluded.name;

-- Twelve bins 200 m apart east of Null Island; the region holds the first
-- three.
insert into bins (osm_type, osm_id, geom, status, eligible)
select 'node', 900000000001600 + i, st_project('SRID=4326;POINT(0 0)'::geography, 200 * (i - 1), radians(90)),
       'active', true
from generate_series(1, 12) i;

update game_config set value = '-0.005' where key = 'region_west';
update game_config set value = '-0.005' where key = 'region_south';
update game_config set value = '0.005' where key = 'region_east';
update game_config set value = '0.005' where key = 'region_north';

-- No badges (their answers would depend on the hour), except where tested.
update badges set active = false;

create function pg_temp.bin(i integer) returns bigint language sql as $$
  select b.id from public.bins b where b.osm_id = 900000000001600 + i;
$$;

create function pg_temp.today() returns date language sql as $$
  select (now() at time zone 'Europe/Brussels')::date;
$$;

-- The Monday of this week (Gent).
create function pg_temp.week0() returns date language sql as $$
  select date_trunc('week', now() at time zone 'Europe/Brussels')::date;
$$;

-- Hour h of local day d.
create function pg_temp.at(d date, h integer) returns timestamptz language sql as $$
  select (d::timestamp + make_interval(hours => h)) at time zone 'Europe/Brussels';
$$;

-- record_checkin for `who` at bin i, 5 m north of it, real or fake location.
create function pg_temp.checkin(who uuid, i integer, fake boolean default false)
returns table (ok boolean, checkin_id uuid, streak_weeks integer, game jsonb, bonus_question jsonb, is_test boolean)
language sql as $$
  select r.ok, r.checkin_id, r.streak_weeks, r.game, r.bonus_question, r.is_test
  from public.bins b,
    lateral public.record_checkin(gen_random_uuid(), who, b.id,
      st_y(st_project(b.geom, 5, 0)::geometry), st_x(st_project(b.geom, 5, 0)::geometry),
      5, false, fake, who::text || '/x.jpg') r
  where b.osm_id = 900000000001600 + i;
$$;

-- A check-in of `who` at bin i at time `at` with status `st`, straight into the
-- table (no refresh): for facts at chosen times.
create function pg_temp.put(who uuid, i integer, at timestamptz, st text)
returns uuid language sql as $$
  insert into public.checkins (user_id, bin_id, photo_path, user_geom, accuracy_m, distance_m, created_at,
                               status, reviewed_at)
  values (who, pg_temp.bin(i), who::text || '/p.jpg', 'SRID=4326;POINT(0 0)', 5, 1, at,
          st, case when st = 'pending' then null else at + interval '1 hour' end)
  returning id;
$$;

-- The quests of `who` on day d (and that week) as 'slot:progress/target:status'.
create function pg_temp.quests(who uuid, d date default null) returns text[] language sql as $$
  select array_agg(q.slot || ':' || q.progress || '/' || q.target || ':' || q.status
                   order by array_position(array['easy', 'medium', 'hard', 'weekly'], q.slot))
  from public.user_quests q
  where q.user_id = who
    and ((q.period = 'day' and q.period_start = coalesce(d, pg_temp.today()))
         or (q.period = 'week' and q.period_start = date_trunc('week', coalesce(d, pg_temp.today()))::date));
$$;

-- The ledger row of the quest in `slot` of `who` on day d: 'source:amount:status'.
create function pg_temp.quest_row(who uuid, s text, d date default null) returns text language sql as $$
  select coalesce((
    select t.source || ':' || t.amount || ':' || t.status
    from public.user_quests q
    join public.point_transactions t on t.user_id = who and t.reward_key = 'quest:' || q.id
    where q.user_id = who and q.slot = s
      and q.period_start = case when s = 'weekly' then date_trunc('week', coalesce(d, pg_temp.today()))::date
                                else coalesce(d, pg_temp.today()) end), 'none');
$$;

create function pg_temp.chest(who uuid, d date default null) returns public.daily_chests language sql as $$
  select * from public.daily_chests c where c.user_id = who and c.day = coalesce(d, pg_temp.today());
$$;

-- Only these quest templates are active (one per slot: a forced pick).
create function pg_temp.only(keys text[]) returns void language sql as $$
  update public.quest_templates set active = key = any (keys);
$$;

-- Only these chest rewards can be drawn.
create function pg_temp.draws(keys text[]) returns void language sql as $$
  update public.chest_rewards set weight = case when key = any (keys) then 1 else 0 end;
$$;

create function pg_temp.claims(who uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
$$;

create function pg_temp.as_admin() returns void language sql as $$
  select pg_temp.claims('c1600000-0000-0000-0000-000000000002');
$$;

-- ---------------------------------------------------------------------------
-- 1. Catalog and rules
-- ---------------------------------------------------------------------------

select is((select array_agg(x order by x) from (
             select slot || ':' || count(*) || ':+' || min(reward_points) as x
             from quest_templates where active group by slot) s),
  array['easy:3:+5', 'hard:2:+15', 'medium:3:+10', 'weekly:3:+40'],
  'the quests of chapter 3: 3 easy (+5), 3 medium (+10), 2 hard (+15), 3 weekly challenges (+40)');
select is((select array_agg(private.quest_rule_ok(r::jsonb)) from unnest(array[
    '{"type": "count", "of": "checkins"}',
    '{"type": "count", "of": "checkins", "hour_before": 10}',
    '{"type": "count", "of": "checkins", "new": true}',
    '{"type": "count", "of": "checkins", "revisit": true, "hour_from": 18}',
    '{"type": "count", "of": "bonus_answers"}',
    '{"type": "count", "of": "reports"}',
    '{"type": "count", "of": "discoveries"}',
    '{"type": "distinct_far_bins", "min_m": 200}',
    '{"type": "active_days"}']) r),
  array[true, true, true, true, true, true, true, true, true], 'the quest rule types and their parameters');
select is((select array_agg(private.quest_rule_ok(r::jsonb)) from unnest(array[
    '{"type": "count", "of": "quests"}',
    '{"type": "count", "of": "checkins", "target": 1}',
    '{"type": "count", "of": "reports", "new": true}',
    '{"type": "count", "of": "checkins", "new": true, "revisit": true}',
    '{"type": "count", "of": "checkins", "new": false}',
    '{"type": "distinct_far_bins"}',
    '{"type": "active_days", "min_m": 3}',
    '{"type": "streak_weeks"}',
    '[{"type": "active_days"}]']) r),
  array[false, false, false, false, false, false, false, false, false],
  'unknown types, keys and wrong parameters are not a quest rule');
select throws_ok($$ insert into quest_templates (key, period, slot, title, rule, target, reward_points, weight)
                    values ('typo', 'day', 'weekly', 'Tikfout', '{"type": "active_days"}', 1, 5, 1) $$,
  '23514', null, 'a day quest in the weekly slot is refused');
select is((select array_agg(key || ':' || weight order by sort) from chest_rewards where active),
  array['points_5:30', 'points_10:30', 'points_15:15', 'points_25:8', 'freeze:8', 'avatar_maan:3', 'avatar_regenboog:1'],
  'the chest rewards of chapter 3 with their weights');
select pg_temp.claims('c1600000-0000-0000-0000-000000000001');
set local role authenticated;
select is((select row(jsonb_array_length(c->'quests'), jsonb_array_length(c->'chest_rewards'),
                      c->'config'->'max_freezes', c->'milestones'->4->'freezes')::text
           from (select game_catalog() c) x),
  '(11,7,2,1)', 'game_catalog has the quests, the chest rewards, the freeze cap and the freeze at milestone 50');
reset role;

-- ---------------------------------------------------------------------------
-- 2. Handing out: deterministic, with conditions (gina)
-- ---------------------------------------------------------------------------

select is(private.ensure_quests('c1600000-0000-0000-0000-00000000000a', pg_temp.today() - 1), 5,
  'one quest per slot, the weekly challenge and the chest are handed out');
select is(private.ensure_quests('c1600000-0000-0000-0000-00000000000a', pg_temp.today() - 1), 0,
  'a second time: nothing new');
create temp table g1 as
  select slot, template_key from user_quests where user_id = 'c1600000-0000-0000-0000-00000000000a';
delete from daily_chests where user_id = 'c1600000-0000-0000-0000-00000000000a';
delete from user_quests where user_id = 'c1600000-0000-0000-0000-00000000000a';
select private.ensure_quests('c1600000-0000-0000-0000-00000000000a', pg_temp.today() - 1);
select is((select array_agg(slot || ':' || template_key order by slot) from user_quests
           where user_id = 'c1600000-0000-0000-0000-00000000000a'),
  (select array_agg(slot || ':' || template_key order by slot) from g1),
  'the same user and day get the same quests');

-- With bins left, 20 days give the quest of a new bin at least once; with
-- every bin of the region discovered, never (nor 5 new bins in a week).
select private.ensure_quests('c1600000-0000-0000-0000-00000000000a', pg_temp.today() - d)
from generate_series(2, 21) d;
select ok(exists (select 1 from user_quests where user_id = 'c1600000-0000-0000-0000-00000000000a'
                  and template_key = 'new_bin'),
  'with undiscovered bins the quest of a new bin is handed out');
select pg_temp.put('c1600000-0000-0000-0000-00000000000a', i, now() - interval '30 days', 'approved')
from generate_series(1, 3) i;
select private.refresh_game_state('c1600000-0000-0000-0000-00000000000a');
delete from daily_chests where user_id = 'c1600000-0000-0000-0000-00000000000a';
delete from user_quests where user_id = 'c1600000-0000-0000-0000-00000000000a';
select private.ensure_quests('c1600000-0000-0000-0000-00000000000a', pg_temp.today() - d)
from generate_series(1, 21) d;
select private.refresh_game_state('c1600000-0000-0000-0000-00000000000a');
select is((select count(*)::integer from user_quests where user_id = 'c1600000-0000-0000-0000-00000000000a'
           and template_key in ('new_bin', 'week_discover')), 0,
  'every bin discovered: no quest of a new bin, no challenge to discover 5');

-- ---------------------------------------------------------------------------
-- 3. The draw follows the table (helen, setseed)
-- ---------------------------------------------------------------------------

select pg_temp.only(array['checkin_any', 'new_bin', 'far_bins', 'week_days']);
select pg_temp.checkin('c1600000-0000-0000-0000-00000000000b', 1);
select pg_temp.checkin('c1600000-0000-0000-0000-00000000000b', 3);
select is((pg_temp.chest('c1600000-0000-0000-0000-00000000000b')).status, 'ready', 'three quests done: the chest is ready');

-- the expected reward for seed 0.42: one roll over the cumulative weights (95)
select setseed(0.42);
create temp table expected as
  select x.key from (
    select r.key, sum(r.weight) over (order by r.sort, r.key) as upto from chest_rewards r where r.active) x,
    (select floor(random() * 95) as v) roll
  where x.upto > roll.v order by x.upto limit 1;
select set_config('test.expected', (select key from expected), true);
select pg_temp.claims('c1600000-0000-0000-0000-00000000000b');
select setseed(0.42);
set local role authenticated;
select is(open_daily_chest((now() at time zone 'Europe/Brussels')::date)->'reward'->>'key', current_setting('test.expected'),
  'the chest draws by the weights of chest_rewards');
select is((select row(r->'reward'->>'key', r->>'already_opened')::text from (select open_daily_chest((now() at time zone 'Europe/Brussels')::date) r) x),
  row(current_setting('test.expected'), 'true')::text, 'opening it again gives the same reward, drawn once');
reset role;

-- ---------------------------------------------------------------------------
-- 4. Quests run up at once, chest, rejection (alice)
-- ---------------------------------------------------------------------------

select pg_temp.only(array['checkin_any', 'two_checkins', 'far_bins', 'week_days']);
update profiles set moments_seen_at = now() - interval '1 minute', results_seen_at = now() - interval '1 minute'
 where id = 'c1600000-0000-0000-0000-000000000001';
create temp table c1 as select * from pg_temp.checkin('c1600000-0000-0000-0000-000000000001', 1);
select is((select array_agg(q->>'slot' || ':' || (q->>'progress') || '/' || (q->>'target') || ':' || (q->>'status')
                            || ':' || (q->>'completed_now') order by n)
           from c1, jsonb_array_elements(c1.game->'quests') with ordinality x(q, n)),
  array['easy:1/1:pending:true', 'medium:1/2:open:false', 'hard:1/2:open:false', 'weekly:1/4:open:false'],
  'game: the quests run up with the check-in; the easy one is done, waiting for approval');
select is((select row(c1.game->'chest'->>'status', c1.game->'chest'->>'quests_done', c1.game->'chest'->>'ready_now')::text
           from c1), '(locked,1,false)', 'game: the chest is locked, 1 of 3');
select is((select row(t.source, t.amount, t.status, t.anchor_checkin_id = c1.checkin_id, t.earned_at = now())::text
           from user_quests q join point_transactions t on t.reward_key = 'quest:' || q.id, c1
           where q.user_id = 'c1600000-0000-0000-0000-000000000001' and q.slot = 'easy'),
  '(quest,5,pending,t,t)', 'its ledger row: +5 pending, anchored at the check-in');
select pg_temp.claims('c1600000-0000-0000-0000-000000000001');
set local role authenticated;
select is((select row(s->>'today', jsonb_array_length(s->'quests'), s->'weekly'->>'ends_on', s->'chest'->>'status',
                      s->>'pending_checkins')::text
           from (select my_game_state() s) x),
  (select row((now() at time zone 'Europe/Brussels')::date, 3, date_trunc('week', now() at time zone 'Europe/Brussels')::date + 6, 'locked', 1)::text),
  'my_game_state: today, three quests, the challenge until Sunday, the chest, one check-in waiting');
reset role;

create temp table c2 as select * from pg_temp.checkin('c1600000-0000-0000-0000-000000000001', 3);
select is(pg_temp.quests('c1600000-0000-0000-0000-000000000001'),
  array['easy:1/1:pending', 'medium:2/2:pending', 'hard:2/2:pending', 'weekly:1/4:open'],
  'a second check-in 400 m away completes the medium and the hard quest');
select is((select row(c2.game->'chest'->>'status', c2.game->'chest'->>'ready_now')::text from c2), '(ready,true)',
  'game: 3/3, the chest became ready now');
select pg_temp.claims('c1600000-0000-0000-0000-000000000001');
set local role authenticated;
select is((select array_agg(m->>'kind' order by n) from jsonb_array_elements(my_unseen()->'moments') with ordinality x(m, n)),
  array['discovery', 'discovery', 'quest', 'quest', 'quest', 'chest'],
  'moments: the discoveries, the three quests and the chest');
reset role;

select pg_temp.as_admin();
select review_checkin((select checkin_id from c1), true);
select is(pg_temp.quests('c1600000-0000-0000-0000-000000000001'),
  array['easy:1/1:granted', 'medium:2/2:pending', 'hard:2/2:pending', 'weekly:1/4:open'],
  'approving the first check-in: the easy quest is certain, the others still wait');
select is(pg_temp.quest_row('c1600000-0000-0000-0000-000000000001', 'easy'), 'quest:5:granted', 'its +5 is granted');

select pg_temp.draws(array['points_10']);
select pg_temp.claims('c1600000-0000-0000-0000-000000000001');
set local role authenticated;
select is((select row(r->'reward'->>'kind', r->'reward'->>'amount', r->'reward'->>'status', r->>'already_opened')::text
           from (select open_daily_chest((now() at time zone 'Europe/Brussels')::date) r) x),
  '(points,10,pending,false)', 'open_daily_chest: +10, pending while a quest waits');
reset role;
select is((select row(t.amount, t.status)::text from point_transactions t
           where t.reward_key = 'chest:' || (pg_temp.chest('c1600000-0000-0000-0000-000000000001')).id),
  '(10,pending)', 'the chest has its ledger row');

select pg_temp.as_admin();
select review_checkin((select checkin_id from c2), false, 'Foto onduidelijk');
select is(pg_temp.quests('c1600000-0000-0000-0000-000000000001'),
  array['easy:1/1:granted', 'medium:1/2:open', 'hard:1/2:open', 'weekly:1/4:open'],
  'rejecting the second check-in sets the medium and hard quest back');
select is((select array_agg(t.status || ':' || t.revoke_reason order by q.slot)
           from user_quests q join point_transactions t on t.reward_key = 'quest:' || q.id
           where q.user_id = 'c1600000-0000-0000-0000-000000000001' and q.slot in ('medium', 'hard')),
  array['revoked:quest_lost', 'revoked:quest_lost'], 'their rewards are revoked');
select is((select row(c.status, c.reward_key, c.reward_status, c.opened_at is not null,
                      (select t.status from point_transactions t where t.reward_key = 'chest:' || c.id))::text
           from pg_temp.chest('c1600000-0000-0000-0000-000000000001') c),
  '(locked,points_10,revoked,t,revoked)', 'the chest is locked again; its reward is revoked, the draw kept');
select pg_temp.claims('c1600000-0000-0000-0000-000000000001');
set local role authenticated;
select throws_ok($$ select open_daily_chest((now() at time zone 'Europe/Brussels')::date) $$, '55000', null, 'a locked chest cannot be opened');
reset role;

create temp table c3 as select * from pg_temp.checkin('c1600000-0000-0000-0000-000000000001', 5);
select is((select row(c.status, c.reward_key, c.reward_status,
                      (select t.status from point_transactions t where t.reward_key = 'chest:' || c.id))::text
           from pg_temp.chest('c1600000-0000-0000-0000-000000000001') c),
  '(opened,points_10,pending,pending)', 'complete again: the chest keeps its draw, the reward waits again');
select pg_temp.as_admin();
select review_checkin((select checkin_id from c3), true);
select is((select row(c.reward_status, (select t.status from point_transactions t where t.reward_key = 'chest:' || c.id))::text
           from pg_temp.chest('c1600000-0000-0000-0000-000000000001') c),
  '(granted,granted)', 'every quest certain: the chest reward is granted');
select pg_temp.claims('c1600000-0000-0000-0000-000000000001');
set local role authenticated;
select is((select row(u->'results'->'by_source'->>'quest', u->'results'->'by_source'->>'chest')::text
           from (select my_unseen() u) x),
  '(30,10)', 'the approval celebration has +30 quest and +10 chest');
reset role;

-- ---------------------------------------------------------------------------
-- 5. The bonus answer moves the quest too (bob)
-- ---------------------------------------------------------------------------

select pg_temp.only(array['bonus_answer', 'two_checkins', 'far_bins', 'week_bonus']);
create temp table b1 as select * from pg_temp.checkin('c1600000-0000-0000-0000-000000000003', 1);
select is(pg_temp.quests('c1600000-0000-0000-0000-000000000003'),
  array['easy:0/1:open', 'medium:1/2:open', 'hard:1/2:open', 'weekly:0/5:open'], 'a check-in alone: no bonus answer yet');
select set_config('test.b1', (select checkin_id::text from b1), true),
       set_config('test.b1_answer', (select bonus_question->'options'->0->>'key' from b1), true);
select pg_temp.claims('c1600000-0000-0000-0000-000000000003');
set local role authenticated;
select mark_bonus_question_shown(current_setting('test.b1')::uuid);
reset role;
update bonus_answers set shown_at = clock_timestamp() - interval '3 seconds' where checkin_id = (select checkin_id from b1);
select pg_temp.claims('c1600000-0000-0000-0000-000000000003');
set local role authenticated;
select answer_bonus_question(current_setting('test.b1')::uuid, current_setting('test.b1_answer'));
reset role;
select is(pg_temp.quests('c1600000-0000-0000-0000-000000000003'),
  array['easy:1/1:pending', 'medium:1/2:open', 'hard:1/2:open', 'weekly:1/5:open'],
  'the bonus answer completes the quest and moves the challenge');
select is(pg_temp.quest_row('c1600000-0000-0000-0000-000000000003', 'easy'), 'quest:5:pending', 'with its +5 waiting');

-- ---------------------------------------------------------------------------
-- 6. The weekly challenge, and a revocation older than 14 days (erin)
-- ---------------------------------------------------------------------------

select pg_temp.only(array['checkin_any', 'two_checkins', 'far_bins', 'week_days']);
create temp table e1 as
  select d, pg_temp.put('c1600000-0000-0000-0000-000000000008', d + 1, pg_temp.at(pg_temp.week0() - 21 + d, 12), 'approved') as id
  from generate_series(0, 3) d;
select private.ensure_quests('c1600000-0000-0000-0000-000000000008', pg_temp.week0() - 21);
select private.refresh_game_state('c1600000-0000-0000-0000-000000000008', pg_temp.week0() - 21);
select is(pg_temp.quests('c1600000-0000-0000-0000-000000000008', pg_temp.week0() - 21),
  array['easy:1/1:granted', 'medium:1/2:open', 'hard:1/2:open', 'weekly:4/4:granted'],
  'check-ins on 4 days of a week complete the challenge');
select is(pg_temp.quest_row('c1600000-0000-0000-0000-000000000008', 'weekly', pg_temp.week0() - 21), 'weekly:40:granted',
  'the challenge: +40, source weekly');
select pg_temp.as_admin();
select revoke_checkin((select id from e1 where d = 0), 'Dubbel');
select is(pg_temp.quests('c1600000-0000-0000-0000-000000000008', pg_temp.week0() - 21),
  array['easy:0/1:open', 'medium:0/2:open', 'hard:0/2:open', 'weekly:3/4:open'],
  'revoking a check-in of three weeks ago recomputes that day and week');
select is(array[pg_temp.quest_row('c1600000-0000-0000-0000-000000000008', 'weekly', pg_temp.week0() - 21),
                pg_temp.quest_row('c1600000-0000-0000-0000-000000000008', 'easy', pg_temp.week0() - 21)],
  array['weekly:40:revoked', 'quest:5:revoked'], 'and takes their rewards back');

-- ---------------------------------------------------------------------------
-- 7. Test check-ins count for nothing (frank)
-- ---------------------------------------------------------------------------

create temp table f1 as select * from pg_temp.checkin('c1600000-0000-0000-0000-000000000009', 1, true);
select is((select row(is_test, game is null, (select count(*) from user_quests
                                              where user_id = 'c1600000-0000-0000-0000-000000000009'))::text from f1),
  '(t,t,0)', 'a test check-in hands out no quests and has no game');
select pg_temp.claims('c1600000-0000-0000-0000-000000000009');
set local role authenticated;
select is((select array_agg(q->>'progress' order by n) from jsonb_array_elements(my_game_state()->'quests') with ordinality x(q, n)),
  array['0', '0', '0'], 'the quests handed out later do not count the test check-in');
reset role;

-- ---------------------------------------------------------------------------
-- 8. Freezes from the chest and the cap (dave)
-- ---------------------------------------------------------------------------

select pg_temp.only(array['checkin_any', 'new_bin', 'far_bins', 'week_days']);
select pg_temp.checkin('c1600000-0000-0000-0000-000000000007', 1);
select pg_temp.checkin('c1600000-0000-0000-0000-000000000007', 3);
select pg_temp.draws(array['freeze']);
select pg_temp.claims('c1600000-0000-0000-0000-000000000007');
set local role authenticated;
select is((select row(r->'reward'->>'kind', r->'reward'->>'amount')::text from (select open_daily_chest((now() at time zone 'Europe/Brussels')::date) r) x),
  '(freeze,1)', 'only freezes in the table: the chest gives a freeze');
reset role;
select is((select array_agg(source || ':' || status) from streak_freezes where user_id = 'c1600000-0000-0000-0000-000000000007'),
  array['chest:pending'], 'the freeze waits for the quests of that day');

-- a second freeze from a milestone (2 discoveries, for this test)
insert into milestones (threshold, points, freezes) values (2, 5, 1);
select private.refresh_game_state('c1600000-0000-0000-0000-000000000007');
select pg_temp.claims('c1600000-0000-0000-0000-000000000007');
set local role authenticated;
select is((select row(s->'streak'->>'freezes', s->'streak'->>'max_freezes')::text from (select my_game_state() s) x),
  '(2,2)', 'two freezes in hand, the maximum');
reset role;

-- yesterday's chest, with freezes and points in the table: no freeze at 2
select pg_temp.put('c1600000-0000-0000-0000-000000000007', 5, pg_temp.at(pg_temp.today() - 1, 12), 'pending');
select pg_temp.put('c1600000-0000-0000-0000-000000000007', 7, pg_temp.at(pg_temp.today() - 1, 13), 'pending');
select private.ensure_quests('c1600000-0000-0000-0000-000000000007', pg_temp.today() - 1);
select private.refresh_game_state('c1600000-0000-0000-0000-000000000007');
select pg_temp.draws(array['freeze', 'points_5']);
update chest_rewards set weight = 1000 where key = 'freeze';
select pg_temp.claims('c1600000-0000-0000-0000-000000000007');
set local role authenticated;
select is((select r->'reward'->>'key' from (select open_daily_chest((now() at time zone 'Europe/Brussels')::date - 1) r) x), 'points_5',
  'with 2 freezes in hand the chest draws no freeze (yesterday''s chest)');
reset role;

-- a third freeze earned later is lost: the cap
update user_milestones set reached_at = now() - interval '2 hours'
 where user_id = 'c1600000-0000-0000-0000-000000000007' and threshold = 2;
update daily_chests set opened_at = now() - interval '2 hours'
 where user_id = 'c1600000-0000-0000-0000-000000000007' and day = pg_temp.today();
insert into milestones (threshold, points, freezes) values (3, 5, 1);
select private.refresh_game_state('c1600000-0000-0000-0000-000000000007');
select is((select row(status, revoke_reason)::text from streak_freezes
           where user_id = 'c1600000-0000-0000-0000-000000000007' and source_key = 'milestone:3:1'),
  '(revoked,freezes_full)', 'a freeze earned with 2 in hand is lost');
delete from user_milestones where threshold in (2, 3);
delete from point_transactions where reward_key in ('milestone:2', 'milestone:3');
delete from streak_freezes where source_key in ('milestone:2:1', 'milestone:3:1');
delete from milestones where threshold in (2, 3);

-- ---------------------------------------------------------------------------
-- 9. A missed week with a freeze keeps the streak (carol, carl, cleo)
-- ---------------------------------------------------------------------------

-- carol and carl: weeks -3 and -2, nothing last week; carol has a freeze from
-- a quest of week -3 (earned then), carl none
select pg_temp.only(array['checkin_any', 'two_checkins', 'far_bins', 'week_days']);
update quest_templates set reward_freezes = 1 where key = 'checkin_any';
select pg_temp.put(u, 1, pg_temp.at(pg_temp.week0() - 21, 12), 'approved'),
       pg_temp.put(u, 2, pg_temp.at(pg_temp.week0() - 14, 12), 'approved')
from unnest(array['c1600000-0000-0000-0000-000000000004', 'c1600000-0000-0000-0000-000000000005']::uuid[]) u;
select private.ensure_quests('c1600000-0000-0000-0000-000000000004', pg_temp.week0() - 21);
select private.refresh_game_state('c1600000-0000-0000-0000-000000000004', pg_temp.week0() - 21);
update user_quests set completed_at = pg_temp.at(pg_temp.week0() - 21, 12)
 where user_id = 'c1600000-0000-0000-0000-000000000004' and status <> 'open';
select private.refresh_game_state('c1600000-0000-0000-0000-000000000004', pg_temp.week0() - 21);
update quest_templates set reward_freezes = 0 where key = 'checkin_any';
select is((select row(status, earned_at = pg_temp.at(pg_temp.week0() - 21, 12))::text from streak_freezes
           where user_id = 'c1600000-0000-0000-0000-000000000004'),
  '(available,t)', 'the quest of week -3 gave a freeze, available (approved)');

select pg_temp.claims('c1600000-0000-0000-0000-000000000004');
set local role authenticated;
select is((select row(weeks, this_week)::text from my_streak()), '(2,f)', 'carol: last week is bridged, the streak lives');
select is((select row(s->'streak'->>'freezes', s->'streak'->'frozen_weeks')::text from (select my_game_state() s) x),
  (select row(0, jsonb_build_array(date_trunc('week', now() at time zone 'Europe/Brussels')::date - 7))::text), 'the freeze is used for last week');
reset role;
select pg_temp.claims('c1600000-0000-0000-0000-000000000005');
set local role authenticated;
select is((select row(weeks, this_week)::text from my_streak()), '(0,f)', 'carl, without a freeze: the streak is gone');
reset role;

select is((select streak_weeks from pg_temp.checkin('c1600000-0000-0000-0000-000000000004', 1)), 3,
  'carol checks in: 3 weeks, the bridged week does not count');
select is((select streak_weeks from pg_temp.checkin('c1600000-0000-0000-0000-000000000005', 1)), 1,
  'carl checks in: a new streak of 1');
select is(private.longest_streak('c1600000-0000-0000-0000-000000000004', false), 3, 'carol''s longest streak is 3');

-- cleo: weeks -4 and -1 with one freeze from week -4: a gap of 2 weeks
select pg_temp.put('c1600000-0000-0000-0000-000000000006', 1, pg_temp.at(pg_temp.week0() - 28, 12), 'approved');
select pg_temp.put('c1600000-0000-0000-0000-000000000006', 2, pg_temp.at(pg_temp.week0() - 7, 12), 'approved');
update quest_templates set reward_freezes = 1 where key = 'checkin_any';
select private.ensure_quests('c1600000-0000-0000-0000-000000000006', pg_temp.week0() - 28);
select private.refresh_game_state('c1600000-0000-0000-0000-000000000006', pg_temp.week0() - 28);
update user_quests set completed_at = pg_temp.at(pg_temp.week0() - 28, 12)
 where user_id = 'c1600000-0000-0000-0000-000000000006' and status <> 'open';
select private.refresh_game_state('c1600000-0000-0000-0000-000000000006', pg_temp.week0() - 28);
update quest_templates set reward_freezes = 0 where key = 'checkin_any';
select pg_temp.claims('c1600000-0000-0000-0000-000000000006');
set local role authenticated;
select is((select row(m.weeks, s->'streak'->>'freezes')::text from my_streak() m, (select my_game_state() s) x),
  '(1,1)', 'a gap of two weeks with one freeze is not bridged; the freeze stays');
reset role;

-- ---------------------------------------------------------------------------
-- 10. Questheld and the chest avatar (ivan)
-- ---------------------------------------------------------------------------

update badges set active = (key = 'quest_hero'),
                  rule = case when key = 'quest_hero' then '{"type": "count", "of": "quests", "target": 2}'::jsonb else rule end;
select pg_temp.only(array['checkin_any', 'new_bin', 'far_bins', 'week_days']);
create temp table i1 as select * from pg_temp.checkin('c1600000-0000-0000-0000-00000000000c', 1);
select is((select array_agg(b->>'key' || ':' || (b->>'status')) from i1, jsonb_array_elements(i1.game->'badges') b),
  array['quest_hero:pending'], 'two quests done: Questheld (2 for this test), pending');
create temp table i2 as select * from pg_temp.checkin('c1600000-0000-0000-0000-00000000000c', 3);
select pg_temp.draws(array['avatar_maan']);
select pg_temp.claims('c1600000-0000-0000-0000-00000000000c');
set local role authenticated;
select is((select row(r->'reward'->>'kind', r->'reward'->>'avatar_key', r->'reward'->>'status')::text
           from (select open_daily_chest((now() at time zone 'Europe/Brussels')::date) r) x),
  '(avatar,maan,pending)', 'the chest gives Maan, pending');
reset role;
select is((select status from private.avatar_states('c1600000-0000-0000-0000-00000000000c') where key = 'maan'), 'pending',
  'Maan is pending until the quests are certain');

select pg_temp.as_admin();
select review_checkin((select checkin_id from i1), true);
select review_checkin((select checkin_id from i2), true);
select is((select row((select ub.status from user_badges ub
                       where ub.user_id = 'c1600000-0000-0000-0000-00000000000c' and ub.badge_key = 'quest_hero'),
                      (select s.status from private.avatar_states('c1600000-0000-0000-0000-00000000000c') s
                       where s.key = 'maan'))::text),
  '(granted,unlocked)', 'approved: Questheld granted, Maan unlocked');
select pg_temp.claims('c1600000-0000-0000-0000-00000000000c');
set local role authenticated;
select is((select u->'results'->'avatars' from (select my_unseen() u) x), '[{"key": "maan", "name": "Maan"}]'::jsonb,
  'the approval celebration shows Maan');
select set_my_avatar('maan');
reset role;
select pg_temp.as_admin();
select revoke_checkin((select checkin_id from i2), 'Geen vuilbak');
select is((select row((pg_temp.chest(p.id)).status, (select s.status from private.avatar_states(p.id) s where s.key = 'maan'),
                      p.avatar_key)::text
           from profiles p where p.id = 'c1600000-0000-0000-0000-00000000000c'),
  '(locked,locked,spruit)', 'revoked: the chest locks, Maan is locked and taken off');

-- ---------------------------------------------------------------------------
-- 11. Who may do what
-- ---------------------------------------------------------------------------

select pg_temp.claims('c1600000-0000-0000-0000-000000000001');
set local role authenticated;
select is((select count(*)::integer from user_quests), 4, 'users read only their own quests');
select is((select count(*)::integer from daily_chests), 1, 'and only their own chests');
select throws_ok($$ insert into user_quests (user_id, period, period_start, slot, template_key, title, rule, target,
                                             reward_points, reward_freezes)
                    values (auth.uid(), 'day', current_date - 1, 'easy', 'checkin_any', 'x', '{}', 1, 500, 0) $$,
  '42501', null, 'users cannot hand themselves a quest');
select throws_ok($$ update daily_chests set status = 'ready' $$, '42501', null, 'users cannot change a chest');
select throws_ok($$ insert into streak_freezes (user_id, source, source_key, status, earned_at)
                    values (auth.uid(), 'chest', 'x', 'available', now()) $$,
  '42501', null, 'users cannot give themselves a freeze');
select throws_ok($$ select * from quest_templates $$, '42501', null, 'the quest templates are read through game_catalog');
select throws_ok($$ select private.ensure_quests(auth.uid(), current_date) $$, '42501', null,
  'users cannot call the internal functions');
select throws_ok($$ select open_daily_chest((now() at time zone 'Europe/Brussels')::date - 7) $$, '22023', null, 'a chest older than 7 days cannot be opened');
select throws_ok($$ select open_daily_chest((now() at time zone 'Europe/Brussels')::date + 1) $$, '22023', null, 'nor tomorrow''s');
reset role;
set local role anon;
select throws_ok($$ select open_daily_chest(current_date) $$, '42501', null, 'anonymous users cannot open a chest');
reset role;

-- ---------------------------------------------------------------------------
-- 12. Invariants
-- ---------------------------------------------------------------------------

update badges set active = false;
select is((select sum(private.refresh_game_state(p.id))::integer from profiles p
           where p.id::text like 'c1600000-%' and exists (select 1 from user_quests q where q.user_id = p.id)), 0,
  'a refresh of every player changes nothing');
select is_empty($$ select * from private.check_points_invariant() $$, 'profiles equal their ledger');

select * from finish();
rollback;
