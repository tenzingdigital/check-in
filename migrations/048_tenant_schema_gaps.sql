-- The gap this closes: docs/KNOWN-ISSUES.md #4. database.js migrates
-- `public` only; a `t_*` tenant schema gets tenant/template.sql once, at
-- provisioning, and nothing has revisited it since. A tenant provisioned
-- before some later migration lands is missing whatever that migration
-- added, and finds out only when a route or a nightly job reaches for the
-- missing piece and 500s or fails — exactly what happened to
-- "cheksteadysitetest" and migration 041's profiles.safeguarding_alert,
-- silently, for two days, until a cron-failure email surfaced it.
--
-- This does not bring a tenant current — replaying arbitrary past
-- migrations against a live schema is its own, larger decision (still
-- open, per #4). What it does is make the gap impossible to miss again:
-- named functions in `public` that a given `t_*` schema does not have,
-- the same technique the "every view, function, policy and index is
-- provisioned too" test already uses to check a *freshly* provisioned
-- schema, pointed instead at whichever schemas actually exist right now.
-- Called at boot (database.js) so it is loud in the deploy log the moment
-- a new migration creates the gap, and from GET /api/tenants (the
-- platform-admin view) so it stays visible after that, not just at the
-- one moment it started.

create or replace function public.tenant_schema_gaps()
returns table (schema text, missing_functions text[])
language sql
stable
security definer
set search_path = public
as $$
  with shared as (
    select unnest(array[
      'tenants', 'schema_migrations', 'signup_requests', 'tenant_demo_rows',
      'immutable_unaccent', 'touch_updated_at', 'tenant_may_write',
      'expire_lapsed_trials', 'sweep_signup_requests', 'handle_new_user',
      'tenant_schema_gaps'
    ]) as proname
  ),
  reference as (
    select p.proname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname not in (select proname from shared)
  ),
  tenant_schemas as (
    select nspname as schema from pg_namespace where nspname like 't\_%'
  )
  select ts.schema,
         array(
           select r.proname from reference r
            where not exists (
              select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = ts.schema and p.proname = r.proname
            )
           order by r.proname
         ) as missing_functions
    from tenant_schemas ts;
$$;

revoke all on function public.tenant_schema_gaps() from public, anon, authenticated;
