-- Event log: log_events (whitelist, sizes, times, location keys, rate limit,
-- idempotence, test flag), who reads app_events, and the cascade with the
-- account. Run with: npm run db:test

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(38);

insert into auth.users (id, email, aud, role) values
  ('a1000000-0000-0000-0000-000000000001', 'ev-user@example.test', 'authenticated', 'authenticated'),
  ('a1000000-0000-0000-0000-000000000002', 'ev-admin@example.test', 'authenticated', 'authenticated'),
  ('a1000000-0000-0000-0000-000000000003', 'ev-busy@example.test', 'authenticated', 'authenticated');
update profiles set is_admin = true where id = 'a1000000-0000-0000-0000-000000000002';

insert into private.app_environment (name) values ('local')
on conflict (singleton) do update set name = excluded.name;

insert into event_names (name, description, active) values ('zz_retired', 'An event that is no longer sent.', false);

-- One event as the app sends it. Batches are built as postgres and handed to
-- the API role through settings (it cannot call pg_temp functions).
create function pg_temp.ev(n text, props jsonb default '{}', ts timestamptz default now(),
                           id uuid default gen_random_uuid(), test boolean default false)
returns jsonb language sql as $$
  select jsonb_build_object('id', id, 'session_id', '5e000000-0000-0000-0000-000000000001', 'name', n,
                            'props', props, 'client_ts', to_char(ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                            'is_test', test);
$$;

create function pg_temp.batch(variadic events jsonb[]) returns text language sql as $$
  select jsonb_agg(e order by o)::text from unnest(events) with ordinality as x(e, o);
$$;

create function pg_temp.result(accepted int, dropped int, limited int) returns jsonb language sql as $$
  select jsonb_build_object('accepted', accepted, 'dropped', dropped, 'rate_limited', limited);
$$;

create function pg_temp.events_of(u uuid) returns int language sql as $$
  select count(*)::int from public.app_events where user_id = u;
$$;

-- ---------------------------------------------------------------------------
-- 1. Who may log
-- ---------------------------------------------------------------------------

select set_config('test.one', pg_temp.batch(pg_temp.ev('app_open', '{"kind": "cold"}')), true);

set local role anon;
select throws_ok($$ select log_events(current_setting('test.one')::jsonb) $$, '42501', null,
  'anon cannot log events');
reset role;

set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($$ select log_events(current_setting('test.one')::jsonb) $$, '42501', null,
  'without a user there is nothing to log');
reset role;

-- ---------------------------------------------------------------------------
-- 2. A good batch, and what is stored
-- ---------------------------------------------------------------------------

select set_config('test.good', pg_temp.batch(
  pg_temp.ev('app_open', '{"kind": "cold"}', now() - interval '2 minutes', 'e1000000-0000-0000-0000-000000000001'),
  pg_temp.ev('screen_view', '{"screen": "map"}', now() - interval '1 minute', 'e1000000-0000-0000-0000-000000000002'),
  pg_temp.ev('map_bin_tap', '{"bin_id": 58}', now(), 'e1000000-0000-0000-0000-000000000003')), true);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select is(log_events(current_setting('test.good')::jsonb,
                     '{"app_version": "0.1.0", "update_id": "fb4c523e-9c9a-4666-8b76-1ab4a5ab5963", "platform": "ios"}'),
  pg_temp.result(3, 0, 0), 'a good batch is accepted: {accepted, dropped, rate_limited}');
select is(log_events('[]'), pg_temp.result(0, 0, 0), 'an empty batch is fine');
select throws_ok($$ select log_events('{"name": "app_open"}') $$, '22023', null, 'events must be an array');
reset role;

select is(
  (select row(e.user_id, e.session_id, e.name, e.props, abs(extract(epoch from e.client_ts - (now() - interval '2 minutes'))) < 0.001, e.server_ts = now(),
              e.app_version, e.update_id, e.platform, e.is_test)::text
   from app_events e where e.id = 'e1000000-0000-0000-0000-000000000001'),
  row('a1000000-0000-0000-0000-000000000001'::uuid, '5e000000-0000-0000-0000-000000000001'::uuid, 'app_open',
      '{"kind": "cold"}'::jsonb, true, true, '0.1.0', 'fb4c523e-9c9a-4666-8b76-1ab4a5ab5963', 'ios', false)::text,
  'the event is stored with the caller, session, props, both times and the client');

-- Idempotence: the same batch again, and a duplicate inside one batch.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select is(log_events(current_setting('test.good')::jsonb), pg_temp.result(3, 0, 0),
  'the same batch again is accepted');
reset role;
select is(pg_temp.events_of('a1000000-0000-0000-0000-000000000001'), 3, 'but stored only once');

select set_config('test.dup', pg_temp.batch(
  pg_temp.ev('app_background', '{"foreground_s": 40}', now(), 'e1000000-0000-0000-0000-000000000004'),
  pg_temp.ev('app_background', '{"foreground_s": 40}', now(), 'e1000000-0000-0000-0000-000000000004')), true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select is(log_events(current_setting('test.dup')::jsonb), pg_temp.result(2, 0, 0), 'a duplicate inside a batch is fine');
reset role;
select is(pg_temp.events_of('a1000000-0000-0000-0000-000000000001'), 4, 'and stored once');

-- ---------------------------------------------------------------------------
-- 3. Rows that fail a check are dropped; the batch still goes through
-- ---------------------------------------------------------------------------

-- Each case: one bad event next to one good one.
create temp table cases (label text, bad jsonb);
insert into cases values
  ('an unknown name', pg_temp.ev('made_up')),
  ('a retired name', pg_temp.ev('zz_retired')),
  ('props that are not an object', pg_temp.ev('app_open', '["cold"]')),
  ('props over 2 KB', pg_temp.ev('screen_view', jsonb_build_object('screen', repeat('x', 2100)))),
  ('more than 20 keys', pg_temp.ev('screen_view', (select jsonb_object_agg('k' || i, i) from generate_series(1, 21) i))),
  ('a nested object', pg_temp.ev('screen_view', '{"screen": {"name": "map"}}')),
  ('an array value', pg_temp.ev('screen_view', '{"screen": ["map"]}')),
  ('a camelCase key', pg_temp.ev('map_bin_tap', '{"binId": 5}')),
  ('a key lat', pg_temp.ev('map_bin_tap', '{"bin_id": 5, "lat": 51.05}')),
  ('a key Longitude', pg_temp.ev('map_bin_tap', '{"bin_id": 5, "Longitude": 3.7}')),
  ('a key user_lng', pg_temp.ev('map_bin_tap', '{"bin_id": 5, "user_lng": 3.7}')),
  ('a key location', pg_temp.ev('map_bin_tap', '{"bin_id": 5, "location": "51.05,3.7"}')),
  ('a key geom', pg_temp.ev('map_bin_tap', '{"bin_id": 5, "geom": "POINT(3.7 51.05)"}')),
  ('a key coords', pg_temp.ev('map_bin_tap', '{"bin_id": 5, "coords": "51.05 3.7"}')),
  ('a client_ts 31 days old', pg_temp.ev('app_open', '{}', now() - interval '31 days')),
  ('a client_ts 2 days ahead', pg_temp.ev('app_open', '{}', now() + interval '2 days')),
  ('a client_ts that is no date', pg_temp.ev('app_open') || '{"client_ts": "2026-13-45T10:00:00Z"}'),
  ('a client_ts "now"', pg_temp.ev('app_open') || '{"client_ts": "now"}'),
  ('a client_ts as a number', pg_temp.ev('app_open') || '{"client_ts": 1760000000000}'),
  ('an id that is no uuid', pg_temp.ev('app_open') || '{"id": "1"}'),
  ('no session_id', pg_temp.ev('app_open') - 'session_id'),
  ('an is_test that is no boolean', pg_temp.ev('app_open') || '{"is_test": "yes"}'),
  ('an event that is no object', '42'::jsonb);

select set_config('test.cases', (select jsonb_agg(jsonb_build_array(c.label, jsonb_build_array(c.bad, pg_temp.ev('app_open'))))::text
                                 from cases c), true);
select set_config('test.expected', (select jsonb_object_agg(c.label, pg_temp.result(1, 1, 0))::text from cases c), true);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select is(
  (select jsonb_object_agg(x.c->>0, log_events(x.c->1))
   from jsonb_array_elements(current_setting('test.cases')::jsonb) x(c)),
  current_setting('test.expected')::jsonb,
  'each bad event is dropped and its good neighbour kept (23 cases)');
reset role;
select is(pg_temp.events_of('a1000000-0000-0000-0000-000000000001'), 4 + 23, 'only the good neighbours are stored');

select set_config('test.edges', pg_temp.batch(
  pg_temp.ev('screen_view', (select jsonb_object_agg('k' || i, i) from generate_series(1, 20) i)),
  pg_temp.ev('checkin_flow_start', '{"bin_id": 5, "distance_bucket": "10_25"}'),
  pg_temp.ev('app_open', '{}', now() - interval '29 days'),
  pg_temp.ev('app_open', '{}', now() + interval '23 hours'),
  pg_temp.ev('checkin_result', '{"ok": false, "reason": null, "duration_ms": 900}'),
  pg_temp.ev('session_start') - 'props' - 'is_test'), true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select is(log_events(current_setting('test.edges')::jsonb), pg_temp.result(6, 0, 0),
  'allowed: 20 keys, bin_id and distance_bucket, 29 days old, 23 hours ahead, null values, no props or is_test');
reset role;

select set_config('test.big', (select jsonb_agg(pg_temp.ev('app_open'))::text from generate_series(1, 101)), true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select throws_ok($$ select log_events(current_setting('test.big')::jsonb) $$, '22023', null,
  'a batch of more than 100 events is refused');
select is(log_events(current_setting('test.one')::jsonb, '{"app_version": 1, "platform": "a-very-long-platform-name"}'),
  pg_temp.result(1, 0, 0), 'odd client fields do not fail the batch');
reset role;
select is((select row(app_version, platform)::text from app_events where id = (current_setting('test.one')::jsonb->0->>'id')::uuid),
  '(,a-very-long-platform)', 'a non-string version is left out, a long platform cut to 20');

-- ---------------------------------------------------------------------------
-- 4. Rate limit: 600 events per user per hour
-- ---------------------------------------------------------------------------

insert into app_events (id, user_id, session_id, name, client_ts, server_ts)
select gen_random_uuid(), 'a1000000-0000-0000-0000-000000000003', gen_random_uuid(), 'screen_view', now(),
       now() - case when i <= 595 then interval '30 minutes' else interval '2 hours' end
from generate_series(1, 700) i;

select set_config('test.ten', (select jsonb_agg(pg_temp.ev('screen_view', '{"screen": "map"}'))::text
                               from generate_series(1, 10)), true);
select set_config('test.eleventh', pg_temp.batch(pg_temp.ev('screen_view', '{"screen": "map"}')), true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
select is(log_events(current_setting('test.ten')::jsonb), pg_temp.result(5, 0, 5),
  '595 events in the last hour (older ones do not count): 5 more fit, 5 are rate limited');
select is(log_events(current_setting('test.ten')::jsonb), pg_temp.result(5, 0, 5),
  'sending the batch again: the stored 5 are accepted, the other 5 still limited');
select is(log_events(current_setting('test.eleventh')::jsonb), pg_temp.result(0, 0, 1), 'the hour is full');
reset role;
select is(pg_temp.events_of('a1000000-0000-0000-0000-000000000003'), 705, 'exactly 600 in the last hour');

-- ---------------------------------------------------------------------------
-- 5. The test flag: only for admins in Dev mode (local or staging)
-- ---------------------------------------------------------------------------

select set_config('test.t1', pg_temp.batch(pg_temp.ev('reveal_shown', '{"total": 11, "preview": true}',
  now(), 'e2000000-0000-0000-0000-000000000001', true)), true);
select set_config('test.t2', pg_temp.batch(pg_temp.ev('reveal_shown', '{"total": 11, "preview": true}',
  now(), 'e2000000-0000-0000-0000-000000000002', true)), true);
select set_config('test.t3', pg_temp.batch(pg_temp.ev('reveal_shown', '{"total": 11, "preview": true}',
  now(), 'e2000000-0000-0000-0000-000000000003', true)), true);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select is(log_events(current_setting('test.t1')::jsonb), pg_temp.result(1, 0, 0), 'a user may ask for the test flag');
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
select is(log_events(current_setting('test.t2')::jsonb), pg_temp.result(1, 0, 0), 'an admin too');
reset role;
update private.app_environment set name = 'production';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
select is(log_events(current_setting('test.t3')::jsonb), pg_temp.result(1, 0, 0), 'and an admin in production');
reset role;
update private.app_environment set name = 'local';

select is((select array_agg(is_test order by id) from app_events where id::text like 'e2000000%'),
  array[false, true, false], 'but only the admin on a local or staging database gets a test event');

-- ---------------------------------------------------------------------------
-- 6. Who reads and writes
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select is((select count(*)::int from app_events), 0, 'users read no events, not even their own');
select throws_ok($$ insert into app_events (id, user_id, session_id, name, client_ts)
                    values (gen_random_uuid(), auth.uid(), gen_random_uuid(), 'app_open', now()) $$,
  '42501', null, 'users cannot insert events directly');
select throws_ok($$ update app_events set props = '{}' $$, '42501', null, 'nor change them');
select throws_ok($$ delete from app_events $$, '42501', null, 'nor delete them');
select throws_ok($$ select * from event_names $$, '42501', null, 'users cannot read the whitelist');
select throws_ok($$ insert into event_names (name, description) values ('my_event', 'x') $$, '42501', null,
  'nor add to it');
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
select ok((select count(*) from app_events) >= 705 + 27, 'admins read all events');
select throws_ok($$ delete from app_events $$, '42501', null, 'but cannot delete them');
reset role;

select is(
  (select array_agg(name order by name) from event_names where active),
  array['app_background', 'app_open', 'bonus_question_answered', 'camera_opened', 'checkin_flow_start',
        'checkin_result', 'checkin_submitted', 'leaderboard_viewed', 'map_bin_tap', 'photo_taken',
        'report_flow_start', 'report_submitted', 'reveal_shown', 'reveal_skipped', 'screen_view',
        'session_end', 'session_start'],
  'the whitelist holds the events of phase 1b (docs/ANALYTICS.md)');
select throws_ok($$ insert into app_events (id, user_id, session_id, name, client_ts)
                    values (gen_random_uuid(), 'a1000000-0000-0000-0000-000000000001', gen_random_uuid(), 'made_up', now()) $$,
  '23503', null, 'every stored event has a whitelisted name (foreign key)');
select throws_ok($$ insert into app_events (id, user_id, session_id, name, client_ts, props)
                    values (gen_random_uuid(), 'a1000000-0000-0000-0000-000000000001', gen_random_uuid(), 'app_open', now(), '[]') $$,
  '23514', null, 'props are always an object');

-- ---------------------------------------------------------------------------
-- 7. The events go with the account
-- ---------------------------------------------------------------------------

delete from auth.users where id = 'a1000000-0000-0000-0000-000000000003';
select is(pg_temp.events_of('a1000000-0000-0000-0000-000000000003'), 0, 'deleting an account deletes its events');
select ok(pg_temp.events_of('a1000000-0000-0000-0000-000000000001') > 0, 'and only its own');

select is_empty($$ select * from private.check_points_invariant() $$, 'every profile equals its ledger');

select * from finish();
rollback;
