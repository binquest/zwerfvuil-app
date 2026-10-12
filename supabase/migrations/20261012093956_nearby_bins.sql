-- Active bins within radius_m metres of a point, nearest first.
-- Distances are computed on the WGS84 spheroid (geography).

create function public.nearby_bins(lat double precision, lon double precision, radius_m double precision)
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
           b.eligible,
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

revoke execute on function public.nearby_bins(double precision, double precision, double precision) from public, anon;
grant execute on function public.nearby_bins(double precision, double precision, double precision) to authenticated, service_role;
