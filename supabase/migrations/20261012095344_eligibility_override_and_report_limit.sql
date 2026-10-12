-- 1. Manual eligibility override for bins. The import only ever writes
--    `eligible`; admins set `eligible_override` (e.g. in Studio). Everything
--    that decides about points uses eligible_effective.
-- 2. Daily limit on bin reports (10 per user per calendar day in Gent).
-- 3. review_bin_report takes (id, approve), like review_checkin.

alter table public.bins
  add column eligible_override boolean,
  add column eligible_effective boolean
    generated always as (coalesce(eligible_override, eligible)) stored;

comment on column public.bins.eligible_override is
  'Manual eligibility set by an admin. Null follows eligible. Never written by the import.';
comment on column public.bins.eligible_effective is
  'coalesce(eligible_override, eligible): used by nearby_bins and check-ins.';

create or replace function public.nearby_bins(lat double precision, lon double precision, radius_m double precision)
returns table (
  id bigint,
  latitude double precision,
  longitude double precision,
  eligible boolean,
  source text,
  tags jsonb,
  distance_m double precision
)
language plpgsql
stable
set search_path = public, extensions, pg_temp
as $$
declare
  origin geography;
begin
  if lat is null or lon is null or lat not between -90 and 90 or lon not between -180 and 180 then
    raise exception 'invalid coordinates' using errcode = '22023';
  end if;
  if radius_m is null or radius_m <= 0 or radius_m > 5000 then
    raise exception 'radius_m must be between 0 and 5000' using errcode = '22023';
  end if;

  origin := st_setsrid(st_makepoint(lon, lat), 4326)::geography;

  return query
    select b.id,
           st_y(b.geom::geometry),
           st_x(b.geom::geometry),
           b.eligible_effective,
           b.source,
           b.tags,
           st_distance(b.geom, origin) as d
    from public.bins b
    where b.status = 'active'
      and st_dwithin(b.geom, origin, radius_m)
    order by d, b.id
    limit 1000;
end;
$$;

-- ---------------------------------------------------------------------------
-- Daily limits are per calendar day in Gent.
-- ---------------------------------------------------------------------------

create function public.local_day_start(ts timestamptz default now())
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select date_trunc('day', ts at time zone 'Europe/Brussels') at time zone 'Europe/Brussels';
$$;

revoke execute on function public.local_day_start(timestamptz) from public, anon;
grant execute on function public.local_day_start(timestamptz) to authenticated, service_role;

create function public.enforce_bin_report_daily_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  max_reports_per_day constant integer := 10;
  reports_today integer;
begin
  -- Serialise report inserts per user so parallel requests cannot exceed the limit.
  perform pg_advisory_xact_lock(hashtextextended('bin_reports:' || new.user_id::text, 0));

  select count(*) into reports_today
  from public.bin_reports r
  where r.user_id = new.user_id
    and r.created_at >= public.local_day_start(now());

  if reports_today >= max_reports_per_day then
    raise exception 'bin_report_daily_limit'
      using errcode = 'P0001',
            detail = format('At most %s bin reports per user per day.', max_reports_per_day);
  end if;
  return new;
end;
$$;

revoke execute on function public.enforce_bin_report_daily_limit() from public, anon, authenticated;

create trigger bin_reports_daily_limit
  before insert on public.bin_reports
  for each row execute function public.enforce_bin_report_daily_limit();

-- ---------------------------------------------------------------------------
-- review_bin_report(id, approve): same parameter names as review_checkin.
-- ---------------------------------------------------------------------------

drop function public.review_bin_report(uuid, boolean);

create function public.review_bin_report(id uuid, approve boolean)
returns public.bin_reports
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  report public.bin_reports;
  new_bin_id bigint;
begin
  if not public.is_admin() then
    raise exception 'only admins can review reports' using errcode = '42501';
  end if;
  if approve is null then
    raise exception 'approve must be true or false' using errcode = '22023';
  end if;

  select * into report from public.bin_reports r where r.id = review_bin_report.id for update;
  if not found then
    raise exception 'report % not found', review_bin_report.id using errcode = 'P0002';
  end if;
  if report.status <> 'pending' then
    raise exception 'report % is already %', review_bin_report.id, report.status using errcode = '55000';
  end if;

  if approve then
    insert into public.bins (geom, tags, source, status, eligible)
    values (report.geom, jsonb_build_object('amenity', 'waste_basket'), 'user', 'active', true)
    returning bins.id into new_bin_id;
  end if;

  update public.bin_reports r
     set status = case when approve then 'approved' else 'rejected' end,
         bin_id = new_bin_id,
         reviewed_at = now(),
         reviewed_by = auth.uid()
   where r.id = review_bin_report.id
  returning * into report;

  return report;
end;
$$;

revoke execute on function public.review_bin_report(uuid, boolean) from public, anon;
grant execute on function public.review_bin_report(uuid, boolean) to authenticated, service_role;
