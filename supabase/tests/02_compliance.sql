\set ON_ERROR_STOP on
\pset pager off

\echo '=========== CALENDAR-DAY HELPERS ==========='
\echo '--- site_today() follows app_settings.local_timezone, not the server clock'
update public.app_settings set local_timezone = 'Pacific/Kiritimati';  -- UTC+14
select public.site_today() as kiritimati_today;
update public.app_settings set local_timezone = 'Pacific/Midway';      -- UTC-11
select public.site_today() as midway_today;
update public.app_settings set local_timezone = 'Europe/Dublin';

\echo '--- compliance_required: the 18th-birthday boundary, computed per day'
select
  public.compliance_required(date '2008-08-10', date '2020-01-01', null, date '2026-08-09', 18) as day_before_18th,
  public.compliance_required(date '2008-08-10', date '2020-01-01', null, date '2026-08-10', 18) as on_18th_birthday,
  public.compliance_required(date '2008-08-10', date '2020-01-01', null, date '2026-08-11', 18) as day_after_18th;

\echo '--- compliance_required: registration and departure bound the duty'
select
  public.compliance_required(date '1990-01-01', date '2026-08-05', null,             date '2026-08-04', 18) as before_registration,
  public.compliance_required(date '1990-01-01', date '2026-08-05', null,             date '2026-08-05', 18) as on_registration_day,
  public.compliance_required(date '1990-01-01', date '2026-08-05', date '2026-08-20', date '2026-08-20', 18) as on_departure_day,
  public.compliance_required(date '1990-01-01', date '2026-08-05', date '2026-08-20', date '2026-08-21', 18) as after_departure;
