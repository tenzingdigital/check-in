-- 032: the staff reminder by email when the House Rules figures are reached.
--
-- Off by default. On, the nightly job (jobs.js) emails every active
-- supervisor and administrator a short list of residents at or over the
-- consecutive-nights or rolling-window figure, after close-out, on the
-- nights there is anyone to list. Needs email configured on the service.
alter table public.app_settings
  add column if not exists notify_thresholds_email boolean not null default false;
comment on column public.app_settings.notify_thresholds_email is 'Email supervisors and admins nightly when a resident is at or over a House Rules figure (jobs.js).';
