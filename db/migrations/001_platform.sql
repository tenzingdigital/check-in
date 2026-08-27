-- ---------------------------------------------------------------------------
-- db/migrations/001_platform.sql — the identity layer schema.sql sits on top of.
-- ---------------------------------------------------------------------------
--
-- Apply this BEFORE schema.sql, on a fresh database:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/001_platform.sql
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/002_schema.sql
--
-- This file used to be `tests/00_supabase_stub.sql`, a thirty-line fake of the
-- Supabase objects that schema.sql depends on, written so the acceptance suite
-- could run against a throwaway cluster. When the app moved to plain Postgres
-- on Render the fake became the real thing: everything Supabase used to
-- provide — the users table, auth.uid(), the anon/authenticated roles, and the
-- default grants that make row-level security load-bearing — is now defined
-- here, and the API service in server/ drives it.
--
-- The payoff is that schema.sql is untouched by the move. Every policy, every
-- SECURITY DEFINER function, every auth.uid() call works exactly as it did on
-- Supabase, because the three things they depend on still exist with the same
-- names and the same semantics. The security model never left the database.
--
-- Two things are new here, because Supabase used to own them and now nobody
-- else does: password hashes (auth.users.encrypted_password) and sessions
-- (auth.sessions). Both are deliberately as small as they can be — see the
-- notes on each.

create schema if not exists auth;
create schema if not exists extensions;

-- pgcrypto provides both the password hashing (crypt/gen_salt) and the random
-- bytes behind session tokens. schema.sql also requires it, and `if not
-- exists` makes the order of the two files irrelevant.
create extension if not exists pgcrypto with schema extensions;


-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------
-- Column names match Supabase's auth.users where they overlap, so that
-- schema.sql's handle_new_user() trigger — which reads `email` and
-- `raw_user_meta_data` — needs no change, and so that a future move back to
-- Supabase is a data copy rather than a rewrite.
--
-- There is no email confirmation flow, no password reset, no OAuth and no
-- sign-up endpoint. Accounts are created by an administrator with
-- `node server/staff.js add`, which is the same posture the Supabase setup had
-- (its very first setup step was "disable public sign-up"): the only way to
-- hold an account at this hut is for someone with database access to have
-- made you one.

create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text not null unique,
  -- bcrypt, via extensions.crypt(password, extensions.gen_salt('bf', 12)).
  -- Verification is `encrypted_password = extensions.crypt(attempt,
  -- encrypted_password)`, which is constant-time within bcrypt itself.
  --
  -- The default is a valid bcrypt hash of a value nobody has ever seen, so a
  -- row inserted directly in SQL — by a migration, a restore, or the
  -- acceptance suite — is login-disabled rather than passwordless. It is a
  -- hash no password can match, not an empty string: an empty string is not a
  -- bcrypt salt, and crypt() would raise on it at login instead of simply
  -- failing to match. Give such an account a password with
  -- `node server/staff.js passwd <email>`.
  encrypted_password text not null
    default extensions.crypt(gen_random_uuid()::text, extensions.gen_salt('bf', 12)),
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  last_sign_in_at    timestamptz
);

comment on table auth.users is
  'Staff credentials. One row per public.profiles row; the profile carries name, role and active flag, this table carries only what is needed to authenticate.';

-- Emails are compared case-insensitively at login, so they must be unique
-- case-insensitively too — otherwise "Gina@hut.example" and "gina@hut.example"
-- are two accounts that both answer to the same typed login.
create unique index if not exists users_email_lower_key on auth.users (lower(email));


-- ---------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------
-- Supabase issued a JWT; this issues an opaque random token and keeps the
-- state here. That is the right trade for this app: a hut needs "revoke this
-- guard's access now" to actually mean now, and a stateless JWT cannot do that
-- without a revocation list — which is this table with extra steps.
--
-- The token itself is never stored. The cookie carries 32 random bytes and
-- this table holds their SHA-256, so a database backup or a leaked dump does
-- not contain anything that can be replayed as a login.

create table if not exists auth.sessions (
  token_sha256 bytea primary key,
  user_id      uuid not null references auth.users (id) on delete cascade,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null,
  user_agent   text
);

create index if not exists sessions_user_id_idx  on auth.sessions (user_id);
create index if not exists sessions_expires_idx  on auth.sessions (expires_at);

comment on table auth.sessions is
  'Opaque server-side sessions. Stores the SHA-256 of the cookie token, never the token. Deleting a row logs that browser out immediately.';

create or replace function auth.purge_expired_sessions()
returns integer
language sql
security definer
set search_path = auth, extensions
as $$
  with gone as (delete from auth.sessions where expires_at < now() returning 1)
  select count(*)::integer from gone;
$$;

comment on function auth.purge_expired_sessions() is
  'Deletes sessions past their expiry. Run daily alongside the other maintenance jobs.';


-- ---------------------------------------------------------------------------
-- auth.uid()
-- ---------------------------------------------------------------------------
-- The hinge the whole security model turns on. On Supabase this read the `sub`
-- claim out of the request's JWT; here the API service opens a transaction and
-- does
--
--   set local role authenticated;
--   set local request.jwt.claim.sub = '<user id>';
--
-- before running any statement on behalf of a guard. Same function, same
-- return value, same policies — the only difference is who sets the GUC.
--
-- `set local` matters: the setting dies with the transaction, so a pooled
-- connection handed to the next request cannot carry the previous guard's
-- identity. The API layer never issues a bare `set`.
--
-- Note the `true` second argument to current_setting: missing GUC returns null
-- rather than raising, so an unauthenticated request produces auth.uid() = null
-- and every is_staff() check fails closed.

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;


-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
-- Supabase's two request roles, reproduced. The API service connects as the
-- owner and immediately drops to one of these per transaction: `authenticated`
-- for a request carrying a valid session, `anon` for one that does not.
--
-- nologin because nothing ever connects as them directly — they are only ever
-- reached through SET LOCAL ROLE from the owning connection.

do $$ begin create role anon nologin;          exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin;  exception when duplicate_object then null; end $$;

grant usage on schema public     to anon, authenticated, service_role;
grant usage on schema auth       to anon, authenticated, service_role;
grant usage on schema extensions to anon, authenticated, service_role;

-- IMPORTANT: reproduce Supabase's default privileges. On a Supabase project
-- the anon and authenticated roles hold full table grants in the public
-- schema, which is precisely why row-level security carries the whole security
-- model. Running without these grants would make RLS look effective when it is
-- really a missing GRANT doing the work — and would then fail open the moment
-- someone granted a table for an unrelated reason.
--
-- Keeping them means the acceptance suite proves the policies, not the grants,
-- and it means schema.sql's own explicit `revoke ... from anon` lines still
-- have something to revoke.
alter default privileges in schema public
  grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;

-- auth.users is readable by authenticated on Supabase (that is how a client
-- reads its own email). Nothing in schema.sql depends on it, but the
-- acceptance suite asserts the same shape, and the password hash must never be
-- part of it — so grant the columns rather than the table.
grant select (id, email, created_at, last_sign_in_at) on auth.users to authenticated;

-- Sessions are the API service's business alone. No request role touches them:
-- session lookup happens on the owner connection, before the role is dropped.
revoke all on auth.sessions from anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- Account management helpers
-- ---------------------------------------------------------------------------
-- Used by server/staff.js. They live here rather than in JavaScript so that an
-- administrator with nothing but psql can still add a guard at 3am, and so the
-- hashing parameters are stated in exactly one place.

create or replace function auth.create_user(
  p_email     text,
  p_password  text,
  p_full_name text,
  p_role      text default 'guard'
)
returns uuid
language plpgsql
security definer
set search_path = auth, public, extensions
as $$
declare v_id uuid;
begin
  if p_role not in ('guard', 'supervisor', 'admin') then
    raise exception 'role must be guard, supervisor or admin' using errcode = '22023';
  end if;
  if length(coalesce(p_password, '')) < 12 then
    raise exception 'password must be at least 12 characters' using errcode = '22023';
  end if;

  insert into auth.users (email, encrypted_password, raw_user_meta_data)
  values (
    btrim(p_email),
    extensions.crypt(p_password, extensions.gen_salt('bf', 12)),
    jsonb_build_object('full_name', p_full_name, 'role', p_role)
  )
  returning id into v_id;

  -- public.handle_new_user() fires on insert and creates the profiles row from
  -- raw_user_meta_data, exactly as it did on Supabase.
  return v_id;
end;
$$;

create or replace function auth.set_password(p_email text, p_password text)
returns boolean
language plpgsql
security definer
set search_path = auth, extensions
as $$
declare v_id uuid;
begin
  if length(coalesce(p_password, '')) < 12 then
    raise exception 'password must be at least 12 characters' using errcode = '22023';
  end if;

  update auth.users
     set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf', 12))
   where lower(email) = lower(btrim(p_email))
  returning id into v_id;

  if v_id is null then
    return false;
  end if;

  -- A password change ends every existing session for that account. This is
  -- the revocation path: "they know the old password" must stop being useful
  -- the moment it is changed, including on a browser already logged in.
  delete from auth.sessions where user_id = v_id;
  return true;
end;
$$;

comment on function auth.set_password(text, text) is
  'Changes a password and logs out every session for that account. Returns false if no such email.';


-- ---------------------------------------------------------------------------
-- Lock down the definer-rights helpers
-- ---------------------------------------------------------------------------
-- Postgres grants EXECUTE to PUBLIC on every new function, and the request
-- roles hold USAGE on this schema so they can reach auth.uid(). Without these
-- revokes, `select auth.create_user('me@x','...','Me','admin')` would be a
-- one-line privilege escalation available to any logged-in guard — a
-- SECURITY DEFINER function is only as safe as the grant in front of it.
--
-- auth.uid() is deliberately left executable by everyone: it is stable, takes
-- no arguments, and returns only what the caller's own transaction already set.

revoke all on function auth.create_user(text, text, text, text) from public;
revoke all on function auth.set_password(text, text)            from public;
revoke all on function auth.purge_expired_sessions()            from public;
