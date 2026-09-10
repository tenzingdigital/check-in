-- 037_weekly_report_recipients.sql — the Sunday email's recipients move to
-- the staff record.
--
-- Recipients of the Weekly register update (035) were a comma-separated
-- list of arbitrary addresses typed into Settings: any address at all, with
-- no login and no tie to the centre's own staff, so resident data could be
-- emailed to anyone an administrator typed. That shipped on 10 September
-- 2026 and was never configured in production, since production has no
-- mail credentials — there is no data to carry across.
--
-- Recipients are now a flag on the staff record, profiles.weekly_report:
-- every recipient is a known person with a login. Disabling or demoting
-- someone off supervisor/admin stops their mail the moment it happens.
--
-- Only a supervisor or an admin may run a report (is_supervisor()); the
-- Sunday email is a report, so a guard must never be able to carry the
-- flag. That is held in the database, not only in the route: a check
-- constraint refuses the combination — a deliberate attempt to tick a
-- guard is a 400 (translateDbError) — and a trigger clears the flag on the
-- role change itself, so a demotion to guard never fails because of it; it
-- quietly stops the mail instead. The trigger only acts when the role is
-- actually changing to guard (or an account is created as one) — it must
-- not silently swallow a deliberate attempt to tick an existing guard,
-- which is exactly the case the constraint above exists to refuse.
alter table public.profiles
  add column if not exists weekly_report boolean not null default false;
comment on column public.profiles.weekly_report is 'Receives the Sunday Weekly register update (035). Only a supervisor or admin may carry this — a guard cannot run the report it summarises.';

create or replace function public.profiles_clear_weekly_report_for_guard()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.role = 'guard' and (tg_op = 'INSERT' or old.role is distinct from new.role) then
    new.weekly_report := false;
  end if;
  return new;
end;
$$;
revoke all on function public.profiles_clear_weekly_report_for_guard() from public, anon, authenticated;
drop trigger if exists profiles_weekly_report_guard on public.profiles;
create trigger profiles_weekly_report_guard
  before insert or update on public.profiles
  for each row execute function public.profiles_clear_weekly_report_for_guard();

-- The route refuses a deliberate attempt to tick a guard, translating this
-- into a plain 400; this is the actual guarantee, reached by any writer.
alter table public.profiles drop constraint if exists profiles_weekly_report_not_guard;
alter table public.profiles
  add constraint profiles_weekly_report_not_guard check (not (weekly_report and role = 'guard'));

-- The old setting: shipped this afternoon (035), never configured, no data
-- to lose. Replaced by profiles.weekly_report above.
alter table public.app_settings drop column if exists weekly_report_recipients;
