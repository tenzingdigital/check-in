-- ============================================================================
-- Portable auth shim — run this INSTEAD of relying on Supabase's auth schema.
--
-- Apply on a plain PostgreSQL database (Render, Neon, Hetzner, anything) BEFORE
-- supabase/schema.sql. With this in place, schema.sql applies completely
-- unchanged, and every row-level security policy, every auth.uid() call and all
-- 84 assertions in supabase/tests/ keep working.
--
-- What it does NOT do: authenticate anybody. There are no passwords here and
-- there is no login. You bring an external identity provider — Clerk, Logto,
-- Zitadel, Auth0, Keycloak, whatever — and this maps its users onto the local
-- identity the schema expects.
--
-- Do not deploy this to a Supabase project. Supabase already provides a real
-- auth schema; this would collide with it.
-- ============================================================================

begin;

create schema if not exists auth;
create extension if not exists pgcrypto;   -- gen_random_uuid()


-- ---------------------------------------------------------------------------
-- Local user identities
-- ---------------------------------------------------------------------------
-- Why a local uuid rather than using the provider's id directly: most providers
-- do not issue UUIDs. Clerk returns "user_2abc...", Auth0 returns
-- "auth0|abc123", Zitadel returns a numeric string. The schema's guard_id
-- columns and auth.uid() are all `uuid`, so adopting the provider's format
-- would mean changing the type of half a dozen columns and every foreign key.
--
-- Instead the provider's identifier is stored alongside a locally generated
-- uuid, and everything downstream keeps using the uuid. Swapping providers
-- later becomes a re-mapping exercise rather than a schema migration.

create table if not exists auth.users (
  id                uuid primary key default gen_random_uuid(),
  -- The external provider's stable identifier for this person — the `sub`
  -- claim in an OIDC token. Nullable only so the test suite can insert
  -- fixtures directly; real logins always go through auth.resolve_user().
  provider_subject  text unique,
  email             text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now()
);

comment on table auth.users is
  'Local mirror of the external identity provider''s users. Holds no credentials — authentication happens at the provider, never here.';


-- ---------------------------------------------------------------------------
-- auth.uid() — who is the current request acting as?
-- ---------------------------------------------------------------------------
-- Supabase derives this from a verified JWT. Here it reads a session variable
-- that your backend sets per transaction, after it has verified the provider's
-- token. Identical signature and semantics, so schema.sql cannot tell the
-- difference.
--
-- SECURITY: everything in this system hangs off this function. Whatever sets
-- the session variable MUST have verified the token first — signature, issuer,
-- audience and expiry. Setting it from an unverified client-supplied value
-- means any caller can be any guard.

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;


-- ---------------------------------------------------------------------------
-- Called by your backend on each successful login
-- ---------------------------------------------------------------------------
-- Returns the local uuid to put into request.jwt.claim.sub. Creates the user on
-- first sight, which fires schema.sql's on_auth_user_created trigger and gives
-- them a profiles row with the default 'guard' role.
--
-- Role is deliberately NOT taken from the provider on subsequent logins. An
-- admin sets it in public.profiles, and a provider-side change must never be
-- able to silently promote someone to admin.

create or replace function auth.resolve_user(
  p_subject   text,
  p_email     text default null,
  p_full_name text default null
)
returns uuid
language plpgsql
security definer
set search_path = auth, public
as $$
declare
  v_id uuid;
begin
  if coalesce(btrim(p_subject), '') = '' then
    raise exception 'auth.resolve_user: provider subject is required'
      using errcode = '22023';
  end if;

  select id into v_id from auth.users where provider_subject = p_subject;

  if v_id is null then
    insert into auth.users (provider_subject, email, raw_user_meta_data)
    values (
      p_subject,
      p_email,
      jsonb_build_object('full_name', coalesce(nullif(btrim(p_full_name), ''), p_email, p_subject))
    )
    returning id into v_id;
  else
    -- Keep contact details current; never touch role.
    update auth.users
       set email = coalesce(p_email, email)
     where id = v_id;
  end if;

  return v_id;
end;
$$;


-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
-- schema.sql grants to these by name. On Supabase they already exist; on a
-- plain database they do not.
--
-- Your backend should connect as `authenticated` for guard traffic — NOT as the
-- database owner, which bypasses row-level security entirely and would silently
-- disable the whole security model.

do $$ begin create role anon nologin;          exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin;  exception when duplicate_object then null; end $$;

grant usage on schema public to anon, authenticated, service_role;
-- anon needs USAGE on auth as well: every RLS policy calls auth.uid(), and the
-- call is evaluated as the current role. Withhold it and an anonymous read
-- fails with "permission denied for schema auth" instead of being filtered to
-- zero rows by the policy — which looks like a pass while actually testing
-- something else. Supabase grants it; reproduce that.
grant usage on schema auth   to anon, authenticated, service_role;
grant select on auth.users   to authenticated;

-- Supabase grants these by default; schema.sql's own REVOKEs then narrow them
-- back down. Reproduce them so the RLS policies are doing the gating, exactly
-- as they do on Supabase.
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

revoke all on function auth.resolve_user(text, text, text) from anon, public;

commit;


-- ============================================================================
-- The backend contract — three steps, per request
-- ============================================================================
--
-- 1. Verify the provider's token yourself. Signature, issuer, audience, expiry.
--    Use the provider's SDK or a vetted JOSE library. Never trust a raw id
--    from the client.
--
-- 2. Map the token's `sub` to a local uuid, once per login:
--
--       SELECT auth.resolve_user($1, $2, $3);   -- sub, email, full name
--
--    Cache the result in your session; it never changes for a given user.
--
-- 3. Open a transaction, set the identity, run the query, commit:
--
--       BEGIN;
--       SET LOCAL request.jwt.claim.sub = '<the uuid from step 2>';
--       SELECT * FROM public.v_resident_compliance;   -- RLS now applies
--       COMMIT;
--
--    SET LOCAL is essential rather than SET: it is scoped to the transaction,
--    so a pooled connection cannot leak one guard's identity into the next
--    request's query. With plain SET on a pooled connection, the next request
--    to reuse that connection inherits the previous user — which is a
--    catastrophic and very quiet failure.
--
-- Connect as the `authenticated` role. Connecting as the database owner
-- bypasses RLS and every protection in schema.sql stops applying.
--
-- ============================================================================
-- Verifying this works
-- ============================================================================
--
--   ./supabase/tests/run.sh --portable
--
-- applies this file instead of the Supabase stub, then runs the entire suite
-- against it: the same 84 assertions that guard the Supabase deployment, plus
-- 23 in supabase/tests/03_portable_auth.sql covering auth.resolve_user() —
-- which does not exist on Supabase and so is otherwise untested code sitting
-- on the login path. 107 assertions and PASS means the security model is
-- intact on plain PostgreSQL.
--
-- ./check.sh runs both modes. Keep it that way: this file is not the deployed
-- path today, so nothing else would notice it rotting until the migration that
-- depends on it.
--
-- Note on schema.sql: it needs no edits. public.profiles keeps its
-- `references auth.users (id)` foreign key and the on_auth_user_created
-- trigger still fires, because auth.users here is a real table rather than a
-- Supabase-managed one. Identity lives in one place and cascade-delete on
-- erasure keeps working.
