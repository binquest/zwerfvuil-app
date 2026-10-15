-- Points with a weekly streak, a bonus question after each check-in, and a
-- leaderboard.
--
-- Points are computed when the check-in is recorded (record_checkin, called by
-- the submit-checkin edge function) and granted when an admin approves it:
--   - base 10 points, then one x1.1 stage per streak week, at most 8 stages
--     (x2.14 after two months);
--   - a streak is the number of consecutive weeks (Monday to Sunday in Gent),
--     up to and including the week of the check-in, with at least one
--     check-in that was not rejected;
--   - stage k is round(10 * 1.1^k); the last stage is the check-in's points.
-- The app only animates the stages the server returns.
--
-- Bonus question: record_checkin offers one question per check-in, the one
-- this user was offered least often. The app marks it shown when it appears
-- and sends the answer; a valid answer earns 5 points, granted with the
-- check-in. Answers within 1.2 s of being shown are flagged as suspicious.
-- Answers keep the bin, the user's location and the time, for a later analysis
-- of where bins are missing.
--
-- Leaderboard: this week (approved points of check-ins made this week) and
-- all time (profile points); display names only.

-- ---------------------------------------------------------------------------
-- Points on check-ins
-- ---------------------------------------------------------------------------

alter table public.checkins
  add column streak_weeks integer not null default 0 check (streak_weeks >= 0),
  add column points_earned integer not null default 0 check (points_earned >= 0),
  add column bonus_points integer not null default 0 check (bonus_points >= 0);

comment on column public.checkins.streak_weeks is
  'The streak in weeks when the check-in was recorded (stages above 8 add nothing).';
comment on column public.checkins.points_earned is
  'Points computed by record_checkin (base and streak stages), granted on approval.';
comment on column public.checkins.bonus_points is
  'Points of the answered bonus question, granted with the check-in.';

-- Check-ins from before this migration earned the flat 10 points.
update public.checkins
   set points_earned = case when status = 'approved' then points_awarded else 10 end;

-- Start of the week (Monday 00:00) in Gent.
create function public.local_week_start(ts timestamptz default now())
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select date_trunc('week', ts at time zone 'Europe/Brussels') at time zone 'Europe/Brussels';
$$;

revoke execute on function public.local_week_start(timestamptz) from public, anon;
grant execute on function public.local_week_start(timestamptz) to authenticated, service_role;

-- Consecutive weeks with at least one check-in that was not rejected, ending at
-- p_week (a Monday, as a local date in Gent). 0 when p_week has no check-in.
create function public.streak_weeks(p_user_id uuid, p_week date)
returns integer
language sql
stable
set search_path = ''
as $$
  with weeks as (
    select distinct date_trunc('week', c.created_at at time zone 'Europe/Brussels')::date as wk
    from public.checkins c
    where c.user_id = p_user_id and c.status <> 'rejected'
  ),
  numbered as (
    select w.wk, row_number() over (order by w.wk desc) as rn
    from weeks w
    where w.wk <= p_week
  )
  -- Week n (counting back from p_week) must be exactly n-1 weeks before it;
  -- after the first gap no later row can match again.
  select count(*)::integer from numbered n where n.wk = p_week - ((n.rn - 1) * 7)::integer;
$$;

revoke execute on function public.streak_weeks(uuid, date) from public, anon, authenticated;
grant execute on function public.streak_weeks(uuid, date) to service_role;

-- The point stages of a check-in: base 10, then x1.1 per streak week, at most
-- 8 stages. The last element is the check-in's points.
create function public.checkin_point_stages(p_streak_weeks integer)
returns integer[]
language sql
immutable
set search_path = ''
as $$
  select array_agg(round(10 * power(1.1::numeric, k))::integer order by k)
  from generate_series(0, least(greatest(coalesce(p_streak_weeks, 0), 0), 8)) as k;
$$;

revoke execute on function public.checkin_point_stages(integer) from public, anon;
grant execute on function public.checkin_point_stages(integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Bonus questions
-- ---------------------------------------------------------------------------

create table public.bonus_questions (
  key text primary key check (key ~ '^[a-z_]+$'),
  prompt text not null check (char_length(prompt) between 1 and 120),
  -- [{"key": "...", "label": "..."}, ...]
  options jsonb not null check (jsonb_typeof(options) = 'array' and jsonb_array_length(options) between 2 and 5),
  sort smallint not null,
  active boolean not null default true
);

comment on table public.bonus_questions is
  'Questions offered after a check-in (one per check-in, rotated per user). Add or deactivate rows without an app update.';

insert into public.bonus_questions (key, prompt, options, sort) values
  ('bin_fullness', 'Hoe vol zat de vuilbak?',
   '[{"key":"empty","label":"Bijna leeg"},{"key":"half","label":"Half vol"},{"key":"full","label":"Vol of overvol"}]', 1),
  ('find_ease', 'Hoe makkelijk vond je een vuilbak?',
   '[{"key":"easy","label":"Meteen"},{"key":"some","label":"Even zoeken"},{"key":"hard","label":"Moeilijk"}]', 2),
  ('walk_distance', 'Hoe ver moest je stappen naar een vuilbak?',
   '[{"key":"lt50","label":"Minder dan 50 m"},{"key":"50_200","label":"50 tot 200 m"},{"key":"gt200","label":"Meer dan 200 m"}]', 3),
  ('litter_amount', 'Hoeveel zwerfvuil lag er in de buurt?',
   '[{"key":"little","label":"Weinig"},{"key":"some","label":"Wat"},{"key":"lots","label":"Veel"}]', 4),
  ('extra_bin', 'Zou een extra vuilbak hier in de buurt helpen?',
   '[{"key":"yes","label":"Ja, zeker"},{"key":"maybe","label":"Misschien"},{"key":"no","label":"Nee"}]', 5),
  ('pickup_place', 'Waar lag het zwerfvuil dat je opraapte?',
   '[{"key":"street","label":"Op straat of stoep"},{"key":"green","label":"In het groen of een park"},{"key":"stop","label":"Aan een halte of bank"}]', 6);

-- One row per check-in: the offered question and, once answered, the answer.
create table public.bonus_answers (
  checkin_id uuid primary key references public.checkins (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  bin_id bigint not null references public.bins (id),
  user_geom extensions.geography(Point, 4326) not null,
  question_key text not null references public.bonus_questions (key),
  offered_at timestamptz not null default now(),
  shown_at timestamptz,
  answer_key text,
  answered_at timestamptz,
  response_ms integer check (response_ms >= 0),
  is_suspicious boolean,
  constraint bonus_answers_answer_complete check (
    (answer_key is null) = (answered_at is null) and (answered_at is null) = (is_suspicious is null)
  )
);

comment on table public.bonus_answers is
  'Bonus question per check-in, with bin, user location and time for the analysis of where bins are missing. is_suspicious: answered within 1.2 s of being shown (or never marked shown).';

create index bonus_answers_user_question_idx on public.bonus_answers (user_id, question_key);
create index bonus_answers_question_answered_idx on public.bonus_answers (question_key, answered_at)
  where answered_at is not null;
create index bonus_answers_geom_idx on public.bonus_answers using gist (user_geom);

-- Users only reach these through the functions below. Admins can read the
-- answers (pending_checkins runs with the caller's rights); users cannot read
-- their own, so the suspicious flag stays hidden from them.
alter table public.bonus_questions enable row level security;
alter table public.bonus_answers enable row level security;
revoke all on public.bonus_questions, public.bonus_answers from anon, authenticated;
grant select on public.bonus_answers to authenticated;

create policy "bonus_answers: admins read all"
  on public.bonus_answers for select to authenticated
  using ((select public.is_admin()));

-- ---------------------------------------------------------------------------
-- record_checkin: the rules of 20261012143619_environment_guard.sql, then the
-- points and the bonus question. New result columns, so drop and recreate.
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
  bonus_question jsonb
)
language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare
  max_distance_m constant double precision := 25;
  cooldown constant interval := interval '10 minutes';
  max_checkins_per_day constant integer := 20;
  bin public.bins;
  dist double precision;
  last_at timestamptz;
  today integer;
  streak integer;
  stages integer[];
  question public.bonus_questions;
begin
  if p_lat is null or p_lon is null or p_lat not between -90 and 90 or p_lon not between -180 and 180 then
    raise exception 'invalid coordinates' using errcode = '22023';
  end if;

  if coalesce(p_is_fake_location, false) and public.app_environment() is distinct from 'local' then
    raise exception 'fake locations are only accepted on a local database (environment: %)',
      coalesce(public.app_environment(), 'unknown') using errcode = '42501';
  end if;

  -- Serialise check-ins per user so parallel requests cannot beat the limits.
  perform pg_advisory_xact_lock(hashtextextended('checkins:' || p_user_id::text, 0));

  select * into bin from public.bins b where b.id = p_bin_id;
  if not found then
    return query select false, 'bin_not_found', null::uuid, null::double precision, null::integer,
      null::integer, null::integer[], null::integer, null::jsonb;
    return;
  end if;
  if bin.status <> 'active' then
    return query select false, 'bin_inactive', null::uuid, null::double precision, null::integer,
      null::integer, null::integer[], null::integer, null::jsonb;
    return;
  end if;
  if not bin.eligible_effective then
    return query select false, 'bin_not_eligible', null::uuid, null::double precision, null::integer,
      null::integer, null::integer[], null::integer, null::jsonb;
    return;
  end if;

  dist := st_distance(bin.geom, st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography);
  if dist > max_distance_m then
    return query select false, 'too_far', null::uuid, dist, null::integer,
      null::integer, null::integer[], null::integer, null::jsonb;
    return;
  end if;

  select max(c.created_at) into last_at
  from public.checkins c
  where c.user_id = p_user_id and c.bin_id = p_bin_id and c.created_at > now() - cooldown;
  if last_at is not null then
    return query select false, 'cooldown', null::uuid, dist,
      ceil(extract(epoch from last_at + cooldown - now()))::integer,
      null::integer, null::integer[], null::integer, null::jsonb;
    return;
  end if;

  select count(*) into today
  from public.checkins c
  where c.user_id = p_user_id and c.created_at >= public.local_day_start(now());
  if today >= max_checkins_per_day then
    return query select false, 'daily_limit', null::uuid, dist,
      ceil(extract(epoch from public.local_day_start(now()) + interval '1 day' - now()))::integer,
      null::integer, null::integer[], null::integer, null::jsonb;
    return;
  end if;

  insert into public.checkins
    (id, user_id, bin_id, photo_path, user_geom, accuracy_m, distance_m, is_mocked, is_fake_location)
  values
    (p_checkin_id, p_user_id, p_bin_id, p_photo_path,
     st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography,
     p_accuracy_m, dist, coalesce(p_is_mocked, false), coalesce(p_is_fake_location, false));

  -- The new check-in counts for its own week, so the streak is at least 1.
  streak := public.streak_weeks(p_user_id, date_trunc('week', now() at time zone 'Europe/Brussels')::date);
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
    insert into public.bonus_answers (checkin_id, user_id, bin_id, user_geom, question_key)
    values (p_checkin_id, p_user_id, p_bin_id, st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography, question.key);
  end if;

  return query select true, null::text, p_checkin_id, dist, null::integer,
    streak, stages, stages[array_upper(stages, 1)],
    case when question.key is null then null
         else jsonb_build_object('key', question.key, 'prompt', question.prompt, 'options', question.options)
    end;
end;
$$;

revoke execute on function public.record_checkin(uuid, uuid, bigint, double precision, double precision, real, boolean, boolean, text)
  from public, anon, authenticated;
grant execute on function public.record_checkin(uuid, uuid, bigint, double precision, double precision, real, boolean, boolean, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- review_checkin: grants points_earned + bonus_points instead of a flat 10.
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

  if approve then
    update public.profiles p set points = p.points + checkin.points_awarded where p.id = checkin.user_id;
  end if;

  return checkin;
end;
$$;

-- ---------------------------------------------------------------------------
-- Bonus question RPCs (for the signed-in user's own check-ins)
-- ---------------------------------------------------------------------------

-- Called when the question appears; the answer time is measured from here.
create function public.mark_bonus_question_shown(checkin_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.bonus_answers a
     set shown_at = now()
   where a.checkin_id = mark_bonus_question_shown.checkin_id
     and a.user_id = auth.uid()
     and a.shown_at is null
     and a.answered_at is null;
end;
$$;

revoke execute on function public.mark_bonus_question_shown(uuid) from public, anon;
grant execute on function public.mark_bonus_question_shown(uuid) to authenticated;

-- Stores the answer and returns the bonus points (5). Errors:
--   P0002 no question for this check-in (or not the caller's)
--   22023 not an option of the question
--   55000 already answered, older than 1 hour, or the check-in was rejected
create function public.answer_bonus_question(checkin_id uuid, answer text)
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
  if checkin.status = 'approved' then
    update public.profiles p set points = p.points + bonus where p.id = checkin.user_id;
  end if;

  return bonus;
end;
$$;

revoke execute on function public.answer_bonus_question(uuid, text) from public, anon;
grant execute on function public.answer_bonus_question(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Streak of the signed-in user, for the profile
-- ---------------------------------------------------------------------------

-- weeks: the current streak; it stays alive through this week when last week
-- had a check-in. this_week: whether this week already counts.
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
-- Leaderboard
-- ---------------------------------------------------------------------------

-- period 'week': approved points of check-ins made this week (Gent);
-- period 'all': profile points. Users with 0 points are left out. Returns
-- the top max_rows (at most 100) plus the caller's own row.
create function public.leaderboard(period text, max_rows integer default 50)
returns table (place integer, display_name text, points integer, is_me boolean)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  if auth.uid() is null then
    raise exception 'sign in to see the leaderboard' using errcode = '42501';
  end if;
  if period is null or period not in ('week', 'all') then
    raise exception 'period must be week or all' using errcode = '22023';
  end if;

  return query
    with scores as (
      select p.id as user_id, p.display_name as name, p.points as pts
      from public.profiles p
      where leaderboard.period = 'all'
      union all
      select c.user_id, p.display_name, sum(c.points_awarded)::integer
      from public.checkins c
      join public.profiles p on p.id = c.user_id
      where leaderboard.period = 'week'
        and c.status = 'approved'
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

revoke execute on function public.leaderboard(text, integer) from public, anon;
grant execute on function public.leaderboard(text, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- pending_checkins: plus points and the bonus answer flag (new columns, so
-- drop and recreate).
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
  bonus_suspicious boolean
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
           c.streak_weeks, c.points_earned, c.bonus_points, coalesce(a.is_suspicious, false)
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
