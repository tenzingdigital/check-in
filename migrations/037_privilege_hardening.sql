-- 037: close the privileges that row-level security was never able to govern.
--
-- 001 reproduces Supabase's default privileges on purpose (001:178-186) so the
-- policies, not the grants, are what the suite proves. That was the right call
-- for the migration off Supabase, and it carried three holes across with it.
-- All three are invisible to RLS, so no policy test could ever have caught them:
--
--   1. TRUNCATE is not filtered by row-level security. It needs the privilege
--      bit and nothing else. `truncate public.gate_events` was permitted for
--      anon and authenticated, which makes "no role holds UPDATE or DELETE on
--      the ledger" true and beside the point.
--   2. Referential cascades run below both RLS and the privilege system.
--      residents_supervisor was FOR ALL, which includes DELETE, and four FKs
--      cascade off residents — so a supervisor could take the whole ledger with
--      one statement and leave no erasure_log row behind.
--   3. A revoke from PUBLIC does not remove a direct grant to authenticated.
--      002's four maintenance functions revoked from `anon, public` only, so
--      every later migration's `revoke ... from authenticated` is the correct
--      pattern and those four are the ones that predate it.
--
-- Nothing here changes what the application can do. Every path in routes/ still
-- works: erase_resident() is SECURITY INVOKER and gated on is_admin(), so the
-- admin-only DELETE policy is the role it already ran as.

-- ---------------------------------------------------------------------------
-- 1. The privilege bits RLS does not govern.
-- ---------------------------------------------------------------------------
revoke truncate, references, trigger on all tables in schema public
  from anon, authenticated, service_role;

-- ...and for every table a future migration adds, so this does not have to be
-- remembered. This is the counterpart to 001's grant of `all on tables`.
alter default privileges in schema public
  revoke truncate, references, trigger on tables
  from anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Split residents_supervisor so DELETE is admin-only.
--
-- A supervisor adds, edits and retires residents. Removing one is an erasure,
-- and an erasure goes through erase_resident() — which computes the digest,
-- counts what it removed and writes erasure_log. Leaving DELETE on the FOR ALL
-- policy meant there was a second way out of the table that recorded nothing.
-- ---------------------------------------------------------------------------
drop policy if exists residents_supervisor on public.residents;

create policy residents_supervisor_insert on public.residents
  for insert with check (public.is_supervisor());
create policy residents_supervisor_update on public.residents
  for update using (public.is_supervisor()) with check (public.is_supervisor());
create policy residents_admin_delete on public.residents
  for delete using (public.is_admin());

-- ---------------------------------------------------------------------------
-- 3. erasure_log becomes append-only, like every other record of what happened.
--
-- FOR ALL let the administrator who performed an erasure delete the row proving
-- they performed it, which is the whole of the Art. 5(2) demonstration. INSERT
-- is kept because erase_resident() is invoker-rights and writes the row as the
-- admin who called it; admin_audit (012:60) already has this shape.
-- ---------------------------------------------------------------------------
drop policy if exists erasure_log_admin on public.erasure_log;

create policy erasure_log_read   on public.erasure_log
  for select using (public.is_admin());
create policy erasure_log_append on public.erasure_log
  for insert with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- 4. The four maintenance functions that predate the revoke convention.
--    None contains a role check, because none was ever meant to need one.
-- ---------------------------------------------------------------------------
revoke all on function public.close_out_compliance_days(date)      from authenticated, service_role;
revoke all on function public.purge_expired_gate_events()          from authenticated, service_role;
revoke all on function public.purge_expired_checkin_events()       from authenticated, service_role;
revoke all on function public.purge_expired_compliance()           from authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Deactivating an account ends its sessions.
--
-- sessionFromToken() joins profiles.active, so access stops on the next
-- request — but the auth.sessions rows survived, and re-enabling inside the
-- 12-hour TTL made every previously issued cookie live again. INCIDENT-
-- RESPONSE.md step 1 tells you to disable and then re-enable after a stolen
-- device, so following the written procedure re-armed the stolen device.
--
-- A trigger rather than a line in routes/staff.js: staff.js (the CLI) and any
-- future admin path get it for free, and it cannot be forgotten at a call site.
-- ---------------------------------------------------------------------------
create or replace function public.end_sessions_on_deactivate()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if old.active and not new.active then
    delete from auth.sessions where user_id = new.id;
  end if;
  return new;
end;
$$;

revoke all on function public.end_sessions_on_deactivate() from public, anon, authenticated, service_role;

drop trigger if exists profiles_end_sessions_on_deactivate on public.profiles;
create trigger profiles_end_sessions_on_deactivate
  after update of active on public.profiles
  for each row execute function public.end_sessions_on_deactivate();

-- ---------------------------------------------------------------------------
-- 6. Two tables from 023 and 030 that revoked from `anon, public` and stopped
--    there, while nine sibling tables in the same range also named
--    `authenticated`. A revoke from PUBLIC does not remove 001's direct grant,
--    so both kept `ALL`.
--
--    Section 1 above already took TRUNCATE back, which was the sharp edge on
--    resident_views (the GDPR access log has a SELECT-only policy, so RLS
--    covers its DML — but RLS has never covered TRUNCATE). What remains is
--    staff_roster, where the retained DELETE privilege meets a FOR ALL policy:
--    a supervisor could delete a roster row outright, and the only thing
--    standing against the table comment's "Archived, never deleted" was the
--    absence of a DELETE route in routes/roster.js. That is Tao 5 inverted —
--    the screen is not the control.
-- ---------------------------------------------------------------------------
revoke all on public.resident_views from authenticated, service_role;
grant select on public.resident_views to authenticated;

revoke all on public.staff_roster   from authenticated, service_role;
grant select, insert, update on public.staff_roster to authenticated;

drop policy if exists staff_roster_supervisor on public.staff_roster;
create policy staff_roster_supervisor_insert on public.staff_roster
  for insert with check (public.is_supervisor());
create policy staff_roster_supervisor_update on public.staff_roster
  for update using (public.is_supervisor()) with check (public.is_supervisor());

-- ---------------------------------------------------------------------------
-- 7. 034's sweep function is the one new function in 021-036 with no revoke,
--    so `anon` holds EXECUTE on it by default privilege. It only deletes spent
--    sign-up rows, but those rows are the support evidence 034 says they are.
-- ---------------------------------------------------------------------------
revoke all on function public.sweep_signup_requests() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. 034's two tables are the only ones in the schema with RLS never enabled;
--    grants alone hold them shut, and they are written by the one
--    unauthenticated endpoint in the system. 001's own header argues against
--    exactly this: grants-only "fails open the moment someone grants a table
--    for an unrelated reason". No policy is needed — the writer is the owner
--    connection, which is exempt — so enabling RLS is deny-by-default.
-- ---------------------------------------------------------------------------
alter table public.signup_requests  enable row level security;
alter table public.tenant_demo_rows enable row level security;
revoke all on public.signup_requests, public.tenant_demo_rows
  from anon, authenticated, service_role, public;
