-- ---------------------------------------------------------------------------
-- 013_invite_staff.sql — a staff account starts with no password.
-- ---------------------------------------------------------------------------
--
-- Until now an administrator invented a twelve-character password for each
-- new colleague, typed it on a phone, and handed it over in person. That is
-- a password two people know, chosen by the wrong one of them. Now the
-- account is created with the unguessable default hash from 001 — a value
-- nobody has ever seen, that no login can match — and the new colleague
-- receives the existing single-use reset link, re-worded as an invitation.
-- Choosing a password through it is the only way the account ever gets one.
--
-- auth.create_user() stays for the CLI and the first-admin bootstrap, where
-- there is no email to send to.

create or replace function auth.create_user_invited(
  p_email     text,
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
  if position('@' in coalesce(btrim(p_email), '')) < 2 then
    raise exception 'A valid email address is required' using errcode = '22023';
  end if;
  if length(coalesce(btrim(p_full_name), '')) = 0 then
    raise exception 'A name is required' using errcode = '22023';
  end if;

  -- encrypted_password takes its default: a bcrypt hash of a random uuid.
  insert into auth.users (email, raw_user_meta_data)
  values (btrim(p_email), jsonb_build_object('full_name', btrim(p_full_name), 'role', p_role))
  returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception 'An account with that email already exists' using errcode = '22023';
end;
$$;

revoke all on function auth.create_user_invited(text, text, text) from public, anon, authenticated, service_role;

-- The admin-gated door, same shape as admin_create_staff().
create or replace function public.admin_invite_staff(
  p_email     text,
  p_full_name text,
  p_role      text default 'guard'
)
returns uuid
language plpgsql
security definer
set search_path = auth, public, extensions
as $$
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can create staff accounts' using errcode = '42501';
  end if;
  return auth.create_user_invited(p_email, p_full_name, p_role);
end;
$$;

comment on function public.admin_invite_staff(text, text, text) is
  'Admin-gated: creates an account that cannot log in until the emailed link is used to choose a password.';

revoke all on function public.admin_invite_staff(text, text, text) from public, anon;
grant execute on function public.admin_invite_staff(text, text, text) to authenticated;
