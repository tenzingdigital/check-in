-- ---------------------------------------------------------------------------
-- 003_request_role_membership.sql
-- ---------------------------------------------------------------------------
-- Let the application's own database role become `anon` / `authenticated`.
--
-- withIdentity() in database.js opens a transaction and issues
--
--   SET LOCAL ROLE authenticated;
--
-- so that every policy in 002_schema.sql applies to the request. `SET ROLE`
-- requires MEMBERSHIP of the target role — creating the role is not enough, and
-- owning every table in the database is not enough either.
--
-- Missing that membership, every single API call that touches resident data
-- fails with
--
--   ERROR: permission denied to set role "authenticated"
--
-- which in the browser looks like this: the login POST succeeds (it runs on the
-- owning connection, so it never needs SET ROLE), the cookie is set, and then
-- the very next request — GET /api/session — 500s and the front end drops
-- straight back to the login screen. Correct password, no error about the
-- password, no way in.
--
-- This did not show up in the test suites for a structural reason worth
-- remembering: they connected to the throwaway cluster as the `postgres`
-- superuser, and a superuser may SET ROLE to anything. Production connects as
-- an ordinary user. test/cluster.sh now builds its cluster the same way Render
-- does — a non-superuser role that owns the database — so this whole class of
-- privilege bug is reproducible locally from here on.
--
-- Granting membership weakens nothing. The application role already owns every
-- table and bypasses row-level security by virtue of that ownership; dropping
-- INTO `authenticated` is strictly a reduction in privilege, which is the whole
-- point of doing it per request.

do $$
declare
  request_role text;
begin
  foreach request_role in array array['anon', 'authenticated', 'service_role'] loop
    -- A superuser already passes this check implicitly, so it is a no-op there
    -- rather than a redundant grant.
    if not pg_has_role(current_user, request_role, 'USAGE') then
      begin
        execute format('grant %I to current_user', request_role);
      exception when insufficient_privilege then
        -- Fail the deploy with something actionable rather than starting a
        -- service whose every authenticated request will 500. The role that
        -- creates these roles normally holds ADMIN OPTION on them; this only
        -- bites when they were created by somebody else.
        raise exception
          'Cannot grant % to %. The application cannot SET ROLE and every API call will fail. '
          'Run, as a superuser or a role holding ADMIN OPTION: '
          'GRANT anon, authenticated, service_role TO %;',
          request_role, current_user, current_user;
      end;
    end if;
  end loop;
end $$;
