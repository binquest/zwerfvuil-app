-- Dev mode: lets an admin test every feature on a local or staging database
-- without walking to a bin. It replaces the old fake-location escape
-- (ALLOW_FAKE_LOCATION, local only) with an admin-only exception.
--
-- Guardrails, all enforced here and never only in the app:
--   - admin only, and only on the caller's own account;
--   - only when private.app_environment says 'local' or 'staging' (refused
--     in production and when the marker is missing);
--   - everything Dev mode touches is flagged as test: check-ins and bonus
--     answers (is_test) and their points (profiles.test_points). Test data
--     never counts for real streaks, the leaderboard or the bin-need data
--     (bin_need_answers);
--   - every action is logged in dev_audit_log.
--
-- What it offers:
--   - a fake location: record_checkin accepts a location picked on the map
--     from an admin on local or staging, as a test check-in;
--   - a streak override: the caller's next check-ins use that many streak
--     weeks, as test check-ins;
--   - a reset of the caller's own test data (test check-ins with their bonus
--     answers, test points, the override);
--   - the leaderboard with test data, to check that test points appear and
--     disappear.

-- ---------------------------------------------------------------------------
-- Test flags
-- ---------------------------------------------------------------------------

alter table public.checkins add column is_test boolean not null default false;
alter table public.bonus_answers add column is_test boolean not null default false;
alter table public.profiles
  add column test_points integer not null default 0 check (test_points >= 0);

comment on column public.checkins.is_test is
  'Made in Dev mode (fake location or streak override): never counts for real points, streaks, the leaderboard or bin data.';
comment on column public.bonus_answers.is_test is 'Answer to the question of a test check-in.';
comment on column public.profiles.test_points is
  'Points of approved test check-ins (Dev mode), kept apart from points.';

-- ---------------------------------------------------------------------------
-- Who may use Dev mode
-- ---------------------------------------------------------------------------

create function public.dev_mode_allowed_for(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select p.is_admin from public.profiles p where p.id = p_user_id), false)
     and coalesce(public.app_environment() in ('local', 'staging'), false);
$$;

revoke execute on function public.dev_mode_allowed_for(uuid) from public, anon, authenticated;
grant execute on function public.dev_mode_allowed_for(uuid) to service_role;

create function public.dev_mode_allowed()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.dev_mode_allowed_for((select auth.uid()));
$$;

revoke execute on function public.dev_mode_allowed() from public, anon;
grant execute on function public.dev_mode_allowed() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Settings and audit log (no direct client writes)
-- ---------------------------------------------------------------------------

create table public.dev_settings (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  streak_override integer check (streak_override between 0 and 52),
  updated_at timestamptz not null default now()
);

create table public.dev_audit_log (
  id bigint generated always as identity primary key,
  -- no foreign key: the log outlives the account
  user_id uuid not null,
  action text not null check (action in ('streak_override', 'test_checkin', 'reset')),
  details jsonb not null default '{}'::jsonb,
  environment text,
  created_at timestamptz not null default now()
);

create index dev_audit_log_user_created_idx on public.dev_audit_log (user_id, created_at desc);

alter table public.dev_settings enable row level security;
alter table public.dev_audit_log enable row level security;
revoke all on public.dev_settings, public.dev_audit_log from anon, authenticated;
grant select on public.dev_audit_log to authenticated;

create policy "dev_audit_log: admins read all"
  on public.dev_audit_log for select to authenticated
  using ((select public.is_admin()));

-- ---------------------------------------------------------------------------
-- Streaks: real streaks ignore test check-ins
-- ---------------------------------------------------------------------------

drop function public.my_streak();
drop function public.streak_weeks(uuid, date);

-- Consecutive weeks with at least one check-in that was not rejected, ending at
-- p_week (a Monday, as a local date in Gent). Test check-ins only count when
-- p_include_test.
create function public.streak_weeks(p_user_id uuid, p_week date, p_include_test boolean default false)
returns integer
language sql
stable
set search_path = ''
as $$
  with weeks as (
    select distinct date_trunc('week', c.created_at at time zone 'Europe/Brussels')::date as wk
    from public.checkins c
    where c.user_id = p_user_id and c.status <> 'rejected' and (p_include_test or not c.is_test)
  ),
  numbered as (
    select w.wk, row_number() over (order by w.wk desc) as rn
    from weeks w
    where w.wk <= p_week
  )
  select count(*)::integer from numbered n where n.wk = p_week - ((n.rn - 1) * 7)::integer;
$$;

revoke execute on function public.streak_weeks(uuid, date, boolean) from public, anon, authenticated;
grant execute on function public.streak_weeks(uuid, date, boolean) to service_role;

create function public.my_streak()
returns table (weeks integer, this_week boolean)
language sql
stable
security definer
set search_path = ''
as $$
  with w as (select date_trunc('week', now() at time zone 'Europe/Brussels')::date as cur),
  s as (
    select public.streak_weeks(auth.uid(), w.cur) as now_weeks,
           public.streak_weeks(auth.uid(), w.cur - 7) as last_weeks
    from w
  )
  select case when s.now_weeks > 0 then s.now_weeks else s.last_weeks end, s.now_weeks > 0
  from s;
$$;

revoke execute on function public.my_streak() from public, anon;
grant execute on function public.my_streak() to authenticated;

-- ---------------------------------------------------------------------------
-- record_checkin: fake locations and the streak override for Dev mode
-- (20261014200000 plus is_test; a refused fake location is now a reason
-- instead of an error, so submit-checkin can answer 403).
-- ---------------------------------------------------------------------------

drop function public.record_checkin(uuid, uuid, bigint, double precision, double precision, real, boolean, boolean, text);

create function public.record_checkin(
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
         else jsonb_build_object('key', question.key, 'prompt', question.prompt, 'options', question.options)
    end,
    test;
end;
$$;

revoke execute on function public.record_checkin(uuid, uuid, bigint, double precision, double precision, real, boolean, boolean, text)
  from public, anon, authenticated;
grant execute on function public.record_checkin(uuid, uuid, bigint, double precision, double precision, real, boolean, boolean, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- Points of test check-ins go to test_points
-- ---------------------------------------------------------------------------

create or replace function public.review_checkin(id uuid, approve boolean)
returns public.checkins
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  checkin public.checkins;
begin
  if not public.is_admin() then
    raise exception 'only admins can review check-ins' using errcode = '42501';
  end if;
  if approve is null then
    raise exception 'approve must be true or false' using errcode = '22023';
  end if;

  select * into checkin from public.checkins c where c.id = review_checkin.id for update;
  if not found then
    raise exception 'check-in % not found', review_checkin.id using errcode = 'P0002';
  end if;
  if checkin.status <> 'pending' then
    raise exception 'check-in % is already %', review_checkin.id, checkin.status using errcode = '55000';
  end if;

  update public.checkins c
     set status = case when approve then 'approved' else 'rejected' end,
         points_awarded = case when approve then c.points_earned + c.bonus_points else 0 end,
         reviewed_at = now(),
         reviewed_by = auth.uid()
   where c.id = review_checkin.id
  returning * into checkin;

  if approve and checkin.is_test then
    update public.profiles p set test_points = p.test_points + checkin.points_awarded where p.id = checkin.user_id;
  elsif approve then
    update public.profiles p set points = p.points + checkin.points_awarded where p.id = checkin.user_id;
  end if;

  return checkin;
end;
$$;

create or replace function public.answer_bonus_question(checkin_id uuid, answer text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  bonus constant integer := 5;
  min_answer_ms constant integer := 1200;
  answer_window constant interval := interval '1 hour';
  row_ public.bonus_answers;
  checkin public.checkins;
  elapsed_ms integer;
begin
  -- Lock the check-in first, in the same order as review_checkin.
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

  update public.checkins c
     set bonus_points = bonus,
         points_awarded = case when c.status = 'approved' then c.points_awarded + bonus else c.points_awarded end
   where c.id = checkin.id;
  if checkin.status = 'approved' and checkin.is_test then
    update public.profiles p set test_points = p.test_points + bonus where p.id = checkin.user_id;
  elsif checkin.status = 'approved' then
    update public.profiles p set points = p.points + bonus where p.id = checkin.user_id;
  end if;

  return bonus;
end;
$$;

-- ---------------------------------------------------------------------------
-- Leaderboard: without test data, unless an admin asks for it in Dev mode
-- ---------------------------------------------------------------------------

drop function public.leaderboard(text, integer);

create function public.leaderboard(period text, max_rows integer default 50, include_test boolean default false)
returns table (place integer, display_name text, points integer, is_me boolean)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  with_test constant boolean := coalesce(leaderboard.include_test, false);
begin
  if auth.uid() is null then
    raise exception 'sign in to see the leaderboard' using errcode = '42501';
  end if;
  if period is null or period not in ('week', 'all') then
    raise exception 'period must be week or all' using errcode = '22023';
  end if;
  if with_test and not public.dev_mode_allowed() then
    raise exception 'test data is only visible to admins in Dev mode' using errcode = '42501';
  end if;

  return query
    with scores as (
      select p.id as user_id, p.display_name as name,
             p.points + case when with_test then p.test_points else 0 end as pts
      from public.profiles p
      where leaderboard.period = 'all'
      union all
      select c.user_id, p.display_name, sum(c.points_awarded)::integer
      from public.checkins c
      join public.profiles p on p.id = c.user_id
      where leaderboard.period = 'week'
        and c.status = 'approved'
        and (with_test or not c.is_test)
        and c.created_at >= public.local_week_start(now())
      group by c.user_id, p.display_name
    ),
    ranked as (
      select s.user_id, s.name, s.pts,
             rank() over (order by s.pts desc)::integer as place_,
             row_number() over (order by s.pts desc, s.name, s.user_id) as rn
      from scores s
      where s.pts > 0
    )
    select r.place_, coalesce(r.name, 'Anoniem'), r.pts, r.user_id = auth.uid()
    from ranked r
    where r.rn <= least(greatest(coalesce(leaderboard.max_rows, 50), 1), 100) or r.user_id = auth.uid()
    order by r.rn;
end;
$$;

revoke execute on function public.leaderboard(text, integer, boolean) from public, anon;
grant execute on function public.leaderboard(text, integer, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Bin-need data: answered questions of real, not rejected check-ins
-- ---------------------------------------------------------------------------

-- Runs with the caller's rights: only admins can read bonus_answers.
create view public.bin_need_answers
with (security_invoker = true)
as
  select a.checkin_id, a.bin_id, a.user_geom, a.question_key, a.answer_key, a.answered_at,
         a.response_ms, a.is_suspicious
  from public.bonus_answers a
  join public.checkins c on c.id = a.checkin_id
  where a.answered_at is not null and not a.is_test and not c.is_test and c.status <> 'rejected';

comment on view public.bin_need_answers is
  'Input for the analysis of where bins are missing: no test data, no rejected check-ins. Filter is_suspicious as needed.';

revoke all on public.bin_need_answers from anon, authenticated;
grant select on public.bin_need_answers to authenticated;

-- ---------------------------------------------------------------------------
-- Admin queue: plus is_test
-- ---------------------------------------------------------------------------

drop function public.pending_checkins();

create function public.pending_checkins()
returns table (
  id uuid,
  created_at timestamptz,
  user_id uuid,
  display_name text,
  bin_id bigint,
  bin_latitude double precision,
  bin_longitude double precision,
  latitude double precision,
  longitude double precision,
  distance_m real,
  accuracy_m real,
  is_mocked boolean,
  is_fake_location boolean,
  photo_path text,
  streak_weeks integer,
  points_earned integer,
  bonus_points integer,
  bonus_suspicious boolean,
  is_test boolean
)
language plpgsql
stable
set search_path = public, extensions, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'only admins can list pending check-ins' using errcode = '42501';
  end if;
  return query
    select c.id, c.created_at, c.user_id, p.display_name, c.bin_id,
           st_y(b.geom::geometry), st_x(b.geom::geometry),
           st_y(c.user_geom::geometry), st_x(c.user_geom::geometry),
           c.distance_m, c.accuracy_m, c.is_mocked, c.is_fake_location, c.photo_path,
           c.streak_weeks, c.points_earned, c.bonus_points, coalesce(a.is_suspicious, false), c.is_test
    from public.checkins c
    join public.bins b on b.id = c.bin_id
    left join public.profiles p on p.id = c.user_id
    left join public.bonus_answers a on a.checkin_id = c.id
    where c.status = 'pending'
    order by c.created_at
    limit 200;
end;
$$;

revoke execute on function public.pending_checkins() from public, anon;
grant execute on function public.pending_checkins() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Dev mode RPCs (the caller's own account only)
-- ---------------------------------------------------------------------------

-- For the admin screen: whether Dev mode is available and the caller's test state.
create function public.dev_mode_status()
returns table (
  allowed boolean,
  environment text,
  streak_override integer,
  test_points integer,
  test_checkins integer
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  if not public.dev_mode_allowed() then
    return query select false, null::text, null::integer, null::integer, null::integer;
    return;
  end if;
  return query
    select true, public.app_environment(),
           (select s.streak_override from public.dev_settings s where s.user_id = auth.uid()),
           (select p.test_points from public.profiles p where p.id = auth.uid()),
           (select count(*)::integer from public.checkins c where c.user_id = auth.uid() and c.is_test);
end;
$$;

revoke execute on function public.dev_mode_status() from public, anon;
grant execute on function public.dev_mode_status() to authenticated;

-- Sets (0..52) or clears (null) the caller's streak override.
create function public.set_dev_streak_override(weeks integer)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.dev_mode_allowed() then
    raise exception 'Dev mode is only for admins on a local or staging database' using errcode = '42501';
  end if;
  if weeks is not null and weeks not between 0 and 52 then
    raise exception 'weeks must be between 0 and 52' using errcode = '22023';
  end if;

  insert into public.dev_settings as s (user_id, streak_override, updated_at)
  values (auth.uid(), weeks, now())
  on conflict (user_id) do update set streak_override = excluded.streak_override, updated_at = now();

  insert into public.dev_audit_log (user_id, action, details, environment)
  values (auth.uid(), 'streak_override', jsonb_build_object('weeks', weeks), public.app_environment());
  return weeks;
end;
$$;

revoke execute on function public.set_dev_streak_override(integer) from public, anon;
grant execute on function public.set_dev_streak_override(integer) to authenticated;

-- Removes the caller's test check-ins (with their bonus answers), test points
-- and streak override. Returns the photo paths of the removed check-ins; the
-- app deletes those files (storage policy below), real photos stay.
create function public.reset_dev_test_data()
returns table (deleted_checkins integer, photo_paths text[])
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  paths text[];
  removed integer;
begin
  if not public.dev_mode_allowed() then
    raise exception 'Dev mode is only for admins on a local or staging database' using errcode = '42501';
  end if;

  with gone as (
    delete from public.checkins c
     where c.user_id = auth.uid() and c.is_test
    returning c.photo_path
  )
  select count(*)::integer, coalesce(array_agg(gone.photo_path), '{}') into removed, paths from gone;

  update public.profiles p set test_points = 0 where p.id = auth.uid();
  delete from public.dev_settings s where s.user_id = auth.uid();

  insert into public.dev_audit_log (user_id, action, details, environment)
  values (auth.uid(), 'reset', jsonb_build_object('deleted_checkins', removed), public.app_environment());

  return query select removed, paths;
end;
$$;

revoke execute on function public.reset_dev_test_data() from public, anon;
grant execute on function public.reset_dev_test_data() to authenticated;

-- After a reset the app removes the photos of the deleted test check-ins. An
-- admin may only delete photos in their own folder that no check-in uses.
create policy "checkin-photos: admins delete own unused photos"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'checkin-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (select public.is_admin())
    and not exists (select 1 from public.checkins c where c.photo_path = storage.objects.name)
  );
