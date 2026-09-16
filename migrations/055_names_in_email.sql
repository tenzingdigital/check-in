-- 055_names_in_email.sql — the Sunday document attaches by default.
--
-- 16 September 2026, Slaney Manor: the manager reads the nightly email
-- and the Sunday return on her phone and does not want the names behind a
-- login. The nightly email names its rows from this deploy (jobs.js,
-- lib/nightlyEmail.js — no schema for that); the Sunday email's Word
-- document (052) becomes the default rather than a switch a centre has to
-- find. The switch stays: a centre that wants counts only can still turn
-- it off under Settings.
alter table public.app_settings alter column weekly_report_attach_document set default true;
update public.app_settings set weekly_report_attach_document = true;
-- Existing tenant schemas, as 052 did: the template cannot patch a default
-- onto an app_settings already provisioned.
do $$
declare s text;
begin
  for s in select nspname from pg_namespace where nspname like 't\_%' escape '\' loop
    execute format('alter table %I.app_settings alter column weekly_report_attach_document set default true', s);
    execute format('update %I.app_settings set weekly_report_attach_document = true', s);
  end loop;
end $$;
