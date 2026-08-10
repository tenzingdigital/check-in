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

-- Assertion helper. RLS does not raise on SELECT, it silently filters rows to
-- zero, so reporting on success/failure alone would call a blocked read
-- "ALLOWED". Report the affected row count too.
-- Copied verbatim from 01_acceptance.sql: pg_temp does not carry across
-- separate psql sessions, and each `psql -f` invocation is its own session.
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

\echo '=========== CALENDAR-DAY HELPERS ==========='
\echo '--- site_today() follows app_settings.local_timezone, not the server clock'
update public.app_settings set local_timezone = 'Pacific/Kiritimati';  -- UTC+14
select public.site_today() as kiritimati_today;
update public.app_settings set local_timezone = 'Pacific/Midway';      -- UTC-11
select public.site_today() as midway_today;
update public.app_settings set local_timezone = 'Europe/Dublin';

-- Don't assert literal dates — they rot daily. Assert the invariant instead:
-- Kiritimati (UTC+14) is never behind Midway (UTC-11), and the two are at
-- most one day apart.
do $$
declare
  v_kiritimati date;
  v_midway     date;
begin
  update public.app_settings set local_timezone = 'Pacific/Kiritimati';
  select public.site_today() into v_kiritimati;
  update public.app_settings set local_timezone = 'Pacific/Midway';
  select public.site_today() into v_midway;
  update public.app_settings set local_timezone = 'Europe/Dublin';

  perform pg_temp.expect(
    'kiritimati_today >= midway_today',
    v_kiritimati >= v_midway,
    true
  );
  perform pg_temp.expect(
    'kiritimati_today and midway_today differ by at most one day',
    (v_kiritimati - v_midway) <= 1,
    true
  );

  -- Later tasks depend on this being Europe/Dublin — confirm the restore stuck.
  perform pg_temp.expect(
    'local_timezone restored to Europe/Dublin',
    (select local_timezone from public.app_settings where id),
    'Europe/Dublin'
  );
end $$;

\echo '--- compliance_required: the 18th-birthday boundary, computed per day'
select
  public.compliance_required(date '2008-08-10', date '2020-01-01', null, date '2026-08-09', 18) as day_before_18th,
  public.compliance_required(date '2008-08-10', date '2020-01-01', null, date '2026-08-10', 18) as on_18th_birthday,
  public.compliance_required(date '2008-08-10', date '2020-01-01', null, date '2026-08-11', 18) as day_after_18th;

do $$
begin
  perform pg_temp.expect('day_before_18th = false',
    public.compliance_required(date '2008-08-10', date '2020-01-01', null, date '2026-08-09', 18), false);
  perform pg_temp.expect('on_18th_birthday = true',
    public.compliance_required(date '2008-08-10', date '2020-01-01', null, date '2026-08-10', 18), true);
  perform pg_temp.expect('day_after_18th = true',
    public.compliance_required(date '2008-08-10', date '2020-01-01', null, date '2026-08-11', 18), true);
end $$;

\echo '--- compliance_required: registration and departure bound the duty'
select
  public.compliance_required(date '1990-01-01', date '2026-08-05', null,             date '2026-08-04', 18) as before_registration,
  public.compliance_required(date '1990-01-01', date '2026-08-05', null,             date '2026-08-05', 18) as on_registration_day,
  public.compliance_required(date '1990-01-01', date '2026-08-05', date '2026-08-20', date '2026-08-20', 18) as on_departure_day,
  public.compliance_required(date '1990-01-01', date '2026-08-05', date '2026-08-20', date '2026-08-21', 18) as after_departure;

do $$
begin
  perform pg_temp.expect('before_registration = false',
    public.compliance_required(date '1990-01-01', date '2026-08-05', null, date '2026-08-04', 18), false);
  perform pg_temp.expect('on_registration_day = true',
    public.compliance_required(date '1990-01-01', date '2026-08-05', null, date '2026-08-05', 18), true);
  perform pg_temp.expect('on_departure_day = true',
    public.compliance_required(date '1990-01-01', date '2026-08-05', date '2026-08-20', date '2026-08-20', 18), true);
  perform pg_temp.expect('after_departure = false',
    public.compliance_required(date '1990-01-01', date '2026-08-05', date '2026-08-20', date '2026-08-21', 18), false);
end $$;

\echo ''
\echo '=========== LEDGER INTEGRITY ==========='
do $$
begin
  -- Without these, the try() probes below are vacuous: try() swallows
  -- "relation does not exist" and reports it as "blocked", so a dropped table
  -- would look exactly like a working RLS denial.
  perform pg_temp.expect('checkin_events exists',
    to_regclass('public.checkin_events') is not null, true);
  perform pg_temp.expect('daily_compliance exists',
    to_regclass('public.daily_compliance') is not null, true);

  perform pg_temp.expect('RLS enabled on checkin_events',
    (select relrowsecurity from pg_class where oid = 'public.checkin_events'::regclass), true);
  perform pg_temp.expect('RLS enabled on daily_compliance',
    (select relrowsecurity from pg_class where oid = 'public.daily_compliance'::regclass), true);

  -- The append-only property, asserted directly rather than inferred from a
  -- swallowed error: exactly one SELECT policy and no write policies at all.
  perform pg_temp.expect('checkin_events has exactly 1 select policy',
    (select count(*)::integer from pg_policies
      where schemaname='public' and tablename='checkin_events' and cmd='SELECT'), 1);
  perform pg_temp.expect('checkin_events has no write policies',
    (select count(*)::integer from pg_policies
      where schemaname='public' and tablename='checkin_events' and cmd <> 'SELECT'), 0);
  perform pg_temp.expect('daily_compliance has exactly 1 select policy',
    (select count(*)::integer from pg_policies
      where schemaname='public' and tablename='daily_compliance' and cmd='SELECT'), 1);
  perform pg_temp.expect('daily_compliance has no write policies',
    (select count(*)::integer from pg_policies
      where schemaname='public' and tablename='daily_compliance' and cmd <> 'SELECT'), 0);
end $$;

set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select pg_temp.try('guard UPDATEs a checkin event',
                   'update public.checkin_events set note=''x'' where true');
select pg_temp.try('guard DELETEs a checkin event',
                   'delete from public.checkin_events where true');
select pg_temp.try('guard UPDATEs the register directly',
                   'update public.daily_compliance set presented=true where true');
select pg_temp.try('guard DELETEs a register row',
                   'delete from public.daily_compliance where true');
reset role;
