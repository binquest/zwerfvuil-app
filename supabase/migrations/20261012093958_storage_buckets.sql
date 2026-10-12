-- Private photo buckets. Object names start with the owner's user id:
--   checkin-photos/<user_id>/<checkin_id>.jpg  (written by the submit-checkin edge function)
--   report-photos/<user_id>/<uuid>.jpg         (uploaded by the app before creating a bin_report)

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('checkin-photos', 'checkin-photos', false, 5242880, array['image/jpeg']),
  ('report-photos', 'report-photos', false, 5242880, array['image/jpeg'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- checkin-photos: no insert/update/delete policies, only the service role writes.
create policy "checkin-photos: read own, admins read all"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'checkin-photos'
    and ((storage.foldername(name))[1] = (select auth.uid())::text or (select public.is_admin()))
  );

create policy "report-photos: upload to own folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'report-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "report-photos: read own, admins read all"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'report-photos'
    and ((storage.foldername(name))[1] = (select auth.uid())::text or (select public.is_admin()))
  );
