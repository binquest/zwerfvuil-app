-- Core schema: bins (from OSM or user reports), profiles, check-ins and
-- user reports of missing bins.

create extension if not exists postgis with schema extensions;

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- bins
-- ---------------------------------------------------------------------------

create table public.bins (
  id bigint generated always as identity primary key,
  osm_type text check (osm_type in ('node', 'way', 'relation')),
  osm_id bigint,
  geom extensions.geography(Point, 4326) not null,
  tags jsonb not null default '{}'::jsonb,
  source text not null default 'osm' check (source in ('osm', 'user')),
  status text not null default 'active' check (status in ('active', 'pending', 'removed')),
  -- false for bins that must not earn points: sharps, dog waste, private access
  eligible boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bins_osm_key unique (osm_type, osm_id),
  constraint bins_osm_ref_matches_source check (
    (source = 'osm') = (osm_type is not null and osm_id is not null)
  )
);

comment on column public.bins.eligible is
  'Whether check-ins at this bin can earn points. Set by scripts/import-bins from the OSM tags.';

create index bins_geom_idx on public.bins using gist (geom);

create trigger bins_set_updated_at
  before update on public.bins
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- profiles (one per auth user, created by trigger)
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (char_length(display_name) between 1 and 50),
  points integer not null default 0 check (points >= 0),
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, nullif(left(split_part(coalesce(new.email, ''), '@', 1), 50), ''));
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- checkins (created only by the submit-checkin edge function)
-- ---------------------------------------------------------------------------

create table public.checkins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  bin_id bigint not null references public.bins (id),
  photo_path text not null,
  user_geom extensions.geography(Point, 4326) not null,
  accuracy_m real not null check (accuracy_m >= 0),
  distance_m real not null check (distance_m >= 0),
  is_mocked boolean not null default false,
  -- true when the dev-only ALLOW_FAKE_LOCATION escape accepted a chosen location
  is_fake_location boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  points_awarded integer not null default 0 check (points_awarded >= 0),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles (id) on delete set null,
  constraint checkins_points_only_when_approved check (status = 'approved' or points_awarded = 0),
  constraint checkins_reviewed_when_decided check ((status = 'pending') = (reviewed_at is null))
);

create index checkins_user_created_idx on public.checkins (user_id, created_at desc);
create index checkins_user_bin_created_idx on public.checkins (user_id, bin_id, created_at desc);
create index checkins_pending_idx on public.checkins (created_at) where status = 'pending';

-- ---------------------------------------------------------------------------
-- bin_reports (missing bins reported by users)
-- ---------------------------------------------------------------------------

create table public.bin_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  geom extensions.geography(Point, 4326) not null,
  photo_path text not null,
  note text check (char_length(note) <= 500),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  -- the bin created from this report once it is approved
  bin_id bigint references public.bins (id),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles (id) on delete set null,
  constraint bin_reports_reviewed_when_decided check ((status = 'pending') = (reviewed_at is null)),
  constraint bin_reports_bin_only_when_approved check (bin_id is null or status = 'approved')
);

create index bin_reports_user_created_idx on public.bin_reports (user_id, created_at desc);
create index bin_reports_pending_idx on public.bin_reports (created_at) where status = 'pending';
