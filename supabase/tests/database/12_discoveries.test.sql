-- Discoveries, milestones and the collection (phase 3): the discovery step in
-- the score and its ledger parts, the first check-in at a bin that was not
-- rejected, a rejection that moves the discovery or revokes it, milestones
-- pending/granted/revoked and earned again with their frozen amount, test
-- check-ins that make no game facts, a refresh that changes nothing the second
-- time, errors that never fail a check-in, my_collection, my_game_state,
-- my_unseen/mark_seen, and who may read or write what.
-- Run with: npm run db:test

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(62);

-- ---------------------------------------------------------------------------
-- Fixtures (as postgres): alice (user), the admin, bob (user)
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, aud, role) values
  ('c1200000-0000-0000-0000-000000000001', 'disc-alice@example.test', 'authenticated', 'authenticated'),
  ('c1200000-0000-0000-0000-000000000002', 'disc-admin@example.test', 'authenticated', 'authenticated'),
  ('c1200000-0000-0000-0000-000000000003', 'disc-bob@example.test', 'authenticated', 'authenticated');
update profiles set is_admin = true where id = 'c1200000-0000-0000-0000-000000000002';

insert into private.app_environment (name) values ('local')
on conflict (singleton) do update set name = excluded.name;

-- Twelve bins 200 m apart east of Null Island, inside the region below, and
-- one outside it.
insert into bins (osm_type, osm_id, geom, status, eligible)
select 'node', 900000000001200 + i, st_project('SRID=4326;POINT(0 0)'::geography, 200 * (i - 1), radians(90)),
       'active', true
from generate_series(1, 12) i;
insert into bins (osm_type, osm_id, geom, status, eligible) values
  ('node', 900000000001213, 'SRID=4326;POINT(0.5 0.5)', 'active', true);

update game_config set value = '-0.005' where key = 'region_west';
update game_config set value = '-0.005' where key = 'region_south';
update game_config set value = '0.025' where key = 'region_east';
update game_config set value = '0.005' where key = 'region_north';

create function pg_temp.bin(i integer) returns bigint language sql as $$
  select b.id from public.bins b where b.osm_id = 900000000001200 + i;
$$;

-- record_checkin for `who` at bin i, 5 m north of it, real or fake location.
create function pg_temp.checkin(who uuid, i integer, fake boolean default false)
returns table (ok boolean, checkin_id uuid, score jsonb, game jsonb, is_test boolean)
language sql as $$
  select r.ok, r.checkin_id, r.score, r.game, r.is_test
  from public.bins b,
    lateral public.record_checkin(gen_random_uuid(), who, b.id,
      st_y(st_project(b.geom, 5, 0)::geometry), st_x(st_project(b.geom, 5, 0)::geometry),
      5, false, fake, who::text || '/x.jpg') r
  where b.osm_id = 900000000001200 + i;
$$;

-- Time passes for `who`: everything of that user moves back by `by`, so
-- check-ins get their own times and cooldowns end. The game state stays
-- consistent (a refresh finds nothing to change).
create function pg_temp.later(who uuid, by interval) returns void language sql as $$
  update public.checkins set created_at = created_at - by where user_id = who;
  update public.discoveries set discovered_at = discovered_at - by where user_id = who;
  update public.user_milestones set reached_at = reached_at - by where user_id = who;
  update public.point_transactions set earned_at = earned_at - by where user_id = who;
$$;

-- A check-in of `who` at bin i, a second after the previous one. Its result
-- is kept in table `runs` under the bin number.
create temp table runs (i integer primary key, checkin_id uuid, score jsonb, game jsonb);
create function pg_temp.run(who uuid, i integer) returns void language plpgsql as $$
begin
  perform pg_temp.later(who, interval '1 second');
  insert into runs (i, checkin_id, score, game)
  select i, r.checkin_id, r.score, r.game from pg_temp.checkin(who, i) r;
end;
$$;

create function pg_temp.rows_of(c uuid) returns text language sql as $$
  select string_agg(t.source || ':' || t.amount || ':' || t.status || case when t.is_test then ':test' else '' end,
                    ',' order by t.source)
  from public.point_transactions t where t.checkin_id = c;
$$;

create function pg_temp.kinds(s jsonb) returns text[] language sql as $$
  select array_agg(x.step->>'kind' order by x.i) from jsonb_array_elements(s->'steps') with ordinality x(step, i);
$$;

create function pg_temp.as_admin() returns void language sql as $$
  select set_config('request.jwt.claims', '{"sub":"c1200000-0000-0000-0000-000000000002","role":"authenticated"}', true);
$$;

-- ---------------------------------------------------------------------------
-- 1. Catalog and config
-- ---------------------------------------------------------------------------

select is((select array_agg(threshold order by threshold) from milestones),
  array[10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150],
  'a milestone every 10 discoveries');
select is((select array_agg(points order by threshold) from milestones where threshold in (10, 50, 100)),
  array[50, 150, 300], '+50 each, with jumps at 50 (+150) and 100 (+300)');
select is(
  (select row(jsonb_array_length(c->'milestones'), c->'milestones'->0, c->'config'->'discovery_chips')::text
   from (select game_catalog() c) x),
  '(15,"{""points"": 50, ""threshold"": 10}",5)', 'game_catalog has the milestones and the discovery chips');

-- ---------------------------------------------------------------------------
-- 2. The score: discovery step, streak extended, ledger parts
-- ---------------------------------------------------------------------------

select is(private.checkin_score(0, true, true),
  '{"steps": [{"kind": "base", "label": "BASIS", "chips": 10, "mult": 1, "total": 10},
              {"kind": "discovery", "label": "NIEUW", "chips": 15, "mult": 1, "total": 15, "add": 5},
              {"kind": "streak", "label": "REEKS", "weeks": 0, "per_week": 1.1, "stages": []}],
    "total": 15, "streak_extended": true, "parts": {"checkin": 10, "discovery": 5}}'::jsonb,
  'a discovery: +5 chips as its own step after the base');
select is(
  (select row(s->'steps'->2->'stages', s->>'total', s->'parts')::text from (select private.checkin_score(4, true) s) x),
  row('[{"mult": 1.1, "total": 17}, {"mult": 1.21, "total": 18}, {"mult": 1.331, "total": 20}, {"mult": 1.4641, "total": 22}]'::jsonb,
      '22', '{"checkin": 15, "discovery": 7}'::jsonb)::text,
  'four streak weeks multiply the 15 chips; the ledger gets round(10 x1.46) = 15 and 22 - 15 = 7 (docs, 2.7)');
select is_empty($$
  select w, d from generate_series(0, 12) w, (values (true), (false)) v(d),
    lateral (select private.checkin_score(w, d) s) x
  where (x.s->'parts'->>'checkin')::integer + coalesce((x.s->'parts'->>'discovery')::integer, 0)
        <> (x.s->>'total')::integer
$$, 'the ledger parts always add up to the total');
select is_empty($$
  select w from generate_series(0, 12) w
  where pg_temp.kinds(private.checkin_score(w, true)) <> array['base', 'discovery', 'streak']
     or pg_temp.kinds(private.checkin_score(w, false)) <> array['base', 'streak']
     or private.checkin_score(w, false)->'parts' ? 'discovery'
$$, 'only a discovery has a discovery step and a discovery part');
update game_config set value = '0' where key = 'discovery_chips';
select is(private.checkin_score(3, true), private.checkin_score(3),
  'with 0 discovery chips a discovery scores like any check-in (the economy before phase 3)');
update game_config set value = '5' where key = 'discovery_chips';

-- From here on no streak multiplier: a check-in is 10, a discovery 15.
update game_config set value = '0' where key = 'streak_max_steps';

-- ---------------------------------------------------------------------------
-- 3. Discoveries
-- ---------------------------------------------------------------------------

create temp table c1 as select * from pg_temp.checkin('c1200000-0000-0000-0000-000000000001', 1);
select is((select row(ok, pg_temp.kinds(score), score->>'total', score->'streak_extended')::text from c1),
  '(t,"{base,discovery,streak}",15,true)', 'a first check-in at a bin: a discovery step, 15 points, the first of the week');
select is((select game from c1),
  jsonb_build_object('discovery', jsonb_build_object('bin_id', pg_temp.bin(1), 'ordinal', 1, 'discovered', 1,
                                                     'total_bins', 12, 'status', 'pending'),
                     'milestone', null, 'as_of', now()),
  'game: the discovery with its counter (1 of the 12 bins of the region), no milestone');
select is((select row(d.checkin_id = c1.checkin_id, d.status)::text from discoveries d, c1
           where d.user_id = 'c1200000-0000-0000-0000-000000000001' and d.bin_id = pg_temp.bin(1)),
  '(t,pending)', 'the discovery points at that check-in, pending');
select is(pg_temp.rows_of((select checkin_id from c1)), 'checkin:10:pending,discovery:5:pending',
  'the ledger splits the points into check-in and discovery');

select pg_temp.later('c1200000-0000-0000-0000-000000000001', interval '11 minutes');
create temp table c2 as select * from pg_temp.checkin('c1200000-0000-0000-0000-000000000001', 1);
select is((select row(ok, pg_temp.kinds(score), score->>'total', score->'streak_extended', game->'discovery')::text from c2),
  '(t,"{base,streak}",10,false,null)', 'a second check-in at the same bin: no discovery, not the first of the week');
select is(pg_temp.rows_of((select checkin_id from c2)), 'checkin:10:pending', 'and only a check-in row');

select pg_temp.later('c1200000-0000-0000-0000-000000000001', interval '1 second');
create temp table c3 as select * from pg_temp.checkin('c1200000-0000-0000-0000-000000000001', 2);
select is((select row(game->'discovery'->>'ordinal', game->'discovery'->>'discovered')::text from c3), '(2,2)',
  'another bin: the second discovery');

-- Test check-ins make no game facts and do not count later on.
create temp table t1 as select * from pg_temp.checkin('c1200000-0000-0000-0000-000000000002', 3, true);
select is((select row(ok, is_test, pg_temp.kinds(score), game)::text from t1), '(t,t,"{base,streak}",)',
  'a test check-in: base and streak only, no game');
select is_empty($$ select 1 from discoveries where user_id = 'c1200000-0000-0000-0000-000000000002'
                   union all select 1 from user_milestones where user_id = 'c1200000-0000-0000-0000-000000000002' $$,
  'test check-ins make no discoveries or milestones');
select pg_temp.later('c1200000-0000-0000-0000-000000000002', interval '11 minutes');
create temp table m1 as select * from pg_temp.checkin('c1200000-0000-0000-0000-000000000002', 3);
select is((select row(is_test, pg_temp.kinds(score), game->'discovery'->>'ordinal')::text from m1), '(f,"{base,discovery,streak}",1)',
  'the first real check-in after a test check-in at that bin is the discovery');

-- A rejection moves the discovery to the next check-in at that bin, without
-- discovery points (they were frozen in the rejected one), or revokes it.
select pg_temp.as_admin();
select review_checkin((select checkin_id from c1), false, 'Foto onduidelijk');
select is((select row(d.checkin_id = c2.checkin_id, d.status, d.discovered_at = k.created_at)::text
           from discoveries d, c2, checkins k
           where d.user_id = 'c1200000-0000-0000-0000-000000000001' and d.bin_id = pg_temp.bin(1) and k.id = c2.checkin_id),
  '(t,pending,t)', 'rejecting the discovery moves it to the next check-in at that bin');
select is(pg_temp.rows_of((select checkin_id from c1)) || ' / ' || pg_temp.rows_of((select checkin_id from c2)),
  'checkin:10:revoked,discovery:5:revoked / checkin:10:pending',
  'the rejected check-in loses its discovery points; the next one does not get them');
select review_checkin((select checkin_id from c2), false);
select is((select status from discoveries where user_id = 'c1200000-0000-0000-0000-000000000001' and bin_id = pg_temp.bin(1)),
  'revoked', 'no check-in left at that bin: the discovery is revoked');

select pg_temp.later('c1200000-0000-0000-0000-000000000001', interval '11 minutes');
create temp table c4 as select * from pg_temp.checkin('c1200000-0000-0000-0000-000000000001', 1);
select is((select row(pg_temp.kinds(score), game->'discovery'->>'ordinal')::text from c4), '("{base,discovery,streak}",2)',
  'a new check-in there is a discovery again');
select is((select row(d.checkin_id = c4.checkin_id, d.status)::text from discoveries d, c4
           where d.user_id = 'c1200000-0000-0000-0000-000000000001' and d.bin_id = pg_temp.bin(1)),
  '(t,pending)', 'and reuses the discovery row');

select review_checkin((select checkin_id from c3), true);
select is((select status from discoveries where user_id = 'c1200000-0000-0000-0000-000000000001' and bin_id = pg_temp.bin(2)),
  'confirmed', 'an approved check-in confirms the discovery');

-- ---------------------------------------------------------------------------
-- 4. Milestones
-- ---------------------------------------------------------------------------

select pg_temp.run('c1200000-0000-0000-0000-000000000001', i) from generate_series(3, 10) i;
select is((select game->'milestone' from runs where i = 9), 'null'::jsonb, 'nine discoveries: no milestone yet');
select is((select game->'milestone' from runs where i = 10), '{"threshold": 10, "points": 50, "status": "pending"}'::jsonb,
  'the tenth discovery reaches milestone 10: +50, waiting for approval');
select is((select game->'discovery'->>'discovered' from runs where i = 10), '10', 'with 10 discovered');
select is(
  (select row(m.status, m.points, m.anchor_checkin_id = r.checkin_id)::text
   from user_milestones m, runs r
   where m.user_id = 'c1200000-0000-0000-0000-000000000001' and m.threshold = 10 and r.i = 10),
  '(pending,50,t)', 'the milestone is pending, anchored at the tenth discovery');
select is(
  (select row(t.source, t.amount, t.status, t.checkin_id is null, t.anchor_checkin_id = r.checkin_id, t.earned_at = m.reached_at)::text
   from point_transactions t, runs r, user_milestones m
   where t.user_id = 'c1200000-0000-0000-0000-000000000001' and t.reward_key = 'milestone:10' and r.i = 10
     and m.user_id = t.user_id and m.threshold = 10),
  '(milestone,50,pending,t,t,t)', 'its ledger row: 50 pending, anchored, earned when reached');

select is(private.refresh_game_state('c1200000-0000-0000-0000-000000000001'), 0, 'a refresh after the check-in changes nothing');
select is(private.refresh_game_state('c1200000-0000-0000-0000-000000000001'), 0, 'neither does a second one');

-- Approve everything that waits: granted once 10 discoveries are confirmed.
select review_checkin(c.id, true)
from checkins c
where c.user_id = 'c1200000-0000-0000-0000-000000000001' and c.status = 'pending'
  and c.id <> (select checkin_id from runs where i = 10);
select is((select status from user_milestones where user_id = 'c1200000-0000-0000-0000-000000000001' and threshold = 10),
  'pending', 'nine confirmed discoveries: the milestone still waits');
select review_checkin((select checkin_id from runs where i = 10), true);
select is(
  (select row(m.status, t.status, p.points)::text
   from user_milestones m, point_transactions t, profiles p
   where m.user_id = 'c1200000-0000-0000-0000-000000000001' and m.threshold = 10
     and t.user_id = m.user_id and t.reward_key = 'milestone:10' and p.id = m.user_id),
  '(granted,granted,200)', 'ten confirmed: granted, and the profile has 10 x 15 + 50');

-- Revoking an approved discovery takes the milestone back.
select revoke_checkin((select checkin_id from runs where i = 5), 'Dubbele foto');
select is((select status from discoveries where user_id = 'c1200000-0000-0000-0000-000000000001' and bin_id = pg_temp.bin(5)),
  'revoked', 'revoking the only check-in at a bin revokes its discovery');
select is(
  (select row(m.status, t.status, t.revoke_reason, p.points)::text
   from user_milestones m, point_transactions t, profiles p
   where m.user_id = 'c1200000-0000-0000-0000-000000000001' and m.threshold = 10
     and t.user_id = m.user_id and t.reward_key = 'milestone:10' and p.id = m.user_id),
  '(revoked,revoked,milestone_lost,135)', 'nine discoveries left: the milestone and its 50 points are revoked');

-- Earned again: the same row, the frozen amount (not the new catalog value).
update milestones set points = 70 where threshold = 10;
select pg_temp.run('c1200000-0000-0000-0000-000000000001', 11);
select is((select game->'milestone' from runs where i = 11), '{"threshold": 10, "points": 50, "status": "pending"}'::jsonb,
  'a new discovery reaches milestone 10 again, with its frozen 50 points');
select is(
  (select row(count(*), min(t.status), min(t.amount), bool_and(t.revoked_at is null and t.revoke_reason is null),
              bool_and(t.anchor_checkin_id = r.checkin_id))::text
   from point_transactions t, runs r
   where t.user_id = 'c1200000-0000-0000-0000-000000000001' and t.reward_key = 'milestone:10' and r.i = 11),
  '(1,pending,50,t,t)', 'the ledger row is reused: pending again, revocation cleared, the new anchor');
update milestones set points = 50 where threshold = 10;

-- ---------------------------------------------------------------------------
-- 5. Collection, game state and moments
-- ---------------------------------------------------------------------------

-- Bob has no discoveries; the admin discovered bin 3 and one outside the region.
select pg_temp.later('c1200000-0000-0000-0000-000000000002', interval '11 minutes');
select * from pg_temp.checkin('c1200000-0000-0000-0000-000000000002', 13);
update profiles set moments_seen_at = now() - interval '1 day' where id = 'c1200000-0000-0000-0000-000000000001';

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"c1200000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select is(
  (select array_agg(coalesce(c.status, '-') || ':' || c.checkins order by c.bin_id) from my_collection() c),
  array['confirmed:1', 'confirmed:1', 'confirmed:1', 'confirmed:1', '-:0', 'confirmed:1', 'confirmed:1',
        'confirmed:1', 'confirmed:1', 'confirmed:1', 'pending:1', '-:0'],
  'the collection: every bin of the region, discovered or not, with the check-ins that count');
select is(
  my_game_state() - 'as_of' - 'streak' - 'level' - 'stats',
  '{"points": {"granted": 135, "pending": 65},
    "discoveries": {"discovered": 10, "confirmed": 9, "total_bins": 12,
                    "next_milestone": {"threshold": 20, "points": 50, "previous": 10}},
    "unseen_moments": 11}'::jsonb,
  'my_game_state: points granted and pending, the counter, the next milestone, the unseen moments');
select is(
  (select row(u->>'moments_total', jsonb_array_length(u->'moments'),
              (select count(*) from jsonb_array_elements(u->'moments') m where m->>'kind' = 'milestone'),
              u->'moments'->-1->>'kind', u->'moments'->-1->>'threshold')::text
   from (select my_unseen() u) x),
  '(11,11,1,milestone,10)', 'my_unseen: ten discoveries and the milestone, oldest first');
select is(mark_seen('moments', now()), now(), 'mark_seen moves the mark to the given time');
select is((select row(my_unseen()->>'moments_total', my_game_state()->>'unseen_moments')::text), '(0,0)',
  'after that nothing is unseen');
select is(mark_seen('moments', now() - interval '2 days'), now(), 'the mark never moves back');
select throws_ok($$ select mark_seen('results', now()) $$, '22023', null, 'mark_seen knows only moments (for now)');
select throws_ok($$ select mark_seen('moments', null) $$, '22023', null, 'and needs a time');
select is((select count(*)::integer from discoveries), 11, 'alice reads her own discoveries only, the revoked one too (RLS)');
select throws_ok($$ insert into discoveries (user_id, bin_id, checkin_id, status, discovered_at)
                    values ('c1200000-0000-0000-0000-000000000001', 1, gen_random_uuid(), 'confirmed', now()) $$,
  '42501', null, 'users cannot write discoveries');
select throws_ok($$ update user_milestones set status = 'granted' $$, '42501', null, 'nor milestones');
select throws_ok($$ select repair_game_state('c1200000-0000-0000-0000-000000000001') $$, '42501', null,
  'only admins repair the game state');

select set_config('request.jwt.claims', '{"sub":"c1200000-0000-0000-0000-000000000003","role":"authenticated"}', true);
select is((select count(*)::integer from my_collection() where status is null), 12,
  'bob sees the same 12 bins, none discovered');
select set_config('request.jwt.claims', '{"sub":"c1200000-0000-0000-0000-000000000002","role":"authenticated"}', true);
select is((select array_agg(c.bin_id order by c.bin_id) from my_collection() c where c.status is not null),
  array[pg_temp.bin(3), pg_temp.bin(13)], 'a bin discovered outside the region is part of the collection too');
select is((my_game_state()->'discoveries'->>'total_bins')::integer, 13, 'and of the counter');

set local role anon;
select throws_ok($$ select my_collection() $$, '42501', null, 'anon cannot read a collection');
select throws_ok($$ select my_game_state() $$, '42501', null, 'nor a game state');
select throws_ok($$ select mark_seen('moments', now()) $$, '42501', null, 'nor mark anything seen');
reset role;

-- ---------------------------------------------------------------------------
-- 6. An error in the game logic never fails a check-in
-- ---------------------------------------------------------------------------

create function pg_temp.boom() returns trigger language plpgsql as $$
begin
  raise exception 'boom';
end;
$$;
create trigger discoveries_boom before insert on discoveries
  for each row execute function pg_temp.boom();

select pg_temp.run('c1200000-0000-0000-0000-000000000001', 12);
select is((select row(r.game, c.points_earned, pg_temp.rows_of(c.id))::text from runs r join checkins c on c.id = r.checkin_id where r.i = 12),
  '(,15,"checkin:10:pending,discovery:5:pending")',
  'the check-in and its points stay; game is null');
select is((select row(e.context, e.message, e.checkin_id = r.checkin_id)::text
           from private.game_errors e, runs r where r.i = 12 and e.user_id = 'c1200000-0000-0000-0000-000000000001'),
  '(record_checkin,boom,t)', 'the error is in private.game_errors');

drop trigger discoveries_boom on discoveries;
select pg_temp.as_admin();
select is(repair_game_state('c1200000-0000-0000-0000-000000000001'), 1, 'repair_game_state adds the missing discovery');
select is(private.refresh_game_state('c1200000-0000-0000-0000-000000000001'), 0, 'after which all is in order');

-- ---------------------------------------------------------------------------
-- 7. Invariants
-- ---------------------------------------------------------------------------

select is_empty($$ select d.* from discoveries d join checkins c on c.id = d.checkin_id where c.is_test $$,
  'no discovery points at a test check-in');
select is_empty($$
  select c.id from checkins c
  where c.score is not null
    and c.points_earned <> coalesce((select sum(t.amount) from point_transactions t
                                     where t.checkin_id = c.id and t.source <> 'bonus'), 0)
$$, 'the ledger rows of every scored check-in add up to its total');
select is_empty($$ select * from private.check_points_invariant() $$, 'every profile equals its ledger');

select * from finish();
rollback;
