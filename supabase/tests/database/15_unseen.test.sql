-- Unseen results (phase 5): the decisions in my_unseen() since
-- results_seen_at (approved with their points per source, rejected and
-- revoked with their reason, the total and the level before and after, badges
-- granted and avatars unlocked), mark_seen('results') with last_seen_level,
-- a review between my_unseen and mark_seen that is shown the next time, badge
-- moments, test check-ins that are never a result, and who may call what.
-- Run with: npm run db:test

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(24);

-- No quests (phase 6) in this test: no quest rewards, no chest.
update quest_templates set active = false;

-- ---------------------------------------------------------------------------
-- Fixtures (as postgres): alice (user), the admin
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, aud, role) values
  ('c1500000-0000-0000-0000-000000000001', 'unseen-alice@example.test', 'authenticated', 'authenticated'),
  ('c1500000-0000-0000-0000-000000000002', 'unseen-admin@example.test', 'authenticated', 'authenticated');
update profiles set is_admin = true where id = 'c1500000-0000-0000-0000-000000000002';

insert into private.app_environment (name) values ('local')
on conflict (singleton) do update set name = excluded.name;

-- Three bins 200 m apart east of Null Island, all in the region.
insert into bins (osm_type, osm_id, geom, status, eligible)
select 'node', 900000000001500 + i, st_project('SRID=4326;POINT(0 0)'::geography, 200 * (i - 1), radians(90)),
       'active', true
from generate_series(1, 3) i;
update game_config set value = '-0.005' where key = 'region_west';
update game_config set value = '-0.005' where key = 'region_south';
update game_config set value = '0.005' where key = 'region_east';
update game_config set value = '0.005' where key = 'region_north';

-- No streak multiplier: a check-in is 10, a discovery 15. The hour badges are
-- tested in 14_badges; without them the results are the same at every hour.
-- Level 3 from 25 points, the merel by Eerste inworp and the bloem by level 3,
-- so a few check-ins show a level-up and unlocked avatars.
update game_config set value = '0' where key = 'streak_max_steps';
update badges set active = false where key in ('early_bird', 'night_owl');
update levels set min_points = 25 where level = 3;
update avatars set unlock_param = 'first_checkin' where key = 'merel';
update avatars set unlock_param = '3' where key = 'bloem';

-- alice saw everything until yesterday
update profiles set moments_seen_at = now() - interval '1 day', results_seen_at = now() - interval '1 day'
where id = 'c1500000-0000-0000-0000-000000000001';

create function pg_temp.bin(i integer) returns bigint language sql as $$
  select b.id from public.bins b where b.osm_id = 900000000001500 + i;
$$;

create function pg_temp.checkin(who uuid, i integer, fake boolean default false) returns uuid language sql as $$
  select r.checkin_id
  from public.bins b,
    lateral public.record_checkin(gen_random_uuid(), who, b.id,
      st_y(st_project(b.geom, 5, 0)::geometry), st_x(st_project(b.geom, 5, 0)::geometry),
      5, false, fake, who::text || '/x.jpg') r
  where b.osm_id = 900000000001500 + i;
$$;

-- Time passes for `who` (check-ins and their facts move back), so cooldowns end.
create function pg_temp.later(who uuid, by interval) returns void language sql as $$
  update public.checkins set created_at = created_at - by where user_id = who;
  update public.discoveries set discovered_at = discovered_at - by where user_id = who;
  update public.user_milestones set reached_at = reached_at - by where user_id = who;
  update public.user_badges set earned_at = earned_at - by where user_id = who;
  update public.point_transactions set earned_at = earned_at - by where user_id = who;
$$;

create function pg_temp.claims(who uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
$$;

create function pg_temp.as_admin() returns void language sql as $$
  select pg_temp.claims('c1500000-0000-0000-0000-000000000002');
$$;

-- my_unseen() of alice, kept in table `u` under a name.
create temp table u (name text primary key, j jsonb);
create function pg_temp.unseen(label text) returns jsonb language plpgsql as $$
declare
  result jsonb;
begin
  perform pg_temp.claims('c1500000-0000-0000-0000-000000000001');
  set local role authenticated;
  result := public.my_unseen();
  reset role;
  insert into u values (label, result) on conflict (name) do update set j = excluded.j;
  return result;
end;
$$;

-- mark_seen() of alice.
create function pg_temp.mark(kind text, until timestamptz) returns timestamptz language plpgsql as $$
declare
  result timestamptz;
begin
  perform pg_temp.claims('c1500000-0000-0000-0000-000000000001');
  set local role authenticated;
  result := public.mark_seen(kind, until);
  reset role;
  return result;
end;
$$;

create function pg_temp.as_of(name text) returns timestamptz language sql as $$
  select (u.j->>'as_of')::timestamptz from u where u.name = $1;
$$;

-- The numbers of a result: approved, rejected, gained, per source, before, after.
create function pg_temp.sums(r jsonb) returns jsonb language sql as $$
  select jsonb_build_array(r->'approved_count', r->'rejected_count', r->'gained', r->'by_source', r->'points_before',
                           r->'points_after');
$$;

create function pg_temp.levels(r jsonb) returns jsonb language sql as $$
  select jsonb_build_array(r->'level_before', r->'level_after', r->'level_title');
$$;

-- One field of every element of an array, in order.
create function pg_temp.keys(a jsonb, k text default 'key') returns jsonb language sql as $$
  select coalesce(jsonb_agg(x->k order by i), '[]'::jsonb) from jsonb_array_elements(a) with ordinality y(x, i);
$$;

-- ---------------------------------------------------------------------------
-- 1. Nothing decided yet
-- ---------------------------------------------------------------------------

select is((select results_seen_at is not null from profiles where id = 'c1500000-0000-0000-0000-000000000002'), true,
  'a new profile has results_seen_at');

create temp table c1 as select pg_temp.checkin('c1500000-0000-0000-0000-000000000001', 1) as id;
select pg_temp.unseen('start');
select is((select pg_temp.sums(j->'results') from u where name = 'start'), '[0, 0, 0, {}, 0, 0]'::jsonb,
  'a check-in that waits is no decision');
select is((select pg_temp.levels(j->'results') from u where name = 'start'), '[1, 1, "Wegwerp-rookie"]'::jsonb,
  'level 1 before and after');
select is((select pg_temp.keys(j->'moments', 'kind') from u where name = 'start'), '["discovery", "badge"]'::jsonb,
  'moments: the discovery and the badge it earned');
select is((select (j->'moments'->1) - 'at' from u where name = 'start'),
  '{"kind": "badge", "key": "first_checkin", "name": "Eerste inworp", "description": "Doe je eerste inworp.",
    "symbol": "hand.thumbsup.fill", "rarity": "common", "status": "pending"}'::jsonb,
  'a badge moment has its name, symbol and status');

-- ---------------------------------------------------------------------------
-- 2. Approved: the points per source, the total, the level, badge and avatar
-- ---------------------------------------------------------------------------

select pg_temp.as_admin();
select review_checkin((select id from c1), true);
select pg_temp.unseen('approved');
select is((select pg_temp.sums(j->'results') from u where name = 'approved'),
  '[1, 0, 15, {"checkin": 10, "discovery": 5}, 0, 15]'::jsonb, 'approved: +15 (10 check-in, 5 discovery), 0 to 15');
select is((select (j->'results'->'approved'->0) - 'decided_at' from u where name = 'approved'),
  jsonb_build_object('checkin_id', (select id from c1), 'bin_id', pg_temp.bin(1), 'points', 15),
  'the approved check-in with its points');
select is((select pg_temp.levels(j->'results') from u where name = 'approved'), '[1, 2, "Blikjesbuddy"]'::jsonb,
  'a level-up from 1 to 2 with the new title');
select is((select jsonb_build_array(pg_temp.keys(j->'results'->'badges'), pg_temp.keys(j->'results'->'avatars'))
           from u where name = 'approved'),
  '[["first_checkin"], ["merel"]]'::jsonb, 'the badge granted and the avatar it unlocked');

select is(pg_temp.mark('results', pg_temp.as_of('approved')), pg_temp.as_of('approved'),
  'mark_seen(results) moves to as_of');
select is((select last_seen_level from profiles where id = 'c1500000-0000-0000-0000-000000000001'), 2,
  'and the level is seen');
select pg_temp.unseen('after');
select is((select jsonb_build_array(pg_temp.sums(j->'results'), pg_temp.levels(j->'results')) from u where name = 'after'),
  '[[0, 0, 0, {}, 15, 15], [2, 2, "Blikjesbuddy"]]'::jsonb, 'seen: nothing left');

-- ---------------------------------------------------------------------------
-- 3. A review between my_unseen and mark_seen is shown the next time
-- ---------------------------------------------------------------------------

select pg_temp.later('c1500000-0000-0000-0000-000000000001', interval '1 hour');
create temp table c2 as select pg_temp.checkin('c1500000-0000-0000-0000-000000000001', 2) as id;
select pg_temp.unseen('before review');
select pg_temp.as_admin();
select review_checkin((select id from c2), true);
select pg_temp.mark('results', pg_temp.as_of('before review'));
select is((select last_seen_level from profiles where id = 'c1500000-0000-0000-0000-000000000001'), 2,
  'mark_seen sets the level of the points at as_of, not of now');
select pg_temp.unseen('next');
select is((select pg_temp.sums(j->'results') from u where name = 'next'),
  '[1, 0, 15, {"checkin": 10, "discovery": 5}, 15, 30]'::jsonb, 'the review in between: shown now');
select is((select jsonb_build_array(pg_temp.keys(j->'results'->'approved', 'checkin_id'), pg_temp.levels(j->'results'),
                                    pg_temp.keys(j->'results'->'avatars'))
           from u where name = 'next'),
  jsonb_build_array(jsonb_build_array((select id from c2)), '[2, 3, "Peukenpikker"]'::jsonb, '["bloem"]'::jsonb),
  'that check-in, with its level-up and the level avatar');
select pg_temp.mark('results', pg_temp.as_of('next'));

-- ---------------------------------------------------------------------------
-- 4. Rejected and revoked: calm, with the reason; the level may drop
-- ---------------------------------------------------------------------------

select pg_temp.later('c1500000-0000-0000-0000-000000000001', interval '1 hour');
create temp table c3 as select pg_temp.checkin('c1500000-0000-0000-0000-000000000001', 3) as id;
select pg_temp.as_admin();
select review_checkin((select id from c3), false, 'Foto onduidelijk');
select revoke_checkin((select id from c1), 'Dubbel');
select pg_temp.unseen('rejected');
select is((select pg_temp.sums(j->'results') from u where name = 'rejected'), '[0, 2, 0, {}, 30, 15]'::jsonb,
  'two rejections: nothing gained, 30 to 15');
select is((select jsonb_agg(x - 'decided_at' - 'bin_id' order by i)
           from u cross join lateral jsonb_array_elements(u.j->'results'->'rejected') with ordinality y(x, i)
           where u.name = 'rejected'),
  jsonb_build_array(
    jsonb_build_object('checkin_id', (select id from c3), 'reason', 'Foto onduidelijk', 'revoked', false),
    jsonb_build_object('checkin_id', (select id from c1), 'reason', 'Dubbel', 'revoked', true)),
  'rejected with its reason, revoked marked');
select is((select pg_temp.levels(j->'results') from u where name = 'rejected'), '[3, 2, "Blikjesbuddy"]'::jsonb,
  'the level drops (no level-up)');
select is((select pg_temp.keys(j->'results'->'badges') from u where name = 'rejected'), '[]'::jsonb,
  'no badge granted');

-- ---------------------------------------------------------------------------
-- 5. mark_seen never moves back or past now; test check-ins; rights
-- ---------------------------------------------------------------------------

select pg_temp.mark('results', pg_temp.as_of('rejected'));
select is(pg_temp.mark('results', '2000-01-01'), pg_temp.as_of('rejected'), 'mark_seen never moves back');
select ok(pg_temp.mark('results', 'infinity') <= clock_timestamp(), 'nor past now');

-- the admin approves a test check-in of their own: no result
select pg_temp.as_admin();
select review_checkin(pg_temp.checkin('c1500000-0000-0000-0000-000000000002', 1, true), true);
set local role authenticated;
select is((select pg_temp.sums(my_unseen()->'results')), '[0, 0, 0, {}, 0, 0]'::jsonb,
  'a test check-in is never a result');
reset role;

select set_config('request.jwt.claims', '', true);
select throws_ok($$ select mark_seen('results', now()) $$, '42501', null, 'mark_seen needs a user');

select is_empty($$ select * from private.check_points_invariant() $$, 'profiles equal their ledger');

select * from finish();
rollback;
