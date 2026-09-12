-- ---------------------------------------------------------------------------
-- 004_staff_admin.sql — let administrators manage staff accounts from the app.
-- ---------------------------------------------------------------------------
--
-- Until now the only ways to add a staff account were `node staff.js add` and
-- psql — both need a shell, and an administrator standing at the hut has
-- neither. This gives the admin role the same operations through the API.
--
-- The shape follows the rest of the schema: the API route stays a thin
-- transport and the AUTHORISATION lives here, in SECURITY DEFINER functions
-- that re-check public.is_admin() themselves. auth.create_user() and the
-- password machinery stay revoked from the request roles; these wrappers are
-- the only doors, and each one is gated.
--
-- Deactivation and role changes need no function at all: the
-- profiles_admin_all policy already lets an admin update public.profiles under
-- the authenticated role, and sessionFromToken() joins profiles.active on
-- every request, so flipping the flag revokes access immediately.

-- Create a staff account. Delegates to auth.create_user(), which enforces the
-- role whitelist and the 12-character password minimum and fires the trigger
-- that creates the profiles row.
create or replace function public.admin_create_staff(
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
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can create staff accounts'
      using errcode = '42501';
  end if;
  if position('@' in coalesce(btrim(p_email), '')) < 2 then
    raise exception 'A valid email address is required' using errcode = '22023';
  end if;
  if length(coalesce(btrim(p_full_name), '')) = 0 then
    raise exception 'A name is required' using errcode = '22023';
  end if;

  return auth.create_user(p_email, p_password, btrim(p_full_name), p_role);
exception when unique_violation then
  raise exception 'An account with that email already exists'
    using errcode = '22023';
end;
$$;

comment on function public.admin_create_staff(text, text, text, text) is
  'Admin-gated wrapper around auth.create_user(), so the Staff tab can add accounts without a shell.';

-- Reset a staff password. Same hashing parameters as auth.set_password(), and
-- the same revocation rule: a changed password ends every session that was
-- opened with the old one, including the account holder''s own.
create or replace function public.admin_set_staff_password(
  p_user_id  uuid,
  p_password text
)
returns boolean
language plpgsql
security definer
set search_path = auth, extensions
as $$
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can reset passwords'
      using errcode = '42501';
  end if;
  if length(coalesce(p_password, '')) < 12 then
    raise exception 'password must be at least 12 characters'
      using errcode = '22023';
  end if;

  update auth.users
     set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf', 12))
   where id = p_user_id;
  if not found then
    return false;
  end if;

  delete from auth.sessions where user_id = p_user_id;
  return true;
end;
$$;

comment on function public.admin_set_staff_password(uuid, text) is
  'Admin-gated password reset. Logs out every session for that account. Returns false if no such user.';

-- Same lockdown as the auth.* helpers: Postgres grants EXECUTE to PUBLIC on
-- every new function, and a SECURITY DEFINER function is only as safe as the
-- grant in front of it. Grant back exactly the role that carries requests —
-- the is_admin() check inside is what narrows it further.
revoke all on function public.admin_create_staff(text, text, text, text) from public;
revoke all on function public.admin_set_staff_password(uuid, text)       from public;
grant execute on function public.admin_create_staff(text, text, text, text) to authenticated;
grant execute on function public.admin_set_staff_password(uuid, text)       to authenticated;
