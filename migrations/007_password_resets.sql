-- ---------------------------------------------------------------------------
-- 007_password_resets.sql — "I forgot my password", without a shell.
-- ---------------------------------------------------------------------------
--
-- Until now the only ways to change a password were `node staff.js passwd`
-- (needs a shell and the database URL) and an admin resetting somebody else
-- from the Staff tab. Neither helps the person who is locked out, and the
-- second one cannot help the last remaining admin at all: there is nobody
-- above them to do it.
--
-- The shape follows auth.sessions exactly, for the same reasons:
--
--   * The token itself is never stored. The emailed link carries 32 random
--     bytes and this table holds their SHA-256, so a leaked backup contains
--     nothing that can be replayed to seize an account.
--   * Single use and short lived. used_at is set in the same statement that
--     changes the password, so a link forwarded, logged or left in a browser
--     history is spent the moment it works once.
--   * Redeeming goes through auth.set_password(), which already deletes every
--     session for the account. Whoever was logged in with the old password is
--     logged out by the reset, which is the point.
--
-- Deliberately NOT here: any hint about whether an address exists. Both
-- functions return a plain boolean and the route above them always answers
-- the same way, so this cannot be used to enumerate staff emails.

create table if not exists auth.password_resets (
  token_sha256 bytea primary key,
  user_id      uuid not null references auth.users (id) on delete cascade,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  used_at      timestamptz
);

create index if not exists password_resets_user_idx    on auth.password_resets (user_id);
create index if not exists password_resets_expires_idx on auth.password_resets (expires_at);

comment on table auth.password_resets is
  'Outstanding password-reset links. Holds the SHA-256 of the token, never the token.';


-- Issue a reset. Returns the full name to greet in the email, or null when
-- the address is unknown or the account is deactivated. The caller must treat
-- null as a non-event and still answer the browser identically.
--
-- Two guards against being used as a mail cannon:
--   * a request within RESEND_GAP of an existing live token is a no-op, so
--     hammering the form cannot fill somebody's inbox;
--   * issuing a new token invalidates that account's older unused ones, so at
--     most one link is ever live per person.
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
  join public.profiles p on p.id = u.id
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
    return null;                              -- too soon; silently do nothing
  end if;

  -- At most one live link per account.
  delete from auth.password_resets
  where user_id = v_id and used_at is null;

  insert into auth.password_resets (token_sha256, user_id, expires_at)
  values (p_token_sha256, v_id, now() + make_interval(mins => greatest(5, least(p_ttl_minutes, 1440))));

  return v_name;
end;
$$;


-- Spend a reset link. False when the token is unknown, expired, already used,
-- or the account has since been deactivated. The password rule (12 characters)
-- is enforced by auth.set_password(), which raises rather than returning
-- false, so a short password is a 400 and a bad token is a 400 with a
-- different message.
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
  -- FOR UPDATE so two submissions of the same link cannot both win.
  select r.user_id into v_id
  from auth.password_resets r
  join public.profiles p on p.id = r.user_id
  where r.token_sha256 = p_token_sha256
    and r.used_at is null
    and r.expires_at > now()
    and p.active
  for update of r;

  if v_id is null then
    return false;
  end if;

  select email into v_email from auth.users where id = v_id;

  -- Marked spent BEFORE the password changes: if set_password raises (a
  -- password under 12 characters), the whole statement rolls back together
  -- and the link survives for another try. If it succeeds, the link is gone.
  update auth.password_resets set used_at = now() where token_sha256 = p_token_sha256;

  -- Ends every existing session for the account, which is the revocation the
  -- reset exists to perform.
  perform auth.set_password(v_email, p_password);
  return true;
end;
$$;


create or replace function auth.purge_expired_password_resets()
returns integer
language plpgsql
security definer
set search_path = auth
as $$
declare v_n integer;
begin
  delete from auth.password_resets
  where expires_at < now() - interval '7 days'
     or (used_at is not null and used_at < now() - interval '7 days');
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;


-- Same lockdown as every other definer-rights helper in 001. These run on the
-- owner connection from routes/password-reset.js; no request role may call
-- them, or "reset anybody's password" would be one query away from a guard.
revoke all on function auth.create_password_reset(text, bytea, integer) from public, anon, authenticated;
revoke all on function auth.redeem_password_reset(bytea, text)          from public, anon, authenticated;
revoke all on function auth.purge_expired_password_resets()             from public, anon, authenticated;
revoke all on auth.password_resets from anon, authenticated, service_role;
