-- 021: a second step at login for supervisors and administrators — a code by
-- email. Roadmap F6, ISO 27001 8.5.
--
-- Guards keep password-only login for the 3 am shift. Anyone above guard, at
-- a site that has turned the switch on, must also type a six-digit code that
-- was emailed to them, and may trust the device they are on for thirty days
-- (never a shared terminal — the screen says so). The switch is per site and
-- refuses to turn on until email is configured, because a code nobody can
-- receive is a lockout.
--
-- The challenge and device tables are shared (auth.*): they hang off
-- auth.users, and the code is checked before any tenant is bound. Only a
-- SHA-256 of the code or the device token is stored, so a database backup
-- holds nothing that can be replayed.

alter table public.app_settings
  add column if not exists mfa_email boolean not null default false;
comment on column public.app_settings.mfa_email is 'Require a code by email at login for supervisors and administrators. Refused while email is unconfigured.';

create table if not exists auth.mfa_challenges (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  code_sha256 bytea not null,
  expires_at  timestamptz not null,
  attempts    integer not null default 0,
  used_at     timestamptz,
  user_agent  text,
  created_at  timestamptz not null default now()
);
create index if not exists mfa_challenges_user_idx on auth.mfa_challenges (user_id, created_at desc);

create table if not exists auth.mfa_devices (
  token_sha256 bytea primary key,
  user_id      uuid not null references auth.users (id) on delete cascade,
  expires_at   timestamptz not null,
  user_agent   text,
  created_at   timestamptz not null default now()
);
create index if not exists mfa_devices_user_idx on auth.mfa_devices (user_id);

revoke all on auth.mfa_challenges, auth.mfa_devices from anon, authenticated, service_role, public;

-- Does this person's login need the second step? Their role, in their own
-- centre, and that centre's switch.
create or replace function auth.mfa_required_for(p_user uuid)
returns boolean
language plpgsql stable security definer set search_path = auth, public
as $$
declare v_schema text; v_role text; v_on boolean;
begin
  select auth.schema_for_tenant(u.tenant_id) into v_schema from auth.users u where u.id = p_user;
  if v_schema is null or not exists (select 1 from pg_namespace where nspname = v_schema) then return false; end if;
  execute format('select p.role from %I.profiles p where p.id = $1', v_schema) into v_role using p_user;
  if v_role is null or v_role = 'guard' then return false; end if;
  execute format('select s.mfa_email from %I.app_settings s limit 1', v_schema) into v_on;
  return coalesce(v_on, false);
end;
$$;
revoke all on function auth.mfa_required_for(uuid) from public, anon, authenticated;

create or replace function auth.purge_expired_mfa()
returns integer
language plpgsql security definer set search_path = auth
as $$
declare v_n integer; v_m integer;
begin
  delete from auth.mfa_challenges where expires_at < now() - interval '1 day';
  get diagnostics v_n = row_count;
  delete from auth.mfa_devices where expires_at < now();
  get diagnostics v_m = row_count;
  return v_n + v_m;
end;
$$;
revoke all on function auth.purge_expired_mfa() from public, anon, authenticated;

-- Two more outcomes on the login record: the code was sent, and a code was
-- wrong. Changing a password or disabling the account still ends sessions;
-- it also forgets every trusted device (auth.set_password is unchanged, the
-- API does it).
alter table auth.login_events drop constraint if exists login_events_outcome_check;
alter table auth.login_events add constraint login_events_outcome_check
  check (outcome in ('ok', 'bad_password', 'unknown_email', 'disabled', 'locked', 'mfa_sent', 'mfa_failed'));

-- A new password forgets every trusted device: the person proving they hold
-- the mailbox is the same proof the code gives, and a device trusted under
-- the old password should not survive it.
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
  delete from auth.mfa_devices where user_id = v_id;
  perform auth.set_password(v_email, p_password);
  return true;
end;
$$;
