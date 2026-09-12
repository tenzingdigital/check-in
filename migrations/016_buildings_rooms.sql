-- 016: buildings, floors and rooms; a resident's room.
--
-- Stage 1 of docs/PRODUCT-ROADMAP.md. A centre describes its buildings and
-- rooms once; a resident is assigned to a room; every staff-facing card can
-- say where the person lives, and the occupancy of a building can be listed
-- with who is on site — the foundation of the evacuation roll call (Stage 2).
--
-- Data held: three small tables and one nullable column on residents. Room
-- numbers are text, because centres paint "G12", "1F-3" and "Annex B" on
-- doors, and nothing here invents a sequence. Migration 006 removed the old
-- free-text room_ref precisely because free text is where sensitive detail
-- arrives by accident; a foreign key to a room a supervisor created cannot
-- carry anything but the room.
--
-- Access follows the register: every staff member reads buildings and rooms
-- (a guard needs "Castle · 12" on the card), supervisors and admins change
-- them, and every change is audited by the same trigger as residents.

create table if not exists public.buildings (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(btrim(name)) between 1 and 60),
  sort       integer not null default 0,
  created_at timestamptz not null default now(),
  constraint buildings_name_key unique (name)
);

create table if not exists public.rooms (
  id          uuid primary key default gen_random_uuid(),
  building_id uuid not null references public.buildings (id) on delete cascade,
  floor       text not null default '' check (length(floor) <= 20),
  number      text not null check (length(btrim(number)) between 1 and 20),
  capacity    integer not null default 1 check (capacity between 1 and 30),
  sort        integer not null default 0,
  created_at  timestamptz not null default now(),
  constraint rooms_building_floor_number_key unique (building_id, floor, number)
);
create index if not exists rooms_building_idx on public.rooms (building_id, sort, floor, number);

alter table public.residents
  add column if not exists room_id uuid references public.rooms (id) on delete set null;
create index if not exists residents_room_idx on public.residents (room_id) where room_id is not null;

comment on table public.buildings is 'The buildings of one centre, named as the centre names them.';
comment on table public.rooms is 'Rooms within a building. number is text: whatever is on the door.';
comment on column public.residents.room_id is 'Where the resident sleeps. Nullable: a resident may be registered before a room is known.';

-- ---------------------------------------------------------------- access
alter table public.buildings enable row level security;
alter table public.rooms     enable row level security;

drop policy if exists buildings_read       on public.buildings;
drop policy if exists buildings_supervisor on public.buildings;
create policy buildings_read       on public.buildings for select using (public.is_staff());
create policy buildings_supervisor on public.buildings for all    using (public.is_supervisor()) with check (public.is_supervisor());

drop policy if exists rooms_read       on public.rooms;
drop policy if exists rooms_supervisor on public.rooms;
create policy rooms_read       on public.rooms for select using (public.is_staff());
create policy rooms_supervisor on public.rooms for all    using (public.is_supervisor()) with check (public.is_supervisor());

revoke all on public.buildings, public.rooms from anon, public;
grant select, insert, update, delete on public.buildings, public.rooms to authenticated;

-- ---------------------------------------------------------------- audit
drop trigger if exists buildings_audit on public.buildings;
create trigger buildings_audit
  after insert or update or delete on public.buildings
  for each row execute function public.audit_row();

drop trigger if exists rooms_audit on public.rooms;
create trigger rooms_audit
  after insert or update or delete on public.rooms
  for each row execute function public.audit_row();

-- ---------------------------------------------------------------- views
-- The room on a resident, for any staff member. Kept separate from
-- v_resident_status so the functions that return that view's row type
-- (search_residents, record_check) are untouched; the API merges this in.
create or replace view public.v_resident_room as
select
  r.id,
  r.room_id,
  rm.building_id,
  b.name   as building,
  rm.floor,
  rm.number as room,
  b.name || case when rm.floor <> '' then ' · ' || rm.floor else '' end || ' · ' || rm.number as room_label
from public.residents r
join public.rooms rm     on rm.id = r.room_id
join public.buildings b  on b.id = rm.building_id
where public.is_staff();

revoke all on public.v_resident_room from anon, public;
grant select on public.v_resident_room to authenticated;

-- Occupancy: every room of every building, how many live there, how many
-- are on site now, and who. Active residents only; a departed resident
-- keeps their room_id for the record but no longer occupies it.
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
      'id', v.id, 'full_name', v.full_name, 'presence', v.presence, 'is_adult', v.is_adult)
    order by v.last_name, v.first_name) filter (where v.id is not null), '[]'::jsonb) as residents
from public.buildings b
join public.rooms rm on rm.building_id = b.id
left join public.residents r on r.room_id = rm.id and r.status = 'active'
left join public.v_resident_status v on v.id = r.id
where public.is_staff()
group by b.id, b.name, b.sort, rm.id, rm.floor, rm.number, rm.capacity, rm.sort;

revoke all on public.v_room_occupancy from anon, public;
grant select on public.v_room_occupancy to authenticated;

analyze public.buildings;
analyze public.rooms;
