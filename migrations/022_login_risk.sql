-- 022: where a login comes from, and what to do about it.
--
-- Every sign-in attempt now records the country its IP resolves to and the
-- reasons it was treated as unusual. Home is Ireland by default, per site.
-- The decision (lib/auth.js):
--
--   a supervisor or administrator from outside the home countries  → refused,
--     with the security contact address in the message;
--   anything else unusual — a guard abroad, a device never seen before
--     together with recent failed passwords — → the emailed code, whatever
--     the role; and if the site cannot send codes, refused the same way;
--   a known device from home                                         → as before.
--
-- Devices are recorded on every successful login (a cookie held for thirty
-- days); "trusted" — skips the code for senior roles — is only the ones the
-- person ticked the box for.

alter table public.app_settings
  add column if not exists home_countries text not null default 'IE'
    check (home_countries ~ '^[A-Z]{2}(,[A-Z]{2})*$');
comment on column public.app_settings.home_countries is 'ISO country codes, comma-separated, that a login is expected from. Anything else is unusual.';

alter table auth.login_events
  add column if not exists country text,
  add column if not exists risk    text;
comment on column auth.login_events.country is 'ISO code the IP resolved to at the time; null for a private or unknown address.';
comment on column auth.login_events.risk    is 'Why the login was treated as unusual: abroad, new_device, recent_failures. Empty when nothing was.';

alter table auth.login_events drop constraint if exists login_events_outcome_check;
alter table auth.login_events add constraint login_events_outcome_check
  check (outcome in ('ok', 'bad_password', 'unknown_email', 'disabled', 'locked', 'mfa_sent', 'mfa_failed', 'blocked_abroad', 'blocked_no_code'));

alter table auth.mfa_devices add column if not exists trusted boolean not null default true;
comment on column auth.mfa_devices.trusted is 'True: skips the code for a senior role for thirty days. False: merely seen before, which counts against "new device".';

-- The site's home countries, for the person's own centre.
create or replace function auth.home_countries_for(p_user uuid)
returns text
language plpgsql stable security definer set search_path = auth, public
as $$
declare v_schema text; v text;
begin
  select auth.schema_for_tenant(u.tenant_id) into v_schema from auth.users u where u.id = p_user;
  if v_schema is null or not exists (select 1 from pg_namespace where nspname = v_schema) then return 'IE'; end if;
  execute format('select s.home_countries from %I.app_settings s limit 1', v_schema) into v;
  return coalesce(v, 'IE');
end;
$$;
revoke all on function auth.home_countries_for(uuid) from public, anon, authenticated;

-- The person's role, for the decision above (before any tenant is bound).
create or replace function auth.role_for(p_user uuid)
returns text
language sql stable security definer set search_path = auth, public
as $$
  select p.role from auth.profile_for(p_user) p;
$$;
revoke all on function auth.role_for(uuid) from public, anon, authenticated;
