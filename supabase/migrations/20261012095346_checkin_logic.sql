-- Check-in validation and moderation.
--
-- record_checkin is only callable by the service role, i.e. the submit-checkin
-- edge function. That function authenticates the user, checks GPS accuracy and
-- the mock flag, strips the photo and uploads it. record_checkin enforces the
-- rules that need the database, atomically:
--   bin exists, is active and eligible (eligible_effective)
--   distance to the bin <= 25 m (PostGIS, WGS84 spheroid)
--   max 1 check-in per bin per user per 10 minutes
--   max 20 check-ins per user per calendar day in Gent
-- Rejections are returned as a reason code instead of raised, so the edge
-- function can report details such as the distance.

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

revoke execute on function public.record_checkin(uuid, uuid, bigint, double precision, double precision, real, boolean, boolean, text)
  from public, anon, authenticated;
grant execute on function public.record_checkin(uuid, uuid, bigint, double precision, double precision, real, boolean, boolean, text)
  to service_role;

-- Admin moderation. Points are only awarded here, on approval.
create function public.review_checkin(id uuid, approve boolean)
returns public.checkins
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  points_per_checkin constant integer := 10;
  checkin public.checkins;
begin
  if not public.is_admin() then
    raise exception 'only admins can review check-ins' using errcode = '42501';
  end if;
  if approve is null then
    raise exception 'approve must be true or false' using errcode = '22023';
  end if;

  select * into checkin from public.checkins c where c.id = review_checkin.id for update;
  if not found then
    raise exception 'check-in % not found', review_checkin.id using errcode = 'P0002';
  end if;
  if checkin.status <> 'pending' then
    raise exception 'check-in % is already %', review_checkin.id, checkin.status using errcode = '55000';
  end if;

  update public.checkins c
     set status = case when approve then 'approved' else 'rejected' end,
         points_awarded = case when approve then points_per_checkin else 0 end,
         reviewed_at = now(),
         reviewed_by = auth.uid()
   where c.id = review_checkin.id
  returning * into checkin;

  if approve then
    update public.profiles p set points = p.points + points_per_checkin where p.id = checkin.user_id;
  end if;

  return checkin;
end;
$$;

revoke execute on function public.review_checkin(uuid, boolean) from public, anon;
grant execute on function public.review_checkin(uuid, boolean) to authenticated, service_role;
