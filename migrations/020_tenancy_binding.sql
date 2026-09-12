-- 020: tenancy binding — Stage 5 of docs/PRODUCT-ROADMAP.md.
--
-- Migrations 009–011 gave every login a tenant and every tenant a schema
-- template. This migration is the half that isolates: the pieces of shared
-- identity that must find a person's profile in THEIR centre's schema, and
-- nowhere else. The request-side binding (search_path per request) is in
-- database.js; the per-tenant nightly jobs are in jobs.js; the proof is the
-- "tenancy isolation" section of test/api.test.js.
--
-- Everything here is shared (auth.*, public.handle_new_user) and therefore
-- deliberately absent from tenant/template.sql. The one rule: a schema name
-- is only ever derived from public.tenants.slug, which a table constraint
-- has validated, and only ever reaches SQL through format('%I').

-- Who may create and close centres. Set by the operator in SQL; there is no
-- route that grants it.
alter table auth.users add column if not exists platform_admin boolean not null default false;
comment on column auth.users.platform_admin is 'May list, provision and close tenants (routes/tenants.js). Granted only in SQL by the operator.';

-- The schema a tenant's data lives in. The legacy deployment stays in public.
create or replace function auth.schema_for_tenant(p_tenant uuid)
returns text
language sql stable security definer set search_path = auth, public
as $$
  select case when t.slug = 'default' then 'public' else 't_' || replace(t.slug, '-', '_') end
    from public.tenants t where t.id = p_tenant;
$$;

-- The caller's own tenant, from the session identity.
create or replace function auth.current_tenant()
returns uuid
language sql stable security definer set search_path = auth, public
as $$
  select u.tenant_id from auth.users u where u.id = auth.uid();
$$;

-- A person's profile, wherever their centre keeps it. Used by login and by
-- session validation, which run as the owner before any tenant is bound.
-- A tenant whose schema is gone (closed and dropped) has no profiles: the
-- login is refused as "disabled", which is the truth.
create or replace function auth.profile_for(p_user uuid)
returns table (full_name text, role text, active boolean)
language plpgsql stable security definer set search_path = auth, public
as $$
declare v_schema text;
begin
  select auth.schema_for_tenant(u.tenant_id) into v_schema from auth.users u where u.id = p_user;
  if v_schema is null or not exists (select 1 from pg_namespace where nspname = v_schema) then return; end if;
  return query execute format('select p.full_name, p.role, p.active from %I.profiles p where p.id = $1', v_schema) using p_user;
end;
$$;

-- The new-user trigger now creates the profile in the new user's own tenant.
-- tenant_id is already set when this AFTER trigger runs: either the caller
-- passed one, or users_default_tenant (011) filled in the default.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = auth, public
as $$
declare v_schema text;
begin
  v_schema := coalesce(auth.schema_for_tenant(new.tenant_id), 'public');
  execute format('insert into %I.profiles (id, full_name, role) values ($1, $2, $3) on conflict (id) do nothing', v_schema)
  using new.id,
        coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), split_part(new.email, '@', 1)),
        coalesce(nullif(new.raw_user_meta_data ->> 'role', ''), 'guard');
  return new;
end;
$$;

-- Account creation names the tenant. When it does not (a call with no
-- session, as the tests and the first-account seed make), the caller's own
-- tenant is used, and failing that the default — never another centre's.
drop function if exists auth.create_user(text, text, text, text);
create or replace function auth.create_user(
  p_email     text,
  p_password  text,
  p_full_name text,
  p_role      text default 'guard',
  p_tenant    uuid default null
)
returns uuid
language plpgsql security definer set search_path = auth, public, extensions
as $$
declare v_id uuid;
begin
  if p_role not in ('guard', 'supervisor', 'admin') then
    raise exception 'role must be guard, supervisor or admin' using errcode = '22023';
  end if;
  if length(coalesce(p_password, '')) < 12 then
    raise exception 'password must be at least 12 characters' using errcode = '22023';
  end if;
  insert into auth.users (email, encrypted_password, raw_user_meta_data, tenant_id)
  values (btrim(p_email),
          extensions.crypt(p_password, extensions.gen_salt('bf', 12)),
          jsonb_build_object('full_name', p_full_name, 'role', p_role),
          coalesce(p_tenant, auth.current_tenant()))
  returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception 'An account with that email already exists' using errcode = '22023';
end;
$$;
revoke all on function auth.create_user(text, text, text, text, uuid) from public, anon, authenticated;

drop function if exists auth.create_user_invited(text, text, text);
create or replace function auth.create_user_invited(
  p_email     text,
  p_full_name text,
  p_role      text default 'guard',
  p_tenant    uuid default null
)
returns uuid
language plpgsql security definer set search_path = auth, public, extensions
as $$
declare v_id uuid;
begin
  if p_role not in ('guard', 'supervisor', 'admin') then
    raise exception 'role must be guard, supervisor or admin' using errcode = '22023';
  end if;
  if position('@' in coalesce(btrim(p_email), '')) < 2 then
    raise exception 'A valid email address is required' using errcode = '22023';
  end if;
  if length(coalesce(btrim(p_full_name), '')) = 0 then
    raise exception 'A name is required' using errcode = '22023';
  end if;
  insert into auth.users (email, raw_user_meta_data, tenant_id)
  values (btrim(p_email), jsonb_build_object('full_name', btrim(p_full_name), 'role', p_role),
          coalesce(p_tenant, auth.current_tenant()))
  returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception 'An account with that email already exists' using errcode = '22023';
end;
$$;
revoke all on function auth.create_user_invited(text, text, text, uuid) from public, anon, authenticated;

-- Password reset and invitation links look the person up in their own
-- centre too; these joined public.profiles, which for a harbour admin's
-- invitation meant "no such active account".
create or replace function auth.create_password_reset(
  p_email        text,
  p_token_sha256 bytea,
  p_ttl_minutes  integer default 60
)
returns text
language plpgsql
security definer
set search_path = auth, public, extensions
as $$
declare
  v_id   uuid;
  v_name text;
  RESEND_GAP constant interval := interval '60 seconds';
begin
  select u.id, p.full_name into v_id, v_name
  from auth.users u
  cross join lateral auth.profile_for(u.id) p
  where lower(u.email) = lower(btrim(coalesce(p_email, '')))
    and p.active;

  if v_id is null then
    return null;
  end if;

  if exists (
    select 1 from auth.password_resets
    where user_id = v_id and used_at is null
      and expires_at > now()
      and created_at > now() - RESEND_GAP
  ) then
    return null;
  end if;

  delete from auth.password_resets
  where user_id = v_id and used_at is null;

  insert into auth.password_resets (token_sha256, user_id, expires_at)
  values (p_token_sha256, v_id, now() + make_interval(mins => greatest(5, least(p_ttl_minutes, 1440))));

  return v_name;
end;
$$;

create or replace function auth.redeem_password_reset(
  p_token_sha256 bytea,
  p_password     text
)
returns boolean
language plpgsql
security definer
set search_path = auth, public, extensions
as $$
declare
  v_id    uuid;
  v_email text;
begin
  select r.user_id into v_id
  from auth.password_resets r
  cross join lateral auth.profile_for(r.user_id) p
  where r.token_sha256 = p_token_sha256
    and r.used_at is null
    and r.expires_at > now()
    and p.active
  for update of r;

  if v_id is null then
    return false;
  end if;

  select email into v_email from auth.users where id = v_id;
  update auth.password_resets set used_at = now() where token_sha256 = p_token_sha256;
  perform auth.set_password(v_email, p_password);
  return true;
end;
$$;
