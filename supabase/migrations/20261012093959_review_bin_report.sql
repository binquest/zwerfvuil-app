-- Admin moderation of user reports of missing bins. Approving a report adds
-- an active, user-sourced bin at the reported location.

create function public.review_bin_report(report_id uuid, approve boolean)
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

  select * into report from public.bin_reports r where r.id = report_id for update;
  if not found then
    raise exception 'report % not found', report_id using errcode = 'P0002';
  end if;
  if report.status <> 'pending' then
    raise exception 'report % is already %', report_id, report.status using errcode = '55000';
  end if;

  if approve then
    insert into public.bins (geom, tags, source, status, eligible)
    values (report.geom, jsonb_build_object('amenity', 'waste_basket'), 'user', 'active', true)
    returning id into new_bin_id;
  end if;

  update public.bin_reports r
     set status = case when approve then 'approved' else 'rejected' end,
         bin_id = new_bin_id,
         reviewed_at = now(),
         reviewed_by = auth.uid()
   where r.id = report_id
  returning * into report;

  return report;
end;
$$;

revoke execute on function public.review_bin_report(uuid, boolean) from public, anon;
grant execute on function public.review_bin_report(uuid, boolean) to authenticated, service_role;
