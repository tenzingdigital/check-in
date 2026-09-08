-- 027: who was off site at midnight, kept night by night.
--
-- The centre managers' question: not just who is off site now, but who was
-- off site at midnight on any night, historically. Movement events are
-- purged after event_retention_days, so the answer is taken once a night
-- and kept as long as the register: one row per resident per night they
-- were absent, with when they were last seen leaving.
--
-- Written by the nightly job (jobs.js) after the day closes, through a
-- function only the owner may run; staff read it through the "Absent
-- overnight" report. Erasing a resident removes their rows.

create table if not exists public.overnight_absences (
  night          date not null,
  resident_id    uuid not null references public.residents (id) on delete cascade,
  off_site_since timestamptz,
  snapshot_at    timestamptz not null default now(),
  primary key (night, resident_id)
);
create index if not exists overnight_absences_night_idx on public.overnight_absences (night desc);

comment on table public.overnight_absences is 'One row per resident per night they were off site at midnight (site time). Taken by the nightly job; kept as long as the register.';

alter table public.overnight_absences enable row level security;
drop policy if exists overnight_absences_read on public.overnight_absences;
create policy overnight_absences_read on public.overnight_absences for select using (public.is_staff());
revoke all on public.overnight_absences from anon, public, authenticated;
grant select on public.overnight_absences to authenticated;

-- Take the snapshot for one night (default: the night just ended). A
-- resident is absent at midnight when their last door movement before the
-- end of that day was OUT, or they have never been signed in. Only
-- residents who were on the register that day count. Re-running for the
-- same night adds nothing.
create or replace function public.snapshot_overnight_absences(p_night date default null)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_night date := coalesce(p_night, public.site_today() - 1);
  v_tz    text;
  v_end   timestamptz;
  v_n     integer;
begin
  select local_timezone into v_tz from public.app_settings where id;
  v_end := ((v_night + 1)::timestamp) at time zone v_tz;   -- midnight at the end of that night, site time
  insert into public.overnight_absences (night, resident_id, off_site_since)
  select v_night, r.id, le.occurred_at
    from public.residents r
    left join lateral (
      select e.kind, e.occurred_at
        from public.gate_events e
       where e.resident_id = r.id and e.occurred_at < v_end
       order by e.occurred_at desc, e.id desc
       limit 1
    ) le on true
   where r.registered_at < v_end
     and (r.status = 'active' or (r.status = 'departed' and r.departed_on is not null and r.departed_on > v_night))
     and (le.kind is null or le.kind = 'out')
  on conflict do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function public.snapshot_overnight_absences(date) from public, anon, authenticated;

-- Retention follows the register.
create or replace function public.purge_expired_overnight_absences()
returns integer
language plpgsql security definer set search_path = public
as $$
declare v_days integer; v_n integer;
begin
  select compliance_retention_days into v_days from public.app_settings where id;
  delete from public.overnight_absences where night < public.site_today() - v_days;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function public.purge_expired_overnight_absences() from public, anon, authenticated;
