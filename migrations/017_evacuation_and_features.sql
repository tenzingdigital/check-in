-- 017: evacuation needs, the roll call, and per-site feature switches.
--
-- Stage 2 of docs/PRODUCT-ROADMAP.md, plus the switches that let a centre
-- show or hide this round of features (Stage 1's buildings included). Both
-- default OFF: a site that never turns them on sees exactly what it saw
-- before, and a trial centre can turn them on one at a time.
--
-- The evacuation need is ONE code from a fixed list, no free text. It is the
-- minimum a fire officer's PEEP (personal emergency evacuation plan) asks
-- for, and it is the first special-category field the product holds — so it
-- appears only where evacuation happens: the roll call, the evacuation list
-- and the room occupancy view, never on the gate or register cards and never
-- in a search. docs/GDPR.md and the DPIA record it as such.
--
-- A roll call is a moment (a drill or an incident) with a set of marks: who
-- was accounted for, by whom, when. Marks are append-only and idempotent on
-- a client reference, so a terminal that lost its connection in the fire
-- alarm can replay them later (routes/sync.js).

-- ---------------------------------------------------------------- switches
alter table public.app_settings
  add column if not exists feature_buildings  boolean not null default false,
  add column if not exists feature_evacuation boolean not null default false;

comment on column public.app_settings.feature_buildings  is 'Show buildings, rooms and a resident''s room. Off: the site looks as it did before migration 016.';
comment on column public.app_settings.feature_evacuation is 'Show the evacuation need on records and the roll call on the gate. Off: the column is ignored and the roll call is hidden.';

-- ---------------------------------------------------------------- need
alter table public.residents
  add column if not exists evac_need text not null default 'none'
    check (evac_need in ('none', 'mobility', 'hearing', 'sight', 'carer', 'other'));

comment on column public.residents.evac_need is
  'Evacuation assistance, one code from a fixed list: none | mobility (needs help to move) | hearing (needs help to hear an alarm) | sight (needs help to find the way) | carer (has an infant or is a carer) | other (no detail held). Shown only on the roll call, the evacuation list and room occupancy.';

-- ---------------------------------------------------------------- the room view, now for every resident
-- Every resident has a row (left join) so the list can carry the need as
-- well; the room columns are null for a resident with no room.
create or replace view public.v_resident_room as
select
  r.id,
  r.room_id,
  rm.building_id,
  b.name   as building,
  rm.floor,
  rm.number as room,
  case when rm.id is null then null
       else b.name || case when rm.floor <> '' then ' · ' || rm.floor else '' end || ' · ' || rm.number end as room_label,
  r.evac_need
from public.residents r
left join public.rooms rm     on rm.id = r.room_id
left join public.buildings b  on b.id = rm.building_id
where public.is_staff();

create or replace view public.v_room_occupancy as
select
  b.id      as building_id,
  b.name    as building,
  b.sort    as building_sort,
  rm.id     as room_id,
  rm.floor,
  rm.number as room,
  rm.capacity,
  rm.sort   as room_sort,
  count(v.id)::integer                                   as occupants,
  count(v.id) filter (where v.presence = 'in')::integer  as on_site,
  coalesce(jsonb_agg(jsonb_build_object(
      'id', v.id, 'full_name', v.full_name, 'presence', v.presence, 'is_adult', v.is_adult, 'evac_need', r.evac_need)
    order by v.last_name, v.first_name) filter (where v.id is not null), '[]'::jsonb) as residents
from public.buildings b
join public.rooms rm on rm.building_id = b.id
left join public.residents r on r.room_id = rm.id and r.status = 'active'
left join public.v_resident_status v on v.id = r.id
where public.is_staff()
group by b.id, b.name, b.sort, rm.id, rm.floor, rm.number, rm.capacity, rm.sort;

-- ---------------------------------------------------------------- evacuation list
-- Everyone active, where they live, whether they are on site now and what
-- help they need; needs first within a building, so the top of each page
-- is who to go to first.
create or replace view public.v_evacuation_list as
select
  v.id,
  v.full_name,
  v.presence,
  v.last_event_at,
  v.is_adult,
  x.building_id,
  x.building,
  x.floor,
  x.room,
  x.room_label,
  r.evac_need,
  b.sort as building_sort
from public.residents r
join public.v_resident_status v on v.id = r.id
left join public.v_resident_room x on x.id = r.id
left join public.buildings b on b.id = x.building_id
where r.status = 'active' and public.is_staff()
order by b.sort nulls last, x.building nulls last, (r.evac_need <> 'none') desc, v.last_name, v.first_name;

revoke all on public.v_resident_room, public.v_room_occupancy, public.v_evacuation_list from anon, public;
grant select on public.v_resident_room, public.v_room_occupancy, public.v_evacuation_list to authenticated;

-- ---------------------------------------------------------------- roll calls
create table if not exists public.roll_calls (
  id         uuid primary key,
  kind       text not null check (kind in ('drill', 'incident')),
  started_at timestamptz not null default now(),
  started_by uuid references public.profiles (id) on delete set null,
  ended_at   timestamptz,
  ended_by   uuid references public.profiles (id) on delete set null
);
create index if not exists roll_calls_open_idx on public.roll_calls (started_at desc) where ended_at is null;

create table if not exists public.roll_call_marks (
  roll_call_id uuid not null references public.roll_calls (id) on delete cascade,
  resident_id  uuid not null references public.residents (id) on delete cascade,
  marked_at    timestamptz not null default now(),
  marked_by    uuid references public.profiles (id) on delete set null,
  client_ref   uuid unique,
  primary key (roll_call_id, resident_id)
);

comment on table public.roll_calls is 'A drill or an incident: when it started, who started it, when it ended. Marks say who was accounted for.';
comment on table public.roll_call_marks is 'Append-only. One row per resident per roll call; a replay with the same client_ref or the same pair is a no-op.';

alter table public.roll_calls      enable row level security;
alter table public.roll_call_marks enable row level security;
drop policy if exists roll_calls_read on public.roll_calls;
create policy roll_calls_read on public.roll_calls for select using (public.is_staff());
drop policy if exists roll_call_marks_read on public.roll_call_marks;
create policy roll_call_marks_read on public.roll_call_marks for select using (public.is_staff());
revoke all on public.roll_calls, public.roll_call_marks from anon, public, authenticated;
grant select on public.roll_calls, public.roll_call_marks to authenticated;

-- Any staff member may start, mark and end a roll call: a fire does not wait
-- for a supervisor. The id comes from the terminal, so a roll call started
-- offline keeps its identity when it syncs.
create or replace function public.start_roll_call(p_id uuid, p_kind text, p_started_at timestamptz default now())
returns public.roll_calls
language plpgsql security definer set search_path = public
as $$
declare v public.roll_calls;
begin
  if not public.is_staff() then raise exception 'Not authorised to start a roll call' using errcode = '42501'; end if;
  if p_kind not in ('drill', 'incident') then raise exception 'kind must be drill or incident' using errcode = '22023'; end if;
  insert into public.roll_calls (id, kind, started_at, started_by)
  values (p_id, p_kind, least(coalesce(p_started_at, now()), now()), auth.uid())
  on conflict (id) do nothing;
  select * into v from public.roll_calls where id = p_id;
  return v;
end;
$$;

create or replace function public.mark_roll_call(p_roll_call_id uuid, p_resident_id uuid, p_client_ref uuid default null, p_at timestamptz default now())
returns public.roll_call_marks
language plpgsql security definer set search_path = public
as $$
declare v public.roll_call_marks;
begin
  if not public.is_staff() then raise exception 'Not authorised to mark a roll call' using errcode = '42501'; end if;
  if not exists (select 1 from public.roll_calls where id = p_roll_call_id) then
    raise exception 'No such roll call' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.residents where id = p_resident_id) then
    raise exception 'Resident not found' using errcode = 'P0002';
  end if;
  insert into public.roll_call_marks (roll_call_id, resident_id, marked_at, marked_by, client_ref)
  values (p_roll_call_id, p_resident_id, least(coalesce(p_at, now()), now()), auth.uid(), p_client_ref)
  on conflict do nothing;
  select * into v from public.roll_call_marks where roll_call_id = p_roll_call_id and resident_id = p_resident_id;
  return v;
end;
$$;

create or replace function public.end_roll_call(p_id uuid, p_at timestamptz default now())
returns public.roll_calls
language plpgsql security definer set search_path = public
as $$
declare v public.roll_calls;
begin
  if not public.is_staff() then raise exception 'Not authorised to end a roll call' using errcode = '42501'; end if;
  update public.roll_calls set ended_at = least(coalesce(p_at, now()), now()), ended_by = auth.uid()
   where id = p_id and ended_at is null;
  select * into v from public.roll_calls where id = p_id;
  if v.id is null then raise exception 'No such roll call' using errcode = 'P0002'; end if;
  return v;
end;
$$;

revoke all on function public.start_roll_call(uuid, text, timestamptz) from public, anon;
revoke all on function public.mark_roll_call(uuid, uuid, uuid, timestamptz) from public, anon;
revoke all on function public.end_roll_call(uuid, timestamptz) from public, anon;
grant execute on function public.start_roll_call(uuid, text, timestamptz) to authenticated;
grant execute on function public.mark_roll_call(uuid, uuid, uuid, timestamptz) to authenticated;
grant execute on function public.end_roll_call(uuid, timestamptz) to authenticated;

-- Kept as long as the register: a drill record is evidence at inspection.
create or replace function public.purge_expired_roll_calls()
returns integer
language plpgsql security definer set search_path = public
as $$
declare v_days integer; v_n integer;
begin
  select compliance_retention_days into v_days from public.app_settings where id;
  delete from public.roll_calls where started_at < now() - make_interval(days => v_days);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function public.purge_expired_roll_calls() from public, anon, authenticated;

analyze public.app_settings;
