-- Daily limit of 10 bin reports per user, and local_day_start.
-- Run with: npm run db:test

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(10);

-- local_day_start: calendar days in Gent (CEST = UTC+2 until 25 Oct 2026, then CET = UTC+1).
select is(local_day_start('2026-10-12 21:30:00+00'), '2026-10-11 22:00:00+00'::timestamptz,
  'local_day_start: 23:30 in Gent belongs to the same day');
select is(local_day_start('2026-10-12 22:30:00+00'), '2026-10-12 22:00:00+00'::timestamptz,
  'local_day_start: 00:30 in Gent starts a new day');
select is(local_day_start('2026-12-01 23:30:00+00'), '2026-12-01 23:00:00+00'::timestamptz,
  'local_day_start follows winter time');

insert into auth.users (id, email, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.test', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.test', 'authenticated', 'authenticated');
insert into storage.objects (bucket_id, name) values
  ('report-photos', '11111111-1111-1111-1111-111111111111/p.jpg'),
  ('report-photos', '22222222-2222-2222-2222-222222222222/p.jpg');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

select lives_ok(
  $$ insert into bin_reports (geom, photo_path)
     select 'SRID=4326;POINT(0 0)', '11111111-1111-1111-1111-111111111111/p.jpg' from generate_series(1, 10) $$,
  'a user can file 10 reports in one day');
select throws_ok(
  $$ insert into bin_reports (geom, photo_path) values ('SRID=4326;POINT(0 0)', '11111111-1111-1111-1111-111111111111/p.jpg') $$,
  'P0001', 'bin_report_daily_limit', 'the 11th report of the day is refused');
select is((select count(*)::int from bin_reports), 10, 'the refused report was not stored');
reset role;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select throws_ok(
  $$ insert into bin_reports (geom, photo_path)
     select 'SRID=4326;POINT(0 0)', '22222222-2222-2222-2222-222222222222/p.jpg' from generate_series(1, 11) $$,
  'P0001', 'bin_report_daily_limit', 'the limit also holds within a single multi-row insert');
select lives_ok(
  $$ insert into bin_reports (geom, photo_path) values ('SRID=4326;POINT(0 0)', '22222222-2222-2222-2222-222222222222/p.jpg') $$,
  'the limit is per user: another user can still report');
reset role;

-- Move 3 of alice's reports to yesterday.
update bin_reports set created_at = local_day_start(now()) - interval '1 hour'
where id in (
  select id from bin_reports where user_id = '11111111-1111-1111-1111-111111111111' limit 3
);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select lives_ok(
  $$ insert into bin_reports (geom, photo_path)
     select 'SRID=4326;POINT(0 0)', '11111111-1111-1111-1111-111111111111/p.jpg' from generate_series(1, 3) $$,
  'reports from yesterday do not count towards today''s limit');
select throws_ok(
  $$ insert into bin_reports (geom, photo_path) values ('SRID=4326;POINT(0 0)', '11111111-1111-1111-1111-111111111111/p.jpg') $$,
  'P0001', 'bin_report_daily_limit', 'after that the limit applies again');
reset role;

select * from finish();
rollback;
