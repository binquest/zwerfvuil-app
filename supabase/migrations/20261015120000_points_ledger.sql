-- Points ledger (docs/GAMIFICATION.md, 2.2 and phase 1a).
--
-- Every point is a row in point_transactions with a source and a status
-- (pending -> granted, or revoked). profiles.points and profiles.test_points
-- follow from the ledger: a trigger adds the difference of each row's granted
-- amount, nobody writes them directly any more.
--
--   - A trigger on checkins projects each check-in onto its rows (source
--     'checkin' = points_earned, 'bonus' = bonus_points): pending check-ins
--     give pending rows, approved ones granted rows, rejected or revoked ones
--     revoked rows. Every path keeps them in sync: record_checkin, reviews,
--     the bonus answer, revocations, and inserts in tests or Studio.
--   - private.check_points_invariant() lists profiles that differ from their
--     ledger; the tests call it.
--   - checkins.points_awarded was a second bookkeeping and is dropped: the
--     points of a check-in are its granted rows.
--   - The old check points >= 0 is dropped: the ledger is the truth, and a
--     revocation must never fail.
--
-- The existing points move into the ledger in this migration: snapshot,
-- projection of every check-in, an 'adjustment' (with a warning) for any
-- difference, and the migration fails unless every profile ends up equal to
-- its snapshot and to its ledger.
--
-- Lock order everywhere (2.9): first the advisory lock of the user
-- ('checkins:' || user_id, as in record_checkin), then rows (for update).

-- The one function the API roles could still execute (a trigger function;
-- triggers do not need the privilege). 00_schema_guard checks that no
-- function is executable by public or anon.
revoke execute on function public.set_updated_at() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Check-ins: review reason and revocation
-- ---------------------------------------------------------------------------

alter table public.checkins
  add column review_reason text check (char_length(review_reason) between 1 and 200),
  add column revoked_at timestamptz,
  add column revoked_by uuid references public.profiles (id) on delete set null,
  add constraint checkins_reason_only_when_rejected check (review_reason is null or status = 'rejected'),
  add constraint checkins_revoked_only_when_rejected check (revoked_at is null or status = 'rejected'),
  add constraint checkins_revoked_by_needs_revoked_at check (revoked_by is null or revoked_at is not null);

comment on column public.checkins.review_reason is
  'Why the check-in was rejected or revoked (optional for a rejection, required for a revocation).';
comment on column public.checkins.revoked_at is
  'Set when an admin revoked an approved check-in: status is then rejected, reviewed_at/reviewed_by keep the approval.';

create index checkins_approved_reviewed_idx on public.checkins (reviewed_at desc) where status = 'approved';

-- ---------------------------------------------------------------------------
-- The ledger
-- ---------------------------------------------------------------------------

create table public.point_transactions (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  is_test boolean not null default false,
  source text not null check (source in
    ('checkin', 'bonus', 'discovery', 'bounty', 'milestone', 'quest', 'weekly', 'chest', 'adjustment')),
  -- stable key of the reward: 'checkin:<id>', 'milestone:20', 'adjustment:<uuid>', ...
  reward_key text not null check (char_length(reward_key) between 1 and 200),
  -- frozen when the reward is created
  amount integer not null check (amount <> 0),
  status text not null default 'pending' check (status in ('pending', 'granted', 'revoked')),
  -- rewards that depend on one check-in only (checkin, bonus, discovery, bounty)
  checkin_id uuid references public.checkins (id) on delete cascade,
  -- milestones, quests, chests, badges, weekly challenges: the check-in that
  -- made them happen (analysis only, their status follows from counts)
  anchor_checkin_id uuid references public.checkins (id) on delete set null,
  -- when the action happened (weekly leaderboard)
  earned_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  granted_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text check (char_length(revoke_reason) between 1 and 200),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  constraint point_transactions_reward_key unique (user_id, is_test, reward_key),
  constraint point_transactions_checkin_sources check (
    (source in ('checkin', 'bonus', 'discovery', 'bounty')) = (checkin_id is not null)
  ),
  -- revoked rows keep granted_at when they were granted before
  constraint point_transactions_status_times check (
    case status
      when 'pending' then granted_at is null and revoked_at is null
      when 'granted' then granted_at is not null and revoked_at is null
      else revoked_at is not null
    end
  ),
  constraint point_transactions_reason_only_when_revoked check (revoke_reason is null or status = 'revoked')
);

comment on table public.point_transactions is
  'Every point is a row here; profiles.points and test_points are the sums of the granted rows (kept by a trigger). See docs/GAMIFICATION.md 2.2.';

create index point_transactions_checkin_idx on public.point_transactions (checkin_id) where checkin_id is not null;
create index point_transactions_anchor_idx on public.point_transactions (anchor_checkin_id)
  where anchor_checkin_id is not null;
create index point_transactions_user_status_idx on public.point_transactions (user_id, status);
create index point_transactions_granted_earned_idx on public.point_transactions (earned_at) where status = 'granted';

-- Users read their own rows, admins all; nobody writes them except the
-- functions below.
alter table public.point_transactions enable row level security;
revoke all on public.point_transactions from anon, authenticated;
grant select on public.point_transactions to authenticated;

create policy "point_transactions: read own, admins read all"
  on public.point_transactions for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

-- ---------------------------------------------------------------------------
-- Profile points follow the ledger
-- ---------------------------------------------------------------------------

-- Adds the change of a row's granted amount to its profile. A delta instead
-- of a new sum: a sum loses updates when two writers run at the same time.
create function private.apply_points_delta()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  old_real integer := 0;
  old_test integer := 0;
  new_real integer := 0;
  new_test integer := 0;
begin
  if tg_op = 'UPDATE' and new.user_id <> old.user_id then
    raise exception 'a point transaction cannot move to another user' using errcode = '55000';
  end if;
  if tg_op in ('UPDATE', 'DELETE') and old.status = 'granted' then
    if old.is_test then old_test := old.amount; else old_real := old.amount; end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.status = 'granted' then
    if new.is_test then new_test := new.amount; else new_real := new.amount; end if;
  end if;

  if new_real <> old_real or new_test <> old_test then
    update public.profiles p
       set points = p.points + (new_real - old_real),
           test_points = p.test_points + (new_test - old_test)
     where p.id = case when tg_op = 'DELETE' then old.user_id else new.user_id end;
  end if;
  return null;
end;
$$;

revoke execute on function private.apply_points_delta() from public;

create trigger point_transactions_apply_delta
  after insert or update or delete on public.point_transactions
  for each row execute function private.apply_points_delta();

-- Profiles whose points differ from their ledger. Empty when all is well.
create function private.check_points_invariant()
returns table (user_id uuid, points integer, ledger_points bigint, test_points integer, ledger_test_points bigint)
language sql
stable
set search_path = ''
as $$
  select p.id, p.points, coalesce(l.real_pts, 0), p.test_points, coalesce(l.test_pts, 0)
  from public.profiles p
  left join (
    select t.user_id,
           sum(t.amount) filter (where not t.is_test) as real_pts,
           sum(t.amount) filter (where t.is_test) as test_pts
    from public.point_transactions t
    where t.status = 'granted'
    group by t.user_id
  ) l on l.user_id = p.id
  where p.points <> coalesce(l.real_pts, 0) or p.test_points <> coalesce(l.test_pts, 0);
$$;

revoke execute on function private.check_points_invariant() from public;

-- ---------------------------------------------------------------------------
-- Projection of a check-in onto its ledger rows
-- ---------------------------------------------------------------------------

-- Keeps the rows of one check-in equal to its status and frozen points. Takes
-- no locks (the caller holds the check-in row) and never changes checkins.
create function private.sync_checkin_ledger(c public.checkins)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target text := case c.status when 'approved' then 'granted' when 'rejected' then 'revoked' else 'pending' end;
  why text := case when c.revoked_at is not null then 'checkin_revoked' else 'checkin_rejected' end;
  part record;
  existing public.point_transactions;
begin
  for part in
    select v.source, v.amount from (values ('checkin', c.points_earned), ('bonus', c.bonus_points)) as v(source, amount)
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

revoke execute on function private.sync_checkin_ledger(public.checkins) from public;

create function private.checkins_sync_ledger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.sync_checkin_ledger(new);
  return null;
end;
$$;

revoke execute on function private.checkins_sync_ledger() from public;

create trigger checkins_sync_ledger
  after insert or update of status, points_earned, bonus_points, is_test, revoked_at on public.checkins
  for each row execute function private.checkins_sync_ledger();

-- ---------------------------------------------------------------------------
-- Move the existing points into the ledger
-- ---------------------------------------------------------------------------

alter table public.profiles drop constraint profiles_points_check;
alter table public.profiles drop constraint profiles_test_points_check;

comment on column public.profiles.points is
  'Sum of the granted, real rows in point_transactions (kept by a trigger; use adjust_points for corrections).';
comment on column public.profiles.test_points is
  'Sum of the granted test rows in point_transactions (Dev mode), kept apart from points.';

-- Builds the ledger from the check-ins of a database whose profile points
-- are the truth (the snapshot). Only for an empty ledger; returns the number
-- of adjustments. Kept as a function so 08_points_ledger can run it on a
-- fixture; it needs the profile guard below to be absent or disabled.
create function private.migrate_points_to_ledger()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  diff record;
  adjustments integer := 0;
begin
  if exists (select 1 from public.point_transactions) then
    raise exception 'points ledger: the ledger is not empty' using errcode = '55000';
  end if;

  create temp table points_snapshot on commit drop as
    select p.id, p.points, p.test_points from public.profiles p;

  -- Rebuild the profile points from the ledger alone.
  update public.profiles p set points = 0, test_points = 0 where p.points <> 0 or p.test_points <> 0;
  perform private.sync_checkin_ledger(c) from public.checkins c order by c.created_at;

  -- Differences with the snapshot (e.g. an edit in Studio) become an adjustment.
  for diff in
    select s.id, d.is_test, d.amount
    from points_snapshot s
    join public.profiles p on p.id = s.id
    cross join lateral (values (false, s.points - p.points), (true, s.test_points - p.test_points)) as d(is_test, amount)
    where d.amount <> 0
  loop
    insert into public.point_transactions
      (user_id, is_test, source, reward_key, amount, status, granted_at, details)
    values
      (diff.id, diff.is_test, 'adjustment', 'adjustment:migration', diff.amount, 'granted', now(),
       jsonb_build_object('reason', 'migratie'));
    adjustments := adjustments + 1;
    raise warning 'points ledger: adjustment of % % point(s) for profile %',
      diff.amount, case when diff.is_test then 'test' else 'real' end, diff.id;
  end loop;

  -- Every profile equals its snapshot and its ledger, or it fails.
  if exists (select 1 from private.check_points_invariant()) then
    raise exception 'points ledger: profiles differ from their ledger after the migration';
  end if;
  if exists (
    select 1 from points_snapshot s join public.profiles p on p.id = s.id
    where (p.points, p.test_points) is distinct from (s.points, s.test_points)
  ) then
    raise exception 'points ledger: profiles differ from their snapshot after the migration';
  end if;

  drop table points_snapshot;
  raise notice 'points ledger: % row(s), % adjustment(s)',
    (select count(*) from public.point_transactions), adjustments;
  return adjustments;
end;
$$;

revoke execute on function private.migrate_points_to_ledger() from public;

do $$
declare
  mismatches integer;
begin
  -- Every approved check-in should have awarded its own points; a difference
  -- shows up as an adjustment below.
  select count(*) into mismatches
  from public.checkins c
  where c.status = 'approved' and c.points_awarded <> c.points_earned + c.bonus_points;
  if mismatches > 0 then
    raise warning 'points ledger: % approved check-in(s) with points_awarded <> points_earned + bonus_points', mismatches;
  end if;

  perform private.migrate_points_to_ledger();
end;
$$;

-- The column and its check go; the ledger has the points of each check-in.
alter table public.checkins drop column points_awarded;

-- From here on only the ledger trigger changes profile points.
create function private.guard_profile_points()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.points <> 0 or new.test_points <> 0 then
      raise exception 'new profiles start with 0 points' using errcode = '42501';
    end if;
  -- pg_trigger_depth() is 1 for a direct update and at least 2 when the
  -- update comes from private.apply_points_delta.
  elsif pg_trigger_depth() < 2
        and (new.points, new.test_points) is distinct from (old.points, old.test_points) then
    raise exception 'points follow point_transactions; use adjust_points for corrections' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke execute on function private.guard_profile_points() from public;

create trigger profiles_points_follow_ledger
  before insert or update of points, test_points on public.profiles
  for each row execute function private.guard_profile_points();

-- ---------------------------------------------------------------------------
-- record_checkin: unchanged rules, now security definer (only the service
-- role may call it, and later phases call functions in schema private,
-- which the service role cannot reach).
-- ---------------------------------------------------------------------------

alter function public.record_checkin(uuid, uuid, bigint, double precision, double precision, real, boolean, boolean, text)
  security definer;

-- ---------------------------------------------------------------------------
-- Moderation: review with an optional reason, revoke, adjust
-- ---------------------------------------------------------------------------

-- Recreated instead of overloaded: PostgREST cannot choose between overloads.
drop function public.review_checkin(uuid, boolean);

-- Approves or rejects a pending check-in; reason is optional and only for a
-- rejection. The ledger follows through the projection trigger.
create function public.review_checkin(id uuid, approve boolean, reason text default null)
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

  return checkin;
end;
$$;

revoke execute on function public.review_checkin(uuid, boolean, text) from public, anon;
grant execute on function public.review_checkin(uuid, boolean, text) to authenticated, service_role;

-- Rejects an approved check-in after all: its points (and the bonus) are
-- revoked through the projection. The reason is required.
create function public.revoke_checkin(id uuid, reason text)
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

  return checkin;
end;
$$;

revoke execute on function public.revoke_checkin(uuid, text) from public, anon;
grant execute on function public.revoke_checkin(uuid, text) to authenticated, service_role;

-- A granted correction of a user's real points (positive or negative).
create function public.adjust_points(user_id uuid, amount integer, reason text)
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

  return row_;
end;
$$;

revoke execute on function public.adjust_points(uuid, integer, text) from public, anon;
grant execute on function public.adjust_points(uuid, integer, text) to authenticated;

-- Admin list of approved check-ins (newest decision first), for revoking.
-- Runs with the caller's rights: only admins read other users' rows.
create function public.approved_checkins(max_rows integer default 50)
returns table (
  id uuid,
  created_at timestamptz,
  reviewed_at timestamptz,
  user_id uuid,
  display_name text,
  bin_id bigint,
  distance_m real,
  accuracy_m real,
  is_mocked boolean,
  is_fake_location boolean,
  photo_path text,
  streak_weeks integer,
  points integer,
  is_test boolean
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'only admins can list approved check-ins' using errcode = '42501';
  end if;
  return query
    select c.id, c.created_at, c.reviewed_at, c.user_id, p.display_name, c.bin_id,
           c.distance_m, c.accuracy_m, c.is_mocked, c.is_fake_location, c.photo_path, c.streak_weeks,
           coalesce((select sum(t.amount) from public.point_transactions t
                      where t.checkin_id = c.id and t.status = 'granted'), 0)::integer,
           c.is_test
    from public.checkins c
    left join public.profiles p on p.id = c.user_id
    where c.status = 'approved'
    order by c.reviewed_at desc, c.id
    limit least(greatest(coalesce(approved_checkins.max_rows, 50), 1), 200);
end;
$$;

revoke execute on function public.approved_checkins(integer) from public, anon;
grant execute on function public.approved_checkins(integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Bonus answer: the user's lock first; points through the projection
-- ---------------------------------------------------------------------------

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
-- Dev mode reset: deleting the test check-ins removes their ledger rows, and
-- with them the test points.
-- ---------------------------------------------------------------------------

create or replace function public.reset_dev_test_data()
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

  perform pg_advisory_xact_lock(hashtextextended('checkins:' || auth.uid()::text, 0));

  with gone as (
    delete from public.checkins c
     where c.user_id = auth.uid() and c.is_test
    returning c.photo_path
  )
  select count(*)::integer, coalesce(array_agg(gone.photo_path), '{}') into removed, paths from gone;

  delete from public.point_transactions t where t.user_id = auth.uid() and t.is_test;
  delete from public.dev_settings s where s.user_id = auth.uid();

  insert into public.dev_audit_log (user_id, action, details, environment)
  values (auth.uid(), 'reset', jsonb_build_object('deleted_checkins', removed), public.app_environment());

  return query select removed, paths;
end;
$$;

-- ---------------------------------------------------------------------------
-- Leaderboard: 'week' = all granted points earned this week (check-ins and,
-- in later phases, quests and milestones); 'all' = profile points.
-- ---------------------------------------------------------------------------

create or replace function public.leaderboard(period text, max_rows integer default 50, include_test boolean default false)
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
    select r.place_, coalesce(r.name, 'Anoniem'), r.pts, r.user_id = auth.uid()
    from ranked r
    where r.rn <= least(greatest(coalesce(leaderboard.max_rows, 50), 1), 100) or r.user_id = auth.uid()
    order by r.rn;
end;
$$;

notify pgrst, 'reload schema';
