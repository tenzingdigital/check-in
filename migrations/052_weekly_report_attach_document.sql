-- 052_weekly_report_attach_document.sql — attach the Sunday Weekly Register
-- Update to its email as a Word document.
--
-- Since 037 the Sunday email has carried counts and a link only: no resident
-- is named in it. The centre manager who receives it today compiles a Word
-- document by hand from the app and forwards it to head office, who copy the
-- names into the two IPAS registers (site visit, 15 September 2026). She asked
-- for the document itself, editable, at 10:00 on Sunday. This switch attaches
-- it. It is OFF by default because the document names residents, rooms and
-- dates, and a service that wants nothing about a resident to leave by email
-- must keep that promise without knowing this switch exists. Recipients are
-- unchanged: the supervisors and admins ticked on the staff record.
alter table public.app_settings
  add column if not exists weekly_report_attach_document boolean not null default false;
comment on column public.app_settings.weekly_report_attach_document is
  'Attach the Weekly Register Update to the Sunday email as a Word document. It names residents and rooms; off unless the centre turns it on (052).';

-- database.js migrates public only (docs/KNOWN-ISSUES.md §4); a tenant
-- schema provisioned before this file would keep the old column list and
-- routes/settings.js would 500 on the select. Additive and idempotent, so it
-- is safe to reach into every tenant schema from here.
do $$
declare s text;
begin
  for s in select nspname from pg_namespace where nspname like 't\_%' escape '\' loop
    execute format('alter table %I.app_settings add column if not exists weekly_report_attach_document boolean not null default false', s);
  end loop;
end $$;
