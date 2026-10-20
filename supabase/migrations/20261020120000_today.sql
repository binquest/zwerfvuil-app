-- Today: daily quests, the weekly challenge, the daily chest and streak
-- freezes (docs/GAMIFICATION.md, 2.3, 2.4, 2.6, 2.8, chapter 3, chapter 5 and
-- phase 6).
--
-- Quests are a catalog (quest_templates) with a rule of a fixed type:
--   {"type":"count","of":"checkins"[,"hour_from":H][,"hour_before":H][,"new":true|"revisit":true]}
--   {"type":"count","of":"discoveries"|"bonus_answers"|"reports"}
--   {"type":"distinct_far_bins","min_m":M}   check-ins at bins at least M apart (target 1 or 2)
--   {"type":"active_days"}                   local days with a check-in
-- The target and the reward are columns. `requires` says when a template may
-- be handed out: {"undiscovered_bins":N} (bins of the collection left) and
-- {"before_hour":H} (only when handed out before that local hour).
--
-- Every user gets one quest per slot per day (easy, medium, hard) and one
-- weekly challenge (Monday to Sunday, Gent). The choice is deterministic: a
-- weighted pick over the templates that may be handed out, rolled with
-- hashtextextended(user, day, slot). Quests are handed out lazily (the
-- refresh and my_game_state) and then frozen in user_quests (title, rule,
-- target, reward), so the same user and day keep the same quests.
--
-- The refresh evaluates the quests of the last 14 days (or since the day of
-- the check-in that was reviewed or revoked, if older) over the two
-- certainties: granted over approved facts, pending over facts that were not
-- rejected, else open again. Rewards are ledger rows `quest:<id>` (source
-- quest, or weekly for the challenge); a rejection takes them back.
--
-- Daily chest: one per day with quests. Ready when every quest of that day is
-- complete; open_daily_chest(day) draws once from chest_rewards (weights,
-- visible in the app; no freeze with max_freezes in hand, no avatar the user
-- already has), keeps the draw, and its reward (points `chest:<id>`, a freeze
-- or an avatar in user_avatars) follows the quests of that day: granted when
-- all are granted, pending while complete, revoked when not. A chest that is
-- complete again keeps its draw. Chests of the last chest_open_days days can
-- be opened.
--
-- Streak freezes come from milestones (milestones.freezes, 1 at 50), quests
-- (reward_freezes) and the chest. At most max_freezes in hand when one is
-- earned, else it is lost ('freezes_full'). Their use is not stored but
-- derived (private.streak_walk): walking the weeks, a gap of k complete weeks
-- after an active week is bridged when k freezes earned before the gap are
-- left, else none is used and the streak starts again. A bridged week keeps
-- the streak but does not count (the multiplier does not rise). streak_weeks,
-- my_streak and private.longest_streak (badges Reeks van 4/8) all walk the
-- same way, up to clock_timestamp() (a freeze earned earlier in the same
-- transaction counts).
--
-- Questheld: a badge rule {"type":"count","of":"quests"} over completed
-- quests (pending/granted), 30 quests.
--
-- Moments: completed quests, a chest that became ready and freezes (not the
-- ones from the chest, shown when it opens). record_checkin's `game` adds
-- `quests` (today's and this week's, with completed_now), `chest` (with
-- ready_now) and `freezes` (earned now). my_game_state() v2 (volatile: it
-- hands out today's quests) adds the days of the week, the freezes, the
-- quests, the challenge, the chest, the ready chests and the pending
-- check-ins.

-- ---------------------------------------------------------------------------
-- Config
-- ---------------------------------------------------------------------------

insert into private.game_config_rules (key, kind, min_value, max_value) values
  ('max_freezes', 'integer', 0, 5),
  ('chest_open_days', 'integer', 1, 14);

insert into public.game_config (key, value, description) values
  ('max_freezes', '2', 'Streak freezes a user can hold. One earned with this many in hand is lost; the chest then draws none.'),
  ('chest_open_days', '7', 'Daily chests can be opened up to this many days back, today included.');

-- ---------------------------------------------------------------------------
-- Catalog: freezes on milestones, quest templates, chest rewards
-- ---------------------------------------------------------------------------

alter table public.milestones
  add column freezes integer not null default 0 check (freezes between 0 and 2);

comment on column public.milestones.freezes is 'Streak freezes earned with the milestone (lost when max_freezes are in hand).';

update public.milestones set freezes = 1 where threshold = 50;

-- True when a quest rule has one of the known types and valid parameters.
create function private.quest_rule_ok(p_rule jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p_rule) = 'object' and coalesce(
    case p_rule->>'type'
      when 'count' then
        p_rule->>'of' in ('checkins', 'discoveries', 'bonus_answers', 'reports')
        and (select bool_and(k in ('type', 'of', 'hour_from', 'hour_before', 'new', 'revisit'))
             from jsonb_object_keys(p_rule) k)
        and (p_rule->>'of' = 'checkins' or not (p_rule ?| array['hour_from', 'hour_before', 'new', 'revisit']))
        and (not p_rule ? 'hour_from'
             or (jsonb_typeof(p_rule->'hour_from') = 'number' and (p_rule->>'hour_from') ~ '^(1?[0-9]|2[0-3])$'))
        and (not p_rule ? 'hour_before'
             or (jsonb_typeof(p_rule->'hour_before') = 'number' and (p_rule->>'hour_before') ~ '^([1-9]|1[0-9]|2[0-4])$'))
        and (not (p_rule ? 'hour_from' and p_rule ? 'hour_before')
             or (p_rule->>'hour_from') <> (p_rule->>'hour_before'))
        and (not p_rule ? 'new' or p_rule->'new' = 'true'::jsonb)
        and (not p_rule ? 'revisit' or p_rule->'revisit' = 'true'::jsonb)
        and not (p_rule ? 'new' and p_rule ? 'revisit')
      when 'distinct_far_bins' then
        (select bool_and(k in ('type', 'min_m')) from jsonb_object_keys(p_rule) k)
        and jsonb_typeof(p_rule->'min_m') = 'number' and (p_rule->>'min_m') ~ '^[1-9][0-9]{0,3}$'
      when 'active_days' then
        (select bool_and(k = 'type') from jsonb_object_keys(p_rule) k)
    end, false);
$$;

revoke execute on function private.quest_rule_ok(jsonb) from public;

-- True when the conditions of a template are known and valid.
create function private.quest_requires_ok(p_requires jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p_requires) = 'object'
    and coalesce((select bool_and(k in ('undiscovered_bins', 'before_hour')) from jsonb_object_keys(p_requires) k), true)
    and (not p_requires ? 'undiscovered_bins'
         or (jsonb_typeof(p_requires->'undiscovered_bins') = 'number'
             and (p_requires->>'undiscovered_bins') ~ '^[1-9][0-9]{0,3}$'))
    and (not p_requires ? 'before_hour'
         or (jsonb_typeof(p_requires->'before_hour') = 'number'
             and (p_requires->>'before_hour') ~ '^([1-9]|1[0-9]|2[0-4])$'));
$$;

revoke execute on function private.quest_requires_ok(jsonb) from public;

create table public.quest_templates (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,63}$'),
  period text not null check (period in ('day', 'week')),
  slot text not null,
  title text not null check (char_length(title) between 1 and 80),
  rule jsonb not null check (private.quest_rule_ok(rule)),
  target integer not null check (target between 1 and 100),
  -- only handed out when these hold (when the day or week starts for the user)
  requires jsonb not null default '{}' check (private.quest_requires_ok(requires)),
  reward_points integer not null check (reward_points between 0 and 1000),
  reward_freezes integer not null default 0 check (reward_freezes between 0 and 2),
  -- the chance within its slot, relative to the other active templates
  weight integer not null check (weight between 1 and 1000),
  active boolean not null default true,
  constraint quest_templates_slot check (
    (period = 'day' and slot in ('easy', 'medium', 'hard')) or (period = 'week' and slot = 'weekly')),
  constraint quest_templates_reward check (reward_points > 0 or reward_freezes > 0),
  constraint quest_templates_far_target check (rule->>'type' <> 'distinct_far_bins' or target <= 2)
);

comment on table public.quest_templates is
  'Quests: per day one per slot (easy, medium, hard) and one weekly challenge, a weighted pick per user (private.ensure_quests). Read through game_catalog().';

alter table public.quest_templates enable row level security;
revoke all on public.quest_templates from anon, authenticated;

-- Chapter 3. The bounty quests (phase 8) come with their rule type.
insert into public.quest_templates (key, period, slot, title, rule, target, requires, reward_points, weight) values
  ('checkin_any', 'day', 'easy', 'Doe een inworp',
   '{"type": "count", "of": "checkins"}', 1, '{}', 5, 3),
  ('bonus_answer', 'day', 'easy', 'Beantwoord een bonusvraag',
   '{"type": "count", "of": "bonus_answers"}', 1, '{}', 5, 2),
  ('revisit', 'day', 'easy', 'Gooi weg bij een vuilbak waar je al eens was',
   '{"type": "count", "of": "checkins", "revisit": true}', 1, '{}', 5, 2),
  ('new_bin', 'day', 'medium', 'Gooi iets weg bij een vuilbak die je nog niet ontdekte',
   '{"type": "count", "of": "checkins", "new": true}', 1, '{"undiscovered_bins": 1}', 10, 3),
  ('two_checkins', 'day', 'medium', 'Doe 2 inworpen',
   '{"type": "count", "of": "checkins"}', 2, '{}', 10, 2),
  ('before_ten', 'day', 'medium', 'Doe een inworp vóór 10 uur',
   '{"type": "count", "of": "checkins", "hour_before": 10}', 1, '{"before_hour": 10}', 10, 2),
  ('far_bins', 'day', 'hard', 'Doe 2 inworpen bij vuilbakken minstens 200 m uit elkaar',
   '{"type": "distinct_far_bins", "min_m": 200}', 2, '{}', 15, 3),
  ('report_bin', 'day', 'hard', 'Meld een ontbrekende vuilbak',
   '{"type": "count", "of": "reports"}', 1, '{}', 15, 1),
  ('week_days', 'week', 'weekly', 'Doe inworpen op 4 verschillende dagen',
   '{"type": "active_days"}', 4, '{}', 40, 2),
  ('week_discover', 'week', 'weekly', 'Ontdek 5 nieuwe vuilbakken',
   '{"type": "count", "of": "discoveries"}', 5, '{"undiscovered_bins": 5}', 40, 1),
  ('week_bonus', 'week', 'weekly', 'Beantwoord 5 bonusvragen',
   '{"type": "count", "of": "bonus_answers"}', 5, '{}', 40, 1);

create table public.chest_rewards (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,63}$'),
  kind text not null check (kind in ('points', 'freeze', 'avatar')),
  -- points or freezes; null for an avatar
  amount integer,
  avatar_key text references public.avatars (key) on update cascade,
  -- the chance relative to the other active rewards (0 = never)
  weight integer not null check (weight between 0 and 1000),
  sort integer not null,
  active boolean not null default true,
  constraint chest_rewards_kind check (
    case kind
      when 'points' then amount between 1 and 1000 and avatar_key is null
      when 'freeze' then amount between 1 and 2 and avatar_key is null
      else amount is null and avatar_key is not null
    end)
);

comment on table public.chest_rewards is
  'What the daily chest can hold and how likely (weights, shown in the app). Drawn once per chest by open_daily_chest.';

alter table public.chest_rewards enable row level security;
revoke all on public.chest_rewards from anon, authenticated;

-- Chapter 3: 5 pt (30), 10 pt (30), 15 pt (15), 25 pt (8), a freeze (8), an
-- avatar (4: Maan 3, Regenboog 1).
insert into public.chest_rewards (sort, key, kind, amount, avatar_key, weight) values
  (1, 'points_5', 'points', 5, null, 30),
  (2, 'points_10', 'points', 10, null, 30),
  (3, 'points_15', 'points', 15, null, 15),
  (4, 'points_25', 'points', 25, null, 8),
  (5, 'freeze', 'freeze', 1, null, 8),
  (6, 'avatar_maan', 'avatar', null, 'maan', 3),
  (7, 'avatar_regenboog', 'avatar', null, 'regenboog', 1);

-- ---------------------------------------------------------------------------
-- Game facts: user_quests, daily_chests, streak_freezes, user_avatars
-- ---------------------------------------------------------------------------

create table public.user_quests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  period text not null check (period in ('day', 'week')),
  -- the local day (Gent), or the Monday of the week
  period_start date not null,
  slot text not null,
  template_key text not null references public.quest_templates (key) on update cascade,
  -- frozen when handed out
  title text not null,
  rule jsonb not null,
  target integer not null check (target >= 1),
  reward_points integer not null check (reward_points >= 0),
  reward_freezes integer not null check (reward_freezes >= 0),
  -- over facts that were not rejected, and over approved facts (capped)
  progress integer not null default 0,
  progress_certain integer not null default 0,
  status text not null default 'open' check (status in ('open', 'pending', 'granted')),
  -- when it was completed (again): the moment
  completed_at timestamptz,
  -- the check-in that completed it (analysis); null for reports
  anchor_checkin_id uuid references public.checkins (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (user_id, period, period_start, slot),
  constraint user_quests_completed check ((status = 'open') = (completed_at is null)),
  constraint user_quests_week check (period = 'day' or extract(isodow from period_start) = 1)
);

comment on table public.user_quests is
  'Quests handed out to a user (3 per day, 1 per week), kept by private.refresh_game_state over the two certainties (open/pending/granted).';

create index user_quests_anchor_idx on public.user_quests (anchor_checkin_id) where anchor_checkin_id is not null;

create table public.daily_chests (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  day date not null,
  -- locked until every quest of the day is complete; opened once drawn
  status text not null default 'locked' check (status in ('locked', 'ready', 'opened')),
  -- when it became ready (again): the moment
  ready_at timestamptz,
  opened_at timestamptz,
  -- the draw: kept for good, also when the chest is locked again
  reward_key text references public.chest_rewards (key) on update cascade,
  reward_kind text check (reward_kind in ('points', 'freeze', 'avatar')),
  reward_amount integer,
  reward_avatar_key text references public.avatars (key) on update cascade,
  reward_status text check (reward_status in ('pending', 'granted', 'revoked')),
  unique (user_id, day),
  constraint daily_chests_ready check ((status = 'locked') = (ready_at is null)),
  constraint daily_chests_opened check ((status = 'opened' and opened_at is not null)
                                        or (status = 'ready' and opened_at is null)
                                        or status = 'locked'),
  constraint daily_chests_reward check ((opened_at is null) = (reward_key is null)
                                        and (opened_at is null) = (reward_kind is null)
                                        and (opened_at is null) = (reward_status is null))
);

comment on table public.daily_chests is
  'One chest per user and day with quests; open_daily_chest draws its reward once, the refresh keeps the status of that reward.';

create table public.streak_freezes (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  source text not null check (source in ('milestone', 'quest', 'chest')),
  -- the reward and a number: 'milestone:50:1', 'quest:<id>:1', 'chest:<id>:1'
  source_key text not null,
  status text not null check (status in ('pending', 'available', 'revoked')),
  earned_at timestamptz not null,
  revoked_at timestamptz,
  revoke_reason text check (revoke_reason in ('source_lost', 'freezes_full')),
  unique (user_id, source_key),
  constraint streak_freezes_revoked check ((status = 'revoked') = (revoked_at is not null)
                                           and (status = 'revoked') = (revoke_reason is not null))
);

comment on table public.streak_freezes is
  'Streak freezes a user earned (pending/available/revoked). Their use is derived by private.streak_walk, not stored.';

create table public.user_avatars (
  user_id uuid not null references public.profiles (id) on delete cascade,
  avatar_key text not null references public.avatars (key) on update cascade,
  -- the reward that unlocked it: 'chest:<id>'
  source_key text not null,
  status text not null check (status in ('pending', 'granted', 'revoked')),
  earned_at timestamptz not null,
  granted_at timestamptz,
  primary key (user_id, source_key),
  constraint user_avatars_granted_at check ((status = 'granted') = (granted_at is not null))
);

comment on table public.user_avatars is
  'Avatars unlocked by a reward (the daily chest). Unlocks by default, level, milestone, badge and quest are computed.';

-- Users read their own rows, admins all; only the functions write.
alter table public.user_quests enable row level security;
revoke all on public.user_quests from anon, authenticated;
grant select on public.user_quests to authenticated;
create policy "user_quests: read own, admins read all"
  on public.user_quests for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

alter table public.daily_chests enable row level security;
revoke all on public.daily_chests from anon, authenticated;
grant select on public.daily_chests to authenticated;
create policy "daily_chests: read own, admins read all"
  on public.daily_chests for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

alter table public.streak_freezes enable row level security;
revoke all on public.streak_freezes from anon, authenticated;
grant select on public.streak_freezes to authenticated;
create policy "streak_freezes: read own, admins read all"
  on public.streak_freezes for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

alter table public.user_avatars enable row level security;
revoke all on public.user_avatars from anon, authenticated;
grant select on public.user_avatars to authenticated;
create policy "user_avatars: read own, admins read all"
  on public.user_avatars for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

-- ---------------------------------------------------------------------------
-- Handing out quests
-- ---------------------------------------------------------------------------

-- Hands out the quests of p_day (one per slot) and of its week, and the chest
-- of that day, when they are not there yet. The pick per slot is weighted
-- over the active templates whose conditions hold now, rolled with
-- hashtextextended(user, day, slot): the same user and day get the same
-- quests. Returns the number of rows added.
create function private.ensure_quests(p_user uuid, p_day date)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  week constant date := p_day - (extract(isodow from p_day)::integer - 1);
  undiscovered integer;
  hour integer;
  n integer;
  added integer := 0;
begin
  if p_user is null or p_day is null then
    return 0;
  end if;
  if exists (select 1 from public.user_quests q
             where q.user_id = p_user and q.period = 'day' and q.period_start = p_day)
     and exists (select 1 from public.user_quests q
                 where q.user_id = p_user and q.period = 'week' and q.period_start = week)
     and exists (select 1 from public.daily_chests c where c.user_id = p_user and c.day = p_day) then
    return 0;
  end if;

  select count(*) filter (where c.status is null) into undiscovered from private.collection(p_user) c;
  -- before_hour only holds for today, before that hour (earlier days: always)
  hour := case when p_day = (now() at time zone 'Europe/Brussels')::date
               then extract(hour from now() at time zone 'Europe/Brussels')::integer
               else -1 end;

  with slots (period, period_start, slot) as (
    values ('day', p_day, 'easy'), ('day', p_day, 'medium'), ('day', p_day, 'hard'), ('week', week, 'weekly')
  ),
  eligible as (
    select s.period, s.period_start, s.slot, t.key, t.title, t.rule, t.target, t.reward_points, t.reward_freezes,
           sum(t.weight) over (partition by s.slot order by t.key) as upto,
           sum(t.weight) over (partition by s.slot) as total
    from slots s
    join public.quest_templates t on t.period = s.period and t.slot = s.slot and t.active
    where coalesce((t.requires->>'undiscovered_bins')::integer, 0) <= undiscovered
      and (not t.requires ? 'before_hour' or hour < (t.requires->>'before_hour')::integer)
      and not exists (select 1 from public.user_quests q
                      where q.user_id = p_user and q.period = s.period and q.period_start = s.period_start
                        and q.slot = s.slot)
  ),
  picked as (
    select distinct on (e.slot) e.*
    from eligible e
    where e.upto > (((hashtextextended(p_user::text || ':' || e.period_start::text || ':' || e.slot, 0)
                      % e.total) + e.total) % e.total)
    order by e.slot, e.upto
  )
  insert into public.user_quests (user_id, period, period_start, slot, template_key, title, rule, target,
                                  reward_points, reward_freezes)
  select p_user, p.period, p.period_start, p.slot, p.key, p.title, p.rule, p.target, p.reward_points,
         p.reward_freezes
  from picked p
  on conflict (user_id, period, period_start, slot) do nothing;
  get diagnostics n = row_count;
  added := added + n;

  if exists (select 1 from public.user_quests q
             where q.user_id = p_user and q.period = 'day' and q.period_start = p_day) then
    insert into public.daily_chests (user_id, day) values (p_user, p_day)
    on conflict (user_id, day) do nothing;
    get diagnostics n = row_count;
    added := added + n;
  end if;

  return added;
end;
$$;

revoke execute on function private.ensure_quests(uuid, date) from public;

-- A quest rule for a user in [p_from, p_to): the value over facts that were
-- not rejected (provisional), over approved facts (certain), and the check-in
-- that reached p_target. Test check-ins never count. Unknown types: 0.
create function private.quest_progress(p_user uuid, p_rule jsonb, p_target integer, p_from timestamptz,
                                       p_to timestamptz)
returns table (provisional integer, certain integer, anchor uuid)
language plpgsql
stable
set search_path = ''
as $$
declare
  hour_from constant integer := (p_rule->>'hour_from')::integer;
  hour_before constant integer := (p_rule->>'hour_before')::integer;
  only_new constant boolean := coalesce(p_rule->'new' = 'true'::jsonb, false);
  revisit constant boolean := coalesce(p_rule->'revisit' = 'true'::jsonb, false);
  min_m constant double precision := (p_rule->>'min_m')::double precision;
begin
  if p_rule->>'type' = 'count' and p_rule->>'of' = 'checkins' then
    -- new: the check-in is the discovery of its bin; revisit: an earlier one
    -- at that bin (approved, for the certain count)
    select count(*) filter (where x.prov), count(*) filter (where x.cert),
           (array_agg(x.id order by x.created_at, x.id) filter (where x.prov))[p_target]
      into provisional, certain, anchor
    from (
      select c.id, c.created_at,
             c.status <> 'rejected'
               and (not only_new or exists (
                 select 1 from public.discoveries d
                 where d.user_id = p_user and d.bin_id = c.bin_id and d.checkin_id = c.id and d.status <> 'revoked'))
               and (not revisit or exists (
                 select 1 from public.checkins e
                 where e.user_id = p_user and e.bin_id = c.bin_id and not e.is_test and e.status <> 'rejected'
                   and e.created_at < c.created_at)) as prov,
             c.status = 'approved'
               and (not only_new or exists (
                 select 1 from public.discoveries d
                 where d.user_id = p_user and d.bin_id = c.bin_id and d.checkin_id = c.id and d.status <> 'revoked'))
               and (not revisit or exists (
                 select 1 from public.checkins e
                 where e.user_id = p_user and e.bin_id = c.bin_id and not e.is_test and e.status = 'approved'
                   and e.created_at < c.created_at)) as cert
      from public.checkins c
      where c.user_id = p_user and not c.is_test and c.created_at >= p_from and c.created_at < p_to
        and private.in_local_hours(c.created_at, hour_from, hour_before)
    ) x;

  elsif p_rule->>'type' = 'count' and p_rule->>'of' = 'discoveries' then
    select count(*) filter (where d.status <> 'revoked'), count(*) filter (where d.status = 'confirmed'),
           (array_agg(d.checkin_id order by d.discovered_at, d.bin_id) filter (where d.status <> 'revoked'))[p_target]
      into provisional, certain, anchor
    from public.discoveries d
    where d.user_id = p_user and d.discovered_at >= p_from and d.discovered_at < p_to;

  elsif p_rule->>'type' = 'count' and p_rule->>'of' = 'bonus_answers' then
    select count(*) filter (where c.status <> 'rejected'), count(*) filter (where c.status = 'approved'),
           (array_agg(c.id order by b.answered_at, c.id) filter (where c.status <> 'rejected'))[p_target]
      into provisional, certain, anchor
    from public.bonus_answers b
    join public.checkins c on c.id = b.checkin_id
    where b.user_id = p_user and not b.is_test and not c.is_test
      and b.answered_at >= p_from and b.answered_at < p_to;

  elsif p_rule->>'type' = 'count' and p_rule->>'of' = 'reports' then
    select count(*) filter (where r.status <> 'rejected'), count(*) filter (where r.status = 'approved')
      into provisional, certain
    from public.bin_reports r
    where r.user_id = p_user and r.created_at >= p_from and r.created_at < p_to;

  elsif p_rule->>'type' = 'distinct_far_bins' then
    -- 2 when two check-ins are at bins at least min_m apart, 1 with one
    with w as (
      select c.id, c.created_at, c.status = 'approved' as ok, b.geom
      from public.checkins c
      join public.bins b on b.id = c.bin_id
      where c.user_id = p_user and not c.is_test and c.status <> 'rejected'
        and c.created_at >= p_from and c.created_at < p_to
    )
    select case when exists (select 1 from w a join w z on extensions.st_distance(a.geom, z.geom) >= min_m) then 2
                when exists (select 1 from w) then 1 else 0 end,
           case when exists (select 1 from w a join w z on a.ok and z.ok
                             and extensions.st_distance(a.geom, z.geom) >= min_m) then 2
                when exists (select 1 from w where w.ok) then 1 else 0 end,
           case when p_target = 1 then (select w.id from w order by w.created_at, w.id limit 1)
                else (select z.id from w a join w z on z.created_at > a.created_at
                                                    and extensions.st_distance(a.geom, z.geom) >= min_m
                      order by z.created_at, z.id limit 1) end
      into provisional, certain, anchor;

  elsif p_rule->>'type' = 'active_days' then
    select count(*) filter (where g.prov), count(*) filter (where g.cert),
           (array_agg(g.first_id order by g.d) filter (where g.prov))[p_target]
      into provisional, certain, anchor
    from (
      select (c.created_at at time zone 'Europe/Brussels')::date as d,
             bool_or(c.status <> 'rejected') as prov,
             bool_or(c.status = 'approved') as cert,
             (array_agg(c.id order by c.created_at, c.id) filter (where c.status <> 'rejected'))[1] as first_id
      from public.checkins c
      where c.user_id = p_user and not c.is_test and c.created_at >= p_from and c.created_at < p_to
      group by 1
    ) g;

  else
    provisional := 0;
    certain := 0;
  end if;

  return next;
end;
$$;

revoke execute on function private.quest_progress(uuid, jsonb, integer, timestamptz, timestamptz) from public;

-- One quest as the app sees it.
create function private.quest_json(q public.user_quests)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', q.id, 'period', q.period, 'period_start', q.period_start, 'slot', q.slot,
    'template_key', q.template_key, 'title', q.title, 'progress', q.progress,
    'progress_certain', q.progress_certain, 'target', q.target, 'reward', q.reward_points,
    'freezes', q.reward_freezes, 'status', q.status, 'completed_at', q.completed_at);
$$;

revoke execute on function private.quest_json(public.user_quests) from public;

-- One chest as the app sees it: its quests done and the reward once drawn.
create function private.chest_json(c public.daily_chests)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', c.id, 'day', c.day, 'status', c.status,
    'quests_done', (select count(*) from public.user_quests q
                    where q.user_id = c.user_id and q.period = 'day' and q.period_start = c.day
                      and q.status <> 'open'),
    'quests_total', (select count(*) from public.user_quests q
                     where q.user_id = c.user_id and q.period = 'day' and q.period_start = c.day),
    'reward', case when c.opened_at is not null then
                jsonb_build_object('key', c.reward_key, 'kind', c.reward_kind, 'amount', c.reward_amount,
                                   'avatar_key', c.reward_avatar_key, 'status', c.reward_status) end);
$$;

revoke execute on function private.chest_json(public.daily_chests) from public;

-- ---------------------------------------------------------------------------
-- Streaks with freezes
-- ---------------------------------------------------------------------------

-- Walks the weeks (Gent) of a user's check-ins up to p_as_of: check-ins that
-- were not rejected or (p_approved_only) approved ones, test check-ins only
-- with p_include_test; freezes earned before p_as_of that are not revoked or
-- (p_approved_only) available. A gap of k complete weeks after an active week
-- is bridged when at least k freezes earned before the gap are left (then k
-- are used), else the streak starts again; a bridged week does not count.
-- Returns the streak alive at p_as_of (this week's, or last week's while this
-- week has none, or bridged up to last week), the longest run, the last active
-- week, the freezes used and held, and the bridged weeks of the live streak.
create function private.streak_walk(p_user uuid, p_include_test boolean, p_approved_only boolean,
                                    p_as_of timestamptz)
returns table (weeks integer, longest integer, last_active date, used integer, held integer, frozen date[])
language plpgsql
stable
set search_path = ''
as $$
declare
  cur constant date := date_trunc('week', p_as_of at time zone 'Europe/Brussels')::date;
  earned timestamptz[];
  wk date;
  prev date;
  run integer := 0;
  gap integer;
  pool integer;
  run_frozen date[] := '{}';
begin
  weeks := 0;
  longest := 0;
  used := 0;

  select coalesce(array_agg(f.earned_at order by f.earned_at), '{}') into earned
  from public.streak_freezes f
  where f.user_id = p_user and f.earned_at < p_as_of
    and case when p_approved_only then f.status = 'available' else f.status <> 'revoked' end;

  for wk in
    select distinct date_trunc('week', c.created_at at time zone 'Europe/Brussels')::date
    from public.checkins c
    where c.user_id = p_user and (p_include_test or not c.is_test) and c.created_at <= p_as_of
      and case when p_approved_only then c.status = 'approved' else c.status <> 'rejected' end
    order by 1
  loop
    if prev is null then
      run := 1;
    else
      gap := (wk - prev) / 7 - 1;
      if gap = 0 then
        run := run + 1;
      else
        select count(*)::integer - used into pool
        from unnest(earned) e
        where e < ((prev + 7)::timestamp at time zone 'Europe/Brussels');
        if pool >= gap then
          used := used + gap;
          run_frozen := run_frozen || array(select prev + 7 * i from generate_series(1, gap) i);
          run := run + 1;
        else
          run := 1;
          run_frozen := '{}';
        end if;
      end if;
    end if;
    longest := greatest(longest, run);
    prev := wk;
  end loop;

  last_active := prev;
  if prev is not null then
    -- complete weeks without a check-in after the last active one
    gap := (cur - prev) / 7 - 1;
    if gap <= 0 then
      weeks := run;
    else
      select count(*)::integer - used into pool
      from unnest(earned) e
      where e < ((prev + 7)::timestamp at time zone 'Europe/Brussels');
      if pool >= gap then
        used := used + gap;
        run_frozen := run_frozen || array(select prev + 7 * i from generate_series(1, gap) i);
        weeks := run;
      end if;
    end if;
  end if;

  frozen := case when weeks > 0 then run_frozen else '{}' end;
  held := cardinality(earned) - used;
  return next;
end;
$$;

revoke execute on function private.streak_walk(uuid, boolean, boolean, timestamptz) from public;

-- streak_weeks from 20261014210000_dev_mode.sql: the same (consecutive weeks
-- ending at the active week p_week), now with freezes bridging gaps. Security
-- definer, so the service role can call it (it has no rights on private).
create or replace function public.streak_weeks(p_user_id uuid, p_week date, p_include_test boolean default false)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select case when w.last_active = p_week then w.weeks else 0 end
  from private.streak_walk(p_user_id, p_include_test, false,
                           least(clock_timestamp(), ((p_week + 7)::timestamp at time zone 'Europe/Brussels')
                                        - interval '1 microsecond')) w;
$$;

-- my_streak from 20261014210000_dev_mode.sql: the live streak (this week's,
-- else last week's, or bridged by freezes) and whether this week counts.
create or replace function public.my_streak()
returns table (weeks integer, this_week boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select w.weeks,
         coalesce(w.last_active = date_trunc('week', now() at time zone 'Europe/Brussels')::date, false)
  from private.streak_walk(auth.uid(), false, false, clock_timestamp()) w;
$$;

-- longest_streak from 20261019180000_progression.sql: with freezes.
create or replace function private.longest_streak(p_user uuid, p_approved_only boolean)
returns integer
language sql
stable
set search_path = ''
as $$
  select w.longest from private.streak_walk(p_user, false, p_approved_only, clock_timestamp()) w;
$$;

create or replace function private.longest_streak(p_user uuid)
returns integer
language sql
stable
set search_path = ''
as $$
  select private.longest_streak(p_user, false);
$$;

-- ---------------------------------------------------------------------------
-- Badges: Questheld
-- ---------------------------------------------------------------------------

-- badge_rule_ok from 20261019180000_progression.sql, plus count of quests.
create or replace function private.badge_rule_ok(p_rule jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p_rule) = 'object' and coalesce(
    case p_rule->>'type'
      when 'count' then
        p_rule->>'of' in ('checkins', 'discoveries', 'bonus_answers', 'reports', 'quests')
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

-- badge_progress from 20261019180000_progression.sql, plus count of quests:
-- completed (pending or granted) and granted.
create or replace function private.badge_progress(p_user uuid, p_rule jsonb)
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

  elsif p_rule->>'type' = 'count' and p_rule->>'of' = 'quests' then
    select count(*) filter (where q.status <> 'open'),
           count(*) filter (where q.status = 'granted'),
           (array_agg(q.anchor_checkin_id order by q.completed_at, q.id)
              filter (where q.status <> 'open'))[(p_rule->>'target')::integer]
      into provisional, certain, anchor
    from public.user_quests q
    where q.user_id = p_user;

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

update public.badges set sort = 12 where key = 'whole_neighbourhood';

insert into public.badges (sort, key, name, description, symbol, rarity, rule, secret) values
  (11, 'quest_hero', 'Questheld', 'Voltooi 30 quests.', 'flag.checkered', 'epic',
   '{"type": "count", "of": "quests", "target": 30}', false);

-- ---------------------------------------------------------------------------
-- Unlocks by quest and chest
-- ---------------------------------------------------------------------------

-- avatar_hint from 20261019180000_progression.sql: a quest avatar names its
-- quest.
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
    when 'quest' then coalesce((select 'Voltooi de quest "' || t.title || '"'
                                from public.quest_templates t where t.key = p_param),
                               'Voltooi een speciale quest')
    when 'chest' then 'Alleen te vinden in de dagkist'
  end;
$$;

-- avatar_states from 20261019180000_progression.sql: a quest avatar follows
-- the best quest of its template, a chest avatar the best chest that gave it
-- (granted = unlocked, pending = pending).
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
           when 'quest' then
             coalesce((select case when bool_or(q.status = 'granted') then 'unlocked'
                                   when bool_or(q.status = 'pending') then 'pending' end
                       from public.user_quests q
                       where q.user_id = p_user and q.template_key = a.unlock_param), 'locked')
           when 'chest' then
             coalesce((select case when bool_or(ua.status = 'granted') then 'unlocked'
                                   when bool_or(ua.status = 'pending') then 'pending' end
                       from public.user_avatars ua
                       where ua.user_id = p_user and ua.avatar_key = a.key), 'locked')
           else 'locked'
         end
  from public.avatars a
  left join lv on true
  where a.active;
$$;

-- ---------------------------------------------------------------------------
-- The refresh adds quests, chests and freezes
-- ---------------------------------------------------------------------------

drop function private.refresh_game_state(uuid);

-- refresh_game_state from 20261019180000_progression.sql: the same, plus
-- (after the milestones) today's quests handed out, the quests and chests
-- since p_since (at most 14 days back by default) with their ledger rows,
-- chest avatars and freezes, before the badges (Questheld, streaks) and the
-- worn avatar.
create function private.refresh_game_state(p_user uuid, p_since date default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  today constant date := (now() at time zone 'Europe/Brussels')::date;
  changed integer := 0;
  n integer;
  provisional integer;
  certain integer;
  stamp timestamptz;
  v_since date;
  max_freezes integer;
  fz record;
  prior public.streak_freezes;
  new_status text;
  reason text;
begin
  if p_user is null then
    return 0;
  end if;
  -- Callers hold it already (a no-op then); others get the lock order right.
  perform pg_advisory_xact_lock(hashtextextended('checkins:' || p_user::text, 0));
  stamp := clock_timestamp();
  v_since := least(coalesce(p_since, today - 14), today - 14);

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

  -- Today's quests (and this week's challenge) are handed out when missing.
  changed := changed + private.ensure_quests(p_user, today);

  -- Quests since v_since over the two certainties: granted when the certain
  -- progress reaches the target, pending when the provisional one does, else
  -- open again. completed_at is the moment (again after being open).
  with prog as (
    select q.id, q.target, least(p.provisional, q.target) as prov, least(p.certain, q.target) as cert, p.anchor
    from public.user_quests q
    cross join lateral private.quest_progress(
      p_user, q.rule, q.target,
      q.period_start::timestamp at time zone 'Europe/Brussels',
      (q.period_start + case when q.period = 'week' then 7 else 1 end)::timestamp at time zone 'Europe/Brussels') p
    where q.user_id = p_user and q.period_start + case when q.period = 'week' then 6 else 0 end >= v_since
  ),
  target as (
    select pr.id, pr.prov, pr.cert, pr.anchor,
           case when pr.cert >= pr.target then 'granted' when pr.prov >= pr.target then 'pending' else 'open' end
             as status
    from prog pr
  )
  update public.user_quests q
     set progress = t.prov,
         progress_certain = t.cert,
         status = t.status,
         completed_at = case when t.status = 'open' then null when q.status = 'open' then now() else q.completed_at end,
         anchor_checkin_id = case when t.status = 'open' then q.anchor_checkin_id else t.anchor end
    from target t
   where q.id = t.id
     and (q.progress, q.progress_certain, q.status, q.anchor_checkin_id)
         is distinct from (t.prov, t.cert, t.status,
                           case when t.status = 'open' then q.anchor_checkin_id else t.anchor end);
  get diagnostics n = row_count;
  changed := changed + n;

  -- Their ledger rows: quest (or weekly), the frozen reward; open = revoked.
  insert into public.point_transactions as t
    (user_id, is_test, source, reward_key, amount, status, anchor_checkin_id, earned_at,
     granted_at, revoked_at, revoke_reason, details)
  select q.user_id, false, case q.period when 'week' then 'weekly' else 'quest' end, 'quest:' || q.id,
         q.reward_points, q.status, q.anchor_checkin_id, q.completed_at,
         case when q.status = 'granted' then stamp end, null, null,
         jsonb_build_object('template', q.template_key, 'period_start', q.period_start)
  from public.user_quests q
  where q.user_id = p_user and q.reward_points > 0 and q.status <> 'open'
    and q.period_start + case when q.period = 'week' then 6 else 0 end >= v_since
  on conflict (user_id, is_test, reward_key) do nothing;
  get diagnostics n = row_count;
  changed := changed + n;

  update public.point_transactions t
     set status = x.status,
         anchor_checkin_id = x.anchor,
         earned_at = coalesce(x.completed_at, t.earned_at),
         granted_at = case x.status
                        when 'granted' then coalesce(case when t.status = 'granted' then t.granted_at end, stamp)
                        when 'revoked' then t.granted_at
                      end,
         revoked_at = case when x.status = 'revoked'
                           then coalesce(case when t.status = 'revoked' then t.revoked_at end, stamp) end,
         revoke_reason = case when x.status = 'revoked' then 'quest_lost' end
    from (
      select 'quest:' || q.id as reward_key,
             case q.status when 'open' then 'revoked' else q.status end as status,
             q.anchor_checkin_id as anchor, q.completed_at
      from public.user_quests q
      where q.user_id = p_user and q.reward_points > 0
        and q.period_start + case when q.period = 'week' then 6 else 0 end >= v_since
    ) x
   where t.user_id = p_user and not t.is_test and t.reward_key = x.reward_key
     and (t.status, t.anchor_checkin_id, t.earned_at)
         is distinct from (x.status, x.anchor, coalesce(x.completed_at, t.earned_at));
  get diagnostics n = row_count;
  changed := changed + n;

  -- Chests since v_since: ready when every quest of the day is complete
  -- (opened once drawn), else locked; the drawn reward is granted when all
  -- are granted, pending while complete, revoked when not.
  with q as (
    select q.period_start as day, count(*) as total,
           count(*) filter (where q.status <> 'open') as done,
           count(*) filter (where q.status = 'granted') as sure
    from public.user_quests q
    where q.user_id = p_user and q.period = 'day' and q.period_start >= v_since
    group by q.period_start
  ),
  target as (
    select c.id, coalesce(q.total > 0 and q.done = q.total, false) as complete,
           coalesce(q.total > 0 and q.sure = q.total, false) as sure
    from public.daily_chests c
    left join q on q.day = c.day
    where c.user_id = p_user and c.day >= v_since
  ),
  wanted as (
    select t.id,
           case when not t.complete then 'locked' when c.opened_at is not null then 'opened' else 'ready' end as status,
           case when not t.complete then null else coalesce(c.ready_at, now()) end as ready_at,
           case when c.opened_at is null then null
                when t.sure then 'granted' when t.complete then 'pending' else 'revoked' end as reward_status
    from target t
    join public.daily_chests c on c.id = t.id
  )
  update public.daily_chests c
     set status = x.status, ready_at = x.ready_at, reward_status = x.reward_status
    from wanted x
   where c.id = x.id
     and (c.status, c.ready_at, c.reward_status) is distinct from (x.status, x.ready_at, x.reward_status);
  get diagnostics n = row_count;
  changed := changed + n;

  -- A chest with points: ledger row chest:<id> (anchor: the check-in that
  -- completed the last quest of that day).
  insert into public.point_transactions as t
    (user_id, is_test, source, reward_key, amount, status, anchor_checkin_id, earned_at,
     granted_at, revoked_at, revoke_reason, details)
  select c.user_id, false, 'chest', 'chest:' || c.id, c.reward_amount, c.reward_status,
         (select q.anchor_checkin_id from public.user_quests q
          where q.user_id = p_user and q.period = 'day' and q.period_start = c.day and q.status <> 'open'
          order by q.completed_at desc, q.id limit 1),
         c.opened_at,
         case when c.reward_status = 'granted' then stamp end,
         case when c.reward_status = 'revoked' then stamp end,
         case when c.reward_status = 'revoked' then 'chest_lost' end,
         jsonb_build_object('day', c.day, 'reward', c.reward_key)
  from public.daily_chests c
  where c.user_id = p_user and c.day >= v_since and c.reward_kind = 'points'
  on conflict (user_id, is_test, reward_key) do update
    set status = excluded.status,
        anchor_checkin_id = case when excluded.status = 'revoked' then t.anchor_checkin_id
                                 else excluded.anchor_checkin_id end,
        granted_at = case excluded.status
                       when 'granted' then coalesce(case when t.status = 'granted' then t.granted_at end, stamp)
                       when 'revoked' then t.granted_at
                     end,
        revoked_at = case when excluded.status = 'revoked'
                          then coalesce(case when t.status = 'revoked' then t.revoked_at end, stamp) end,
        revoke_reason = excluded.revoke_reason
    where t.status is distinct from excluded.status
       or (excluded.status <> 'revoked' and t.anchor_checkin_id is distinct from excluded.anchor_checkin_id);
  get diagnostics n = row_count;
  changed := changed + n;

  -- A chest with an avatar: user_avatars follows the reward.
  insert into public.user_avatars as ua (user_id, avatar_key, source_key, status, earned_at, granted_at)
  select c.user_id, c.reward_avatar_key, 'chest:' || c.id, c.reward_status, c.opened_at,
         case when c.reward_status = 'granted' then stamp end
  from public.daily_chests c
  where c.user_id = p_user and c.day >= v_since and c.reward_kind = 'avatar'
  on conflict (user_id, source_key) do update
    set status = excluded.status,
        granted_at = case when excluded.status = 'granted' then coalesce(ua.granted_at, stamp) end
    where ua.status is distinct from excluded.status;
  get diagnostics n = row_count;
  changed := changed + n;

  -- Freezes, oldest first: lost with their source, lost when max_freezes were
  -- in hand when earned (held: private.streak_walk at that time, over the
  -- freezes before it), else available (source granted) or pending.
  max_freezes := (private.cfg('max_freezes'))::integer;
  for fz in
    select x.source, x.source_key, x.src_status,
           coalesce(x.earned_at, (select s.earned_at from public.streak_freezes s
                                  where s.user_id = p_user and s.source_key = x.source_key)) as earned_at
    from (
      select 'milestone' as source, 'milestone:' || um.threshold || ':' || i as source_key,
             um.status as src_status, um.reached_at as earned_at
      from public.user_milestones um
      join public.milestones m on m.threshold = um.threshold and m.freezes > 0
      cross join generate_series(1, m.freezes) i
      where um.user_id = p_user
      union all
      select 'quest', 'quest:' || q.id || ':' || i, case q.status when 'open' then 'revoked' else q.status end,
             q.completed_at
      from public.user_quests q
      cross join generate_series(1, q.reward_freezes) i
      where q.user_id = p_user and q.reward_freezes > 0
      union all
      select 'chest', 'chest:' || c.id || ':' || i, c.reward_status, c.opened_at
      from public.daily_chests c
      cross join generate_series(1, c.reward_amount) i
      where c.user_id = p_user and c.reward_kind = 'freeze'
    ) x
    order by 4, 2
  loop
    continue when fz.earned_at is null;
    select * into prior from public.streak_freezes s where s.user_id = p_user and s.source_key = fz.source_key;
    reason := null;
    if fz.src_status = 'revoked' then
      new_status := 'revoked';
      reason := 'source_lost';
    elsif (select count(*) from public.streak_freezes s
           where s.user_id = p_user and s.status <> 'revoked' and s.earned_at < fz.earned_at
             and s.source_key <> fz.source_key) >= max_freezes
          and (select w.held from private.streak_walk(p_user, false, false, fz.earned_at) w) >= max_freezes then
      new_status := 'revoked';
      reason := 'freezes_full';
    else
      new_status := case fz.src_status when 'granted' then 'available' else 'pending' end;
    end if;

    if prior.id is null then
      continue when reason = 'source_lost';
      insert into public.streak_freezes (user_id, source, source_key, status, earned_at, revoked_at, revoke_reason)
      values (p_user, fz.source, fz.source_key, new_status, fz.earned_at,
              case when new_status = 'revoked' then stamp end, reason);
      changed := changed + 1;
    elsif (prior.status, prior.earned_at, prior.revoke_reason) is distinct from (new_status, fz.earned_at, reason) then
      update public.streak_freezes s
         set status = new_status,
             earned_at = fz.earned_at,
             revoked_at = case when new_status = 'revoked'
                               then coalesce(case when prior.status = 'revoked' then prior.revoked_at end, stamp) end,
             revoke_reason = reason
       where s.id = prior.id;
      changed := changed + 1;
    end if;
  end loop;

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
  -- unlocked (a lower level after a rejection, a revoked milestone, badge or
  -- chest).
  changed := changed + private.refresh_avatar(p_user);

  return changed;
end;
$$;

revoke execute on function private.refresh_game_state(uuid, date) from public;

-- refresh_game_state_safely from 20261015180000_discoveries.sql: a review or
-- revocation of an older check-in also recomputes the quests and chests since
-- its day.
create or replace function private.refresh_game_state_safely(p_user uuid, p_context text, p_checkin uuid default null)
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
  perform private.refresh_game_state(
    p_user, (select (c.created_at at time zone 'Europe/Brussels')::date from public.checkins c where c.id = p_checkin));
  return true;
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_detail = pg_exception_detail;
  insert into private.game_errors (user_id, context, checkin_id, sqlstate, message, detail)
  values (p_user, p_context, p_checkin, v_state, left(v_message, 1000), left(v_detail, 1000));
  return false;
end;
$$;

-- repair_game_state from 20261015180000_discoveries.sql: everything, also
-- quests and chests older than 14 days.
create or replace function public.repair_game_state(user_id uuid)
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
  return private.refresh_game_state(repair_game_state.user_id, '-infinity'::date);
end;
$$;

-- ---------------------------------------------------------------------------
-- Moments, the answer of record_checkin, results
-- ---------------------------------------------------------------------------

-- moments_since from 20261019180000_progression.sql, plus completed quests,
-- a chest that became ready (and is not opened yet) and freezes (not those
-- from the chest). Order: time, then discovery, milestone, quest, chest,
-- badge, freeze.
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
           0 as sort, 0 as sub
    from counted c
    where c.discovered_at > p_since
    union all
    select 'milestone', m.reached_at,
           jsonb_build_object('threshold', m.threshold, 'points', m.points, 'status', m.status),
           1, 0
    from public.user_milestones m
    where m.user_id = p_user and m.status <> 'revoked' and m.reached_at > p_since
    union all
    select 'quest', q.completed_at,
           jsonb_build_object('id', q.id, 'period', q.period, 'slot', q.slot, 'title', q.title,
                              'reward', q.reward_points, 'freezes', q.reward_freezes, 'status', q.status),
           2, array_position(array['easy', 'medium', 'hard', 'weekly'], q.slot)
    from public.user_quests q
    where q.user_id = p_user and q.status <> 'open' and q.completed_at > p_since
    union all
    select 'chest', c.ready_at, jsonb_build_object('day', c.day),
           3, 0
    from public.daily_chests c
    where c.user_id = p_user and c.status = 'ready' and c.ready_at > p_since
    union all
    select 'badge', ub.earned_at,
           private.badge_json(b, true) - 'sort' - 'secret' || jsonb_build_object('status', ub.status),
           4, 0
    from public.user_badges ub
    join public.badges b on b.key = ub.badge_key
    where ub.user_id = p_user and ub.status <> 'revoked' and ub.earned_at > p_since
    union all
    select 'freeze', f.earned_at, jsonb_build_object('source', f.source, 'status', f.status),
           5, f.id::integer
    from public.streak_freezes f
    where f.user_id = p_user and f.status <> 'revoked' and f.source <> 'chest' and f.earned_at > p_since
  ) x
  order by x.at, x.sort, x.sub, x.details->>'bin_id', x.details->>'threshold', x.details->>'key';
$$;

-- checkin_game from 20261019180000_progression.sql, plus today's quests and
-- this week's challenge (with completed_now), today's chest (with ready_now)
-- and the freezes earned in this transaction.
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
  ),
  days as (
    select (now() at time zone 'Europe/Brussels')::date as today,
           date_trunc('week', now() at time zone 'Europe/Brussels')::date as week
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
    'quests', (
      select coalesce(jsonb_agg(private.quest_json(q)
                                || jsonb_build_object('completed_now', coalesce(q.completed_at = now(), false))
                                order by array_position(array['easy', 'medium', 'hard', 'weekly'], q.slot)),
                      '[]'::jsonb)
      from public.user_quests q, days
      where q.user_id = p_user
        and ((q.period = 'day' and q.period_start = days.today) or (q.period = 'week' and q.period_start = days.week))),
    'chest', (
      select private.chest_json(c) || jsonb_build_object('ready_now', coalesce(c.ready_at = now(), false))
      from public.daily_chests c, days
      where c.user_id = p_user and c.day = days.today),
    'freezes', (
      select coalesce(jsonb_agg(jsonb_build_object('source', f.source, 'status', f.status) order by f.id), '[]'::jsonb)
      from public.streak_freezes f
      where f.user_id = p_user and f.status <> 'revoked' and f.earned_at = now()),
    'as_of', now());
$$;

-- results_since from 20261019180000_progression.sql: avatars unlocked by a
-- granted quest or chest count too.
create or replace function private.results_since(p_user uuid, p_since timestamptz, p_as_of timestamptz)
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
      when 'quest' then exists (
        select 1 from public.user_quests q
        join public.point_transactions t on t.user_id = p_user and not t.is_test and t.reward_key = 'quest:' || q.id
        where q.user_id = p_user and q.template_key = a.unlock_param
          and t.status = 'granted' and t.granted_at > p_since and t.granted_at <= p_as_of)
      when 'chest' then exists (
        select 1 from public.user_avatars ua
        where ua.user_id = p_user and ua.avatar_key = a.key and ua.status = 'granted'
          and ua.granted_at > p_since and ua.granted_at <= p_as_of)
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

-- ---------------------------------------------------------------------------
-- For the app
-- ---------------------------------------------------------------------------

-- my_game_state() from 20261019120000_identity.sql, v2: hands out today's
-- quests first (volatile; a refresh when it did, so today's facts count),
-- and adds to the streak the freezes (held, the maximum, the bridged weeks of
-- the live streak) and the days of this week (approved, pending or none), and
-- today's date, the quests, the weekly challenge (with its last day), today's
-- chest, the days with a ready chest that can still be opened, and the
-- pending real check-ins.
create or replace function public.my_game_state()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  uid constant uuid := auth.uid();
  today constant date := (now() at time zone 'Europe/Brussels')::date;
  week constant date := date_trunc('week', now() at time zone 'Europe/Brussels')::date;
  discovered integer;
  confirmed integer;
  total integer;
  seen timestamptz;
  granted integer;
  walk record;
begin
  if uid is null then
    raise exception 'sign in to see your game' using errcode = '42501';
  end if;

  if private.ensure_quests(uid, today) > 0 then
    perform private.refresh_game_state_safely(uid, 'my_game_state', null);
  end if;

  select count(*) filter (where d.status <> 'revoked'), count(*) filter (where d.status = 'confirmed')
    into discovered, confirmed
  from public.discoveries d
  where d.user_id = uid;
  select count(*) into total from private.collection(uid);
  select p.moments_seen_at, p.points into seen, granted from public.profiles p where p.id = uid;
  select * into walk from private.streak_walk(uid, false, false, clock_timestamp());

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
    'streak', jsonb_build_object(
      'weeks', walk.weeks,
      'this_week', coalesce(walk.last_active = week, false),
      'freezes', walk.held,
      'max_freezes', (private.cfg('max_freezes'))::integer,
      'frozen_weeks', to_jsonb(walk.frozen),
      'week_start', week,
      'days', (
        select jsonb_agg(jsonb_build_object(
                 'date', g.d,
                 'state', coalesce((
                   select case when bool_or(c.status = 'approved') then 'approved' else 'pending' end
                   from public.checkins c
                   where c.user_id = uid and not c.is_test and c.status <> 'rejected'
                     and c.created_at >= g.d::timestamp at time zone 'Europe/Brussels'
                     and c.created_at < (g.d + 1)::timestamp at time zone 'Europe/Brussels'
                   having count(*) > 0), 'none'))
               order by g.d)
        from (select week + i as d from generate_series(0, 6) i) g)),
    'today', today,
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
      'longest_streak', walk.longest),
    'quests', (
      select coalesce(jsonb_agg(private.quest_json(q)
                                order by array_position(array['easy', 'medium', 'hard'], q.slot)), '[]'::jsonb)
      from public.user_quests q
      where q.user_id = uid and q.period = 'day' and q.period_start = today),
    'weekly', (
      select private.quest_json(q) || jsonb_build_object('ends_on', q.period_start + 6)
      from public.user_quests q
      where q.user_id = uid and q.period = 'week' and q.period_start = week),
    'chest', (
      select private.chest_json(c)
      from public.daily_chests c
      where c.user_id = uid and c.day = today),
    'chests_ready', (
      select coalesce(jsonb_agg(c.day order by c.day desc), '[]'::jsonb)
      from public.daily_chests c
      where c.user_id = uid and c.status = 'ready'
        and c.day > today - (private.cfg('chest_open_days'))::integer),
    'pending_checkins', (select count(*) from public.checkins c
                         where c.user_id = uid and not c.is_test and c.status = 'pending'),
    'unseen_moments', (select count(*) from private.moments_since(uid, seen)),
    'as_of', now());
end;
$$;

-- Opens the caller's chest of `day` (today or up to chest_open_days - 1 days
-- back) once it is ready: draws one reward from the active chest rewards by
-- weight (no freeze with max_freezes in hand, no avatar the caller already
-- has or that is not active), keeps it, and returns {day, reward {key, kind,
-- amount, avatar_key, status}, already_opened, as_of}. Opening it again
-- returns the same reward. The reward follows the quests of that day.
create function public.open_daily_chest(day date)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  uid constant uuid := auth.uid();
  today constant date := (now() at time zone 'Europe/Brussels')::date;
  chest public.daily_chests;
  prize public.chest_rewards;
  held integer;
  sure boolean;
  already boolean;
begin
  if uid is null then
    raise exception 'sign in to open a chest' using errcode = '42501';
  end if;
  if open_daily_chest.day is null or open_daily_chest.day > today
     or open_daily_chest.day <= today - (private.cfg('chest_open_days'))::integer then
    raise exception 'the chest of % cannot be opened (any more)', open_daily_chest.day using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('checkins:' || uid::text, 0));
  select * into chest from public.daily_chests c where c.user_id = uid and c.day = open_daily_chest.day for update;
  if not found or chest.status = 'locked' then
    raise exception 'the chest of % is not ready', open_daily_chest.day using errcode = '55000';
  end if;

  already := chest.status = 'opened';
  if not already then
    select w.held into held from private.streak_walk(uid, false, false, clock_timestamp()) w;
    -- one roll (a CTE with random() is evaluated once) over the cumulative
    -- weights of what may be drawn
    with choice as (
      select r.key, sum(r.weight) over (order by r.sort, r.key) as upto, sum(r.weight) over () as total
      from public.chest_rewards r
      left join public.avatars a on a.key = r.avatar_key
      where r.active and r.weight > 0
        and (r.kind <> 'freeze' or held + r.amount <= (private.cfg('max_freezes'))::integer)
        and (r.kind <> 'avatar'
             or (a.active and not exists (select 1 from private.avatar_states(uid) s
                                          where s.key = r.avatar_key and s.status <> 'locked')))
    ),
    roll as (
      select floor(random() * max(c.total))::bigint as v from choice c
    )
    select r.* into prize
    from choice c
    join roll on c.upto > roll.v
    join public.chest_rewards r on r.key = c.key
    order by c.upto
    limit 1;
    if prize.key is null then
      raise exception 'the chest has nothing to give' using errcode = 'P0001';
    end if;

    select coalesce(bool_and(q.status = 'granted'), false) into sure
    from public.user_quests q
    where q.user_id = uid and q.period = 'day' and q.period_start = chest.day;

    update public.daily_chests c
       set status = 'opened', opened_at = now(),
           reward_key = prize.key, reward_kind = prize.kind, reward_amount = prize.amount,
           reward_avatar_key = prize.avatar_key,
           reward_status = case when sure then 'granted' else 'pending' end
     where c.id = chest.id;

    -- the ledger row, the freeze or the avatar
    perform private.refresh_game_state_safely(uid, 'open_daily_chest', null);
    select * into chest from public.daily_chests c where c.id = chest.id;
  end if;

  return jsonb_build_object(
    'day', chest.day,
    'reward', jsonb_build_object('key', chest.reward_key, 'kind', chest.reward_kind, 'amount', chest.reward_amount,
                                 'avatar_key', chest.reward_avatar_key, 'status', chest.reward_status),
    'already_opened', already,
    'as_of', now());
end;
$$;

revoke execute on function public.open_daily_chest(date) from public, anon;
grant execute on function public.open_daily_chest(date) to authenticated;

-- game_catalog() from 20261019180000_progression.sql, plus the freezes of the
-- milestones, the active quest templates and the chest rewards with their
-- weights (the chances in the app).
create or replace function public.game_catalog()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'config', (select coalesce(jsonb_object_agg(c.key, c.value), '{}'::jsonb) from public.game_config c),
    'milestones', (select coalesce(jsonb_agg(jsonb_build_object('threshold', m.threshold, 'points', m.points,
                                                                'freezes', m.freezes)
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
               where b.active),
    'quests', (select coalesce(jsonb_agg(jsonb_build_object(
                                 'key', t.key, 'period', t.period, 'slot', t.slot, 'title', t.title,
                                 'target', t.target, 'reward_points', t.reward_points,
                                 'reward_freezes', t.reward_freezes)
                               order by t.period, array_position(array['easy', 'medium', 'hard', 'weekly'], t.slot),
                                        t.key), '[]'::jsonb)
               from public.quest_templates t
               where t.active),
    'chest_rewards', (select coalesce(jsonb_agg(jsonb_build_object(
                                        'key', r.key, 'kind', r.kind, 'amount', r.amount,
                                        'avatar_key', r.avatar_key, 'weight', r.weight)
                                      order by r.sort, r.key), '[]'::jsonb)
                      from public.chest_rewards r
                      where r.active and r.weight > 0));
$$;

-- ---------------------------------------------------------------------------
-- Events
-- ---------------------------------------------------------------------------

insert into public.event_names (name, description) values
  ('quest_viewed', 'The quests on Today came into view.'),
  ('quest_completed', 'A completed quest was shown (after a check-in or as a missed moment).'),
  ('chest_opened', 'A daily chest was opened.'),
  ('tip_shown', 'A one-time explanation (streak, quests, chest) was shown on Today.');

notify pgrst, 'reload schema';
