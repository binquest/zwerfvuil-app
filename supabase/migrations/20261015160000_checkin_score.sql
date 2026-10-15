-- The score of a check-in as steps (docs/GAMIFICATION.md, 2.7, chapter 4 and
-- phase 2).
--
-- private.checkin_score(streak) builds the steps the reveal plays, each with
-- its rounded running total: the base, then the streak with one stage per week
-- up to the maximum. The app plays exactly these numbers and computes nothing
-- itself. Same points as before: there is no discovery step yet (phase 3) and
-- no bounty (phase 8).
--
-- record_checkin returns `score` instead of `point_stages` and `points_total`
-- (a new result type, so it is dropped and created again with its grants).
-- checkin_point_stages is gone: checkin_score replaces it.
--
-- game_catalog() gives signed-in users the numbers of game_config, for the
-- labels in the app (x1.1 per week, up to x2.14) and the Dev mode preview.
-- Later phases add levels, badges, avatars, quests, milestones and chest odds.

-- ---------------------------------------------------------------------------
-- Score
-- ---------------------------------------------------------------------------

-- {steps: [base, streak], total}. Base: {kind, label, chips, mult 1, total}.
-- Streak: {kind, label, weeks, per_week, stages: [{mult, total}]}, one stage
-- per week up to streak_max_steps; `weeks` is the whole streak (more weeks
-- than stages = the maximum). `mult` is the exact combined multiplier
-- per_week^k (the app rounds it for display) and the running total is
-- round(chips * per_week^k). The total is the last running total.
create function private.checkin_score(p_streak_weeks integer)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with c as (
    select (private.cfg('checkin_base_chips'))::integer as chips,
           private.cfg('streak_multiplier') as per_week_json,
           (private.cfg('streak_multiplier'))::numeric as per_week,
           (private.cfg('streak_max_steps'))::integer as max_steps,
           greatest(coalesce(p_streak_weeks, 0), 0) as weeks
  ),
  stages as (
    select k,
           trim_scale(power(c.per_week, k)) as mult,
           round(c.chips * power(c.per_week, k))::integer as total
    from c cross join lateral generate_series(1, least(c.weeks, c.max_steps)) as k
  )
  select jsonb_build_object(
    'steps', jsonb_build_array(
      jsonb_build_object('kind', 'base', 'label', 'BASIS', 'chips', c.chips, 'mult', 1, 'total', c.chips),
      jsonb_build_object(
        'kind', 'streak', 'label', 'REEKS', 'weeks', c.weeks, 'per_week', c.per_week_json,
        'stages', coalesce((select jsonb_agg(jsonb_build_object('mult', s.mult, 'total', s.total) order by s.k)
                            from stages s), '[]'::jsonb))),
    'total', coalesce((select s.total from stages s order by s.k desc limit 1), c.chips))
  from c;
$$;

revoke execute on function private.checkin_score(integer) from public;

-- ---------------------------------------------------------------------------
-- record_checkin returns the score
-- ---------------------------------------------------------------------------

drop function public.record_checkin(uuid, uuid, bigint, double precision, double precision, real, boolean, boolean, text);
drop function public.checkin_point_stages(integer);

-- record_checkin from 20261015140000_config_and_events.sql: the same rules,
-- with `score` in place of `point_stages` and `points_total`. The check-in
-- stores the score's total as its points (the ledger follows, as before).
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
  score jsonb,
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
  result_score jsonb;
  question public.bonus_questions;
begin
  if p_lat is null or p_lon is null or p_lat not between -90 and 90 or p_lon not between -180 and 180 then
    raise exception 'invalid coordinates' using errcode = '22023';
  end if;

  -- Dev mode: only admins, only on local or staging.
  dev_ok := public.dev_mode_allowed_for(p_user_id);
  if fake and not dev_ok then
    return query select false, 'fake_location_not_allowed', null::uuid, null::double precision, null::integer,
      null::integer, null::jsonb, null::jsonb, null::boolean;
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
      null::integer, null::jsonb, null::jsonb, null::boolean;
    return;
  end if;
  if bin.status <> 'active' then
    return query select false, 'bin_inactive', null::uuid, null::double precision, null::integer,
      null::integer, null::jsonb, null::jsonb, null::boolean;
    return;
  end if;
  if not bin.eligible_effective then
    return query select false, 'bin_not_eligible', null::uuid, null::double precision, null::integer,
      null::integer, null::jsonb, null::jsonb, null::boolean;
    return;
  end if;

  dist := st_distance(bin.geom, st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography);
  if dist > max_distance_m then
    return query select false, 'too_far', null::uuid, dist, null::integer,
      null::integer, null::jsonb, null::jsonb, null::boolean;
    return;
  end if;

  select max(c.created_at) into last_at
  from public.checkins c
  where c.user_id = p_user_id and c.bin_id = p_bin_id and c.created_at > now() - cooldown;
  if last_at is not null then
    return query select false, 'cooldown', null::uuid, dist,
      ceil(extract(epoch from last_at + cooldown - now()))::integer,
      null::integer, null::jsonb, null::jsonb, null::boolean;
    return;
  end if;

  select count(*) into today
  from public.checkins c
  where c.user_id = p_user_id and c.created_at >= public.local_day_start(now());
  if today >= max_checkins_per_day then
    return query select false, 'daily_limit', null::uuid, dist,
      ceil(extract(epoch from public.local_day_start(now()) + interval '1 day' - now()))::integer,
      null::integer, null::jsonb, null::jsonb, null::boolean;
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
  -- A test check-in gets the same score (base and streak) as a real one.
  week := date_trunc('week', now() at time zone 'Europe/Brussels')::date;
  streak := case when test then coalesce(override, public.streak_weeks(p_user_id, week, true))
                 else public.streak_weeks(p_user_id, week, false) end;
  result_score := private.checkin_score(streak);
  update public.checkins c
     set streak_weeks = streak, points_earned = (result_score->>'total')::integer
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
    streak, result_score,
    case when question.key is null then null
         else jsonb_build_object('key', question.key, 'prompt', question.prompt, 'options', question.options,
                                 'points', (private.cfg('bonus_question_points'))::integer)
    end,
    test;
end;
$$;

revoke execute on function public.record_checkin(uuid, uuid, bigint, double precision, double precision, real, boolean, boolean, text)
  from public, anon, authenticated;
grant execute on function public.record_checkin(uuid, uuid, bigint, double precision, double precision, real, boolean, boolean, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- Catalog
-- ---------------------------------------------------------------------------

-- What the app may know about the game: for now {config: {key: value}}, every
-- number of game_config.
create function public.game_catalog()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('config', coalesce(jsonb_object_agg(c.key, c.value), '{}'::jsonb))
  from public.game_config c;
$$;

revoke execute on function public.game_catalog() from public, anon;
grant execute on function public.game_catalog() to authenticated;

notify pgrst, 'reload schema';
