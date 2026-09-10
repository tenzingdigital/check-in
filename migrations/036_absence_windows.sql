-- 036_absence_windows.sql — the permitted absence periods IPAS notifies.
--
-- Christmas, Ramadan, Easter, the summer school holiday: dates that change
-- every year, held here by an administrator so the app can say when a
-- holiday falls outside them. It says so; it does not refuse. The 14-day
-- cap (029) and the guardian rule are unchanged. Policy, not a person:
-- no retention clock, kept until removed.

create table if not exists public.absence_windows (
  id         bigserial primary key,
  name       text not null check (length(btrim(name)) between 1 and 60),
  from_date  date not null,
  to_date    date not null,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  check (to_date >= from_date)
);
comment on table public.absence_windows is 'Permitted absence periods notified by IPAS. A holiday authorised outside every window carries a warning; nothing is refused.';

alter table public.absence_windows enable row level security;
drop policy if exists absence_windows_read on public.absence_windows;
create policy absence_windows_read on public.absence_windows for select using (public.is_staff());
drop policy if exists absence_windows_admin on public.absence_windows;
create policy absence_windows_admin on public.absence_windows for all using (public.is_admin()) with check (public.is_admin());
revoke all on public.absence_windows from anon, public, authenticated;
grant select, insert, delete on public.absence_windows to authenticated;
grant usage on sequence public.absence_windows_id_seq to authenticated;

drop trigger if exists absence_windows_audit on public.absence_windows;
create trigger absence_windows_audit
  after insert or update or delete on public.absence_windows
  for each row execute function public.audit_row();

-- Does the whole span lie inside one window? False when there are no
-- windows at all is not useful, so the caller asks separately whether any
-- exist (routes/residents.js).
create or replace function public.inside_absence_window(p_from date, p_to date)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.absence_windows w
                  where daterange(w.from_date, w.to_date, '[]') @> daterange(p_from, p_to, '[]'));
$$;
revoke all on function public.inside_absence_window(date, date) from public, anon;
grant execute on function public.inside_absence_window(date, date) to authenticated;
