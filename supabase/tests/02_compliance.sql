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
