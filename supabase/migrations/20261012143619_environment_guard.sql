-- Which environment this database belongs to: 'local' (a developer's Supabase
-- CLI stack), 'staging' (the homeserver VM, see docs/STAGING.md) or
-- 'production'. One row, written by supabase/seed.sql locally and by
-- infra/staging on the VM; no row means unknown.
--
-- - The scripts in scripts/ read it to refuse the wrong database, also when a
--   remote database is reached through an SSH tunnel on 127.0.0.1.
-- - record_checkin only accepts fake (map-picked) locations when it says
--   'local': a second line of defence after the submit-checkin edge function.
--
-- A table instead of a database setting (ALTER DATABASE ... SET app.x): only a
-- superuser may set custom settings, and seed.sql runs as postgres.

create schema if not exists private;
revoke all on schema private from public;

create table private.app_environment (
  singleton boolean primary key default true check (singleton),
  name text not null check (name in ('local', 'staging', 'production')),
  updated_at timestamptz not null default now()
);

create function public.app_environment()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select name from private.app_environment
$$;

revoke execute on function public.app_environment() from public, anon, authenticated;
grant execute on function public.app_environment() to service_role;

-- record_checkin from 20261012095346_checkin_logic.sql, plus the fake-location
-- check right after the coordinate check.
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
  retry_after_s integer
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
    return query select false, 'bin_not_found', null::uuid, null::double precision, null::integer;
    return;
  end if;
  if bin.status <> 'active' then
    return query select false, 'bin_inactive', null::uuid, null::double precision, null::integer;
    return;
  end if;
  if not bin.eligible_effective then
    return query select false, 'bin_not_eligible', null::uuid, null::double precision, null::integer;
    return;
  end if;

  dist := st_distance(bin.geom, st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography);
  if dist > max_distance_m then
    return query select false, 'too_far', null::uuid, dist, null::integer;
    return;
  end if;

  select max(c.created_at) into last_at
  from public.checkins c
  where c.user_id = p_user_id and c.bin_id = p_bin_id and c.created_at > now() - cooldown;
  if last_at is not null then
    return query select false, 'cooldown', null::uuid, dist,
      ceil(extract(epoch from last_at + cooldown - now()))::integer;
    return;
  end if;

  select count(*) into today
  from public.checkins c
  where c.user_id = p_user_id and c.created_at >= public.local_day_start(now());
  if today >= max_checkins_per_day then
    return query select false, 'daily_limit', null::uuid, dist,
      ceil(extract(epoch from public.local_day_start(now()) + interval '1 day' - now()))::integer;
    return;
  end if;

  insert into public.checkins
    (id, user_id, bin_id, photo_path, user_geom, accuracy_m, distance_m, is_mocked, is_fake_location)
  values
    (p_checkin_id, p_user_id, p_bin_id, p_photo_path,
     st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography,
     p_accuracy_m, dist, coalesce(p_is_mocked, false), coalesce(p_is_fake_location, false));

  return query select true, null::text, p_checkin_id, dist, null::integer;
end;
$$;
