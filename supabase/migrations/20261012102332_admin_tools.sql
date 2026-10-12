-- Admin tools for the app:
--   set_bin_eligibility(id, eligible)  exclude / re-admit a bin via eligible_override
--   pending_checkins()                 moderation queue with locations
--   pending_bin_reports()              moderation queue with locations and nearest bin

-- Sets the effective eligibility of a bin. The override is cleared when the
-- requested value equals the imported `eligible`, so a later change in OSM
-- tags is followed again; otherwise it is stored as eligible_override.
create function public.set_bin_eligibility(id bigint, eligible boolean)
returns table (bin_id bigint, eligible_override boolean, eligible_effective boolean)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'only admins can change bin eligibility' using errcode = '42501';
  end if;
  if set_bin_eligibility.eligible is null then
    raise exception 'eligible must be true or false' using errcode = '22023';
  end if;

  return query
    update public.bins b
       set eligible_override = case
             when b.eligible = set_bin_eligibility.eligible then null
             else set_bin_eligibility.eligible
           end
     where b.id = set_bin_eligibility.id
    returning b.id, b.eligible_override, b.eligible_effective;

  if not found then
    raise exception 'bin % not found', set_bin_eligibility.id using errcode = 'P0002';
  end if;
end;
$$;

revoke execute on function public.set_bin_eligibility(bigint, boolean) from public, anon;
grant execute on function public.set_bin_eligibility(bigint, boolean) to authenticated, service_role;

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
  photo_path text
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
           c.distance_m, c.accuracy_m, c.is_mocked, c.is_fake_location, c.photo_path
    from public.checkins c
    join public.bins b on b.id = c.bin_id
    left join public.profiles p on p.id = c.user_id
    where c.status = 'pending'
    order by c.created_at
    limit 200;
end;
$$;

revoke execute on function public.pending_checkins() from public, anon;
grant execute on function public.pending_checkins() to authenticated, service_role;

create function public.pending_bin_reports()
returns table (
  id uuid,
  created_at timestamptz,
  user_id uuid,
  display_name text,
  latitude double precision,
  longitude double precision,
  note text,
  photo_path text,
  nearest_bin_m double precision
)
language plpgsql
stable
set search_path = public, extensions, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'only admins can list pending reports' using errcode = '42501';
  end if;
  return query
    select r.id, r.created_at, r.user_id, p.display_name,
           st_y(r.geom::geometry), st_x(r.geom::geometry),
           r.note, r.photo_path,
           (select st_distance(b.geom, r.geom) from public.bins b
             where b.status = 'active' order by b.geom <-> r.geom limit 1)
    from public.bin_reports r
    left join public.profiles p on p.id = r.user_id
    where r.status = 'pending'
    order by r.created_at
    limit 200;
end;
$$;

revoke execute on function public.pending_bin_reports() from public, anon;
grant execute on function public.pending_bin_reports() to authenticated, service_role;
