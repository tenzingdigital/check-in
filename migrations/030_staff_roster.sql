-- 030: the site's staff list.
--
-- A centre wants its own staff on a list, so that signing a kitchen worker
-- or a cleaner in is one tap on the Visitors tab rather than typing a name
-- each time, and so that the roll call names them properly. Supervisors
-- keep the list; every staff member reads it. It holds a name and a job
-- title, nothing else, and a person is archived rather than deleted so the
-- visits that name them keep their meaning.

create table if not exists public.staff_roster (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 1 and 80),
  role        text check (role is null or length(role) <= 80),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  created_by  uuid references public.profiles (id) on delete set null
);
create unique index if not exists staff_roster_name_idx on public.staff_roster (lower(btrim(name)));
comment on table public.staff_roster is 'The site''s own staff: name and job title, for one-tap sign-in on the Visitors tab. Archived, never deleted.';

alter table public.staff_roster enable row level security;
drop policy if exists staff_roster_read on public.staff_roster;
create policy staff_roster_read on public.staff_roster for select using (public.is_staff());
drop policy if exists staff_roster_supervisor on public.staff_roster;
create policy staff_roster_supervisor on public.staff_roster
  for all using (public.is_supervisor()) with check (public.is_supervisor());
revoke all on public.staff_roster from anon, public;
grant select, insert, update on public.staff_roster to authenticated;

drop trigger if exists staff_roster_audit on public.staff_roster;
create trigger staff_roster_audit
  after insert or update or delete on public.staff_roster
  for each row execute function public.audit_row();

-- A visit can point at the roster entry it came from.
alter table public.visits add column if not exists roster_id uuid references public.staff_roster (id) on delete set null;
create index if not exists visits_roster_open_idx on public.visits (roster_id) where left_at is null;

-- Sign a listed staff member in: the name and job title come from the list.
create or replace function public.record_staff_arrival(p_roster_id uuid)
returns public.visits
language plpgsql security definer set search_path = public
as $$
declare r public.staff_roster; v public.visits;
begin
  if not public.is_staff() then raise exception 'Not authorised to sign a staff member in' using errcode = '42501'; end if;
  select * into r from public.staff_roster where id = p_roster_id and active;
  if not found then raise exception 'Not on the staff list' using errcode = 'P0002'; end if;
  if exists (select 1 from public.visits where roster_id = p_roster_id and left_at is null) then
    raise exception 'Already signed in' using errcode = '23505';
  end if;
  insert into public.visits (kind, name, company, arrived_by, roster_id)
  values ('staff', btrim(r.name), r.role, auth.uid(), r.id)
  returning * into v;
  return v;
end;
$$;
revoke all on function public.record_staff_arrival(uuid) from public, anon;
grant execute on function public.record_staff_arrival(uuid) to authenticated;
