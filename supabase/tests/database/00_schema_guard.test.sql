-- Schema guard: what the API roles can reach. Fails when a new table, view or
-- function is exposed by accident. Run with: npm run db:test

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(8);

-- Tables, views and functions created by extensions (PostGIS, pgTAP) are not ours.
create function pg_temp.ours(cls regclass, oid oid) returns boolean language sql as $$
  select not exists (select 1 from pg_depend d where d.classid = cls and d.objid = oid and d.deptype = 'e');
$$;

select is_empty($$
  select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
    and pg_temp.ours('pg_class', c.oid)
$$, 'every table in public has row level security');

select is_empty($$
  select c.relname || ':' || p.priv
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) p(priv)
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm') and pg_temp.ours('pg_class', c.oid)
    and (has_table_privilege('anon', c.oid, p.priv)
         or (p.priv in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES') and has_any_column_privilege('anon', c.oid, p.priv)))
$$, 'anon has no privileges on any table or view in public');

select is_empty($$
  select c.relname || ':' || p.priv
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join (values ('DELETE'), ('TRUNCATE'), ('TRIGGER'), ('REFERENCES')) p(priv)
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm') and pg_temp.ours('pg_class', c.oid)
    and has_table_privilege('authenticated', c.oid, p.priv)
$$, 'signed-in users cannot delete, truncate, reference or add triggers anywhere in public');

select is(
  (select array_agg(c.relname || '.' || a.attname || ':' || p.priv order by c.relname, a.attname, p.priv)
   from pg_class c join pg_namespace n on n.oid = c.relnamespace
   join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
   cross join (values ('INSERT'), ('UPDATE')) p(priv)
   where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm') and pg_temp.ours('pg_class', c.oid)
     and has_column_privilege('authenticated', c.oid, a.attnum, p.priv)),
  array['bin_reports.geom:INSERT', 'bin_reports.note:INSERT', 'bin_reports.photo_path:INSERT'],
  'signed-in users write only these columns directly; everything else goes through functions');

select is_empty($$
  select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'v' and pg_temp.ours('pg_class', c.oid)
    and not coalesce('security_invoker=true' = any (c.reloptions), false)
$$, 'every view in public runs with the caller''s rights (security_invoker)');

select is_empty($$
  select p.oid::regprocedure::text
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private') and pg_temp.ours('pg_proc', p.oid)
    and (has_function_privilege('public', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))
$$, 'no function in public or private is executable by public or anon');

select is_empty($$
  select p.oid::regprocedure::text
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private' and pg_temp.ours('pg_proc', p.oid)
    and (has_function_privilege('authenticated', p.oid, 'execute')
         or has_function_privilege('service_role', p.oid, 'execute'))
$$, 'functions in private are internal: not executable by authenticated or the service role');

select is(
  (select array[has_schema_privilege('anon', 'private', 'usage'),
                has_schema_privilege('authenticated', 'private', 'usage'),
                has_schema_privilege('service_role', 'private', 'usage')]),
  array[false, false, false],
  'no API role can use schema private');

select * from finish();
rollback;
