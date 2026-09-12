-- ---------------------------------------------------------------------------
-- 009_tenants.sql — the registry of businesses, their trials, and the terms
-- they accepted.
-- ---------------------------------------------------------------------------
--
-- Everything here is deliberately independent of HOW tenants are isolated from
-- one another. Whether each centre gets its own schema or a tenant_id column
-- on shared tables, it still needs one row saying who they are, when their
-- trial ends and which version of the terms they agreed to. That decision can
-- change in 010 without touching this file.
--
-- WHY A TRIAL EXPIRES INTO READ-ONLY, NOT INTO NOTHING
--
-- A centre that trials this puts a real register in it — real people, recorded
-- presence, TRC numbers. If a trial simply switched off on day eight, the
-- centre would lose the record of who was seen last week, which is the exact
-- evidence IPAS audits. So an expired trial keeps answering questions and
-- stops accepting new facts: staff can read, export and erase, and cannot
-- record. That is recoverable in both directions and never destroys evidence
-- (Tao 2). Deletion happens on request, or by the retention purge, never as a
-- side effect of not paying.
--
-- WHY TERMS ACCEPTANCE IS A COLUMN AND NOT A CHECKBOX
--
-- Accepting real resident data on day one makes the operator of this service a
-- data processor from the moment somebody signs up. The defensible version of
-- that is a recorded acceptance: who clicked, when, and WHICH VERSION of the
-- terms and data-processing agreement they saw. A boolean proves nothing a
-- year later when the wording has changed twice.

set search_path = public, extensions;

create table if not exists public.tenants (
  id          uuid primary key default gen_random_uuid(),
  -- What the centre calls itself, and the URL-safe handle derived from it.
  name        text not null check (length(btrim(name)) between 2 and 120),
  slug        text not null unique
                check (slug ~ '^[a-z][a-z0-9-]{1,38}[a-z0-9]$'),

  status      text not null default 'trial'
                check (status in ('trial', 'active', 'expired', 'suspended', 'closed')),

  trial_started_at timestamptz not null default now(),
  trial_ends_at    timestamptz not null default now() + interval '7 days',

  -- Recorded at signup. Nullable only so a tenant created by a migration or a
  -- console command is representable; the signup path always sets all three.
  terms_accepted_at      timestamptz,
  terms_version          text,
  terms_accepted_by_email text,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- A closed tenant has an end date; an open one does not. Same biconditional
  -- discipline as departed_on_matches_status (Tao 18).
  closed_at   timestamptz,
  constraint tenant_closed_has_date check ((status = 'closed') = (closed_at is not null))
);

comment on table public.tenants is
  'One row per business using the service. Trials expire into read-only, never into deletion.';
comment on column public.tenants.terms_version is
  'Which published version of the terms and DPA was accepted. A boolean would prove nothing later.';

create index if not exists tenants_status_idx on public.tenants (status);
create index if not exists tenants_trial_ends_idx on public.tenants (trial_ends_at)
  where status = 'trial';

drop trigger if exists tenants_touch_updated_at on public.tenants;
create trigger tenants_touch_updated_at
  before update on public.tenants
  for each row execute function public.touch_updated_at();


-- Which business a login belongs to. One user, one tenant: a centre manager
-- works at a centre, not at several, and pretending otherwise would put a
-- tenant-switcher in front of a register where picking the wrong one means
-- recording a resident against the wrong site.
alter table auth.users
  add column if not exists tenant_id uuid references public.tenants (id) on delete restrict;

create index if not exists users_tenant_idx on auth.users (tenant_id);

comment on column auth.users.tenant_id is
  'The business this login belongs to. on delete restrict: closing a tenant must not silently erase the identities behind its audit trail (Tao 4).';


-- ---------------------------------------------------------------------------
-- Is this tenant still allowed to record?
-- ---------------------------------------------------------------------------
-- One place the answer lives, so the API, the RPCs and any future job all
-- agree. Reading is a separate question and is always allowed for a tenant
-- that is not suspended or closed.
create or replace function public.tenant_may_write(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.tenants t
    where t.id = p_tenant
      and t.status in ('trial', 'active')
      and (t.status <> 'trial' or t.trial_ends_at > now())
  );
$$;

comment on function public.tenant_may_write(uuid) is
  'False once a trial lapses. Reading, exporting and erasing stay available: an expired trial must never cost a centre the evidence it already recorded.';


-- Move lapsed trials to 'expired'. Idempotent and safe to run late, same
-- contract as every other job in jobs.js.
create or replace function public.expire_lapsed_trials()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_n integer;
begin
  update public.tenants
     set status = 'expired'
   where status = 'trial'
     and trial_ends_at <= now();
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;


-- ---------------------------------------------------------------------------
-- The site that already exists becomes the first tenant.
-- ---------------------------------------------------------------------------
-- Without this every existing login would have a null tenant_id and the
-- session layer would have to treat that as a special case forever. It is
-- created as 'active' rather than 'trial': it is not on a trial, it is the
-- deployment that predates trials existing.
do $$
declare v_tenant uuid;
begin
  if not exists (select 1 from public.tenants) then
    insert into public.tenants (name, slug, status, terms_accepted_at, terms_version)
    select coalesce(nullif(btrim(s.site_name), ''), 'Security Hut'),
           'default', 'active', now(), 'pre-signup'
    from public.app_settings s
    limit 1
    returning id into v_tenant;

    -- No app_settings row at all (a bare database): still create the tenant.
    if v_tenant is null then
      insert into public.tenants (name, slug, status, terms_accepted_at, terms_version)
      values ('Security Hut', 'default', 'active', now(), 'pre-signup')
      returning id into v_tenant;
    end if;
  else
    select id into v_tenant from public.tenants order by created_at limit 1;
  end if;

  update auth.users set tenant_id = v_tenant where tenant_id is null;
end $$;


revoke all on public.tenants from anon, authenticated, service_role;
revoke all on function public.tenant_may_write(uuid)     from public, anon, authenticated;
revoke all on function public.expire_lapsed_trials()     from public, anon, authenticated;
