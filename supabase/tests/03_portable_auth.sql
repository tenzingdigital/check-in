-- Portable-auth-only tests. Run by ./supabase/tests/run.sh --portable.
--
-- 01 and 02 prove the security model works when identity is already
-- established. They cannot cover auth.resolve_user(), because on Supabase that
-- function does not exist. It is the one piece of genuinely new logic in
-- portable-auth.sql, and it sits directly on the login path — so it gets its
-- own suite.
--
-- These tests run last, after 01 and 02, and create their own users; they do
-- not disturb the fixtures those suites built.

\set ON_ERROR_STOP on
\pset pager off

create or replace function pg_temp.expect(label text, actual anyelement, expected anyelement)
returns void language plpgsql as $$
begin
  if actual is distinct from expected then
    raise exception 'ASSERTION FAILED: % — expected %, got %', label, expected, actual;
  end if;
  raise notice '  ok  %', label;
end;
$$;

-- pg_temp does not survive across psql sessions, so this is copied from
-- 01_acceptance.sql rather than shared.
create or replace function pg_temp.try(label text, stmt text) returns text
language plpgsql as $$
declare n bigint;
begin
  execute stmt;
  get diagnostics n = row_count;
  if n = 0 then
    return format('  no-op    %s  (0 rows)', label);
  end if;
  return format('  ALLOWED  %s  (%s row(s))', label, n);
exception when others then
  return format('  blocked  %s  (%s)', label, sqlerrm);
end $$;

reset role;
select set_config('request.jwt.claim.sub', '', true);

\echo '=========== PORTABLE AUTH: first login ==========='

do $$
declare
  v_id      uuid;
  v_profile record;
begin
  v_id := auth.resolve_user('clerk|user_2abcDEF', 'nuala@example.test', 'Nuala Byrne');

  perform pg_temp.expect('resolve_user returns a uuid for a new subject', v_id is not null, true);

  perform pg_temp.expect(
    'the provider subject is stored verbatim, not coerced to a uuid',
    (select provider_subject from auth.users where id = v_id),
    'clerk|user_2abcDEF'::text
  );

  -- schema.sql's on_auth_user_created trigger must have fired.
  select * into v_profile from public.profiles where id = v_id;
  perform pg_temp.expect('first login creates a profiles row', v_profile.id, v_id);
  perform pg_temp.expect('full name comes from the provider', v_profile.full_name, 'Nuala Byrne'::text);
  perform pg_temp.expect('a new account is a guard, never an admin', v_profile.role, 'guard'::text);
  perform pg_temp.expect('a new account is active', v_profile.active, true);
end $$;

\echo '--- a missing display name falls back to email, then to the subject'

do $$
declare v_id uuid;
begin
  v_id := auth.resolve_user('zitadel|30982', 'padraig@example.test', null);
  perform pg_temp.expect('blank full name falls back to email',
    (select full_name from public.profiles where id = v_id), 'padraig@example.test'::text);

  v_id := auth.resolve_user('logto|xyz789', null, '   ');
  perform pg_temp.expect('whitespace-only name and no email falls back to the subject',
    (select full_name from public.profiles where id = v_id), 'logto|xyz789'::text);
end $$;

\echo '=========== PORTABLE AUTH: repeat login ==========='

do $$
declare
  v_first  uuid;
  v_second uuid;
  v_count  integer;
begin
  v_first  := auth.resolve_user('auth0|abc123', 'sean@example.test', 'Seán Ó Riain');
  v_second := auth.resolve_user('auth0|abc123', 'sean@example.test', 'Seán Ó Riain');

  perform pg_temp.expect('the same subject always maps to the same uuid', v_second, v_first);

  select count(*) into v_count from auth.users where provider_subject = 'auth0|abc123';
  perform pg_temp.expect('a repeat login does not create a second user', v_count, 1);

  select count(*) into v_count from public.profiles where id = v_first;
  perform pg_temp.expect('a repeat login does not create a second profile', v_count, 1);

  -- Changing the email at the provider should follow through.
  perform auth.resolve_user('auth0|abc123', 'sean.oriain@example.test', 'Seán Ó Riain');
  perform pg_temp.expect('a changed provider email is picked up',
    (select email from auth.users where id = v_first), 'sean.oriain@example.test'::text);
end $$;

\echo '--- a role granted in the database survives the next login'
-- The attack this blocks: someone who can edit their own profile at the
-- identity provider adds "role": "admin" and expects the next login to apply
-- it. resolve_user has no role parameter at all, so there is nothing to apply.
-- The inverse matters just as much: an admin promoted here must not be demoted
-- back to guard the next time they sign in.

do $$
declare v_id uuid;
begin
  v_id := auth.resolve_user('clerk|user_promoted', 'aoife@example.test', 'Aoife Ní Dhomhnaill');
  update public.profiles set role = 'admin' where id = v_id;

  perform auth.resolve_user('clerk|user_promoted', 'aoife@example.test', 'Aoife Ní Dhomhnaill');

  perform pg_temp.expect('a database-granted admin role is not reset by logging in again',
    (select role from public.profiles where id = v_id), 'admin'::text);

  -- And the provider cannot push a role in, because there is no way to pass
  -- one. Assert the whole signature rather than the absence of one parameter
  -- name: a role argument called anything at all would fail this.
  perform pg_temp.expect('resolve_user accepts only subject, email and name',
    (select pg_get_function_arguments(p.oid)
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'auth' and p.proname = 'resolve_user'),
    'p_subject text, p_email text DEFAULT NULL::text, p_full_name text DEFAULT NULL::text'::text);
end $$;

\echo '=========== PORTABLE AUTH: rejected input ==========='

do $$
declare v_msg text;
begin
  begin
    perform auth.resolve_user('', 'nobody@example.test', 'Nobody');
    raise exception 'ASSERTION FAILED: an empty subject was accepted';
  exception when sqlstate '22023' then
    get stacked diagnostics v_msg = message_text;
    perform pg_temp.expect('an empty provider subject is rejected',
      v_msg like '%provider subject is required%', true);
  end;

  begin
    perform auth.resolve_user('   ', null, null);
    raise exception 'ASSERTION FAILED: a whitespace-only subject was accepted';
  exception when sqlstate '22023' then
    perform pg_temp.expect('a whitespace-only provider subject is rejected', true, true);
  end;

  begin
    perform auth.resolve_user(null, null, null);
    raise exception 'ASSERTION FAILED: a null subject was accepted';
  exception when sqlstate '22023' then
    perform pg_temp.expect('a null provider subject is rejected', true, true);
  end;
end $$;

\echo '--- two identity records can never share one provider subject'
select pg_temp.try(
  'insert a duplicate provider_subject',
  $$insert into auth.users (provider_subject, email) values ('auth0|abc123', 'impostor@example.test')$$
);

\echo '=========== PORTABLE AUTH: auth.uid() ==========='

do $$
declare v_id uuid;
begin
  select id into v_id from auth.users where provider_subject = 'auth0|abc123';

  perform set_config('request.jwt.claim.sub', v_id::text, true);
  perform pg_temp.expect('auth.uid() returns the identity the backend set', auth.uid(), v_id);
  perform pg_temp.expect('my_role() resolves through auth.uid()', public.my_role(), 'guard'::text);

  -- An unset claim must be nobody, not an error and not a stale identity. A
  -- pooled connection that leaked the previous request's user here would be a
  -- silent authorisation failure.
  perform set_config('request.jwt.claim.sub', '', true);
  perform pg_temp.expect('an unset claim makes auth.uid() null', auth.uid(), null::uuid);
  perform pg_temp.expect('an unset claim has no role', public.my_role(), 'none'::text);
end $$;

\echo '=========== PORTABLE AUTH: who may call resolve_user ==========='
-- Only the backend, connecting as a privileged role, mints identities. If a
-- guard session could call this it could create accounts at will; if anon
-- could, anyone on the internet could.

set role anon;
select pg_temp.try(
  'anon calls resolve_user',
  $$select auth.resolve_user('clerk|attacker', 'attacker@example.test', 'Attacker')$$
);
reset role;

set role authenticated;
select pg_temp.try(
  'a signed-in guard calls resolve_user',
  $$select auth.resolve_user('clerk|attacker', 'attacker@example.test', 'Attacker')$$
);
reset role;

do $$
begin
  perform pg_temp.expect('no account was created by those attempts',
    (select count(*)::integer from auth.users where provider_subject = 'clerk|attacker'), 0);
end $$;

\echo '=========== PORTABLE AUTH: no credentials are stored ==========='
-- Authentication happens at the provider. If a password, hash or token column
-- ever appears here, this database has become a credential store and inherits
-- every obligation that comes with one.

do $$
begin
  perform pg_temp.expect('auth.users holds no credential columns',
    (select count(*)::integer
       from information_schema.columns
      where table_schema = 'auth' and table_name = 'users'
        and (column_name ~* 'password|secret|token|hash')),
    0);
end $$;
