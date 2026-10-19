-- Identity: levels, avatars, onboarding and the profile (docs/GAMIFICATION.md,
-- 2.3, 2.4, 2.6, chapter 3 and phase 4).
--
-- Levels follow the granted real points (test points never count): the
-- highest level whose min_points the points reach. 20 levels, 10 x (L-1)^2.6
-- rounded to 5, each with a title. A level can drop (a rejection or
-- revocation lowers the points), without a celebration.
--
-- Avatars are a catalog of 12 (placeholders until the drawings are there: an
-- SF Symbol on a coloured circle). Unlocks are computed, never stored: default
-- always; level from the granted points; milestone from user_milestones;
-- badge (phase 5), quest and chest (phase 6) stay locked until their phases.
-- A status 'unlocked' can be worn, 'pending' waits for an approval, 'locked'
-- comes with a hint. When the worn avatar is no longer unlocked (a lower level
-- after a rejection, a revoked milestone, an inactive avatar), the refresh
-- puts the user back on the standard avatar: the first default by sort.
--
-- Profiles get avatar_key, onboarded_at and last_seen_level (phase 5 uses it
-- for level-ups). A new account no longer gets a name from its e-mail address:
-- onboarding asks for one (complete_onboarding). Clients no longer write
-- profiles directly; the name changes through set_my_name, the avatar through
-- set_my_avatar, with one rule for names (private.clean_name).
--
-- For the app: game_catalog() adds the levels and avatars, my_game_state() the
-- level and the profile statistics, my_avatars() every avatar with its status
-- and hint, leaderboard() the avatar, level and title of every row.
--
-- Lock order (2.9): complete_onboarding and set_my_avatar take the user's
-- advisory lock before they check an unlock, like the refresh.

-- ---------------------------------------------------------------------------
-- Catalog: levels
-- ---------------------------------------------------------------------------

create table public.levels (
  level integer primary key check (level between 1 and 100),
  min_points integer not null unique check (min_points >= 0),
  title text not null check (char_length(title) between 1 and 40)
);

comment on table public.levels is
  'Levels: a user is on the highest level whose min_points the granted real points reach (level 1 starts at 0). Read through game_catalog().';

alter table public.levels enable row level security;
revoke all on public.levels from anon, authenticated;

-- 10 x (L-1)^2.6 rounded to 5 (chapter 3), with the titles of chapter 3 and
-- new ones in between.
insert into public.levels (level, min_points, title)
select t.l, (round(10 * power(t.l - 1, 2.6) / 5) * 5)::integer, t.title
from unnest(array[
  'Wegwerp-rookie', 'Blikjesbuddy', 'Peukenpikker', 'Stoepridder', 'Papiertjesprof',
  'Buurtbezem', 'Pleinpatrouille', 'Leiewachter', 'Scheldespeurder', 'Straatheld',
  'Blikvanger', 'Kringloopkampioen', 'Afvalalchemist', 'Stadsveger', 'Stoepsheriff',
  'Netheidsninja', 'Opruimorakel', 'Buurtbaron', 'Afvallegende', 'Vuilbakkoning'
]) with ordinality as t(title, l);

-- The level of a number of points, with the next one (null at the top).
create function private.level_of(p_points integer)
returns table (level integer, title text, min_points integer,
               next_level integer, next_title text, next_min_points integer)
language sql
stable
set search_path = ''
as $$
  with cur as (
    select l.level, l.title, l.min_points
    from public.levels l
    where l.min_points <= greatest(coalesce(p_points, 0), 0)
    order by l.level desc
    limit 1
  )
  select coalesce(c.level, 1), coalesce(c.title, ''), coalesce(c.min_points, 0),
         n.level, n.title, n.min_points
  from (select 1) one
  left join cur c on true
  left join lateral (
    select l.level, l.title, l.min_points
    from public.levels l
    where l.level > coalesce(c.level, 1)
    order by l.level
    limit 1
  ) n on true;
$$;

revoke execute on function private.level_of(integer) from public;

-- ---------------------------------------------------------------------------
-- Catalog: avatars
-- ---------------------------------------------------------------------------

create table public.avatars (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,31}$'),
  name text not null check (char_length(name) between 1 and 30),
  rarity text not null check (rarity in ('common', 'rare', 'epic', 'legendary')),
  unlock_type text not null check (unlock_type in ('default', 'level', 'milestone', 'badge', 'quest', 'chest')),
  -- level: the level; milestone: the threshold; badge, quest: a key; else null
  unlock_param text,
  sort integer not null,
  active boolean not null default true,
  -- until the drawing is there: this SF Symbol on a circle in this colour
  placeholder_symbol text not null check (placeholder_symbol ~ '^[a-z0-9]+(\.[a-z0-9]+)*$'),
  placeholder_color text not null check (placeholder_color ~ '^#[0-9A-F]{6}$'),
  constraint avatars_unlock_param check (
    case unlock_type
      when 'default' then unlock_param is null
      when 'chest' then unlock_param is null
      when 'level' then unlock_param is not null and unlock_param ~ '^[1-9][0-9]{0,2}$'
      when 'milestone' then unlock_param is not null and unlock_param ~ '^[1-9][0-9]{0,4}$'
      else unlock_param is not null and unlock_param ~ '^[a-z][a-z0-9_]{1,63}$'
    end)
);

comment on table public.avatars is
  'Avatars: the drawing is app/assets/avatars/<key>.png (docs/AVATARS.md), else the placeholder. Unlocks are computed (private.avatar_states). Read through game_catalog() and my_avatars().';

alter table public.avatars enable row level security;
revoke all on public.avatars from anon, authenticated;

-- 4 default, 3 by level (5, 8, 12), 2 by milestone (50, 100), 1 by badge
-- (Vroege vogel, phase 5), 2 only from the daily chest (phase 6). The mascot
-- Zwerfie is not one of them: it lives in the app (onboarding, empty screens).
insert into public.avatars (sort, key, name, rarity, unlock_type, unlock_param, placeholder_symbol, placeholder_color) values
  (1, 'spruit', 'Spruit', 'common', 'default', null, 'leaf.fill', '#4E9A52'),
  (2, 'vos', 'Vos', 'common', 'default', null, 'pawprint.fill', '#C8553D'),
  (3, 'zon', 'Zon', 'common', 'default', null, 'sun.max.fill', '#C9821A'),
  (4, 'berg', 'Berg', 'common', 'default', null, 'mountain.2.fill', '#6B7A8F'),
  (5, 'bloem', 'Bloem', 'rare', 'level', '5', 'camera.macro', '#C2508A'),
  (6, 'bliksem', 'Bliksem', 'rare', 'level', '8', 'bolt.fill', '#7B4FD0'),
  (7, 'eik', 'Eik', 'epic', 'level', '12', 'tree.fill', '#6E5338'),
  (8, 'haas', 'Haas', 'rare', 'milestone', '50', 'hare.fill', '#A0794F'),
  (9, 'schildpad', 'Schildpad', 'epic', 'milestone', '100', 'tortoise.fill', '#2C7A7B'),
  (10, 'merel', 'Merel', 'rare', 'badge', 'early_bird', 'bird.fill', '#3D3D4E'),
  (11, 'maan', 'Maan', 'epic', 'chest', null, 'moon.stars.fill', '#2F3A7A'),
  (12, 'regenboog', 'Regenboog', 'legendary', 'chest', null, 'rainbow', '#1F9BD1');

-- The standard avatar: the first active default.
create function private.default_avatar()
returns text
language sql
stable
set search_path = ''
as $$
  select a.key from public.avatars a
  where a.active and a.unlock_type = 'default'
  order by a.sort, a.key
  limit 1;
$$;

revoke execute on function private.default_avatar() from public;

-- How to unlock an avatar, for the picker. The badge names come with the
-- badges table in phase 5; until then the one badge of the catalog is named
-- here.
create function private.avatar_hint(p_type text, p_param text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_type
    when 'level' then 'Bereik level ' || p_param
    when 'milestone' then 'Ontdek ' || p_param || ' vuilbakken'
    when 'badge' then 'Verdien de badge ' || case p_param when 'early_bird' then 'Vroege vogel' else p_param end
    when 'quest' then 'Voltooi een speciale quest'
    when 'chest' then 'Alleen te vinden in de dagkist'
  end;
$$;

revoke execute on function private.avatar_hint(text, text) from public;

-- Every active avatar with its status for a user: 'unlocked' (can be worn),
-- 'pending' (unlocked once the pending points or milestone are approved) or
-- 'locked'. Test points never count.
create function private.avatar_states(p_user uuid)
returns table (key text, status text)
language sql
stable
set search_path = ''
as $$
  with pts as (
    select p.points as granted,
           p.points + coalesce((select sum(t.amount) from public.point_transactions t
                                where t.user_id = p_user and not t.is_test and t.status = 'pending'), 0)::integer
             as provisional
    from public.profiles p
    where p.id = p_user
  ),
  lv as (
    select (select l.level from private.level_of(pts.granted) l) as granted,
           (select l.level from private.level_of(pts.provisional) l) as provisional
    from pts
  )
  select a.key,
         case a.unlock_type
           when 'default' then 'unlocked'
           when 'level' then
             case when lv.granted >= a.unlock_param::integer then 'unlocked'
                  when lv.provisional >= a.unlock_param::integer then 'pending'
                  else 'locked' end
           when 'milestone' then
             coalesce((select case m.status when 'granted' then 'unlocked' when 'pending' then 'pending' end
                       from public.user_milestones m
                       where m.user_id = p_user and m.threshold = a.unlock_param::integer), 'locked')
           -- badge (phase 5), quest and chest (phase 6)
           else 'locked'
         end
  from public.avatars a
  left join lv on true
  where a.active;
$$;

revoke execute on function private.avatar_states(uuid) from public;

-- ---------------------------------------------------------------------------
-- Profiles
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column avatar_key text references public.avatars (key) on update cascade on delete set null,
  add column onboarded_at timestamptz,
  add column last_seen_level integer not null default 1 check (last_seen_level >= 1);

comment on column public.profiles.avatar_key is
  'The worn avatar (null = the standard avatar). Only unlocked avatars, through complete_onboarding and set_my_avatar.';
comment on column public.profiles.onboarded_at is
  'When the user finished the onboarding (name and avatar); null = the app shows it.';
comment on column public.profiles.last_seen_level is
  'The level the app last celebrated (phase 5: level-ups).';

-- Existing users start on their current level: no level-up for old points.
update public.profiles p
   set last_seen_level = (select l.level from private.level_of(p.points) l)
 where p.points > 0;

-- A new account gets no name from its e-mail address (the name was on the
-- leaderboard for everyone): onboarding asks for one.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id) values (new.id);
  return new;
end;
$$;

-- Clients no longer write profiles directly: the name through set_my_name.
revoke update (display_name) on public.profiles from authenticated;
drop policy "profiles: update own" on public.profiles;

-- One rule for names: whitespace collapsed and trimmed, 2 to 24 characters,
-- no control characters. Null when the name is not allowed.
create function private.clean_name(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when x.n is not null and char_length(x.n) between 2 and 24 and x.n !~ '[[:cntrl:]]' then x.n end
  from (select btrim(regexp_replace(p_name, '\s+', ' ', 'g')) as n) x;
$$;

revoke execute on function private.clean_name(text) from public;

-- Raises unless the user can wear the avatar: P0002 for an unknown or
-- inactive key, 42501 for one that is not unlocked.
create function private.require_avatar(p_user uuid, p_key text)
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  v_status text;
begin
  if not exists (select 1 from public.avatars a where a.key = p_key and a.active) then
    raise exception 'unknown avatar %', coalesce(p_key, 'null') using errcode = 'P0002';
  end if;
  select s.status into v_status from private.avatar_states(p_user) s where s.key = p_key;
  if v_status is distinct from 'unlocked' then
    raise exception 'avatar % is locked', p_key using errcode = '42501';
  end if;
end;
$$;

revoke execute on function private.require_avatar(uuid, text) from public;

-- The worn avatar back to the standard avatar when it is no longer unlocked.
-- Returns the number of profiles it changed (0 or 1).
create function private.refresh_avatar(p_user uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  update public.profiles p
     set avatar_key = private.default_avatar()
   where p.id = p_user
     and p.avatar_key is not null
     and p.avatar_key is distinct from private.default_avatar()
     and not exists (select 1 from private.avatar_states(p_user) s
                     where s.key = p.avatar_key and s.status = 'unlocked');
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function private.refresh_avatar(uuid) from public;

-- The longest run of consecutive weeks with a real check-in that was not
-- rejected (weeks of Gent, like streak_weeks).
create function private.longest_streak(p_user uuid)
returns integer
language sql
stable
set search_path = ''
as $$
  with weeks as (
    select distinct date_trunc('week', c.created_at at time zone 'Europe/Brussels')::date as wk
    from public.checkins c
    where c.user_id = p_user and c.status <> 'rejected' and not c.is_test
  ),
  runs as (
    select w.wk - (row_number() over (order by w.wk) * 7)::integer as grp
    from weeks w
  )
  select coalesce(max(x.n), 0)::integer
  from (select count(*) as n from runs r group by r.grp) x;
$$;

revoke execute on function private.longest_streak(uuid) from public;

-- ---------------------------------------------------------------------------
-- The refresh also checks the worn avatar
-- ---------------------------------------------------------------------------

-- refresh_game_state from 20261015180000_discoveries.sql: the same, and then
-- the worn avatar (counted in the changed rows).
create or replace function private.refresh_game_state(p_user uuid)
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

  -- The worn avatar: back to the standard avatar when it is no longer
  -- unlocked (a lower level after a rejection, a revoked milestone).
  changed := changed + private.refresh_avatar(p_user);

  return changed;
end;
$$;

-- adjust_points from 20261015120000_points_ledger.sql: the same, and a lower
-- level takes off an avatar that is no longer unlocked.
create or replace function public.adjust_points(user_id uuid, amount integer, reason text)
returns public.point_transactions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  why constant text := nullif(btrim(reason), '');
  row_ public.point_transactions;
begin
  if not public.is_admin() then
    raise exception 'only admins can adjust points' using errcode = '42501';
  end if;
  if adjust_points.amount is null or adjust_points.amount = 0 or abs(adjust_points.amount) > 10000 then
    raise exception 'amount must be between -10000 and 10000 and not 0' using errcode = '22023';
  end if;
  if why is null or char_length(why) > 200 then
    raise exception 'a reason of 1 to 200 characters is required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.profiles p where p.id = adjust_points.user_id) then
    raise exception 'user % not found', adjust_points.user_id using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('checkins:' || adjust_points.user_id::text, 0));

  insert into public.point_transactions (user_id, source, reward_key, amount, status, granted_at, details)
  values (adjust_points.user_id, 'adjustment', 'adjustment:' || gen_random_uuid(), adjust_points.amount,
          'granted', now(), jsonb_build_object('reason', why, 'by', auth.uid()))
  returning * into row_;

  perform private.refresh_avatar(adjust_points.user_id);
  return row_;
end;
$$;

-- ---------------------------------------------------------------------------
-- For the app: onboarding, name, avatar
-- ---------------------------------------------------------------------------

-- Finishes the onboarding: the name (2 to 24 characters after trimming) and
-- an unlocked avatar. Again later: name and avatar change, onboarded_at stays.
-- Returns {display_name, avatar_key, onboarded_at}.
create function public.complete_onboarding(name text, avatar_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid constant uuid := auth.uid();
  clean text;
  result jsonb;
begin
  if uid is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  clean := private.clean_name(complete_onboarding.name);
  if clean is null then
    raise exception 'a name of 2 to 24 characters is required' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('checkins:' || uid::text, 0));
  perform private.require_avatar(uid, complete_onboarding.avatar_key);

  update public.profiles p
     set display_name = clean,
         avatar_key = complete_onboarding.avatar_key,
         onboarded_at = coalesce(p.onboarded_at, now())
   where p.id = uid
  returning jsonb_build_object('display_name', p.display_name, 'avatar_key', p.avatar_key,
                               'onboarded_at', p.onboarded_at)
    into result;
  if result is null then
    raise exception 'profile not found' using errcode = 'P0002';
  end if;
  return result;
end;
$$;

revoke execute on function public.complete_onboarding(text, text) from public, anon;
grant execute on function public.complete_onboarding(text, text) to authenticated;

-- Changes the caller's name (same rule as the onboarding). Returns the name as
-- it was saved.
create function public.set_my_name(name text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid constant uuid := auth.uid();
  clean text;
begin
  if uid is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  clean := private.clean_name(set_my_name.name);
  if clean is null then
    raise exception 'a name of 2 to 24 characters is required' using errcode = '22023';
  end if;
  update public.profiles p set display_name = clean where p.id = uid;
  return clean;
end;
$$;

revoke execute on function public.set_my_name(text) from public, anon;
grant execute on function public.set_my_name(text) to authenticated;

-- Puts on an unlocked avatar. Returns its key.
create function public.set_my_avatar(key text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid constant uuid := auth.uid();
begin
  if uid is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('checkins:' || uid::text, 0));
  perform private.require_avatar(uid, set_my_avatar.key);
  update public.profiles p set avatar_key = set_my_avatar.key where p.id = uid;
  return set_my_avatar.key;
end;
$$;

revoke execute on function public.set_my_avatar(text) from public, anon;
grant execute on function public.set_my_avatar(text) to authenticated;

-- Every active avatar for the picker: the catalog fields, the status, how to
-- unlock it (null when unlocked) and whether the caller wears it (the
-- standard avatar when none is chosen).
create function public.my_avatars()
returns table (key text, name text, rarity text, unlock_type text, unlock_param text, sort integer,
               placeholder_symbol text, placeholder_color text, status text, hint text, is_current boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  uid constant uuid := auth.uid();
  worn text;
begin
  if uid is null then
    raise exception 'sign in to see your avatars' using errcode = '42501';
  end if;
  select coalesce(p.avatar_key, private.default_avatar()) into worn from public.profiles p where p.id = uid;

  return query
    select a.key, a.name, a.rarity, a.unlock_type, a.unlock_param, a.sort,
           a.placeholder_symbol, a.placeholder_color, s.status,
           case when s.status = 'unlocked' then null else private.avatar_hint(a.unlock_type, a.unlock_param) end,
           a.key = worn
    from public.avatars a
    join private.avatar_states(uid) s on s.key = a.key
    order by a.sort, a.key;
end;
$$;

revoke execute on function public.my_avatars() from public, anon;
grant execute on function public.my_avatars() to authenticated;

-- ---------------------------------------------------------------------------
-- For the app: catalog, game state, leaderboard
-- ---------------------------------------------------------------------------

-- game_catalog() from 20261015180000_discoveries.sql, plus the levels and the
-- active avatars.
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
                   from public.milestones m),
    'levels', (select coalesce(jsonb_agg(jsonb_build_object('level', l.level, 'min_points', l.min_points,
                                                            'title', l.title)
                                         order by l.level), '[]'::jsonb)
               from public.levels l),
    'avatars', (select coalesce(jsonb_agg(jsonb_build_object(
                                  'key', a.key, 'name', a.name, 'rarity', a.rarity,
                                  'unlock_type', a.unlock_type, 'unlock_param', a.unlock_param, 'sort', a.sort,
                                  'placeholder_symbol', a.placeholder_symbol,
                                  'placeholder_color', a.placeholder_color)
                                order by a.sort, a.key), '[]'::jsonb)
                from public.avatars a
                where a.active));
$$;

-- my_game_state() from 20261015180000_discoveries.sql, plus the level (from
-- the granted real points, with the next one) and the statistics of the
-- profile: real check-ins and answered bonus questions that were not
-- rejected, the longest streak.
create or replace function public.my_game_state()
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
  granted integer;
begin
  if uid is null then
    raise exception 'sign in to see your game' using errcode = '42501';
  end if;

  select count(*) filter (where d.status <> 'revoked'), count(*) filter (where d.status = 'confirmed')
    into discovered, confirmed
  from public.discoveries d
  where d.user_id = uid;
  select count(*) into total from private.collection(uid);
  select p.moments_seen_at, p.points into seen, granted from public.profiles p where p.id = uid;

  return jsonb_build_object(
    'points', jsonb_build_object(
      'granted', coalesce(granted, 0),
      'pending', coalesce((select sum(t.amount) from public.point_transactions t
                           where t.user_id = uid and not t.is_test and t.status = 'pending'), 0)),
    'level', (
      select jsonb_build_object(
               'level', l.level, 'title', l.title, 'min_points', l.min_points,
               'next', case when l.next_level is not null then
                         jsonb_build_object('level', l.next_level, 'title', l.next_title,
                                            'min_points', l.next_min_points) end)
      from private.level_of(granted) l),
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
    'stats', jsonb_build_object(
      'checkins', (select count(*) from public.checkins c
                   where c.user_id = uid and not c.is_test and c.status <> 'rejected'),
      'bonus_answers', (select count(*) from public.bonus_answers b
                        join public.checkins c on c.id = b.checkin_id
                        where b.user_id = uid and not b.is_test and b.answered_at is not null
                          and c.status <> 'rejected'),
      'longest_streak', private.longest_streak(uid)),
    'unseen_moments', (select count(*) from private.moments_since(uid, seen)),
    'as_of', now());
end;
$$;

-- leaderboard() from 20261015120000_points_ledger.sql, plus the avatar (the
-- standard avatar when none is chosen), the level and its title. The level
-- always follows the granted real points, also in the week and with test data.
drop function public.leaderboard(text, integer, boolean);

create function public.leaderboard(period text, max_rows integer default 50, include_test boolean default false)
returns table (place integer, display_name text, points integer, is_me boolean,
               avatar_key text, level integer, title text)
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
      select t.user_id, p.display_name, sum(t.amount)::integer
      from public.point_transactions t
      join public.profiles p on p.id = t.user_id
      where leaderboard.period = 'week'
        and t.status = 'granted'
        and (with_test or not t.is_test)
        and t.earned_at >= public.local_week_start(now())
      group by t.user_id, p.display_name
    ),
    ranked as (
      select s.user_id, s.name, s.pts,
             rank() over (order by s.pts desc)::integer as place_,
             row_number() over (order by s.pts desc, s.name, s.user_id) as rn
      from scores s
      where s.pts > 0
    )
    select r.place_, coalesce(r.name, 'Anoniem'), r.pts, r.user_id = auth.uid(),
           coalesce(p.avatar_key, private.default_avatar()), lv.level, lv.title
    from ranked r
    join public.profiles p on p.id = r.user_id
    cross join lateral private.level_of(p.points) lv
    where r.rn <= least(greatest(coalesce(leaderboard.max_rows, 50), 1), 100) or r.user_id = auth.uid()
    order by r.rn;
end;
$$;

revoke execute on function public.leaderboard(text, integer, boolean) from public, anon;
grant execute on function public.leaderboard(text, integer, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Events
-- ---------------------------------------------------------------------------

insert into public.event_names (name, description) values
  ('avatar_changed', 'An avatar is saved (in the onboarding or from the profile).'),
  ('onboarding_step', 'A step of the onboarding is shown (name, avatar).'),
  ('onboarding_completed', 'The onboarding is finished.');

notify pgrst, 'reload schema';
