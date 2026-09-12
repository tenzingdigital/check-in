-- 024: who else is on site — staff, visitors, contractors and suppliers.
--
-- The gate has always answered "which residents are on site". A fire
-- officer's question is wider: who is in the building? This adds a Visitors
-- tab to the gate, behind the feature_visitors switch, where a guard signs
-- in anyone who is not a resident on arrival and out when they leave, and
-- the roll call lists whoever is still on site so they can be marked safe.
--
-- The least data that does the job: a kind from a fixed list, a name, an
-- optional company or reason, the times, and who recorded them. No phone
-- number, no vehicle, no ID. Kept as long as the movement log
-- (event_retention_days), then purged with it. Append-only apart from the
-- departure time, which is written once through a function.

alter table public.app_settings
  add column if not exists feature_visitors boolean not null default false;
comment on column public.app_settings.feature_visitors is 'Show the Visitors tab on the gate: staff, visitors, contractors and suppliers signed in and out, and on the roll call.';

create table if not exists public.visits (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('staff', 'visitor', 'contractor', 'supplier')),
  name        text not null check (length(btrim(name)) between 1 and 80),
  company     text check (company is null or length(company) <= 80),
  arrived_at  timestamptz not null default now(),
  arrived_by  uuid references public.profiles (id) on delete set null,
  left_at     timestamptz,
  left_by     uuid references public.profiles (id) on delete set null,
  constraint visits_left_after_arrival check (left_at is null or left_at >= arrived_at)
);
create index if not exists visits_arrived_idx on public.visits (arrived_at desc);
create index if not exists visits_on_site_idx on public.visits (arrived_at desc) where left_at is null;

comment on table public.visits is 'Non-residents on site: staff, visitors, contractors, suppliers. One row per visit, arrival and departure.';

alter table public.visits enable row level security;
drop policy if exists visits_read on public.visits;
create policy visits_read on public.visits for select using (public.is_staff());
revoke all on public.visits from anon, public, authenticated;
grant select on public.visits to authenticated;
-- No insert or update grant: arrivals and departures go through the functions.

create or replace function public.record_visit_arrival(p_kind text, p_name text, p_company text default null)
returns public.visits
language plpgsql security definer set search_path = public
as $$
declare v public.visits;
begin
  if not public.is_staff() then raise exception 'Not authorised to sign a visitor in' using errcode = '42501'; end if;
  if p_kind not in ('staff', 'visitor', 'contractor', 'supplier') then
    raise exception 'kind must be staff, visitor, contractor or supplier' using errcode = '22023';
  end if;
  if length(coalesce(btrim(p_name), '')) = 0 then raise exception 'A name is required' using errcode = '22023'; end if;
  insert into public.visits (kind, name, company, arrived_by)
  values (p_kind, btrim(p_name), nullif(btrim(coalesce(p_company, '')), ''), auth.uid())
  returning * into v;
  return v;
end;
$$;

create or replace function public.record_visit_departure(p_id uuid)
returns public.visits
language plpgsql security definer set search_path = public
as $$
declare v public.visits;
begin
  if not public.is_staff() then raise exception 'Not authorised to sign a visitor out' using errcode = '42501'; end if;
  update public.visits set left_at = now(), left_by = auth.uid()
   where id = p_id and left_at is null;
  select * into v from public.visits where id = p_id;
  if v.id is null then raise exception 'No such visit' using errcode = 'P0002'; end if;
  return v;
end;
$$;

revoke all on function public.record_visit_arrival(text, text, text) from public, anon;
revoke all on function public.record_visit_departure(uuid) from public, anon;
grant execute on function public.record_visit_arrival(text, text, text) to authenticated;
grant execute on function public.record_visit_departure(uuid) to authenticated;

-- Retention follows the movement log: a visit is a door movement.
create or replace function public.purge_expired_visits()
returns integer
language plpgsql security definer set search_path = public
as $$
declare v_days integer; v_n integer;
begin
  select event_retention_days into v_days from public.app_settings where id;
  delete from public.visits where arrived_at < now() - make_interval(days => v_days) and left_at is not null;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function public.purge_expired_visits() from public, anon, authenticated;

-- ---------------------------------------------------------------- roll call
-- A non-resident on site is on the roll call too, and is marked safe the
-- same way. A separate marks table keeps the resident marks' primary key
-- as it is; a purged visit takes its mark with it.
create table if not exists public.roll_call_visit_marks (
  roll_call_id uuid not null references public.roll_calls (id) on delete cascade,
  visit_id     uuid not null references public.visits (id) on delete cascade,
  marked_at    timestamptz not null default now(),
  marked_by    uuid references public.profiles (id) on delete set null,
  client_ref   uuid unique,
  primary key (roll_call_id, visit_id)
);
alter table public.roll_call_visit_marks enable row level security;
drop policy if exists roll_call_visit_marks_read on public.roll_call_visit_marks;
create policy roll_call_visit_marks_read on public.roll_call_visit_marks for select using (public.is_staff());
revoke all on public.roll_call_visit_marks from anon, public, authenticated;
grant select on public.roll_call_visit_marks to authenticated;

create or replace function public.mark_roll_call_visit(p_roll_call_id uuid, p_visit_id uuid, p_client_ref uuid default null, p_at timestamptz default now())
returns public.roll_call_visit_marks
language plpgsql security definer set search_path = public
as $$
declare v public.roll_call_visit_marks;
begin
  if not public.is_staff() then raise exception 'Not authorised to mark a roll call' using errcode = '42501'; end if;
  if not exists (select 1 from public.roll_calls where id = p_roll_call_id) then
    raise exception 'No such roll call' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.visits where id = p_visit_id) then
    raise exception 'No such visit' using errcode = 'P0002';
  end if;
  insert into public.roll_call_visit_marks (roll_call_id, visit_id, marked_at, marked_by, client_ref)
  values (p_roll_call_id, p_visit_id, least(coalesce(p_at, now()), now()), auth.uid(), p_client_ref)
  on conflict do nothing;
  select * into v from public.roll_call_visit_marks where roll_call_id = p_roll_call_id and visit_id = p_visit_id;
  return v;
end;
$$;
revoke all on function public.mark_roll_call_visit(uuid, uuid, uuid, timestamptz) from public, anon;
grant execute on function public.mark_roll_call_visit(uuid, uuid, uuid, timestamptz) to authenticated;
