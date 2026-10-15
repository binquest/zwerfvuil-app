-- Game config and event log (docs/GAMIFICATION.md, 2.3, 2.5 and phase 1b).
--
-- game_config holds the numbers of the game (chapter 3), so they can be tuned
-- without an app update: in a migration, or by hand in Studio.
--   - A trigger checks every write against private.game_config_rules (type
--     and range per key) and refuses unknown keys, renames and deletes: a typo
--     in Studio must never break check-ins.
--   - private.cfg(key) reads a value in SQL.
--   - checkin_point_stages, record_checkin and answer_bonus_question read
--     their numbers from it, with the values of the old constants: the same
--     points as before. A change only affects new rewards; amounts already in
--     the ledger are frozen.
--   - The anti-cheat rules (25 m, cooldown, daily limit, accuracy, and the
--     1.2 s and 1 hour of the bonus question) stay constants on purpose.
--   - Users cannot read or write the table; the app gets the numbers through
--     game_catalog() in a later phase.
--
-- app_events is the event log of the app (docs/ANALYTICS.md). The app sends
-- batches through log_events(events, client); event_names is the whitelist
-- (a new event = one row in a migration). Users read nothing, admins
-- everything; the events go with the account (on delete cascade).

-- ---------------------------------------------------------------------------
-- Config
-- ---------------------------------------------------------------------------

-- Type and range of every key. Not reachable through the API. A new key = a
-- rule and a row, in a migration; a new kind = a migration of the validator.
create table private.game_config_rules (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,62}$'),
  kind text not null check (kind in ('integer', 'number')),
  min_value numeric not null,
  max_value numeric not null,
  check (min_value <= max_value)
);

comment on table private.game_config_rules is
  'Type and range of every key in public.game_config, checked on every write.';

create table public.game_config (
  key text primary key,
  value jsonb not null,
  description text not null check (char_length(description) between 1 and 300),
  updated_at timestamptz not null default now()
);

comment on table public.game_config is
  'The numbers of the game (docs/GAMIFICATION.md, chapter 3). Values are checked against private.game_config_rules; read in SQL with private.cfg(key).';

alter table public.game_config enable row level security;
revoke all on public.game_config from anon, authenticated;

-- Refuses values of the wrong type or out of range, unknown keys, renames,
-- and deletes of keys that are still in use (a migration that retires a key
-- deletes its rule first).
create function private.validate_game_config()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  rule private.game_config_rules;
  n numeric;
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from private.game_config_rules r where r.key = old.key) then
      raise exception 'game_config: % is in use and cannot be deleted', old.key using errcode = '23514';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' and new.key is distinct from old.key then
    raise exception 'game_config: keys cannot be renamed (% -> %)', old.key, new.key using errcode = '23514';
  end if;

  select * into rule from private.game_config_rules r where r.key = new.key;
  if not found then
    raise exception 'game_config: unknown key %', new.key using errcode = '23514';
  end if;
  if jsonb_typeof(new.value) is distinct from 'number' then
    raise exception 'game_config: % must be a number, got %', new.key, new.value using errcode = '23514';
  end if;
  n := new.value::numeric;
  if rule.kind = 'integer' and n <> trunc(n) then
    raise exception 'game_config: % must be a whole number, got %', new.key, new.value using errcode = '23514';
  end if;
  if n < rule.min_value or n > rule.max_value then
    raise exception 'game_config: % must be between % and %, got %', new.key, rule.min_value, rule.max_value, n
      using errcode = '23514';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function private.validate_game_config() from public;

create trigger game_config_validate
  before insert or update or delete on public.game_config
  for each row execute function private.validate_game_config();

create function private.refuse_game_config_truncate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'game_config cannot be truncated' using errcode = '23514';
end;
$$;

revoke execute on function private.refuse_game_config_truncate() from public;

create trigger game_config_no_truncate
  before truncate on public.game_config
  for each statement execute function private.refuse_game_config_truncate();

-- One value. Every key in use has a rule, and the trigger keeps its row.
create function private.cfg(p_key text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v jsonb;
begin
  select c.value into v from public.game_config c where c.key = p_key;
  if v is null then
    raise exception 'game_config: missing key %', p_key using errcode = 'P0002';
  end if;
  return v;
end;
$$;

revoke execute on function private.cfg(text) from public;

-- The constants of 20261014200000_points_streaks_bonus_leaderboard.sql.
insert into private.game_config_rules (key, kind, min_value, max_value) values
  ('checkin_base_chips', 'integer', 1, 100),
  ('streak_multiplier', 'number', 1, 1.5),
  ('streak_max_steps', 'integer', 0, 12),
  ('bonus_question_points', 'integer', 1, 50);

insert into public.game_config (key, value, description) values
  ('checkin_base_chips', '10', 'Points of a check-in before the streak multiplier.'),
  ('streak_multiplier', '1.1', 'Multiplier per streak week.'),
  ('streak_max_steps', '8', 'At most this many streak weeks multiply (1.1^8 = x2.14).'),
  ('bonus_question_points', '5', 'Points for answering the bonus question.');

-- ---------------------------------------------------------------------------
-- The points read the config
-- ---------------------------------------------------------------------------

-- The point stages of a check-in: the base, then one stage per streak week up
-- to the maximum. The last element is the check-in's points. Stable instead of
-- immutable now that it reads the config; security definer so its callers need
-- no access to schema private. Replaced by private.checkin_score in phase 2.
create or replace function public.checkin_point_stages(p_streak_weeks integer)
returns integer[]
language sql
stable
security definer
set search_path = ''
as $$
  select array_agg(round(c.base * power(c.mult, k))::integer order by k)
  from (select (private.cfg('checkin_base_chips'))::integer as base,
               (private.cfg('streak_multiplier'))::numeric as mult,
               (private.cfg('streak_max_steps'))::integer as max_steps) c
  cross join lateral generate_series(0, least(greatest(coalesce(p_streak_weeks, 0), 0), c.max_steps)) as k;
$$;

-- record_checkin from 20261014210000_dev_mode.sql (security definer since
-- 20261015120000_points_ledger.sql): the bonus question now carries its points
-- from the config. Same signature and result, so the grants stay.
create or replace function public.record_checkin(
  p_checkin_id uuid,
  p_user_id uuid,
  p_bin_id bigint,
  p_lat double precision,
  p_lon double precision,
  p_accuracy_m real,
  p_is_mocked boolean,
  p_is_fake_location boolean,
  p_photo_path text
)
returns table (
  ok boolean,
  reason text,
  checkin_id uuid,
  distance_m double precision,
  retry_after_s integer,
  streak_weeks integer,
  point_stages integer[],
  points_total integer,
  bonus_question jsonb,
  is_test boolean
)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  max_distance_m constant double precision := 25;
  cooldown constant interval := interval '10 minutes';
  max_checkins_per_day constant integer := 20;
  fake constant boolean := coalesce(p_is_fake_location, false);
  dev_ok boolean;
  override integer;
  test boolean;
  bin public.bins;
  dist double precision;
  last_at timestamptz;
  today integer;
  week date;
  streak integer;
  stages integer[];
  question public.bonus_questions;
begin
  if p_lat is null or p_lon is null or p_lat not between -90 and 90 or p_lon not between -180 and 180 then
    raise exception 'invalid coordinates' using errcode = '22023';
  end if;

  -- Dev mode: only admins, only on local or staging.
  dev_ok := public.dev_mode_allowed_for(p_user_id);
  if fake and not dev_ok then
    return query select false, 'fake_location_not_allowed', null::uuid, null::double precision, null::integer,
      null::integer, null::integer[], null::integer, null::jsonb, null::boolean;
    return;
  end if;
  if dev_ok then
    select s.streak_override into override from public.dev_settings s where s.user_id = p_user_id;
  end if;
  test := fake or override is not null;

  -- Serialise check-ins per user so parallel requests cannot beat the limits.
  perform pg_advisory_xact_lock(hashtextextended('checkins:' || p_user_id::text, 0));

  select * into bin from public.bins b where b.id = p_bin_id;
  if not found then
    return query select false, 'bin_not_found', null::uuid, null::double precision, null::integer,
      null::integer, null::integer[], null::integer, null::jsonb, null::boolean;
    return;
  end if;
  if bin.status <> 'active' then
    return query select false, 'bin_inactive', null::uuid, null::double precision, null::integer,
      null::integer, null::integer[], null::integer, null::jsonb, null::boolean;
    return;
  end if;
  if not bin.eligible_effective then
    return query select false, 'bin_not_eligible', null::uuid, null::double precision, null::integer,
      null::integer, null::integer[], null::integer, null::jsonb, null::boolean;
    return;
  end if;

  dist := st_distance(bin.geom, st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography);
  if dist > max_distance_m then
    return query select false, 'too_far', null::uuid, dist, null::integer,
      null::integer, null::integer[], null::integer, null::jsonb, null::boolean;
    return;
  end if;

  select max(c.created_at) into last_at
  from public.checkins c
  where c.user_id = p_user_id and c.bin_id = p_bin_id and c.created_at > now() - cooldown;
  if last_at is not null then
    return query select false, 'cooldown', null::uuid, dist,
      ceil(extract(epoch from last_at + cooldown - now()))::integer,
      null::integer, null::integer[], null::integer, null::jsonb, null::boolean;
    return;
  end if;

  select count(*) into today
  from public.checkins c
  where c.user_id = p_user_id and c.created_at >= public.local_day_start(now());
  if today >= max_checkins_per_day then
    return query select false, 'daily_limit', null::uuid, dist,
      ceil(extract(epoch from public.local_day_start(now()) + interval '1 day' - now()))::integer,
      null::integer, null::integer[], null::integer, null::jsonb, null::boolean;
    return;
  end if;

  insert into public.checkins
    (id, user_id, bin_id, photo_path, user_geom, accuracy_m, distance_m, is_mocked, is_fake_location, is_test)
  values
    (p_checkin_id, p_user_id, p_bin_id, p_photo_path,
     st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography,
     p_accuracy_m, dist, coalesce(p_is_mocked, false), fake, test);

  -- The new check-in counts for its own week, so the streak is at least 1.
  -- Real check-ins never see test check-ins; test check-ins use the override.
  week := date_trunc('week', now() at time zone 'Europe/Brussels')::date;
  streak := case when test then coalesce(override, public.streak_weeks(p_user_id, week, true))
                 else public.streak_weeks(p_user_id, week, false) end;
  stages := public.checkin_point_stages(streak);
  update public.checkins c
     set streak_weeks = streak, points_earned = stages[array_upper(stages, 1)]
   where c.id = p_checkin_id;

  select q.* into question
  from public.bonus_questions q
  where q.active
  order by (select count(*) from public.bonus_answers a where a.user_id = p_user_id and a.question_key = q.key),
           q.sort, q.key
  limit 1;
  if found then
    insert into public.bonus_answers (checkin_id, user_id, bin_id, user_geom, question_key, is_test)
    values (p_checkin_id, p_user_id, p_bin_id, st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography,
            question.key, test);
  end if;

  if test then
    insert into public.dev_audit_log (user_id, action, details, environment)
    values (p_user_id, 'test_checkin',
            jsonb_build_object('checkin_id', p_checkin_id, 'bin_id', p_bin_id, 'fake_location', fake,
                               'streak_override', override, 'streak_weeks', streak),
            public.app_environment());
  end if;

  return query select true, null::text, p_checkin_id, dist, null::integer,
    streak, stages, stages[array_upper(stages, 1)],
    case when question.key is null then null
         else jsonb_build_object('key', question.key, 'prompt', question.prompt, 'options', question.options,
                                 'points', (private.cfg('bonus_question_points'))::integer)
    end,
    test;
end;
$$;

-- answer_bonus_question from 20261015120000_points_ledger.sql, with the points
-- from the config (read when the answer comes in: that is when the reward is
-- made and frozen).
create or replace function public.answer_bonus_question(checkin_id uuid, answer text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  bonus constant integer := (private.cfg('bonus_question_points'))::integer;
  min_answer_ms constant integer := 1200;
  answer_window constant interval := interval '1 hour';
  row_ public.bonus_answers;
  checkin public.checkins;
  elapsed_ms integer;
begin
  -- Lock order: the user's lock, the check-in, then its question.
  perform pg_advisory_xact_lock(hashtextextended('checkins:' || auth.uid()::text, 0));
  select * into checkin from public.checkins c
   where c.id = answer_bonus_question.checkin_id and c.user_id = auth.uid()
   for update;
  select * into row_ from public.bonus_answers a
   where a.checkin_id = answer_bonus_question.checkin_id and a.user_id = auth.uid()
   for update;
  if checkin.id is null or row_.checkin_id is null then
    raise exception 'no bonus question for check-in %', answer_bonus_question.checkin_id using errcode = 'P0002';
  end if;
  if row_.answered_at is not null then
    raise exception 'the bonus question was already answered' using errcode = '55000';
  end if;
  if now() > row_.offered_at + answer_window then
    raise exception 'the bonus question has expired' using errcode = '55000';
  end if;
  if checkin.status = 'rejected' then
    raise exception 'the check-in was rejected' using errcode = '55000';
  end if;
  if not exists (
    select 1 from public.bonus_questions q, jsonb_array_elements(q.options) o
    where q.key = row_.question_key and o->>'key' = answer_bonus_question.answer
  ) then
    raise exception 'not an option of this question' using errcode = '22023';
  end if;

  elapsed_ms := case when row_.shown_at is null then null
                     else greatest(0, (extract(epoch from (clock_timestamp() - row_.shown_at)) * 1000)::integer) end;

  update public.bonus_answers a
     set answer_key = answer_bonus_question.answer,
         answered_at = now(),
         response_ms = elapsed_ms,
         is_suspicious = elapsed_ms is null or elapsed_ms < min_answer_ms
   where a.checkin_id = row_.checkin_id;

  -- Pending or granted with the check-in, through the projection.
  update public.checkins c set bonus_points = bonus where c.id = checkin.id;

  return bonus;
end;
$$;

-- ---------------------------------------------------------------------------
-- Event log
-- ---------------------------------------------------------------------------

-- The whitelist: log_events drops every other name. Inactive names stay for
-- the history in app_events.
create table public.event_names (
  name text primary key check (name ~ '^[a-z][a-z0-9_]{1,47}$'),
  description text not null check (char_length(description) between 1 and 300),
  active boolean not null default true
);

comment on table public.event_names is
  'Events the app may log (docs/ANALYTICS.md). A new event = one row in a migration.';

alter table public.event_names enable row level security;
revoke all on public.event_names from anon, authenticated;

insert into public.event_names (name, description) values
  ('app_open', 'The app starts (cold) or comes back from the background (warm).'),
  ('session_start', 'A new session: a cold start, a sign-in, or back after more than 30 minutes away.'),
  ('session_end', 'The previous session is over; sent as soon as that is certain.'),
  ('app_background', 'The app goes to the background.'),
  ('screen_view', 'Another screen is shown (route name without parameters).'),
  ('map_bin_tap', 'A bin pin on the map is tapped.'),
  ('checkin_flow_start', 'The check-in button is tapped.'),
  ('camera_opened', 'The camera opens, for a check-in or a report.'),
  ('photo_taken', 'A photo is taken (or retaken).'),
  ('checkin_submitted', 'A check-in is sent.'),
  ('checkin_result', 'The answer to a check-in arrives.'),
  ('reveal_shown', 'The points reveal starts.'),
  ('reveal_skipped', 'The reveal is skipped.'),
  ('bonus_question_answered', 'The bonus question is answered or skipped.'),
  ('leaderboard_viewed', 'The leaderboard is opened or switches period.'),
  ('report_flow_start', 'A report of a missing bin starts (long press on the map).'),
  ('report_submitted', 'A report of a missing bin is sent.');

create table public.app_events (
  -- made by the app, so a batch sent twice is stored once
  id uuid primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  session_id uuid not null,
  name text not null references public.event_names (name),
  props jsonb not null default '{}'::jsonb check (jsonb_typeof(props) = 'object'),
  client_ts timestamptz not null,
  server_ts timestamptz not null default now(),
  app_version text check (char_length(app_version) <= 40),
  update_id text check (char_length(update_id) <= 64),
  platform text check (char_length(platform) <= 20),
  -- events from Dev mode previews (only accepted from admins on local or staging)
  is_test boolean not null default false
);

comment on table public.app_events is
  'Usage events of the app, written only by log_events (docs/ANALYTICS.md). Never locations in props.';

create index app_events_user_ts_idx on public.app_events (user_id, server_ts);
create index app_events_name_ts_idx on public.app_events (name, server_ts);

alter table public.app_events enable row level security;
revoke all on public.app_events from anon, authenticated;
grant select on public.app_events to authenticated;

create policy "app_events: admins read all"
  on public.app_events for select to authenticated
  using ((select public.is_admin()));

-- Stores a batch of the caller's events. The whole batch is checked in one
-- set-based statement; rows that fail a check are dropped, the rest is kept.
-- Event: {id, session_id, name, props, client_ts, is_test}; client:
-- {app_version, update_id, platform}. Answer: {accepted, dropped, rate_limited}
-- (accepted includes events that were already stored).
create function public.log_events(events jsonb, client jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  max_batch constant integer := 100;
  max_props_bytes constant integer := 2048;
  max_props_keys constant integer := 20;
  max_age constant interval := interval '30 days';
  max_ahead constant interval := interval '1 day';
  max_per_hour constant integer := 600;
  uuid_re constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  -- prop keys that smell like a location (keys are snake_case, see below)
  location_re constant text :=
    '(^|_)(lat|lon|lng|latitude|longitude|latlng|lnglat|geo|geom|geometry|geohash|coord|coords|coordinates|location|loc|position|gps|address|altitude)(_|$)';
  uid constant uuid := auth.uid();
  total integer;
  budget integer;
  valid_count integer;
  new_count integer;
  limited integer;
  test_ok boolean;
  v_app_version text;
  v_update_id text;
  v_platform text;
begin
  if uid is null then
    raise exception 'sign in to log events' using errcode = '42501';
  end if;
  if events is null or jsonb_typeof(events) <> 'array' then
    raise exception 'events must be an array' using errcode = '22023';
  end if;
  total := jsonb_array_length(events);
  if total > max_batch then
    raise exception 'at most % events per batch', max_batch using errcode = '22023';
  end if;
  if total = 0 then
    return jsonb_build_object('accepted', 0, 'dropped', 0, 'rate_limited', 0);
  end if;

  v_app_version := case when jsonb_typeof(client->'app_version') = 'string' then left(client->>'app_version', 40) end;
  v_update_id := case when jsonb_typeof(client->'update_id') = 'string' then left(client->>'update_id', 64) end;
  v_platform := case when jsonb_typeof(client->'platform') = 'string' then left(client->>'platform', 20) end;
  test_ok := public.dev_mode_allowed();

  -- One batch of this user at a time, so parallel batches cannot beat the limit.
  perform pg_advisory_xact_lock(hashtextextended('events:' || uid::text, 0));
  select greatest(0, max_per_hour - count(*))::integer into budget
  from public.app_events a
  where a.user_id = uid and a.server_ts > now() - interval '1 hour';

  -- The casts sit behind CASE so a malformed row becomes nulls instead of an
  -- error, whatever order the planner checks the conditions in.
  with input as (
    select x.e, x.n from jsonb_array_elements(events) with ordinality as x(e, n)
  ),
  shaped as (
    select i.n, i.e,
           coalesce(jsonb_typeof(i.e) = 'object'
             and i.e->>'id' ~ uuid_re
             and i.e->>'session_id' ~ uuid_re
             and jsonb_typeof(i.e->'name') = 'string'
             and i.e->>'client_ts' ~ '^\d{4}-\d{2}-\d{2}T'
             and pg_input_is_valid(i.e->>'client_ts', 'timestamptz')
             and jsonb_typeof(coalesce(i.e->'props', '{}'::jsonb)) = 'object'
             and jsonb_typeof(coalesce(i.e->'is_test', 'false'::jsonb)) = 'boolean', false) as ok
    from input i
  ),
  parsed as (
    select s.n,
           case when s.ok then (s.e->>'id')::uuid end as id,
           case when s.ok then (s.e->>'session_id')::uuid end as session_id,
           case when s.ok then s.e->>'name' end as name,
           case when s.ok then coalesce(s.e->'props', '{}'::jsonb) end as props,
           case when s.ok then (s.e->>'client_ts')::timestamptz end as client_ts,
           case when s.ok then coalesce((s.e->>'is_test')::boolean, false) end as is_test
    from shaped s
  ),
  valid as (
    select p.*
    from parsed p
    where p.id is not null
      and exists (select 1 from public.event_names en where en.name = p.name and en.active)
      and p.client_ts between now() - max_age and now() + max_ahead
      and octet_length(p.props::text) <= max_props_bytes
      and (select count(*) from jsonb_object_keys(p.props)) <= max_props_keys
      -- flat objects with snake_case keys and no location
      and not exists (
        select 1 from jsonb_each(p.props) kv
        where kv.key !~ '^[a-z][a-z0-9_]{0,39}$'
           or kv.key ~ location_re
           or jsonb_typeof(kv.value) in ('object', 'array')
      )
  ),
  fresh as (
    select distinct on (v.id) v.*
    from valid v
    where not exists (select 1 from public.app_events a where a.id = v.id)
    order by v.id, v.n
  ),
  numbered as (
    select f.*, row_number() over (order by f.n) as k from fresh f
  ),
  stored as (
    insert into public.app_events
      (id, user_id, session_id, name, props, client_ts, app_version, update_id, platform, is_test)
    select r.id, uid, r.session_id, r.name, r.props, r.client_ts, v_app_version, v_update_id, v_platform,
           r.is_test and test_ok
    from numbered r
    where r.k <= budget
    on conflict (id) do nothing
  )
  select (select count(*) from valid), (select count(*) from fresh) into valid_count, new_count;

  limited := greatest(new_count - budget, 0);
  return jsonb_build_object('accepted', valid_count - limited, 'dropped', total - valid_count, 'rate_limited', limited);
end;
$$;

revoke execute on function public.log_events(jsonb, jsonb) from public, anon;
grant execute on function public.log_events(jsonb, jsonb) to authenticated;

notify pgrst, 'reload schema';
