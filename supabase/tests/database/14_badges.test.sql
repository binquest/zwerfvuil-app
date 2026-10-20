-- Badges (phase 5): the catalog and its rule check, every rule type (count of
-- check-ins with and without hours, discoveries, bonus answers and reports,
-- streak weeks, the whole region) over the two certainties
-- (pending/granted/revoked and earned again), test check-ins that count for
-- nothing, the badge in the answer of record_checkin, my_badges with progress
-- and secret badges, the badge avatar (unlock, hint, taken off), reports that
-- start the refresh, and who may read or write what.
-- Run with: npm run db:test

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(47);

-- No quests (phase 6) in this test: no quest rewards, no chest.
update quest_templates set active = false;

-- ---------------------------------------------------------------------------
-- Fixtures (as postgres)
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, aud, role) values
  ('c1400000-0000-0000-0000-000000000001', 'badge-alice@example.test', 'authenticated', 'authenticated'),
  ('c1400000-0000-0000-0000-000000000002', 'badge-admin@example.test', 'authenticated', 'authenticated'),
  ('c1400000-0000-0000-0000-000000000003', 'badge-carol@example.test', 'authenticated', 'authenticated'),
  ('c1400000-0000-0000-0000-000000000004', 'badge-dave@example.test', 'authenticated', 'authenticated'),
  ('c1400000-0000-0000-0000-000000000005', 'badge-erin@example.test', 'authenticated', 'authenticated'),
  ('c1400000-0000-0000-0000-000000000006', 'badge-frank@example.test', 'authenticated', 'authenticated'),
  ('c1400000-0000-0000-0000-000000000007', 'badge-george@example.test', 'authenticated', 'authenticated'),
  ('c1400000-0000-0000-0000-000000000008', 'badge-henk@example.test', 'authenticated', 'authenticated');
update profiles set is_admin = true where id = 'c1400000-0000-0000-0000-000000000002';

insert into private.app_environment (name) values ('local')
on conflict (singleton) do update set name = excluded.name;

-- Twelve bins 200 m apart east of Null Island; the region holds the first
-- three (Heel de buurt = 3 bins).
insert into bins (osm_type, osm_id, geom, status, eligible)
select 'node', 900000000001400 + i, st_project('SRID=4326;POINT(0 0)'::geography, 200 * (i - 1), radians(90)),
       'active', true
from generate_series(1, 12) i;

update game_config set value = '-0.005' where key = 'region_west';
update game_config set value = '-0.005' where key = 'region_south';
update game_config set value = '0.005' where key = 'region_east';
update game_config set value = '0.005' where key = 'region_north';

create function pg_temp.bin(i integer) returns bigint language sql as $$
  select b.id from public.bins b where b.osm_id = 900000000001400 + i;
$$;

-- record_checkin for `who` at bin i, 5 m north of it, real or fake location.
create function pg_temp.checkin(who uuid, i integer, fake boolean default false)
returns table (ok boolean, checkin_id uuid, game jsonb, is_test boolean)
language sql as $$
  select r.ok, r.checkin_id, r.game, r.is_test
  from public.bins b,
    lateral public.record_checkin(gen_random_uuid(), who, b.id,
      st_y(st_project(b.geom, 5, 0)::geometry), st_x(st_project(b.geom, 5, 0)::geometry),
      5, false, fake, who::text || '/x.jpg') r
  where b.osm_id = 900000000001400 + i;
$$;

-- A check-in of `who` at bin i at time `at` with status `st`, straight into the
-- table (no refresh): for facts at chosen times.
create function pg_temp.put(who uuid, i integer, at timestamptz, st text, test boolean default false)
returns uuid language sql as $$
  insert into public.checkins (user_id, bin_id, photo_path, user_geom, accuracy_m, distance_m, created_at,
                               status, reviewed_at, is_test)
  values (who, pg_temp.bin(i), who::text || '/p.jpg', 'SRID=4326;POINT(0 0)', 5, 1, at,
          st, case when st = 'pending' then null else at + interval '1 hour' end, test)
  returning id;
$$;

-- Time passes for `who`: everything of that user moves back by `by`.
create function pg_temp.later(who uuid, by interval) returns void language sql as $$
  update public.checkins set created_at = created_at - by where user_id = who;
  update public.discoveries set discovered_at = discovered_at - by where user_id = who;
  update public.user_milestones set reached_at = reached_at - by where user_id = who;
  update public.user_badges set earned_at = earned_at - by where user_id = who;
  update public.point_transactions set earned_at = earned_at - by where user_id = who;
$$;

-- The status of a badge of `who` ('none' without a row).
create function pg_temp.badge(who uuid, k text) returns text language sql as $$
  select coalesce((select ub.status from public.user_badges ub where ub.user_id = who and ub.badge_key = k), 'none');
$$;

create function pg_temp.claims(who uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
$$;

create function pg_temp.as_admin() returns void language sql as $$
  select pg_temp.claims('c1400000-0000-0000-0000-000000000002');
$$;

-- ---------------------------------------------------------------------------
-- 1. Catalog and rules
-- ---------------------------------------------------------------------------

select is((select array_agg(key order by sort) from badges where active),
  array['first_checkin', 'explorer_10', 'explorer_50', 'explorer_100', 'streak_4', 'streak_8', 'curious',
        'mapmaker', 'early_bird', 'night_owl', 'quest_hero', 'whole_neighbourhood'],
  'the badges of chapter 3 (without bounties)');
select is((select array_agg(private.badge_rule_ok(r::jsonb)) from unnest(array[
    '{"type": "count", "of": "checkins", "target": 1}',
    '{"type": "count", "of": "checkins", "target": 3, "hour_from": 22, "hour_before": 5}',
    '{"type": "count", "of": "checkins", "target": 1, "hour_before": 24}',
    '{"type": "count", "of": "reports", "target": 1}',
    '{"type": "streak_weeks", "target": 8}',
    '{"type": "region_complete"}',
    '{"type": "count", "of": "quests", "target": 30}']) r),
  array[true, true, true, true, true, true, true], 'the rule types and their parameters');
select is((select array_agg(private.badge_rule_ok(r::jsonb)) from unnest(array[
    '{"type": "count", "of": "checkins"}',
    '{"type": "count", "of": "checkins", "target": 0}',
    '{"type": "count", "of": "checkins", "target": "3"}',
    '{"type": "count", "of": "bounties", "target": 3}',
    '{"type": "count", "of": "discoveries", "target": 3, "hour_from": 5}',
    '{"type": "count", "of": "checkins", "target": 1, "hour_from": 24}',
    '{"type": "count", "of": "checkins", "target": 1, "hour_from": 5, "hour_before": 5}',
    '{"type": "count", "of": "checkins", "target": 1, "new": true}',
    '{"type": "streak_weeks"}',
    '{"type": "region_complete", "target": 3}',
    '{"type": "distinct_far_bins", "target": 2}',
    '[{"type": "region_complete"}]']) r),
  array[false, false, false, false, false, false, false, false, false, false, false, false],
  'unknown types, keys and wrong parameters are not a rule');
select throws_ok($$ insert into badges (key, name, description, symbol, rarity, rule, sort)
                    values ('typo', 'Typo', 'Een tikfout.', 'star', 'common', '{"type": "count", "of": "checkins"}', 99) $$,
  '23514', null, 'a badge with a broken rule is refused');
select is_empty($$ select a.key from avatars a
                   where a.unlock_type = 'badge' and not exists (select 1 from badges b where b.key = a.unlock_param) $$,
  'every badge avatar names a badge');
select is((select row(jsonb_array_length(c->'badges'), c->'badges'->0->>'name', c->'badges'->9->>'name',
                      c->'badges'->9->>'symbol', c->'badges'->9->>'description' = 'Een verrassing: blijf spelen.')::text
           from (select game_catalog() c) x),
  '(12,"Eerste inworp","Geheime badge",questionmark,t)', 'game_catalog has the badges, the secret one hidden');

-- ---------------------------------------------------------------------------
-- 2. A count of check-ins: pending, granted, back to pending, revoked, again
-- ---------------------------------------------------------------------------

create temp table c1 as select * from pg_temp.checkin('c1400000-0000-0000-0000-000000000001', 1);
select is((select x from c1, jsonb_array_elements(c1.game->'badges') x where x->>'key' = 'first_checkin'),
  '{"key": "first_checkin", "name": "Eerste inworp", "description": "Doe je eerste inworp.",
    "symbol": "hand.thumbsup.fill", "rarity": "common", "status": "pending"}'::jsonb,
  'record_checkin: the first check-in earns Eerste inworp, pending');
select is((select row(ub.status, ub.granted_at is null, ub.anchor_checkin_id = c1.checkin_id, ub.earned_at = now())::text
           from user_badges ub, c1
           where ub.user_id = 'c1400000-0000-0000-0000-000000000001' and ub.badge_key = 'first_checkin'),
  '(pending,t,t,t)', 'user_badges: pending, not granted, anchored on the check-in, earned now');

select pg_temp.claims('c1400000-0000-0000-0000-000000000001');
set local role authenticated;
select is((select row(status, progress, target, earned_at is not null)::text from my_badges() where key = 'first_checkin'),
  '(pending,1,1,t)', 'my_badges: pending with its progress');
reset role;

select pg_temp.as_admin();
select review_checkin((select checkin_id from c1), true);
select is((select row(status, granted_at is not null)::text from user_badges
           where user_id = 'c1400000-0000-0000-0000-000000000001' and badge_key = 'first_checkin'),
  '(granted,t)', 'approved: granted');

select pg_temp.later('c1400000-0000-0000-0000-000000000001', interval '1 hour');
create temp table c2 as select * from pg_temp.checkin('c1400000-0000-0000-0000-000000000001', 2);
select pg_temp.as_admin();
select revoke_checkin((select checkin_id from c1), 'Dubbel');
select is((select row(status, granted_at is null, anchor_checkin_id = (select checkin_id from c2))::text from user_badges
           where user_id = 'c1400000-0000-0000-0000-000000000001' and badge_key = 'first_checkin'),
  '(pending,t,t)', 'revoked check-in: back to pending on the one that waits');

select review_checkin((select checkin_id from c2), false);
select is(pg_temp.badge('c1400000-0000-0000-0000-000000000001', 'first_checkin'), 'revoked',
  'rejected too: revoked');
select pg_temp.claims('c1400000-0000-0000-0000-000000000001');
set local role authenticated;
select is((select row(status, earned_at is null, progress)::text from my_badges() where key = 'first_checkin'),
  '(locked,t,0)', 'my_badges: a revoked badge is locked again');
reset role;

select pg_temp.later('c1400000-0000-0000-0000-000000000001', interval '1 hour');
create temp table c3 as select * from pg_temp.checkin('c1400000-0000-0000-0000-000000000001', 3);
select is((select row(count(*), min(status), min(earned_at) = now())::text from user_badges
           where user_id = 'c1400000-0000-0000-0000-000000000001' and badge_key = 'first_checkin'),
  '(1,pending,t)', 'earned again: the same row, pending, a new moment');
select is(private.refresh_game_state('c1400000-0000-0000-0000-000000000001'), 0,
  'a refresh right after the check-in changes nothing');

-- ---------------------------------------------------------------------------
-- 3. Hours: Vroege vogel (5-8) and Nachtuil (22-5, secret), the badge avatar
-- ---------------------------------------------------------------------------

create temp table d (k text primary key, id uuid);
insert into d values
  ('early', pg_temp.put('c1400000-0000-0000-0000-000000000004', 1, '2026-10-13 06:30 Europe/Brussels', 'pending')),
  ('night', pg_temp.put('c1400000-0000-0000-0000-000000000004', 2, '2026-10-13 23:15 Europe/Brussels', 'approved')),
  ('rejected', pg_temp.put('c1400000-0000-0000-0000-000000000004', 3, '2026-10-14 04:59 Europe/Brussels', 'rejected')),
  ('eight', pg_temp.put('c1400000-0000-0000-0000-000000000004', 4, '2026-10-14 08:00 Europe/Brussels', 'approved'));
select private.refresh_game_state('c1400000-0000-0000-0000-000000000004');
select is(row(pg_temp.badge('c1400000-0000-0000-0000-000000000004', 'early_bird'),
              pg_temp.badge('c1400000-0000-0000-0000-000000000004', 'night_owl'))::text,
  '(pending,granted)', 'local hours: 06:30 waits (Vroege vogel pending), 23:15 approved (Nachtuil granted); 08:00 is not early');
select is((select status from private.avatar_states('c1400000-0000-0000-0000-000000000004') where key = 'merel'),
  'pending', 'the badge avatar is pending with its badge');

select pg_temp.as_admin();
select review_checkin((select id from d where k = 'early'), true);
select is(pg_temp.badge('c1400000-0000-0000-0000-000000000004', 'early_bird'), 'granted', 'approved: Vroege vogel granted');
select is((select status from private.avatar_states('c1400000-0000-0000-0000-000000000004') where key = 'merel'),
  'unlocked', 'and the merel unlocked');

select pg_temp.claims('c1400000-0000-0000-0000-000000000004');
set local role authenticated;
select set_my_avatar('merel');
select is((select row(name, symbol, status)::text from my_badges() where key = 'night_owl'),
  '(Nachtuil,moon.zzz.fill,granted)', 'a secret badge shows itself once earned');
reset role;

select pg_temp.as_admin();
select revoke_checkin((select id from d where k = 'early'), 'Foto onduidelijk');
select is((select row(pg_temp.badge(p.id, 'early_bird'), p.avatar_key)::text from profiles p
           where p.id = 'c1400000-0000-0000-0000-000000000004'),
  '(revoked,spruit)', 'revoked: the badge goes and the merel is taken off');

-- erin has done nothing yet
select pg_temp.claims('c1400000-0000-0000-0000-000000000005');
set local role authenticated;
select is((select row(name, description, symbol, status, progress, target)::text from my_badges() where key = 'night_owl'),
  '("Geheime badge","Een verrassing: blijf spelen.",questionmark,locked,,)', 'a secret badge stays hidden, without progress');
select is((select row(count(*), count(*) filter (where status = 'locked'), min(progress))::text from my_badges()),
  '(12,12,0)', 'a new player: every badge locked, no progress');
select is((select hint from my_avatars() where key = 'merel'), 'Verdien de badge Vroege vogel',
  'the hint of the badge avatar names the badge from the catalog');
reset role;
select is(private.avatar_hint('badge', 'night_owl'), 'Verdien een geheime badge', 'a hint keeps a secret badge secret');

-- ---------------------------------------------------------------------------
-- 4. Discoveries and the whole region
-- ---------------------------------------------------------------------------

create temp table f (i integer primary key, id uuid);
insert into f
select i, pg_temp.put('c1400000-0000-0000-0000-000000000006', i, timestamptz '2026-10-01 12:00+02' + i * interval '1 hour',
                      case when i = 10 then 'pending' else 'approved' end)
from generate_series(1, 10) i;
select private.refresh_game_state('c1400000-0000-0000-0000-000000000006');
select is((select row(pg_temp.badge(ub.user_id, 'explorer_10'), pg_temp.badge(ub.user_id, 'whole_neighbourhood'),
                      ub.anchor_checkin_id = (select id from f where i = 10))::text
           from user_badges ub
           where ub.user_id = 'c1400000-0000-0000-0000-000000000006' and ub.badge_key = 'explorer_10'),
  '(pending,granted,t)', 'ten discoveries, one waiting: Ontdekker 10 pending (anchored on the 10th); the region: granted');

select pg_temp.claims('c1400000-0000-0000-0000-000000000006');
set local role authenticated;
select is((select array_agg(row(key, status, progress, target)::text order by sort) from my_badges()
           where key in ('explorer_10', 'explorer_50', 'whole_neighbourhood')),
  array['(explorer_10,pending,10,10)', '(explorer_50,locked,10,50)', '(whole_neighbourhood,granted,3,3)'],
  'my_badges: progress towards each target');
reset role;

select pg_temp.as_admin();
select review_checkin((select id from f where i = 10), true);
select is(pg_temp.badge('c1400000-0000-0000-0000-000000000006', 'explorer_10'), 'granted', 'approved: Ontdekker 10 granted');
select revoke_checkin((select id from f where i = 3), 'Geen vuilbak');
select is(row(pg_temp.badge('c1400000-0000-0000-0000-000000000006', 'explorer_10'),
              pg_temp.badge('c1400000-0000-0000-0000-000000000006', 'whole_neighbourhood'))::text,
  '(revoked,revoked)', 'a revoked discovery: nine left, and a bin of the region missing');

-- The region counts its active bins: a removed bin no longer has to be found.
update bins set status = 'removed' where osm_id = 900000000001403;
select private.refresh_game_state('c1400000-0000-0000-0000-000000000006');
select is(pg_temp.badge('c1400000-0000-0000-0000-000000000006', 'whole_neighbourhood'), 'granted',
  'the region counts its active bins only (bin 3 removed: two of two)');

-- ---------------------------------------------------------------------------
-- 5. Bonus answers: only answered, real and not rejected
-- ---------------------------------------------------------------------------

create temp table g as
select pg_temp.put('c1400000-0000-0000-0000-000000000007', 1, timestamptz '2026-08-01 12:00+02' + n * interval '1 day',
                   'approved', n = 25) as id, n
from generate_series(1, 26) n;
insert into bonus_answers (checkin_id, user_id, bin_id, user_geom, question_key, answer_key, answered_at, is_suspicious,
                           is_test)
select c.id, c.user_id, c.bin_id, c.user_geom, (select q.key from bonus_questions q order by q.key limit 1),
       case when g.n <> 26 then 'x' end, case when g.n <> 26 then c.created_at + interval '1 minute' end,
       case when g.n <> 26 then false end, c.is_test
from g join checkins c on c.id = g.id;
select private.refresh_game_state('c1400000-0000-0000-0000-000000000007');
select is(pg_temp.badge('c1400000-0000-0000-0000-000000000007', 'curious'), 'none',
  '24 real answers (one on a test check-in, one not answered): not yet Nieuwsgierig');

update checkins c set is_test = false from g where c.id = g.id and g.n = 25;
update bonus_answers b set is_test = false from g where b.checkin_id = g.id and g.n = 25;
update checkins c set status = 'pending', reviewed_at = null from g where c.id = g.id and g.n = 24;
select private.refresh_game_state('c1400000-0000-0000-0000-000000000007');
select is(pg_temp.badge('c1400000-0000-0000-0000-000000000007', 'curious'), 'pending',
  'the 25th answer on a check-in that waits: pending');

-- ---------------------------------------------------------------------------
-- 6. Streak weeks (the longest run, test weeks do not fill a gap)
-- ---------------------------------------------------------------------------

create temp table h (w integer primary key, id uuid);
insert into h values
  (1, pg_temp.put('c1400000-0000-0000-0000-000000000008', 1, '2026-09-07 12:00+02', 'approved')),
  (2, pg_temp.put('c1400000-0000-0000-0000-000000000008', 1, '2026-09-14 12:00+02', 'approved')),
  (3, pg_temp.put('c1400000-0000-0000-0000-000000000008', 1, '2026-09-21 12:00+02', 'approved', true)),
  (4, pg_temp.put('c1400000-0000-0000-0000-000000000008', 1, '2026-09-28 12:00+02', 'approved'));
select private.refresh_game_state('c1400000-0000-0000-0000-000000000008');
select is(pg_temp.badge('c1400000-0000-0000-0000-000000000008', 'streak_4'), 'none',
  'a test check-in does not fill the gap in week 3');
insert into h values (5, pg_temp.put('c1400000-0000-0000-0000-000000000008', 2, '2026-09-23 12:00+02', 'pending'));
select private.refresh_game_state('c1400000-0000-0000-0000-000000000008');
select is(pg_temp.badge('c1400000-0000-0000-0000-000000000008', 'streak_4'), 'pending',
  'four weeks with one waiting: Reeks van 4 pending');
select pg_temp.as_admin();
select review_checkin((select id from h where w = 5), true);
select is(row(pg_temp.badge('c1400000-0000-0000-0000-000000000008', 'streak_4'),
              pg_temp.badge('c1400000-0000-0000-0000-000000000008', 'streak_8'))::text,
  '(granted,none)', 'approved: Reeks van 4 granted, Reeks van 8 not');

-- ---------------------------------------------------------------------------
-- 7. Reports start the refresh (Kaartmaker)
-- ---------------------------------------------------------------------------

insert into bin_reports (user_id, geom, photo_path)
values ('c1400000-0000-0000-0000-000000000003', 'SRID=4326;POINT(0.02 0.02)', 'c1400000-0000-0000-0000-000000000003/r.jpg');
select is(pg_temp.badge('c1400000-0000-0000-0000-000000000003', 'mapmaker'), 'pending', 'a new report: Kaartmaker pending');
select pg_temp.as_admin();
select review_bin_report((select id from bin_reports where user_id = 'c1400000-0000-0000-0000-000000000003'), true);
select is(pg_temp.badge('c1400000-0000-0000-0000-000000000003', 'mapmaker'), 'granted', 'the report approved: granted');

-- ---------------------------------------------------------------------------
-- 8. Test check-ins make no badges; inactive badges are not evaluated
-- ---------------------------------------------------------------------------

create temp table t1 as select * from pg_temp.checkin('c1400000-0000-0000-0000-000000000002', 5, true);
select is((select row(ok, is_test, game is null)::text from t1), '(t,t,t)', 'a test check-in: no game');
select is_empty($$ select 1 from user_badges where user_id = 'c1400000-0000-0000-0000-000000000002' $$,
  'and no badge');

update badges set active = false where key = 'explorer_100';
select pg_temp.claims('c1400000-0000-0000-0000-000000000005');
set local role authenticated;
select is((select count(*) from my_badges() where key = 'explorer_100'), 0::bigint, 'an inactive badge is not shown');
reset role;
select is((select count(*) from jsonb_array_elements(game_catalog()->'badges') x where x->>'key' = 'explorer_100'),
  0::bigint, 'nor in the catalog');

-- ---------------------------------------------------------------------------
-- 9. Rights and invariants
-- ---------------------------------------------------------------------------

select pg_temp.claims('c1400000-0000-0000-0000-000000000001');
set local role authenticated;
select is((select count(*) from user_badges where user_id <> 'c1400000-0000-0000-0000-000000000001'), 0::bigint,
  'a user reads only their own badges');
select throws_ok($$ insert into user_badges (user_id, badge_key, status)
                    values ('c1400000-0000-0000-0000-000000000001', 'curious', 'granted') $$,
  '42501', null, 'users cannot write badges');
select throws_ok($$ select * from badges $$, '42501', null, 'the catalog table is not readable (game_catalog is)');
reset role;

select set_config('request.jwt.claims', '', true);
select throws_ok($$ select * from my_badges() $$, '42501', null, 'my_badges needs a user');

select is((select sum(private.refresh_game_state(p.id))::integer from profiles p where p.id::text like 'c1400000-%'), 0,
  'a refresh of every player changes nothing');
select is_empty($$ select * from private.check_points_invariant() $$, 'profiles equal their ledger');

select * from finish();
rollback;
