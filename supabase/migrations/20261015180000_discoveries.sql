-- Discoveries, milestones and the collection (docs/GAMIFICATION.md, 2.2, 2.4,
-- 2.7, 2.8 and phase 3).
--
-- A discovery is the first check-in of a user at a bin that was not rejected
-- (real check-ins only). It earns discovery chips (+5) in the score of that
-- check-in: the score gets a discovery step before the streak, and the
-- check-in keeps its frozen score in checkins.score. The projection splits the
-- points of a check-in into ledger rows 'checkin' = round(10 * m) and
-- 'discovery' = round(15 * m) - checkin (m = the streak multiplier), together
-- exactly the total.
--
-- Game facts follow from the check-ins: private.refresh_game_state(user)
-- recomputes the discoveries and milestones of one user and changes only what
-- differs. Two certainties: a fact that holds over approved check-ins is
-- confirmed (granted); one that holds only over all check-ins that were not
-- rejected is pending; one that no longer holds is revoked. A rejection or
-- revocation therefore takes everything back by itself: the discovery moves
-- to the next check-in at that bin (without discovery points, those were
-- frozen in the rejected one) or is revoked, and milestones below their
-- threshold are revoked. A milestone earned again reuses its row and keeps its
-- frozen amount.
--
-- record_checkin, review_checkin, revoke_checkin and the bonus answer run the
-- refresh in a block of its own: an error in the game logic is written to
-- private.game_errors and never fails a valid check-in or review (the next
-- refresh repairs it). Test check-ins make no game facts and never count.
--
-- For the app: `game` in the answer of record_checkin (what is new), the
-- discovery counter in my_game_state(), the collection in my_collection(),
-- and moments missed since the last visit in my_unseen() / mark_seen().
--
-- Lock order (2.9): the user's advisory lock first, then rows. The refresh
-- takes the user's lock itself (a no-op for callers that hold it) and never
-- changes checkins.

-- ---------------------------------------------------------------------------
-- Config: discovery chips and the region of the counter
-- ---------------------------------------------------------------------------

insert into private.game_config_rules (key, kind, min_value, max_value) values
  ('discovery_chips', 'integer', 0, 50),
  ('region_west', 'number', -180, 180),
  ('region_south', 'number', -90, 90),
  ('region_east', 'number', -180, 180),
  ('region_north', 'number', -90, 90);

-- The region is config/region.json (Oude Houtlei, Gent, +600 m).
insert into public.game_config (key, value, description) values
  ('discovery_chips', '5', 'Extra chips for the first check-in of a user at a bin (0 = no discovery step).'),
  ('region_west', '3.708015', 'West edge of the region whose bins the discovery counter and the collection show.'),
  ('region_south', '51.044642', 'South edge of the region of the discovery counter.'),
  ('region_east', '3.725743', 'East edge of the region of the discovery counter.'),
  ('region_north', '51.059883', 'North edge of the region of the discovery counter.');

-- ---------------------------------------------------------------------------
-- Catalog: milestones
-- ---------------------------------------------------------------------------

-- Every 10 discoveries +50, with jumps at 50 and 100 (chapter 3). Freezes,
-- avatars and the badge come with their phases. Read through game_catalog().
create table public.milestones (
  threshold integer primary key check (threshold > 0),
  points integer not null check (points between 1 and 10000)
);

comment on table public.milestones is
  'Discovery milestones: reaching `threshold` discoveries earns `points` (frozen when reached). Read through game_catalog().';

alter table public.milestones enable row level security;
revoke all on public.milestones from anon, authenticated;

insert into public.milestones (threshold, points)
select t, case t when 50 then 150 when 100 then 300 else 50 end
from generate_series(10, 150, 10) as t;

-- ---------------------------------------------------------------------------
-- Game facts per user
-- ---------------------------------------------------------------------------

create table public.discoveries (
  user_id uuid not null references public.profiles (id) on delete cascade,
  bin_id bigint not null references public.bins (id) on delete cascade,
  -- the first check-in at this bin that was not rejected (the last one while revoked)
  checkin_id uuid not null references public.checkins (id) on delete cascade,
  status text not null check (status in ('pending', 'confirmed', 'revoked')),
  -- when that check-in was made
  discovered_at timestamptz not null,
  -- when the refresh first counted this discovery (analysis)
  first_counted_at timestamptz not null default now(),
  primary key (user_id, bin_id)
);

comment on table public.discoveries is
  'Bins a user discovered: kept by private.refresh_game_state from the real check-ins (docs/GAMIFICATION.md 2.4).';

create index discoveries_checkin_idx on public.discoveries (checkin_id);
create index discoveries_bin_idx on public.discoveries (bin_id);

create table public.user_milestones (
  user_id uuid not null references public.profiles (id) on delete cascade,
  threshold integer not null references public.milestones (threshold),
  -- frozen when first reached; the ledger row has the same amount
  points integer not null check (points > 0),
  status text not null check (status in ('pending', 'granted', 'revoked')),
  -- when it was reached (again)
  reached_at timestamptz not null default now(),
  -- the check-in of the discovery that reached it (analysis)
  anchor_checkin_id uuid references public.checkins (id) on delete set null,
  primary key (user_id, threshold)
);

comment on table public.user_milestones is
  'Milestones a user reached: kept by private.refresh_game_state, with a ledger row milestone:<threshold>.';

create index user_milestones_anchor_idx on public.user_milestones (anchor_checkin_id)
  where anchor_checkin_id is not null;

-- Users read their own rows, admins all; only the functions write.
alter table public.discoveries enable row level security;
alter table public.user_milestones enable row level security;
revoke all on public.discoveries, public.user_milestones from anon, authenticated;
grant select on public.discoveries, public.user_milestones to authenticated;

create policy "discoveries: read own, admins read all"
  on public.discoveries for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

create policy "user_milestones: read own, admins read all"
  on public.user_milestones for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

-- Errors of the game logic, for admins (Studio). The check-in or review that
-- ran into one went on; the next refresh repairs the state.
create table private.game_errors (
  id bigint generated always as identity primary key,
  user_id uuid references public.profiles (id) on delete cascade,
  context text not null,
  checkin_id uuid,
  sqlstate text,
  message text,
  detail text,
  created_at timestamptz not null default now()
);

comment on table private.game_errors is
  'Errors caught around private.refresh_game_state; repair with repair_game_state(user).';

-- Moments (discoveries, milestones) after this time are unseen.
alter table public.profiles
  add column moments_seen_at timestamptz not null default now();

comment on column public.profiles.moments_seen_at is
  'Moments (discovery, milestone) after this time are unseen: my_unseen() lists them, mark_seen() moves it.';

-- ---------------------------------------------------------------------------
-- The score: discovery step, streak extended, ledger parts
-- ---------------------------------------------------------------------------

alter table public.checkins
  add column score jsonb,
  add constraint checkins_score_is_points check (
    score is null or (jsonb_typeof(score) = 'object' and (score->>'total')::integer = points_earned)
  );

comment on column public.checkins.score is
  'The frozen score of record_checkin: steps, total, streak_extended and parts (ledger rows per source).';

drop function private.checkin_score(integer);

-- {steps, total, streak_extended, parts}. Steps: base {kind, label, chips,
-- mult 1, total}; with a discovery {kind 'discovery', label, chips (base +
-- discovery), mult 1, total, add}; streak {kind, label, weeks, per_week,
-- stages: [{mult, total}]} with one stage per week up to streak_max_steps.
-- `mult` is the exact combined multiplier per_week^k (the app rounds it for
-- display); every running total is round(chips * per_week^k). parts: the
-- ledger rows of the check-in, 'checkin' = round(base * m) and 'discovery' =
-- total - checkin (0 parts are left out), together exactly the total.
-- streak_extended: the first check-in of the week (the flame in the reveal).
create function private.checkin_score(
  p_streak_weeks integer,
  p_discovery boolean default false,
  p_streak_extended boolean default false
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with c as (
    select (private.cfg('checkin_base_chips'))::integer as base,
           case when coalesce(p_discovery, false) then (private.cfg('discovery_chips'))::integer else 0 end as extra,
           private.cfg('streak_multiplier') as per_week_json,
           (private.cfg('streak_multiplier'))::numeric as per_week,
           (private.cfg('streak_max_steps'))::integer as max_steps,
           greatest(coalesce(p_streak_weeks, 0), 0) as weeks
  ),
  m as (
    select c.*, c.base + c.extra as chips, least(c.weeks, c.max_steps) as k_max from c
  ),
  stages as (
    select k,
           trim_scale(power(m.per_week, k)) as mult,
           round(m.chips * power(m.per_week, k))::integer as total
    from m cross join lateral generate_series(1, m.k_max) as k
  ),
  t as (
    select m.*,
           round(m.chips * power(m.per_week, m.k_max))::integer as total,
           round(m.base * power(m.per_week, m.k_max))::integer as checkin_part
    from m
  )
  select jsonb_build_object(
    'steps',
      jsonb_build_array(jsonb_build_object('kind', 'base', 'label', 'BASIS', 'chips', t.base, 'mult', 1, 'total', t.base))
      || case when t.extra > 0
              then jsonb_build_array(jsonb_build_object('kind', 'discovery', 'label', 'NIEUW', 'chips', t.chips,
                                                        'mult', 1, 'total', t.chips, 'add', t.extra))
              else '[]'::jsonb end
      || jsonb_build_array(jsonb_build_object(
           'kind', 'streak', 'label', 'REEKS', 'weeks', t.weeks, 'per_week', t.per_week_json,
           'stages', coalesce((select jsonb_agg(jsonb_build_object('mult', s.mult, 'total', s.total) order by s.k)
                               from stages s), '[]'::jsonb))),
    'total', t.total,
    'streak_extended', coalesce(p_streak_extended, false),
    'parts', jsonb_strip_nulls(jsonb_build_object(
      'checkin', nullif(t.checkin_part, 0),
      'discovery', nullif(t.total - t.checkin_part, 0))))
  from t;
$$;

revoke execute on function private.checkin_score(integer, boolean, boolean) from public;

-- The projection of 20261015120000_points_ledger.sql with the parts of the
-- frozen score: 'checkin', 'discovery' and (phase 8) 'bounty'. Check-ins
-- without a score (from before this migration, or inserted directly) keep one
-- 'checkin' row of points_earned.
create or replace function private.sync_checkin_ledger(c public.checkins)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target text := case c.status when 'approved' then 'granted' when 'rejected' then 'revoked' else 'pending' end;
  why text := case when c.revoked_at is not null then 'checkin_revoked' else 'checkin_rejected' end;
  scored constant boolean := c.score is not null and jsonb_typeof(c.score->'parts') = 'object';
  part record;
  existing public.point_transactions;
begin
  for part in
    select v.source, v.amount
    from (values
      ('checkin', case when scored then (c.score->'parts'->>'checkin')::integer else c.points_earned end),
      ('discovery', case when scored then (c.score->'parts'->>'discovery')::integer end),
      ('bounty', case when scored then (c.score->'parts'->>'bounty')::integer end),
      ('bonus', c.bonus_points)) as v(source, amount)
  loop
    select * into existing from public.point_transactions t where t.checkin_id = c.id and t.source = part.source;

    if coalesce(part.amount, 0) = 0 then
      -- rows with amount 0 do not exist
      if existing.id is not null then
        delete from public.point_transactions t where t.id = existing.id;
      end if;
    elsif existing.id is null then
      insert into public.point_transactions
        (user_id, is_test, source, reward_key, amount, status, checkin_id, earned_at,
         granted_at, revoked_at, revoke_reason)
      values
        (c.user_id, c.is_test, part.source, part.source || ':' || c.id, part.amount, target, c.id, c.created_at,
         case when target = 'granted' then coalesce(c.reviewed_at, now()) end,
         case when target = 'revoked' then coalesce(c.revoked_at, c.reviewed_at, now()) end,
         case when target = 'revoked' then why end);
    elsif (existing.amount, existing.status, existing.is_test, existing.revoke_reason)
          is distinct from (part.amount, target, c.is_test, case when target = 'revoked' then why end) then
      update public.point_transactions t
         set amount = part.amount,
             is_test = c.is_test,
             status = target,
             granted_at = case
               when target = 'granted' then coalesce(case when t.status = 'granted' then t.granted_at end,
                                                     c.reviewed_at, now())
               when target = 'revoked' then t.granted_at
             end,
             revoked_at = case
               when target = 'revoked' then coalesce(case when t.status = 'revoked' then t.revoked_at end,
                                                     c.revoked_at, c.reviewed_at, now())
             end,
             revoke_reason = case when target = 'revoked' then why end
       where t.id = existing.id;
    end if;
  end loop;
end;
$$;

-- The trigger also follows the score now.
drop trigger checkins_sync_ledger on public.checkins;
create trigger checkins_sync_ledger
  after insert or update of status, points_earned, bonus_points, is_test, revoked_at, score on public.checkins
  for each row execute function private.checkins_sync_ledger();

-- ---------------------------------------------------------------------------
-- Refresh of the game state
-- ---------------------------------------------------------------------------

-- Recomputes the discoveries and milestones of one user from the real
-- check-ins and changes only what differs. Returns the number of rows it
-- changed (0 when all was in order). Never changes checkins.
create function private.refresh_game_state(p_user uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed integer := 0;
  n integer;
  provisional integer;
  certain integer;
begin
  if p_user is null then
    return 0;
  end if;
  -- Callers hold it already (a no-op then); others get the lock order right.
  perform pg_advisory_xact_lock(hashtextextended('checkins:' || p_user::text, 0));

  -- Discoveries: the first check-in per bin that was not rejected; confirmed
  -- when an approved one exists.
  with facts as (
    select c.bin_id,
           (array_agg(c.id order by c.created_at, c.id) filter (where c.status <> 'rejected'))[1] as first_id,
           min(c.created_at) filter (where c.status <> 'rejected') as first_at,
           coalesce(bool_or(c.status = 'approved'), false) as certain
    from public.checkins c
    where c.user_id = p_user and not c.is_test
    group by c.bin_id
  )
  insert into public.discoveries as d (user_id, bin_id, checkin_id, status, discovered_at)
  select p_user, f.bin_id, f.first_id, case when f.certain then 'confirmed' else 'pending' end, f.first_at
  from facts f
  where f.first_id is not null
  on conflict (user_id, bin_id) do update
    set checkin_id = excluded.checkin_id, status = excluded.status, discovered_at = excluded.discovered_at
    where (d.checkin_id, d.status, d.discovered_at)
          is distinct from (excluded.checkin_id, excluded.status, excluded.discovered_at);
  get diagnostics n = row_count;
  changed := changed + n;

  -- No check-in left that was not rejected: revoked (the row stays, so a new
  -- check-in there is a discovery again).
  update public.discoveries d
     set status = 'revoked'
   where d.user_id = p_user and d.status <> 'revoked'
     and not exists (
       select 1 from public.checkins c
       where c.user_id = p_user and c.bin_id = d.bin_id and not c.is_test and c.status <> 'rejected');
  get diagnostics n = row_count;
  changed := changed + n;

  -- Milestones: granted over confirmed discoveries, pending over all that
  -- were not revoked, else revoked. The anchor is the check-in of the
  -- discovery that reached the threshold.
  select count(*) filter (where d.status <> 'revoked'), count(*) filter (where d.status = 'confirmed')
    into provisional, certain
  from public.discoveries d
  where d.user_id = p_user;

  with ordered as (
    select d.checkin_id, row_number() over (order by d.discovered_at, d.bin_id) as k
    from public.discoveries d
    where d.user_id = p_user and d.status <> 'revoked'
  ),
  target as (
    select m.threshold, m.points,
           case when certain >= m.threshold then 'granted'
                when provisional >= m.threshold then 'pending'
                else 'revoked' end as status,
           (select o.checkin_id from ordered o where o.k = m.threshold) as anchor
    from public.milestones m
  )
  insert into public.user_milestones as um (user_id, threshold, points, status, reached_at, anchor_checkin_id)
  select p_user, t.threshold, t.points, t.status, now(), t.anchor
  from target t
  where t.status <> 'revoked'
     or exists (select 1 from public.user_milestones x where x.user_id = p_user and x.threshold = t.threshold)
  on conflict (user_id, threshold) do update
    set status = excluded.status,
        reached_at = case when um.status = 'revoked' then now() else um.reached_at end,
        anchor_checkin_id = case when excluded.status = 'revoked' then um.anchor_checkin_id
                                 else excluded.anchor_checkin_id end
    where um.status is distinct from excluded.status
       or (excluded.status <> 'revoked' and um.anchor_checkin_id is distinct from excluded.anchor_checkin_id);
  get diagnostics n = row_count;
  changed := changed + n;

  -- Their ledger rows: the frozen amount, the status of the milestone.
  insert into public.point_transactions as t
    (user_id, is_test, source, reward_key, amount, status, anchor_checkin_id, earned_at,
     granted_at, revoked_at, revoke_reason, details)
  select um.user_id, false, 'milestone', 'milestone:' || um.threshold, um.points, um.status,
         um.anchor_checkin_id, um.reached_at,
         case when um.status = 'granted' then now() end,
         case when um.status = 'revoked' then now() end,
         case when um.status = 'revoked' then 'milestone_lost' end,
         jsonb_build_object('threshold', um.threshold)
  from public.user_milestones um
  where um.user_id = p_user
  on conflict (user_id, is_test, reward_key) do update
    set status = excluded.status,
        anchor_checkin_id = excluded.anchor_checkin_id,
        earned_at = excluded.earned_at,
        granted_at = case excluded.status
                       when 'granted' then coalesce(case when t.status = 'granted' then t.granted_at end, now())
                       when 'revoked' then t.granted_at
                     end,
        revoked_at = case when excluded.status = 'revoked'
                          then coalesce(case when t.status = 'revoked' then t.revoked_at end, now()) end,
        revoke_reason = excluded.revoke_reason
    where (t.status, t.anchor_checkin_id, t.earned_at)
          is distinct from (excluded.status, excluded.anchor_checkin_id, excluded.earned_at);
  get diagnostics n = row_count;
  changed := changed + n;

  return changed;
end;
$$;

revoke execute on function private.refresh_game_state(uuid) from public;

-- The refresh in a block of its own: an error rolls back only the refresh and
-- lands in private.game_errors. True when it ran.
create function private.refresh_game_state_safely(p_user uuid, p_context text, p_checkin uuid default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state text;
  v_message text;
  v_detail text;
begin
  perform private.refresh_game_state(p_user);
  return true;
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_detail = pg_exception_detail;
  insert into private.game_errors (user_id, context, checkin_id, sqlstate, message, detail)
  values (p_user, p_context, p_checkin, v_state, left(v_message, 1000), left(v_detail, 1000));
  return false;
end;
$$;

revoke execute on function private.refresh_game_state_safely(uuid, text, uuid) from public;

-- ---------------------------------------------------------------------------
-- Collection and moments (internal)
-- ---------------------------------------------------------------------------

-- The bins of a user's collection: the active, eligible bins of the region and
-- every bin the user discovered (also outside the region), with the discovery.
create function private.collection(p_user uuid)
returns table (bin_id bigint, status text, discovered_at timestamptz)
language sql
stable
set search_path = ''
as $$
  with r as (
    select (private.cfg('region_west'))::double precision as w,
           (private.cfg('region_south'))::double precision as s,
           (private.cfg('region_east'))::double precision as e,
           (private.cfg('region_north'))::double precision as n
  )
  select b.id, d.status, d.discovered_at
  from public.bins b
  cross join r
  left join public.discoveries d on d.user_id = p_user and d.bin_id = b.id and d.status <> 'revoked'
  where d.bin_id is not null
     or (b.status = 'active' and b.eligible_effective
         and extensions.st_x(b.geom::extensions.geometry) between r.w and r.e
         and extensions.st_y(b.geom::extensions.geometry) between r.s and r.n);
$$;

revoke execute on function private.collection(uuid) from public;

-- Discoveries and milestones of a user after p_since, oldest first. A
-- discovery counts from its check-in, a milestone from when it was reached.
create function private.moments_since(p_user uuid, p_since timestamptz)
returns table (kind text, at timestamptz, details jsonb)
language sql
stable
set search_path = ''
as $$
  with counted as (
    select d.bin_id, d.status, d.discovered_at,
           row_number() over (order by d.discovered_at, d.bin_id) as ordinal
    from public.discoveries d
    where d.user_id = p_user and d.status <> 'revoked'
  )
  select x.kind, x.at, x.details
  from (
    select 'discovery' as kind, c.discovered_at as at,
           jsonb_build_object('bin_id', c.bin_id, 'ordinal', c.ordinal, 'status', c.status) as details,
           0 as sort
    from counted c
    where c.discovered_at > p_since
    union all
    select 'milestone', m.reached_at,
           jsonb_build_object('threshold', m.threshold, 'points', m.points, 'status', m.status),
           1
    from public.user_milestones m
    where m.user_id = p_user and m.status <> 'revoked' and m.reached_at > p_since
  ) x
  order by x.at, x.sort, x.details->>'bin_id', x.details->>'threshold';
$$;

revoke execute on function private.moments_since(uuid, timestamptz) from public;

-- What a check-in made new, for the answer of record_checkin: its discovery
-- (with the counter) and the highest milestone reached in this transaction.
-- `as_of` is the server time the app passes to mark_seen after the reveal.
create function private.checkin_game(p_user uuid, p_checkin uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with counted as (
    select d.bin_id, d.checkin_id, d.status,
           row_number() over (order by d.discovered_at, d.bin_id) as ordinal
    from public.discoveries d
    where d.user_id = p_user and d.status <> 'revoked'
  )
  select jsonb_build_object(
    'discovery', (
      select jsonb_build_object('bin_id', c.bin_id, 'ordinal', c.ordinal,
                                'discovered', (select count(*) from counted),
                                'total_bins', (select count(*) from private.collection(p_user)),
                                'status', c.status)
      from counted c
      where c.checkin_id = p_checkin),
    'milestone', (
      select jsonb_build_object('threshold', m.threshold, 'points', m.points, 'status', m.status)
      from public.user_milestones m
      where m.user_id = p_user and m.status <> 'revoked' and m.reached_at = now()
      order by m.threshold desc
      limit 1),
    'as_of', now());
$$;

revoke execute on function private.checkin_game(uuid, uuid) from public;

-- ---------------------------------------------------------------------------
-- record_checkin: discovery, frozen score, refresh, `game`
-- ---------------------------------------------------------------------------

drop function public.record_checkin(uuid, uuid, bigint, double precision, double precision, real, boolean, boolean, text);

-- record_checkin from 20261015160000_checkin_score.sql: the same rules. The
-- score adds the discovery step (no earlier real check-in of this user at
-- this bin that was not rejected) and streak_extended (the first check-in of
-- the week), and is stored on the check-in. Test check-ins keep base and
-- streak only and make no game facts. After the bonus question the game state
-- is refreshed; `game` says what is new (null for test check-ins, or when the
-- refresh failed).
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
  game jsonb,
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
  discovery boolean;
  extended boolean;
  result_score jsonb;
  result_game jsonb;
  question public.bonus_questions;
begin
  if p_lat is null or p_lon is null or p_lat not between -90 and 90 or p_lon not between -180 and 180 then
    raise exception 'invalid coordinates' using errcode = '22023';
  end if;

  -- Dev mode: only admins, only on local or staging.
  dev_ok := public.dev_mode_allowed_for(p_user_id);
  if fake and not dev_ok then
    return query select false, 'fake_location_not_allowed', null::uuid, null::double precision, null::integer,
      null::integer, null::jsonb, null::jsonb, null::jsonb, null::boolean;
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
      null::integer, null::jsonb, null::jsonb, null::jsonb, null::boolean;
    return;
  end if;
  if bin.status <> 'active' then
    return query select false, 'bin_inactive', null::uuid, null::double precision, null::integer,
      null::integer, null::jsonb, null::jsonb, null::jsonb, null::boolean;
    return;
  end if;
  if not bin.eligible_effective then
    return query select false, 'bin_not_eligible', null::uuid, null::double precision, null::integer,
      null::integer, null::jsonb, null::jsonb, null::jsonb, null::boolean;
    return;
  end if;

  dist := st_distance(bin.geom, st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography);
  if dist > max_distance_m then
    return query select false, 'too_far', null::uuid, dist, null::integer,
      null::integer, null::jsonb, null::jsonb, null::jsonb, null::boolean;
    return;
  end if;

  select max(c.created_at) into last_at
  from public.checkins c
  where c.user_id = p_user_id and c.bin_id = p_bin_id and c.created_at > now() - cooldown;
  if last_at is not null then
    return query select false, 'cooldown', null::uuid, dist,
      ceil(extract(epoch from last_at + cooldown - now()))::integer,
      null::integer, null::jsonb, null::jsonb, null::jsonb, null::boolean;
    return;
  end if;

  select count(*) into today
  from public.checkins c
  where c.user_id = p_user_id and c.created_at >= public.local_day_start(now());
  if today >= max_checkins_per_day then
    return query select false, 'daily_limit', null::uuid, dist,
      ceil(extract(epoch from public.local_day_start(now()) + interval '1 day' - now()))::integer,
      null::integer, null::jsonb, null::jsonb, null::jsonb, null::boolean;
    return;
  end if;

  insert into public.checkins
    (id, user_id, bin_id, photo_path, user_geom, accuracy_m, distance_m, is_mocked, is_fake_location, is_test)
  values
    (p_checkin_id, p_user_id, p_bin_id, p_photo_path,
     st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography,
     p_accuracy_m, dist, coalesce(p_is_mocked, false), fake, test);

  -- The new check-in counts for its own week, so the streak is at least 1.
  -- Real check-ins never see test check-ins; test check-ins use the override
  -- and get base and streak only.
  week := date_trunc('week', now() at time zone 'Europe/Brussels')::date;
  streak := case when test then coalesce(override, public.streak_weeks(p_user_id, week, true))
                 else public.streak_weeks(p_user_id, week, false) end;
  discovery := not test and not exists (
    select 1 from public.checkins c
    where c.user_id = p_user_id and c.bin_id = p_bin_id and c.id <> p_checkin_id
      and not c.is_test and c.status <> 'rejected');
  extended := not test and not exists (
    select 1 from public.checkins c
    where c.user_id = p_user_id and c.id <> p_checkin_id and not c.is_test and c.status <> 'rejected'
      and c.created_at >= public.local_week_start(now()));
  result_score := private.checkin_score(streak, discovery, extended);
  update public.checkins c
     set streak_weeks = streak, points_earned = (result_score->>'total')::integer, score = result_score
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
  elsif private.refresh_game_state_safely(p_user_id, 'record_checkin', p_checkin_id) then
    result_game := private.checkin_game(p_user_id, p_checkin_id);
  end if;

  return query select true, null::text, p_checkin_id, dist, null::integer,
    streak, result_score, result_game,
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
-- Moderation and the bonus answer refresh the game state
-- ---------------------------------------------------------------------------

-- review_checkin from 20261015120000_points_ledger.sql, plus the refresh.
create or replace function public.review_checkin(id uuid, approve boolean, reason text default null)
returns public.checkins
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  why constant text := nullif(btrim(reason), '');
  owner uuid;
  checkin public.checkins;
begin
  if not public.is_admin() then
    raise exception 'only admins can review check-ins' using errcode = '42501';
  end if;
  if approve is null then
    raise exception 'approve must be true or false' using errcode = '22023';
  end if;
  if why is not null and approve then
    raise exception 'a reason is only for rejections' using errcode = '22023';
  end if;
  if char_length(why) > 200 then
    raise exception 'the reason is longer than 200 characters' using errcode = '22023';
  end if;

  -- The user's lock first, then the row (the user of a check-in never changes).
  select c.user_id into owner from public.checkins c where c.id = review_checkin.id;
  if not found then
    raise exception 'check-in % not found', review_checkin.id using errcode = 'P0002';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('checkins:' || owner::text, 0));

  select * into checkin from public.checkins c where c.id = review_checkin.id for update;
  if not found then
    raise exception 'check-in % not found', review_checkin.id using errcode = 'P0002';
  end if;
  if checkin.status <> 'pending' then
    raise exception 'check-in % is already %', review_checkin.id, checkin.status using errcode = '55000';
  end if;

  update public.checkins c
     set status = case when approve then 'approved' else 'rejected' end,
         review_reason = why,
         reviewed_at = now(),
         reviewed_by = auth.uid()
   where c.id = review_checkin.id
  returning * into checkin;

  if not checkin.is_test then
    perform private.refresh_game_state_safely(owner, 'review_checkin', checkin.id);
  end if;

  return checkin;
end;
$$;

-- revoke_checkin from 20261015120000_points_ledger.sql, plus the refresh.
create or replace function public.revoke_checkin(id uuid, reason text)
returns public.checkins
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  why constant text := nullif(btrim(reason), '');
  owner uuid;
  checkin public.checkins;
begin
  if not public.is_admin() then
    raise exception 'only admins can revoke check-ins' using errcode = '42501';
  end if;
  if why is null or char_length(why) > 200 then
    raise exception 'a reason of 1 to 200 characters is required' using errcode = '22023';
  end if;

  select c.user_id into owner from public.checkins c where c.id = revoke_checkin.id;
  if not found then
    raise exception 'check-in % not found', revoke_checkin.id using errcode = 'P0002';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('checkins:' || owner::text, 0));

  select * into checkin from public.checkins c where c.id = revoke_checkin.id for update;
  if not found then
    raise exception 'check-in % not found', revoke_checkin.id using errcode = 'P0002';
  end if;
  if checkin.status <> 'approved' then
    raise exception 'only approved check-ins can be revoked (this one is %)', checkin.status using errcode = '55000';
  end if;

  update public.checkins c
     set status = 'rejected',
         review_reason = why,
         revoked_at = now(),
         revoked_by = auth.uid()
   where c.id = revoke_checkin.id
  returning * into checkin;

  if not checkin.is_test then
    perform private.refresh_game_state_safely(owner, 'revoke_checkin', checkin.id);
  end if;

  return checkin;
end;
$$;

-- answer_bonus_question from 20261015140000_config_and_events.sql, plus the
-- refresh (bonus answers count for quests and badges in later phases).
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

  if not checkin.is_test then
    perform private.refresh_game_state_safely(checkin.user_id, 'answer_bonus_question', checkin.id);
  end if;

  return bonus;
end;
$$;

-- Admins: recompute a user's game state now (errors are raised, not caught).
create function public.repair_game_state(user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'only admins can repair the game state' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles p where p.id = repair_game_state.user_id) then
    raise exception 'user % not found', repair_game_state.user_id using errcode = 'P0002';
  end if;
  return private.refresh_game_state(repair_game_state.user_id);
end;
$$;

revoke execute on function public.repair_game_state(uuid) from public, anon;
grant execute on function public.repair_game_state(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- For the app
-- ---------------------------------------------------------------------------

-- The collection: every bin of the region and every bin the caller
-- discovered, with the discovery (status null = not discovered) and the
-- number of the caller's real check-ins there that were not rejected.
create function public.my_collection()
returns table (bin_id bigint, status text, discovered_at timestamptz, checkins integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  uid constant uuid := auth.uid();
begin
  if uid is null then
    raise exception 'sign in to see your collection' using errcode = '42501';
  end if;
  return query
    select c.bin_id, c.status, c.discovered_at, coalesce(k.n, 0)::integer
    from private.collection(uid) c
    left join (
      select x.bin_id, count(*) as n
      from public.checkins x
      where x.user_id = uid and not x.is_test and x.status <> 'rejected'
      group by x.bin_id
    ) k on k.bin_id = c.bin_id
    order by c.bin_id;
end;
$$;

revoke execute on function public.my_collection() from public, anon;
grant execute on function public.my_collection() to authenticated;

-- The caller's game at a glance (v1): points granted and pending, the streak,
-- the discovery counter with the next milestone, and the number of unseen
-- moments. Later phases add level, quests, chest and weekly challenge.
create function public.my_game_state()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  uid constant uuid := auth.uid();
  discovered integer;
  confirmed integer;
  total integer;
  seen timestamptz;
begin
  if uid is null then
    raise exception 'sign in to see your game' using errcode = '42501';
  end if;

  select count(*) filter (where d.status <> 'revoked'), count(*) filter (where d.status = 'confirmed')
    into discovered, confirmed
  from public.discoveries d
  where d.user_id = uid;
  select count(*) into total from private.collection(uid);
  select p.moments_seen_at into seen from public.profiles p where p.id = uid;

  return jsonb_build_object(
    'points', jsonb_build_object(
      'granted', coalesce((select p.points from public.profiles p where p.id = uid), 0),
      'pending', coalesce((select sum(t.amount) from public.point_transactions t
                           where t.user_id = uid and not t.is_test and t.status = 'pending'), 0)),
    'streak', (select jsonb_build_object('weeks', s.weeks, 'this_week', s.this_week) from public.my_streak() s),
    'discoveries', jsonb_build_object(
      'discovered', discovered,
      'confirmed', confirmed,
      'total_bins', total,
      'next_milestone', (
        select jsonb_build_object(
                 'threshold', m.threshold, 'points', m.points,
                 'previous', coalesce((select max(x.threshold) from public.milestones x where x.threshold <= discovered), 0))
        from public.milestones m
        where m.threshold > discovered
        order by m.threshold
        limit 1)),
    'unseen_moments', (select count(*) from private.moments_since(uid, seen)),
    'as_of', now());
end;
$$;

revoke execute on function public.my_game_state() from public, anon;
grant execute on function public.my_game_state() to authenticated;

-- What the caller missed since the last visit: {moments, moments_total,
-- as_of}. Moments: discoveries and milestones that were not revoked, newest 20
-- (oldest first). After showing them the app calls mark_seen('moments', as_of).
create function public.my_unseen()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  uid constant uuid := auth.uid();
  seen timestamptz;
begin
  if uid is null then
    raise exception 'sign in to see what is new' using errcode = '42501';
  end if;
  select p.moments_seen_at into seen from public.profiles p where p.id = uid;

  return (
    with m as (select * from private.moments_since(uid, seen)),
    newest as (
      select m.* from m order by m.at desc, m.kind desc limit 20
    )
    select jsonb_build_object(
      'moments', coalesce((select jsonb_agg(jsonb_build_object('kind', n.kind, 'at', n.at) || n.details
                                            order by n.at, n.kind) from newest n), '[]'::jsonb),
      'moments_total', (select count(*) from m),
      'as_of', now()));
end;
$$;

revoke execute on function public.my_unseen() from public, anon;
grant execute on function public.my_unseen() to authenticated;

-- Marks what the app showed: kind 'moments' up to `until` (a time from the
-- server: `as_of` of my_unseen or of a check-in). Never moves back, never past
-- now. Returns the new mark.
create function public.mark_seen(kind text, until timestamptz)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid constant uuid := auth.uid();
  result timestamptz;
begin
  if uid is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if kind is distinct from 'moments' then
    raise exception 'kind must be moments' using errcode = '22023';
  end if;
  if until is null then
    raise exception 'until is required' using errcode = '22023';
  end if;

  update public.profiles p
     set moments_seen_at = greatest(p.moments_seen_at, least(mark_seen.until, now()))
   where p.id = uid
  returning p.moments_seen_at into result;
  return result;
end;
$$;

revoke execute on function public.mark_seen(text, timestamptz) from public, anon;
grant execute on function public.mark_seen(text, timestamptz) to authenticated;

-- game_catalog() from 20261015160000_checkin_score.sql, plus the milestones.
create or replace function public.game_catalog()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'config', (select coalesce(jsonb_object_agg(c.key, c.value), '{}'::jsonb) from public.game_config c),
    'milestones', (select coalesce(jsonb_agg(jsonb_build_object('threshold', m.threshold, 'points', m.points)
                                             order by m.threshold), '[]'::jsonb)
                   from public.milestones m));
$$;

-- ---------------------------------------------------------------------------
-- Events
-- ---------------------------------------------------------------------------

insert into public.event_names (name, description) values
  ('discovery_shown', 'A discovery is celebrated (in the reveal or as a missed moment).'),
  ('milestone_shown', 'A milestone celebration is shown.'),
  ('collection_viewed', 'The collection is opened.');

-- ---------------------------------------------------------------------------
-- The game state of existing users
-- ---------------------------------------------------------------------------

-- Discoveries and milestones of the real check-ins so far (no discovery
-- points: those only exist in new scores). moments_seen_at is now() for every
-- existing profile, so none of this shows up as a missed moment.
do $$
declare
  changed integer;
begin
  select coalesce(sum(private.refresh_game_state(p.id)), 0) into changed
  from public.profiles p
  where exists (select 1 from public.checkins c where c.user_id = p.id and not c.is_test);
  raise notice 'discoveries: % row(s) from existing check-ins', changed;
  if exists (select 1 from private.check_points_invariant()) then
    raise exception 'discoveries: profiles differ from their ledger after the refresh';
  end if;
end;
$$;

notify pgrst, 'reload schema';
