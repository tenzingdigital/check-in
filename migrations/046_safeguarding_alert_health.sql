-- The nightly safeguarding alert (041) has a dead-man's-switch problem: it
-- ships with nobody ticked to receive it (safeguarding_alert defaults
-- false), and when nobody has it, the nightly job records "no recipients"
-- and sends nothing -- ok=true, no email, no complaint of any kind. Every
-- other check this app runs eventually surfaces on a screen: a close-out
-- that stops shows red on every terminal (v_system_health.close_out_behind,
-- migration 012); a job that fails is a recent_failure. A safeguarding
-- alert nobody is signed up for fails neither test -- it just never fires --
-- so a centre could go live and have this entire feature sit inert,
-- indefinitely, with nothing anywhere saying so.
--
-- Added to v_system_health as unattended-switch monitoring, not a compliance
-- rule of its own: it says nothing about whether a centre uses the feature,
-- only whether the box that turns it on has ever been ticked.

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
  ) as close_out_behind,
  not exists (
    select 1 from public.profiles p join auth.users u on u.id = p.id
     where p.active and p.safeguarding_alert and p.role in ('supervisor', 'admin') and u.email is not null
  ) as safeguarding_alert_unset
where public.is_staff();

revoke all on public.v_system_health from anon, public;
grant select on public.v_system_health to authenticated;
