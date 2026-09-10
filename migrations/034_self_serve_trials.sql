-- 034_self_serve_trials.sql — a centre can start its own trial.
--
-- Until now a tenant could only be created by a platform administrator
-- (routes/tenants.js, POST /api/tenants). Migration 009 already built the
-- whole trial LIFECYCLE — status 'trial', trial_ends_at, tenant_may_write()
-- going false when it lapses, expire_lapsed_trials() in the nightly job — so
-- what is missing is only the front door.
--
-- Two tables here, and one deliberate constraint on the design:
--
--   NOTHING IS PROVISIONED UNTIL AN EMAIL IS PROVEN.
--
-- Provisioning runs `create schema` plus the whole of tenant/template.sql.
-- That is expensive, and a public endpoint that does it on an unverified POST
-- is a way to fill a database from a script in an afternoon. So a sign-up
-- writes a row here, an email is sent, and only the click on that link — which
-- proves somebody reads that inbox — creates a centre.

-- ---------------------------------------------------------------------------
-- Pending sign-ups
-- ---------------------------------------------------------------------------
-- A row here is a request, not a centre. It holds no resident data and never
-- will; it is deleted once it has been used or has aged out.
create table if not exists public.signup_requests (
  id            uuid primary key default gen_random_uuid(),
  email         text        not null,
  full_name     text        not null,
  centre_name   text        not null,
  slug          text        not null,
  -- 'sample' seeds a demo centre; 'empty' provisions a bare one. Asked on the
  -- form because the answer changes what the person sees in the first second,
  -- and because fabricated residents must never appear in a register somebody
  -- believed was empty.
  seed          text        not null default 'sample'
                            check (seed in ('sample', 'empty')),
  -- Only the digest. A leaked backup of this table must not be a set of live
  -- sign-up links, same rule as auth.password_resets.
  token_sha256  bytea       not null,
  requested_ip  inet,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '24 hours',
  confirmed_at  timestamptz,
  tenant_id     uuid references public.tenants (id) on delete set null,

  constraint signup_requests_email_shape check (position('@' in email) > 1),
  constraint signup_requests_slug_shape
    check (slug ~ '^[a-z][a-z0-9-]{1,38}[a-z0-9]$')
);

create index if not exists signup_requests_token_idx
  on public.signup_requests (token_sha256) where confirmed_at is null;
create index if not exists signup_requests_email_idx
  on public.signup_requests (lower(email), created_at desc);
-- The sweep in jobs.js reads this.
create index if not exists signup_requests_expiry_idx
  on public.signup_requests (expires_at) where confirmed_at is null;

comment on table public.signup_requests is
  'A self-serve trial request awaiting email confirmation. Holds no resident data. Deleted once used or expired — see public.sweep_signup_requests().';
comment on column public.signup_requests.seed is
  'What the centre asked to start with: sample residents to explore, or empty for their own list.';

-- ---------------------------------------------------------------------------
-- Which rows are sample data
-- ---------------------------------------------------------------------------
-- A trial started with sample residents may become a real register. Fabricated
-- people must not sit in a statutory record beside real ones, so every seeded
-- resident is registered here and Admin can clear exactly those and nothing
-- else.
--
-- This lives in public rather than as a column on the tenant's own residents
-- table on purpose: there is no per-tenant migration ledger yet
-- (docs/MULTI-TENANCY.md, "the two things that need care"), so adding a column
-- to tenant/template.sql would give it to centres provisioned afterwards and
-- not to the ones already running. A registry in public applies to every
-- tenant on day one and needs no DDL against any schema.
create table if not exists public.tenant_demo_rows (
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  kind        text not null check (kind in ('resident', 'building', 'household')),
  row_id      uuid not null,
  created_at  timestamptz not null default now(),
  primary key (tenant_id, kind, row_id)
);

comment on table public.tenant_demo_rows is
  'Rows written by the sample-data seed, so a trial can clear exactly those and keep anything real that was added beside them.';

-- ---------------------------------------------------------------------------
-- Housekeeping
-- ---------------------------------------------------------------------------
-- Unconfirmed requests are rubbish after a day. Confirmed ones are kept for a
-- fortnight so support can answer "I signed up and nothing arrived", then go.
create or replace function public.sweep_signup_requests()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_n integer;
begin
  delete from public.signup_requests
   where (confirmed_at is null and expires_at < now())
      or (confirmed_at is not null and confirmed_at < now() - interval '14 days');
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

comment on function public.sweep_signup_requests() is
  'Deletes spent and expired sign-up requests. Run nightly from jobs.js.';

-- Neither table is reachable by a tenant role: sign-ups are handled by the
-- app before any session exists, and the demo registry is read by the owner
-- connection only. No grants, and no RLS policy, because no request role can
-- see them at all.
revoke all on public.signup_requests   from anon, authenticated;
revoke all on public.tenant_demo_rows  from anon, authenticated;
