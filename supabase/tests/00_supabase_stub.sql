-- Minimal local stand-in for the Supabase platform objects that schema.sql
-- depends on. Test harness only; never run this on a real project.
create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb default '{}'::jsonb
);

-- Supabase derives auth.uid() from the JWT; locally we drive it from a GUC.
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

do $$ begin create role anon nologin;          exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin;  exception when duplicate_object then null; end $$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth   to anon, authenticated, service_role;
grant select on auth.users   to authenticated;

-- IMPORTANT: reproduce Supabase's default privileges. On a real project the
-- anon and authenticated roles hold full table grants in the public schema,
-- which is precisely why row-level security carries the whole security model.
-- Testing without these grants would make RLS look effective when it is really
-- the missing GRANT doing the work.
alter default privileges in schema public
  grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;
