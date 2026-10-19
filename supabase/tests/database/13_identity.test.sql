-- Identity (phase 4): the levels and avatars of the catalog, a new account
-- without a name from its e-mail address, the onboarding and its rules for
-- names and avatars, set_my_name and set_my_avatar, unlocks by level (only
-- granted real points, pending shown as pending) and by milestone, a rejection
-- that lowers the level and takes off the avatar, test points that unlock
-- nothing, the level and statistics in my_game_state, the leaderboard with
-- avatar, level and title, and who may read or write what.
-- Run with: npm run db:test

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(65);

-- ---------------------------------------------------------------------------
-- Fixtures (as postgres): alice, the admin, bob and carol
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, aud, role) values
  ('c1300000-0000-0000-0000-000000000001', 'id-alice@example.test', 'authenticated', 'authenticated'),
  ('c1300000-0000-0000-0000-000000000002', 'id-admin@example.test', 'authenticated', 'authenticated'),
  ('c1300000-0000-0000-0000-000000000003', 'id-bob@example.test', 'authenticated', 'authenticated'),
  ('c1300000-0000-0000-0000-000000000004', 'id-carol@example.test', 'authenticated', 'authenticated');
update profiles set is_admin = true, display_name = 'Beheer' where id = 'c1300000-0000-0000-0000-000000000002';

insert into private.app_environment (name) values ('local')
on conflict (singleton) do update set name = excluded.name;

-- One bin at Null Island.
insert into bins (osm_type, osm_id, geom, status, eligible) values
  ('node', 900000000001301, 'SRID=4326;POINT(0 0)', 'active', true);

-- Badges are tested in 14_badges; none here, so the badge avatar stays locked
-- at every hour of the day (Vroege vogel).
update badges set active = false;

-- A real check-in of `who` at that bin, 5 m north of it.
create function pg_temp.checkin(who uuid) returns uuid language sql as $$
  select r.checkin_id
  from public.bins b,
    lateral public.record_checkin(gen_random_uuid(), who, b.id,
      st_y(st_project(b.geom, 5, 0)::geometry), st_x(st_project(b.geom, 5, 0)::geometry),
      5, false, false, who::text || '/x.jpg') r
  where b.osm_id = 900000000001301;
$$;

create function pg_temp.claims(who uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
$$;

-- ---------------------------------------------------------------------------
-- 1. Catalog
-- ---------------------------------------------------------------------------

select is((select array_agg(level order by level) from levels), (select array_agg(g) from generate_series(1, 20) g),
  '20 levels');
select is_empty($$ select level from levels where min_points <> round(10 * power(level - 1, 2.6) / 5) * 5 $$,
  'every threshold is 10 x (L-1)^2.6 rounded to 5');
select is((select array_agg(min_points order by level) from levels where level in (2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20)),
  array[10, 60, 175, 370, 655, 1055, 1575, 2230, 3025, 5100, 9550, 21125], 'the thresholds of chapter 3');
select is((select array_agg(title order by level) from levels where level in (1, 2, 3, 4, 5, 6, 7, 8, 10, 13, 16, 19, 20)),
  array['Wegwerp-rookie', 'Blikjesbuddy', 'Peukenpikker', 'Stoepridder', 'Papiertjesprof', 'Buurtbezem',
        'Pleinpatrouille', 'Leiewachter', 'Straatheld', 'Afvalalchemist', 'Netheidsninja', 'Afvallegende',
        'Vuilbakkoning'],
  'the titles of chapter 3');
select is((select array_agg(key order by sort) from avatars where active),
  array['spruit', 'vos', 'zon', 'berg', 'bloem', 'bliksem', 'eik', 'haas', 'schildpad', 'merel', 'maan', 'regenboog'],
  '12 avatars');
select is((select count(*)::integer from avatars where unlock_type = 'default' and rarity = 'common'), 4,
  'four common default avatars');
select is(
  (select string_agg(unlock_type || ':' || coalesce(unlock_param, '') || ':' || rarity, ',' order by sort)
   from avatars where unlock_type <> 'default'),
  'level:5:rare,level:8:rare,level:12:epic,milestone:50:rare,milestone:100:epic,badge:early_bird:rare,chest::epic,chest::legendary',
  'three by level, two by milestone, one by badge, two only from the chest (epic, legendary)');
select is_empty($$
  select key from avatars
  where (unlock_type = 'level' and unlock_param::integer not in (select level from levels))
     or (unlock_type = 'milestone' and unlock_param::integer not in (select threshold from milestones))
$$, 'every level and milestone of an avatar exists');
select is(private.default_avatar(), 'spruit', 'the standard avatar is the first default');
select throws_ok($$ insert into avatars (key, name, rarity, unlock_type, sort, placeholder_symbol, placeholder_color)
                    values ('draak', 'Draak', 'rare', 'level', 13, 'flame.fill', '#AA0000') $$,
  '23514', null, 'a level avatar needs its level');
select is((select game_catalog()->'levels'->4), '{"level": 5, "min_points": 370, "title": "Papiertjesprof"}'::jsonb,
  'game_catalog has the levels');
select is((select row(jsonb_array_length(c->'levels'), jsonb_array_length(c->'avatars'))::text from (select game_catalog() c) x),
  '(20,12)', 'all 20 levels and 12 avatars');
select is((select game_catalog()->'avatars'->4),
  '{"key": "bloem", "name": "Bloem", "rarity": "rare", "unlock_type": "level", "unlock_param": "5", "sort": 5,
    "placeholder_symbol": "camera.macro", "placeholder_color": "#C2508A"}'::jsonb,
  'an avatar with its unlock and placeholder');

-- ---------------------------------------------------------------------------
-- 2. A new account
-- ---------------------------------------------------------------------------

select is((select row(display_name, avatar_key, onboarded_at, last_seen_level)::text from profiles
           where id = 'c1300000-0000-0000-0000-000000000001'),
  '(,,,1)', 'a new account gets no name from its e-mail address, no avatar and no onboarding yet');

select pg_temp.claims('c1300000-0000-0000-0000-000000000001');
set local role authenticated;
select throws_ok($$ update profiles set display_name = 'id-alice' where id = auth.uid() $$, '42501', null,
  'users cannot write their name directly');
select throws_ok($$ update profiles set avatar_key = 'eik' where id = auth.uid() $$, '42501', null,
  'nor their avatar');
select throws_ok($$ update profiles set onboarded_at = now() where id = auth.uid() $$, '42501', null,
  'nor their onboarding');
select throws_ok($$ select * from levels $$, '42501', null, 'the levels are read through game_catalog only');
select throws_ok($$ select * from avatars $$, '42501', null, 'and the avatars');

-- ---------------------------------------------------------------------------
-- 3. Onboarding
-- ---------------------------------------------------------------------------

select is((select string_agg(a.key || ':' || a.status, ',' order by a.sort) from my_avatars() a where a.unlock_type = 'default'),
  'spruit:unlocked,vos:unlocked,zon:unlocked,berg:unlocked',
  'the default avatars are unlocked');
select is((select string_agg(a.key || ':' || a.status, ',' order by a.sort) from my_avatars() a where a.unlock_type <> 'default'),
  'bloem:locked,bliksem:locked,eik:locked,haas:locked,schildpad:locked,merel:locked,maan:locked,regenboog:locked',
  'the others are locked');
select is((select array_agg(a.hint order by a.sort) from my_avatars() a),
  array[null, null, null, null, 'Bereik level 5', 'Bereik level 8', 'Bereik level 12', 'Ontdek 50 vuilbakken',
        'Ontdek 100 vuilbakken', 'Verdien de badge Vroege vogel', 'Alleen te vinden in de dagkist',
        'Alleen te vinden in de dagkist'],
  'a locked avatar says how to unlock it');
select is((select array_agg(a.key) from my_avatars() a where a.is_current), array['spruit'],
  'without a choice the standard avatar is the current one');

select throws_ok($$ select complete_onboarding(' a ', 'vos') $$, '22023', null, 'a name needs 2 characters');
select throws_ok($$ select complete_onboarding(repeat('x', 25), 'vos') $$, '22023', null, 'and at most 24');
select throws_ok($$ select complete_onboarding(E'Al\x07ice', 'vos') $$, '22023', null, 'and no control characters');
select throws_ok($$ select complete_onboarding(null, 'vos') $$, '22023', null, 'a name is required');
select throws_ok($$ select complete_onboarding('Alice', 'bloem') $$, '42501', null, 'a locked avatar is refused');
select throws_ok($$ select complete_onboarding('Alice', 'draak') $$, 'P0002', null, 'and an unknown one');
select is((select onboarded_at from profiles where id = auth.uid()), null, 'after a refusal nothing changed');
select is(
  (select row(r->>'display_name', r->>'avatar_key', (r->>'onboarded_at')::timestamptz = now())::text
   from (select complete_onboarding(E'  Alice \t  Peeters ', 'vos') r) x),
  '("Alice Peeters",vos,t)', 'complete_onboarding saves the trimmed name, the avatar and the time');
select is((select array_agg(a.key) from my_avatars() a where a.is_current), array['vos'], 'vos is the current avatar');
reset role;
update profiles set onboarded_at = '2026-10-01 10:00+02' where id = 'c1300000-0000-0000-0000-000000000001';
set local role authenticated;
select is((select row(r->>'display_name', r->>'avatar_key', (r->>'onboarded_at')::timestamptz)::text
           from (select complete_onboarding('Alice', 'zon') r) x),
  row('Alice', 'zon', '2026-10-01 10:00+02'::timestamptz)::text,
  'onboarding again changes name and avatar, onboarded_at stays');

select is(set_my_name('  Ali   P  '), 'Ali P', 'set_my_name saves the trimmed name');
select throws_ok($$ select set_my_name('x') $$, '22023', null, 'with the same rule');
select throws_ok($$ select set_my_avatar('bloem') $$, '42501', null, 'set_my_avatar refuses a locked avatar');
select throws_ok($$ select set_my_avatar('draak') $$, 'P0002', null, 'and an unknown one');
select is(set_my_avatar('berg'), 'berg', 'and puts on an unlocked one');
select is((select row(display_name, avatar_key)::text from profiles where id = auth.uid()), '("Ali P",berg)',
  'the profile has the name and the avatar');
reset role;

-- ---------------------------------------------------------------------------
-- 4. Unlocks by level; a revocation takes them back
-- ---------------------------------------------------------------------------

create temp table c1 as select pg_temp.checkin('c1300000-0000-0000-0000-000000000001') as id;
create temp table c1_points as select points_earned as x from checkins where id = (select id from c1);

select pg_temp.claims('c1300000-0000-0000-0000-000000000001');
set local role authenticated;
select is(my_game_state()->'level',
  '{"level": 1, "title": "Wegwerp-rookie", "min_points": 0, "next": {"level": 2, "title": "Blikjesbuddy", "min_points": 10}}'::jsonb,
  'pending points make no level');
reset role;

-- The admin gives alice what she needs for level 5 minus the pending check-in.
select pg_temp.claims('c1300000-0000-0000-0000-000000000002');
select adjust_points('c1300000-0000-0000-0000-000000000001', 370 - (select x from c1_points), 'Test');

select pg_temp.claims('c1300000-0000-0000-0000-000000000001');
set local role authenticated;
select is((select row(my_game_state()->'level'->>'level', s.v)::text
           from (select string_agg(a.key || ':' || a.status, ',' order by a.sort) as v
                 from my_avatars() a where a.unlock_type = 'level') s),
  '(4,"bloem:pending,bliksem:locked,eik:locked")',
  'level 4; bloem waits for the approval of the check-in that reaches level 5');
select throws_ok($$ select set_my_avatar('bloem') $$, '42501', null, 'a pending avatar cannot be worn yet');
reset role;

select pg_temp.claims('c1300000-0000-0000-0000-000000000002');
select review_checkin((select id from c1), true);

select pg_temp.claims('c1300000-0000-0000-0000-000000000001');
set local role authenticated;
select is(my_game_state()->'level',
  '{"level": 5, "title": "Papiertjesprof", "min_points": 370, "next": {"level": 6, "title": "Buurtbezem", "min_points": 655}}'::jsonb,
  'approved: level 5 with the next level');
select is(my_game_state()->'stats', '{"checkins": 1, "bonus_answers": 0, "longest_streak": 1}'::jsonb,
  'the statistics: one check-in, a streak of one week');
select is((select string_agg(a.key || ':' || a.status, ',' order by a.sort) from my_avatars() a where a.unlock_type = 'level'),
  'bloem:unlocked,bliksem:locked,eik:locked', 'bloem is unlocked');
select is(set_my_avatar('bloem'), 'bloem', 'and can be worn');
select is(
  (select row(l.place, l.display_name, l.points, l.is_me, l.avatar_key, l.level, l.title)::text
   from leaderboard('all') l where l.is_me),
  '(1,"Ali P",370,t,bloem,5,Papiertjesprof)', 'the leaderboard shows avatar, level and title');
reset role;

select pg_temp.claims('c1300000-0000-0000-0000-000000000002');
select revoke_checkin((select id from c1), 'Dubbele foto');

select pg_temp.claims('c1300000-0000-0000-0000-000000000001');
set local role authenticated;
select is((select row(my_game_state()->'level'->>'level', p.avatar_key)::text from profiles p where p.id = auth.uid()),
  '(4,spruit)', 'revoked: back on level 4 and on the standard avatar');
select is(my_game_state()->'stats', '{"checkins": 0, "bonus_answers": 0, "longest_streak": 0}'::jsonb,
  'a revoked check-in no longer counts');
reset role;
select is(private.refresh_game_state('c1300000-0000-0000-0000-000000000001'), 0, 'a refresh then changes nothing');

-- ---------------------------------------------------------------------------
-- 5. Test points unlock nothing
-- ---------------------------------------------------------------------------

insert into point_transactions (user_id, is_test, source, reward_key, amount, status, granted_at)
values ('c1300000-0000-0000-0000-000000000003', true, 'adjustment', 'adjustment:test13', 5000, 'granted', now());

select pg_temp.claims('c1300000-0000-0000-0000-000000000003');
set local role authenticated;
select is((select row(p.test_points, my_game_state()->'level'->>'level')::text from profiles p where p.id = auth.uid()),
  '(5000,1)', '5000 test points: still level 1');
select is((select string_agg(a.status, ',') from my_avatars() a where a.unlock_type = 'level'), 'locked,locked,locked',
  'and no level avatar');
reset role;

select pg_temp.claims('c1300000-0000-0000-0000-000000000002');
set local role authenticated;
select is(
  (select row(l.display_name, l.points, l.avatar_key, l.level, l.title)::text
   from leaderboard('all', 50, true) l where l.points = 5000),
  '(Anoniem,5000,spruit,1,Wegwerp-rookie)',
  'with test data: the test points count on the board, not for the level; no name, the standard avatar');
reset role;

-- ---------------------------------------------------------------------------
-- 6. Unlocks by milestone; inactive avatars
-- ---------------------------------------------------------------------------

insert into user_milestones (user_id, threshold, points, status)
values ('c1300000-0000-0000-0000-000000000004', 50, 150, 'pending');

select pg_temp.claims('c1300000-0000-0000-0000-000000000004');
set local role authenticated;
select is((select string_agg(a.key || ':' || a.status, ',' order by a.sort) from my_avatars() a where a.unlock_type = 'milestone'),
  'haas:pending,schildpad:locked', 'a pending milestone 50: haas waits');
reset role;
update user_milestones set status = 'granted' where user_id = 'c1300000-0000-0000-0000-000000000004';
set local role authenticated;
select is(set_my_avatar('haas'), 'haas', 'granted: haas can be worn');
reset role;

-- The milestone falls (carol has no discoveries): the refresh revokes it and
-- takes off haas.
select is(private.refresh_game_state('c1300000-0000-0000-0000-000000000004') > 0, true, 'the refresh revokes the milestone');
select is((select row(m.status, p.avatar_key)::text from user_milestones m join profiles p on p.id = m.user_id
           where m.user_id = 'c1300000-0000-0000-0000-000000000004'),
  '(revoked,spruit)', 'and puts carol back on the standard avatar');

set local role authenticated;
select set_my_avatar('vos');
reset role;
update avatars set active = false where key = 'vos';
set local role authenticated;
select is((select row(jsonb_array_length(game_catalog()->'avatars'), (select count(*) from my_avatars()))::text),
  '(11,11)', 'an inactive avatar is gone from the catalog and the picker');
select throws_ok($$ select set_my_avatar('vos') $$, 'P0002', null, 'and cannot be put on');
reset role;
select is(private.refresh_avatar('c1300000-0000-0000-0000-000000000004'), 1, 'whoever wore it gets the standard avatar');
update avatars set active = true where key = 'vos';

-- ---------------------------------------------------------------------------
-- 7. Rights
-- ---------------------------------------------------------------------------

select is_empty($$
  select f from unnest(array['complete_onboarding(text,text)', 'set_my_name(text)', 'set_my_avatar(text)', 'my_avatars()']) f
  where has_function_privilege('anon', 'public.' || f, 'execute')
     or not has_function_privilege('authenticated', 'public.' || f, 'execute')
$$, 'the new RPCs are for signed-in users only');

set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($$ select my_avatars() $$, '42501', null, 'without a user there are no avatars');
select throws_ok($$ select complete_onboarding('Nobody', 'vos') $$, '42501', null, 'and no onboarding');
reset role;

-- ---------------------------------------------------------------------------
-- 8. Invariants
-- ---------------------------------------------------------------------------

select is_empty($$ select p.id from profiles p where p.avatar_key is not null and p.avatar_key not in (select key from avatars) $$,
  'every worn avatar exists');
select is_empty($$ select * from private.check_points_invariant() $$, 'every profile equals its ledger');

select * from finish();
rollback;
