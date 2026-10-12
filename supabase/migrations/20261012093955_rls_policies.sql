-- Row level security and table privileges.
--
-- Clients (anon/authenticated) never write check-ins or points directly:
-- check-ins are created by the submit-checkin edge function with the service
-- role, and moderation goes through admin-only security definer RPCs.
-- Signed-in users can read bins, read their own rows, edit their display name
-- and create their own (pending) bin reports.

create function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select p.is_admin from public.profiles p where p.id = (select auth.uid())),
    false
  );
$$;

revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated, service_role;

alter table public.bins enable row level security;
alter table public.profiles enable row level security;
alter table public.checkins enable row level security;
alter table public.bin_reports enable row level security;

-- Supabase grants everything on public tables to the API roles by default.
-- Start from nothing and grant only what the policies below need.
revoke all on public.bins, public.profiles, public.checkins, public.bin_reports
  from anon, authenticated;

grant select on public.bins to authenticated;
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;
grant select on public.checkins to authenticated;
grant select on public.bin_reports to authenticated;
grant insert (geom, photo_path, note) on public.bin_reports to authenticated;

-- bins -----------------------------------------------------------------------

create policy "bins: signed-in users read all"
  on public.bins for select to authenticated
  using (true);

-- profiles -------------------------------------------------------------------

create policy "profiles: read own, admins read all"
  on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select public.is_admin()));

create policy "profiles: update own"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- checkins -------------------------------------------------------------------

create policy "checkins: read own, admins read all"
  on public.checkins for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

-- bin_reports ----------------------------------------------------------------

create policy "bin_reports: read own, admins read all"
  on public.bin_reports for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

-- The photo must already be uploaded to the reporter's own folder.
create policy "bin_reports: create own pending report"
  on public.bin_reports for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and status = 'pending'
    and split_part(photo_path, '/', 1) = (select auth.uid())::text
    and exists (
      select 1 from storage.objects o
      where o.bucket_id = 'report-photos' and o.name = photo_path
    )
  );
