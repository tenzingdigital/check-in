-- 025: the close-out banner waits for the job's own hour.
--
-- v_system_health.close_out_behind compared the last closed day with
-- yesterday from the first second of the new day, but hut-nightly runs at
-- 00:30 UTC (render.yaml), which is 01:30 in Dublin for half the year. So
-- every register terminal showed "The nightly close-out has not run" in red
-- from midnight until the job ran — a false alarm every night, which is how
-- a real one gets ignored (seen on a phone at 00:09 on 8 September 2026).
--
-- The rule now: until 02:00 site time, the day that must be closed is the
-- day before yesterday; from 02:00, yesterday. 02:00 leaves the job half an
-- hour of headroom in summer and an hour and a half in winter. Same
-- columns, same order; the register page needs no change.
set search_path = public, extensions;

create or replace function public.close_out_due_through()
returns date
language sql stable
set search_path = public
as $$
  select case
    when date_part('hour', now() at time zone (select local_timezone from public.app_settings where id)) < 2
      then public.site_today() - 2
    else public.site_today() - 1
  end;
$$;

comment on function public.close_out_due_through() is
  'The latest day the nightly close-out should have closed by now: yesterday, or the day before until 02:00 site time (hut-nightly runs at 00:30 UTC).';

revoke all on function public.close_out_due_through() from anon, public;
grant execute on function public.close_out_due_through() to authenticated;

create or replace view public.v_system_health as
select
  (select max(compliance_date) from public.daily_compliance where closed_at is not null) as last_closed_day,
  public.site_today() as site_today,
  (select max(ran_at) from public.job_runs where job = 'close-out-compliance-days' and ok) as last_close_out_run,
  (select max(ran_at) from public.job_runs where ok) as last_job_run,
  (select count(*)::integer from public.job_runs where not ok and ran_at > now() - interval '2 days') as recent_failures,
  coalesce(
    (select max(compliance_date) from public.daily_compliance where closed_at is not null) < public.close_out_due_through(),
    -- No closed day at all: behind only once there has been a full day to close.
    exists (select 1 from public.daily_compliance where compliance_date < public.close_out_due_through())
  ) as close_out_behind
where public.is_staff();
