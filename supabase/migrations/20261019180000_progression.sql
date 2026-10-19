-- Progression: badges and the approval celebration (docs/GAMIFICATION.md,
-- 2.3, 2.4, 2.6, 2.8, chapter 3, chapter 5 and phase 5).
--
-- Badges are a catalog; every badge has a rule of a fixed type (badges.rule):
--   {"type":"count","of":"checkins","target":N[,"hour_from":H][,"hour_before":H]}
--   {"type":"count","of":"discoveries"|"bonus_answers"|"reports","target":N}
--   {"type":"streak_weeks","target":N}      the longest run of weeks
--   {"type":"region_complete"}              every bin of the region discovered
-- Hours are local (Europe/Brussels); hour_from > hour_before wraps midnight.
-- A new badge of an existing type is one row; a new type is a migration.
--
-- The refresh evaluates every active badge over the two certainties (2.1):
-- granted when the rule holds over approved facts, pending when it holds over
-- facts that were not rejected, else revoked (user_badges; a badge earned
-- again reuses its row). Test check-ins never count. Badges carry no points.
-- Missing-bin reports now start the refresh too (insert and review), for
-- Kaartmaker.
--
-- Unlocks: a badge avatar is unlocked when its badge is granted and pending
-- when the badge is pending; the refresh takes it off when the badge is
-- revoked. The hint names the badge from the catalog (a secret one stays
-- secret).
--
-- Decisions (the approval celebration): my_unseen() adds `results`, what was
-- decided after profiles.results_seen_at up to `as_of`: approved and rejected
-- check-ins, the points granted per source, the total before and after, the
-- level before (profiles.last_seen_level) and after, the badges granted and
-- the avatars unlocked. mark_seen('results', until) moves results_seen_at and
-- sets last_seen_level to the level of the points at that time.
--
-- No race with a review in between: my_unseen takes the user's lock and reads
-- `as_of` after it; review_checkin, revoke_checkin and the refresh stamp their
-- times after taking that same lock (clock_timestamp(), not the start of the
-- transaction). So a decision is either visible to my_unseen and before
-- `as_of`, or after `as_of` and shown the next time.

-- ---------------------------------------------------------------------------
-- Catalog: badges
-- ---------------------------------------------------------------------------

-- True when a badge rule has one of the known types and valid parameters.
create function private.badge_rule_ok(p_rule jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p_rule) = 'object' and coalesce(
    case p_rule->>'type'
      when 'count' then
        p_rule->>'of' in ('checkins', 'discoveries', 'bonus_answers', 'reports')
        and jsonb_typeof(p_rule->'target') = 'number' and (p_rule->>'target') ~ '^[1-9][0-9]{0,5}$'
        and (select bool_and(k in ('type', 'of', 'target', 'hour_from', 'hour_before'))
             from jsonb_object_keys(p_rule) k)
        and (p_rule->>'of' = 'checkins' or not (p_rule ? 'hour_from' or p_rule ? 'hour_before'))
        and (not p_rule ? 'hour_from'
             or (jsonb_typeof(p_rule->'hour_from') = 'number' and (p_rule->>'hour_from') ~ '^(1?[0-9]|2[0-3])$'))
        and (not p_rule ? 'hour_before'
             or (jsonb_typeof(p_rule->'hour_before') = 'number' and (p_rule->>'hour_before') ~ '^([1-9]|1[0-9]|2[0-4])$'))
        and (not (p_rule ? 'hour_from' and p_rule ? 'hour_before')
             or (p_rule->>'hour_from') <> (p_rule->>'hour_before'))
      when 'streak_weeks' then
        jsonb_typeof(p_rule->'target') = 'number' and (p_rule->>'target') ~ '^[1-9][0-9]{0,2}$'
        and (select bool_and(k in ('type', 'target')) from jsonb_object_keys(p_rule) k)
      when 'region_complete' then
        (select bool_and(k = 'type') from jsonb_object_keys(p_rule) k)
    end, false);
$$;

revoke execute on function private.badge_rule_ok(jsonb) from public;

create table public.badges (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,63}$'),
  name text not null check (char_length(name) between 1 and 30),
  -- how to earn it: the explanation in the app
  description text not null check (char_length(description) between 1 and 120),
  symbol text not null check (symbol ~ '^[a-z0-9]+(\.[a-z0-9]+)*$'),
  rarity text not null check (rarity in ('common', 'rare', 'epic', 'legendary')),
  rule jsonb not null check (private.badge_rule_ok(rule)),
  -- a secret badge shows as "Geheime badge" until it is earned
  secret boolean not null default false,
  sort integer not null,
  active boolean not null default true
);

comment on table public.badges is
  'Badges: a rule of a fixed type (private.badge_progress), evaluated by private.refresh_game_state into user_badges. Read through game_catalog() and my_badges().';

alter table public.badges enable row level security;
revoke all on public.badges from anon, authenticated;

-- Chapter 3, without Questheld (quests, phase 6) and Premiejager (bounties,
-- phase 8): their rule types come with their phases.
insert into public.badges (sort, key, name, description, symbol, rarity, rule, secret) values
  (1, 'first_checkin', 'Eerste inworp', 'Doe je eerste inworp.', 'hand.thumbsup.fill', 'common',
   '{"type": "count", "of": "checkins", "target": 1}', false),
  (2, 'explorer_10', 'Ontdekker 10', 'Ontdek 10 vuilbakken.', 'map.fill', 'common',
   '{"type": "count", "of": "discoveries", "target": 10}', false),
  (3, 'explorer_50', 'Ontdekker 50', 'Ontdek 50 vuilbakken.', 'binoculars.fill', 'rare',
   '{"type": "count", "of": "discoveries", "target": 50}', false),
  (4, 'explorer_100', 'Ontdekker 100', 'Ontdek 100 vuilbakken.', 'globe.europe.africa.fill', 'epic',
   '{"type": "count", "of": "discoveries", "target": 100}', false),
  (5, 'streak_4', 'Reeks van 4', 'Doe 4 weken na elkaar minstens één inworp.', 'flame.fill', 'rare',
   '{"type": "streak_weeks", "target": 4}', false),
  (6, 'streak_8', 'Reeks van 8', 'Doe 8 weken na elkaar minstens één inworp.', 'flame.circle.fill', 'epic',
   '{"type": "streak_weeks", "target": 8}', false),
  (7, 'curious', 'Nieuwsgierig', 'Beantwoord 25 bonusvragen.', 'questionmark.bubble.fill', 'rare',
   '{"type": "count", "of": "bonus_answers", "target": 25}', false),
  (8, 'mapmaker', 'Kaartmaker', 'Meld een ontbrekende vuilbak die goedgekeurd wordt.', 'mappin.and.ellipse', 'rare',
   '{"type": "count", "of": "reports", "target": 1}', false),
  (9, 'early_bird', 'Vroege vogel', 'Doe een inworp tussen 5 en 8 uur ''s ochtends.', 'sunrise.fill', 'rare',
   '{"type": "count", "of": "checkins", "target": 1, "hour_from": 5, "hour_before": 8}', false),
  (10, 'night_owl', 'Nachtuil', 'Doe een inworp tussen 22 en 5 uur ''s nachts.', 'moon.zzz.fill', 'rare',
   '{"type": "count", "of": "checkins", "target": 1, "hour_from": 22, "hour_before": 5}', true),
  (11, 'whole_neighbourhood', 'Heel de buurt', 'Ontdek alle vuilbakken van de regio.', 'trophy.fill', 'legendary',
   '{"type": "region_complete"}', false);

-- One badge as the app sees it. A secret badge that is not revealed shows no
-- name, explanation or symbol.
create function private.badge_json(b public.badges, p_revealed boolean)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select case when b.secret and not p_revealed then
      jsonb_build_object('key', b.key, 'name', 'Geheime badge', 'description', 'Een verrassing: blijf spelen.',
                         'symbol', 'questionmark', 'rarity', b.rarity, 'secret', true, 'sort', b.sort)
    else
      jsonb_build_object('key', b.key, 'name', b.name, 'description', b.description, 'symbol', b.symbol,
                         'rarity', b.rarity, 'secret', b.secret, 'sort', b.sort)
    end;
$$;

revoke execute on function private.badge_json(public.badges, boolean) from public;

-- ---------------------------------------------------------------------------
-- Game facts: user_badges
-- ---------------------------------------------------------------------------

create table public.user_badges (
  user_id uuid not null references public.profiles (id) on delete cascade,
  badge_key text not null references public.badges (key) on update cascade,
  status text not null check (status in ('pending', 'granted', 'revoked')),
  -- when it was earned (again): the moment
  earned_at timestamptz not null default now(),
  -- when it became granted (the approval celebration)
  granted_at timestamptz,
  -- the check-in that reached the target (analysis); null for streaks and reports
  anchor_checkin_id uuid references public.checkins (id) on delete set null,
  primary key (user_id, badge_key),
  constraint user_badges_granted_at check ((status = 'granted') = (granted_at is not null))
);

comment on table public.user_badges is
  'Badges a user earned: kept by private.refresh_game_state over the two certainties (pending/granted/revoked).';

create index user_badges_anchor_idx on public.user_badges (anchor_checkin_id)
  where anchor_checkin_id is not null;

-- Users read their own rows, admins all; only the functions write.
alter table public.user_badges enable row level security;
revoke all on public.user_badges from anon, authenticated;
grant select on public.user_badges to authenticated;

create policy "user_badges: read own, admins read all"
  on public.user_badges for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

-- Decisions (approved, rejected, revoked) after this time are unseen.
alter table public.profiles
  add column results_seen_at timestamptz not null default now();

comment on column public.profiles.results_seen_at is
  'Decisions after this time are unseen: my_unseen() lists them in `results`, mark_seen(''results'', until) moves it.';

-- ---------------------------------------------------------------------------
-- Rules
-- ---------------------------------------------------------------------------

-- Whether the local hour (Gent) of p_at is in [p_from, p_before); without
-- bounds always, and p_from > p_before wraps midnight.
create function private.in_local_hours(p_at timestamptz, p_from integer, p_before integer)
returns boolean
language sql
stable
set search_path = ''
as $$
  select case
    when p_from is null and p_before is null then true
    when p_from is null then x.h < p_before
    when p_before is null then x.h >= p_from
    when p_from < p_before then x.h >= p_from and x.h < p_before
    else x.h >= p_from or x.h < p_before
  end
  from (select extract(hour from p_at at time zone 'Europe/Brussels')::integer as h) x;
$$;

revoke execute on function private.in_local_hours(timestamptz, integer, integer) from public;

-- The longest run of consecutive weeks with a real check-in, over check-ins
-- that were not rejected or (p_approved_only) over approved ones.
create function private.longest_streak(p_user uuid, p_approved_only boolean)
returns integer
language sql
stable
set search_path = ''
as $$
  with weeks as (
    select distinct date_trunc('week', c.created_at at time zone 'Europe/Brussels')::date as wk
    from public.checkins c
    where c.user_id = p_user and not c.is_test
      and case when p_approved_only then c.status = 'approved' else c.status <> 'rejected' end
  ),
  runs as (
    select w.wk - (row_number() over (order by w.wk) * 7)::integer as grp
    from weeks w
  )
  select coalesce(max(x.n), 0)::integer
  from (select count(*) as n from runs r group by r.grp) x;
$$;

revoke execute on function private.longest_streak(uuid, boolean) from public;

-- A badge rule for a user: the value over facts that were not rejected
-- (provisional), over approved facts (certain), the target and the check-in
-- that reached it. Unknown types never hold (target null).
create function private.badge_progress(p_user uuid, p_rule jsonb)
returns table (provisional integer, certain integer, target integer, anchor uuid)
language plpgsql
stable
set search_path = ''
as $$
declare
  hour_from constant integer := (p_rule->>'hour_from')::integer;
  hour_before constant integer := (p_rule->>'hour_before')::integer;
begin
  target := (p_rule->>'target')::integer;

  if p_rule->>'type' = 'count' and p_rule->>'of' = 'checkins' then
    select count(*) filter (where c.status <> 'rejected'),
           count(*) filter (where c.status = 'approved'),
           (array_agg(c.id order by c.created_at, c.id) filter (where c.status <> 'rejected'))[target]
      into provisional, certain, anchor
    from public.checkins c
    where c.user_id = p_user and not c.is_test
      and private.in_local_hours(c.created_at, hour_from, hour_before);

  elsif p_rule->>'type' = 'count' and p_rule->>'of' = 'discoveries' then
    select count(*) filter (where d.status <> 'revoked'),
           count(*) filter (where d.status = 'confirmed'),
           (array_agg(d.checkin_id order by d.discovered_at, d.bin_id) filter (where d.status <> 'revoked'))[target]
      into provisional, certain, anchor
    from public.discoveries d
    where d.user_id = p_user;

  elsif p_rule->>'type' = 'count' and p_rule->>'of' = 'bonus_answers' then
    select count(*) filter (where c.status <> 'rejected'),
           count(*) filter (where c.status = 'approved'),
           (array_agg(c.id order by b.answered_at, c.id) filter (where c.status <> 'rejected'))[target]
      into provisional, certain, anchor
    from public.bonus_answers b
    join public.checkins c on c.id = b.checkin_id
    where b.user_id = p_user and b.answered_at is not null and not b.is_test and not c.is_test;

  elsif p_rule->>'type' = 'count' and p_rule->>'of' = 'reports' then
    select count(*) filter (where r.status <> 'rejected'), count(*) filter (where r.status = 'approved')
      into provisional, certain
    from public.bin_reports r
    where r.user_id = p_user;

  elsif p_rule->>'type' = 'streak_weeks' then
    provisional := private.longest_streak(p_user, false);
    certain := private.longest_streak(p_user, true);

  elsif p_rule->>'type' = 'region_complete' then
    -- the active, eligible bins of the region (like private.collection)
    with r as (
      select (private.cfg('region_west'))::double precision as w,
             (private.cfg('region_south'))::double precision as s,
             (private.cfg('region_east'))::double precision as e,
             (private.cfg('region_north'))::double precision as n
    ),
    region as (
      select b.id
      from public.bins b
      cross join r
      where b.status = 'active' and b.eligible_effective
        and extensions.st_x(b.geom::extensions.geometry) between r.w and r.e
        and extensions.st_y(b.geom::extensions.geometry) between r.s and r.n
    )
    select count(d.bin_id) filter (where d.status <> 'revoked'),
           count(d.bin_id) filter (where d.status = 'confirmed'),
           count(*),
           (array_agg(d.checkin_id order by d.discovered_at desc) filter (where d.status <> 'revoked'))[1]
      into provisional, certain, target, anchor
    from region g
    left join public.discoveries d on d.user_id = p_user and d.bin_id = g.id;

  else
    provisional := 0;
    certain := 0;
    target := null;
  end if;

  return next;
end;
$$;

revoke execute on function private.badge_progress(uuid, jsonb) from public;

-- ---------------------------------------------------------------------------
-- Unlocks by badge
-- ---------------------------------------------------------------------------

-- avatar_hint from 20261019120000_identity.sql: the badge name from the
-- catalog (a secret badge stays secret).
create or replace function private.avatar_hint(p_type text, p_param text)
returns text
language sql
stable
set search_path = ''
as $$
  select case p_type
    when 'level' then 'Bereik level ' || p_param
    when 'milestone' then 'Ontdek ' || p_param || ' vuilbakken'
    when 'badge' then coalesce((select case when b.secret then 'Verdien een geheime badge'
                                            else 'Verdien de badge ' || b.name end
                                from public.badges b where b.key = p_param),
                               'Verdien de badge ' || p_param)
    when 'quest' then 'Voltooi een speciale quest'
    when 'chest' then 'Alleen te vinden in de dagkist'
  end;
$$;

-- avatar_states from 20261019120000_identity.sql: a badge avatar follows its
-- badge (granted = unlocked, pending = pending).
create or replace function private.avatar_states(p_user uuid)
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
           when 'badge' then
             coalesce((select case ub.status when 'granted' then 'unlocked' when 'pending' then 'pending' end
                       from public.user_badges ub
                       where ub.user_id = p_user and ub.badge_key = a.unlock_param), 'locked')
           -- quest and chest (phase 6)
           else 'locked'
         end
  from public.avatars a
  left join lv on true
  where a.active;
$$;

-- ---------------------------------------------------------------------------
-- The refresh adds the badges
-- ---------------------------------------------------------------------------

-- refresh_game_state from 20261019120000_identity.sql: the same, plus the
-- badges before the worn avatar. Times that the approval celebration reads
-- (granted_at, revoked_at) are clock_timestamp() after the user's lock; the
-- moments keep now() (record_checkin finds what it reached by now()).
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
  stamp timestamptz;
begin
  if p_user is null then
    return 0;
  end if;
  -- Callers hold it already (a no-op then); others get the lock order right.
  perform pg_advisory_xact_lock(hashtextextended('checkins:' || p_user::text, 0));
  stamp := clock_timestamp();

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
         case when um.status = 'granted' then stamp end,
         case when um.status = 'revoked' then stamp end,
         case when um.status = 'revoked' then 'milestone_lost' end,
         jsonb_build_object('threshold', um.threshold)
  from public.user_milestones um
  where um.user_id = p_user
  on conflict (user_id, is_test, reward_key) do update
    set status = excluded.status,
        anchor_checkin_id = excluded.anchor_checkin_id,
        earned_at = excluded.earned_at,
        granted_at = case excluded.status
                       when 'granted' then coalesce(case when t.status = 'granted' then t.granted_at end, stamp)
                       when 'revoked' then t.granted_at
                     end,
        revoked_at = case when excluded.status = 'revoked'
                          then coalesce(case when t.status = 'revoked' then t.revoked_at end, stamp) end,
        revoke_reason = excluded.revoke_reason
    where (t.status, t.anchor_checkin_id, t.earned_at)
          is distinct from (excluded.status, excluded.anchor_checkin_id, excluded.earned_at);
  get diagnostics n = row_count;
  changed := changed + n;

  -- Badges: the rule of every active badge over the two certainties. A badge
  -- earned again reuses its row (earned_at is the new moment).
  with target as (
    select b.key,
           case when p.target >= 1 and p.certain >= p.target then 'granted'
                when p.target >= 1 and p.provisional >= p.target then 'pending'
                else 'revoked' end as status,
           p.anchor
    from public.badges b
    cross join lateral private.badge_progress(p_user, b.rule) p
    where b.active
  )
  insert into public.user_badges as ub (user_id, badge_key, status, earned_at, granted_at, anchor_checkin_id)
  select p_user, t.key, t.status, now(), case when t.status = 'granted' then stamp end, t.anchor
  from target t
  where t.status <> 'revoked'
     or exists (select 1 from public.user_badges x where x.user_id = p_user and x.badge_key = t.key)
  on conflict (user_id, badge_key) do update
    set status = excluded.status,
        earned_at = case when ub.status = 'revoked' then now() else ub.earned_at end,
        granted_at = case when excluded.status = 'granted' then coalesce(ub.granted_at, stamp) end,
        anchor_checkin_id = case when excluded.status = 'revoked' then ub.anchor_checkin_id
                                 else excluded.anchor_checkin_id end
    where ub.status is distinct from excluded.status
       or (excluded.status <> 'revoked' and ub.anchor_checkin_id is distinct from excluded.anchor_checkin_id);
  get diagnostics n = row_count;
  changed := changed + n;

  -- The worn avatar: back to the standard avatar when it is no longer
  -- unlocked (a lower level after a rejection, a revoked milestone or badge).
  changed := changed + private.refresh_avatar(p_user);

  return changed;
end;
$$;

-- Missing-bin reports start the refresh (Kaartmaker): a new report (pending)
-- and its review. Errors never fail the report or the review.
create function private.bin_report_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.refresh_game_state_safely(new.user_id, 'bin_report', null);
  return null;
end;
$$;

revoke execute on function private.bin_report_changed() from public;

create trigger bin_reports_refresh_game
  after insert or update of status on public.bin_reports
  for each row execute function private.bin_report_changed();

-- ---------------------------------------------------------------------------
-- Decisions are stamped after the user's lock
-- ---------------------------------------------------------------------------

-- review_checkin from 20261015180000_discoveries.sql: reviewed_at is
-- clock_timestamp() (after the lock) instead of the start of the transaction.
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
         reviewed_at = clock_timestamp(),
         reviewed_by = auth.uid()
   where c.id = review_checkin.id
  returning * into checkin;

  if not checkin.is_test then
    perform private.refresh_game_state_safely(owner, 'review_checkin', checkin.id);
  end if;

  return checkin;
end;
$$;

-- revoke_checkin from 20261015180000_discoveries.sql: revoked_at is
-- clock_timestamp() (after the lock).
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
         revoked_at = clock_timestamp(),
         revoked_by = auth.uid()
   where c.id = revoke_checkin.id
  returning * into checkin;

  if not checkin.is_test then
    perform private.refresh_game_state_safely(owner, 'revoke_checkin', checkin.id);
  end if;

  return checkin;
end;
$$;

-- ---------------------------------------------------------------------------
-- Moments and results (internal)
-- ---------------------------------------------------------------------------

-- moments_since from 20261015180000_discoveries.sql, plus the badges (from
-- when they were earned, revealed).
create or replace function private.moments_since(p_user uuid, p_since timestamptz)
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
    union all
    select 'badge', ub.earned_at,
           private.badge_json(b, true) - 'sort' - 'secret' || jsonb_build_object('status', ub.status),
           2
    from public.user_badges ub
    join public.badges b on b.key = ub.badge_key
    where ub.user_id = p_user and ub.status <> 'revoked' and ub.earned_at > p_since
  ) x
  order by x.at, x.sort, x.details->>'bin_id', x.details->>'threshold', x.details->>'key';
$$;

-- checkin_game from 20261015180000_discoveries.sql, plus the badges reached
-- in this transaction (revealed, by catalog order).
create or replace function private.checkin_game(p_user uuid, p_checkin uuid)
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
    'badges', (
      select coalesce(jsonb_agg(private.badge_json(b, true) - 'sort' - 'secret'
                                || jsonb_build_object('status', ub.status)
                                order by b.sort, b.key), '[]'::jsonb)
      from public.user_badges ub
      join public.badges b on b.key = ub.badge_key
      where ub.user_id = p_user and ub.status <> 'revoked' and ub.earned_at = now()),
    'as_of', now());
$$;

-- The granted real points of a user at time p_at, from the ledger: rows
-- granted by then that were not revoked by then.
create function private.points_at(p_user uuid, p_at timestamptz)
returns integer
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(t.amount), 0)::integer
  from public.point_transactions t
  where t.user_id = p_user and not t.is_test and t.granted_at <= p_at
    and (t.status = 'granted' or (t.status = 'revoked' and t.revoked_at > p_at));
$$;

revoke execute on function private.points_at(uuid, timestamptz) from public;

-- What was decided for a user after p_since up to p_as_of (now, under the
-- user's lock): approved and rejected real check-ins (newest 50 of each,
-- oldest first), the points granted per source, the total before and after,
-- the level before (last_seen_level) and after, the badges granted and the
-- avatars unlocked (by level, granted milestone or granted badge).
create function private.results_since(p_user uuid, p_since timestamptz, p_as_of timestamptz)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with decided as (
    select c.id, c.bin_id, c.status, c.review_reason, c.revoked_at is not null as revoked,
           coalesce(c.revoked_at, c.reviewed_at) as decided_at
    from public.checkins c
    where c.user_id = p_user and not c.is_test and c.status <> 'pending'
      and coalesce(c.revoked_at, c.reviewed_at) > p_since
      and coalesce(c.revoked_at, c.reviewed_at) <= p_as_of
  ),
  approved as (
    select d.* from decided d where d.status = 'approved' order by d.decided_at desc, d.id limit 50
  ),
  rejected as (
    select d.* from decided d where d.status = 'rejected' order by d.decided_at desc, d.id limit 50
  ),
  gained as (
    select t.source, sum(t.amount)::integer as amount
    from public.point_transactions t
    where t.user_id = p_user and not t.is_test and t.status = 'granted'
      and t.granted_at > p_since and t.granted_at <= p_as_of
    group by t.source
  ),
  lv as (
    select p.last_seen_level as level_before, l.level as level_after, l.title, p.points
    from public.profiles p
    cross join lateral private.level_of(p.points) l
    where p.id = p_user
  ),
  badges as (
    select b
    from public.user_badges ub
    join public.badges b on b.key = ub.badge_key
    where ub.user_id = p_user and ub.status = 'granted' and ub.granted_at > p_since and ub.granted_at <= p_as_of
  ),
  avatars as (
    select a.key, a.name, a.sort
    from public.avatars a
    join private.avatar_states(p_user) s on s.key = a.key and s.status = 'unlocked'
    cross join lv
    where case a.unlock_type
      when 'level' then a.unlock_param::integer > lv.level_before and a.unlock_param::integer <= lv.level_after
      when 'milestone' then exists (
        select 1 from public.point_transactions t
        where t.user_id = p_user and not t.is_test and t.reward_key = 'milestone:' || a.unlock_param
          and t.status = 'granted' and t.granted_at > p_since and t.granted_at <= p_as_of)
      when 'badge' then exists (select 1 from badges x where (x.b).key = a.unlock_param)
      else false
    end
  )
  select jsonb_build_object(
    'approved', coalesce((select jsonb_agg(jsonb_build_object(
                            'checkin_id', a.id, 'bin_id', a.bin_id, 'decided_at', a.decided_at,
                            'points', (select coalesce(sum(t.amount), 0) from public.point_transactions t
                                       where t.checkin_id = a.id and t.status = 'granted'))
                          order by a.decided_at, a.id) from approved a), '[]'::jsonb),
    'rejected', coalesce((select jsonb_agg(jsonb_build_object(
                            'checkin_id', r.id, 'bin_id', r.bin_id, 'decided_at', r.decided_at,
                            'reason', r.review_reason, 'revoked', r.revoked)
                          order by r.decided_at, r.id) from rejected r), '[]'::jsonb),
    'approved_count', (select count(*) from decided d where d.status = 'approved'),
    'rejected_count', (select count(*) from decided d where d.status = 'rejected'),
    'gained', coalesce((select sum(g.amount) from gained g), 0),
    'by_source', coalesce((select jsonb_object_agg(g.source, g.amount) from gained g), '{}'::jsonb),
    'points_before', private.points_at(p_user, p_since),
    'points_after', lv.points,
    'level_before', lv.level_before,
    'level_after', lv.level_after,
    'level_title', lv.title,
    'badges', coalesce((select jsonb_agg(private.badge_json(x.b, true) - 'secret' order by (x.b).sort, (x.b).key)
                        from badges x), '[]'::jsonb),
    'avatars', coalesce((select jsonb_agg(jsonb_build_object('key', v.key, 'name', v.name) order by v.sort, v.key)
                         from avatars v), '[]'::jsonb))
  from lv;
$$;

revoke execute on function private.results_since(uuid, timestamptz, timestamptz) from public;

-- ---------------------------------------------------------------------------
-- For the app
-- ---------------------------------------------------------------------------

-- What the caller missed since the last visit: {moments, moments_total,
-- results, as_of}. Moments: discoveries, milestones and badges that were not
-- revoked, newest 20 (oldest first); after showing them the app calls
-- mark_seen('moments', as_of). Results: the decisions since results_seen_at
-- (private.results_since); after showing them mark_seen('results', as_of).
-- Takes the user's lock first, so every decision stamped before as_of is
-- visible here (see the top of this file).
create or replace function public.my_unseen()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  uid constant uuid := auth.uid();
  seen timestamptz;
  results_seen timestamptz;
  v_as_of timestamptz;
begin
  if uid is null then
    raise exception 'sign in to see what is new' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('checkins:' || uid::text, 0));
  v_as_of := clock_timestamp();
  select p.moments_seen_at, p.results_seen_at into seen, results_seen from public.profiles p where p.id = uid;

  return (
    -- in the order of moments_since: by time, then discovery, milestone, badge
    with m as (select * from private.moments_since(uid, seen) with ordinality x(kind, at, details, ord)),
    newest as (
      select m.* from m order by m.ord desc limit 20
    )
    select jsonb_build_object(
      'moments', coalesce((select jsonb_agg(jsonb_build_object('kind', n.kind, 'at', n.at) || n.details
                                            order by n.ord) from newest n), '[]'::jsonb),
      'moments_total', (select count(*) from m),
      'results', private.results_since(uid, results_seen, v_as_of),
      'as_of', v_as_of));
end;
$$;

-- Marks what the app showed, up to `until` (a time from the server: `as_of`
-- of my_unseen or of a check-in). Kind 'moments' moves moments_seen_at;
-- 'results' moves results_seen_at and sets last_seen_level to the level of
-- the points at that time (a level-up after `until` is shown next time).
-- Never moves back, never past now. Returns the new mark.
create or replace function public.mark_seen(kind text, until timestamptz)
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
  if kind is null or kind not in ('moments', 'results') then
    raise exception 'kind must be moments or results' using errcode = '22023';
  end if;
  if until is null then
    raise exception 'until is required' using errcode = '22023';
  end if;

  if kind = 'moments' then
    update public.profiles p
       set moments_seen_at = greatest(p.moments_seen_at, least(mark_seen.until, now()))
     where p.id = uid
    returning p.moments_seen_at into result;
  else
    update public.profiles p
       set results_seen_at = x.seen,
           last_seen_level = (select l.level from private.level_of(private.points_at(uid, x.seen)) l)
      from (select greatest(q.results_seen_at, least(mark_seen.until, clock_timestamp())) as seen
            from public.profiles q
            where q.id = uid) x
     where p.id = uid
    returning p.results_seen_at into result;
  end if;
  return result;
end;
$$;

-- Every active badge for the profile: the catalog fields (a secret badge that
-- is not earned stays hidden), the status ('granted', 'pending' or 'locked'),
-- when it was earned and the progress towards the target (null when hidden).
create function public.my_badges()
returns table (key text, name text, description text, symbol text, rarity text, secret boolean, sort integer,
               status text, earned_at timestamptz, progress integer, target integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  uid constant uuid := auth.uid();
begin
  if uid is null then
    raise exception 'sign in to see your badges' using errcode = '42501';
  end if;

  return query
    select b.key, v.j->>'name', v.j->>'description', v.j->>'symbol', b.rarity, b.secret, b.sort,
           coalesce(case when ub.status <> 'revoked' then ub.status end, 'locked'),
           case when ub.status <> 'revoked' then ub.earned_at end,
           case when v.hidden then null else least(p.provisional, p.target) end,
           case when v.hidden then null else p.target end
    from public.badges b
    left join public.user_badges ub on ub.user_id = uid and ub.badge_key = b.key
    cross join lateral (
      select coalesce(ub.status, 'revoked') = 'revoked' and b.secret as hidden,
             private.badge_json(b, coalesce(ub.status, 'revoked') <> 'revoked') as j
    ) v
    cross join lateral private.badge_progress(uid, b.rule) p
    where b.active
    order by b.sort, b.key;
end;
$$;

revoke execute on function public.my_badges() from public, anon;
grant execute on function public.my_badges() to authenticated;

-- game_catalog() from 20261019120000_identity.sql, plus the active badges
-- (secret ones hidden).
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
                where a.active),
    'badges', (select coalesce(jsonb_agg(private.badge_json(b, false) order by b.sort, b.key), '[]'::jsonb)
               from public.badges b
               where b.active));
$$;

-- ---------------------------------------------------------------------------
-- Events
-- ---------------------------------------------------------------------------

insert into public.event_names (name, description) values
  ('approval_shown', 'The approval celebration was shown (decisions since the last visit).'),
  ('level_up_shown', 'A level-up was shown (in the approval celebration or on its own).'),
  ('badge_shown', 'A badge was shown in a celebration (after a check-in or as a missed moment).');

-- ---------------------------------------------------------------------------
-- Existing users
-- ---------------------------------------------------------------------------

-- Badges for what users did before this migration: none of them is a missed
-- moment or part of an approval celebration, and no old decision is shown.
do $$
declare
  u uuid;
begin
  for u in
    select p.id from public.profiles p
    where exists (select 1 from public.checkins c where c.user_id = p.id and not c.is_test)
       or exists (select 1 from public.bin_reports r where r.user_id = p.id)
  loop
    perform private.refresh_game_state(u);
  end loop;
end;
$$;

update public.user_badges ub
   set earned_at = least(ub.earned_at, p.moments_seen_at)
  from public.profiles p
 where p.id = ub.user_id;

update public.profiles set results_seen_at = clock_timestamp();

notify pgrst, 'reload schema';
