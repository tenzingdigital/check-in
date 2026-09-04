-- ---------------------------------------------------------------------------
-- 011_default_tenant_for_new_users.sql — a new login belongs somewhere.
-- ---------------------------------------------------------------------------
--
-- 009 attached every EXISTING login to the default tenant with a one-off
-- backfill, and nothing since has attached a NEW one. Every account created
-- afterwards — the Staff tab, `node staff.js add`, the first-admin bootstrap —
-- has tenant_id null, which lib/tenancy.js's schemaForUser() refuses with
-- "user belongs to no tenant". Nothing calls that yet, which is why the
-- deployment has not noticed; the HTTP suite only noticed because its
-- "no login is left without a tenant" assertion was being rescued by a
-- different test re-applying 009 and its backfill on every run.
--
-- Until signup exists and sets tenant_id explicitly, a login created with
-- none is a login at the default site. The trigger fills only a null, so a
-- future signup path that names its tenant is left alone.

create or replace function auth.assign_default_tenant()
returns trigger
language plpgsql
security definer
set search_path = auth, public
as $$
begin
  if new.tenant_id is null then
    select id into new.tenant_id from public.tenants where slug = 'default';
  end if;
  return new;
end;
$$;

revoke all on function auth.assign_default_tenant() from public, anon, authenticated, service_role;

drop trigger if exists users_default_tenant on auth.users;
create trigger users_default_tenant
  before insert on auth.users
  for each row execute function auth.assign_default_tenant();

-- Anyone created between 009 and this migration.
update auth.users u
   set tenant_id = (select id from public.tenants where slug = 'default')
 where u.tenant_id is null;
