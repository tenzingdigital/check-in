-- 031: rooms are archived, not deleted; contracted capacity; bed configuration.
--
-- From the centre call: a removed room must keep its history (who lived
-- there, when), the IPAS return wants vacancies against the CONTRACTED
-- capacity (which can differ from the physical one: one room contracted for
-- five), and the bed configuration ("double + bunk") is part of that return.

alter table public.rooms
  add column if not exists archived_at          timestamptz,
  add column if not exists contracted_capacity  integer check (contracted_capacity is null or contracted_capacity between 0 and 30),
  add column if not exists bed_config           text check (bed_config is null or length(bed_config) <= 80);
comment on column public.rooms.archived_at is 'Set when the room is taken out of use. The room and its history stay; nobody can be assigned to it.';
comment on column public.rooms.contracted_capacity is 'Beds contracted with IPAS, when different from the physical capacity. Null: same as capacity.';
comment on column public.rooms.bed_config is 'The beds as words, e.g. "double + bunk". For the vacancy return only.';

-- Nobody moves into an archived room.
create or replace function public.refuse_archived_room()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.room_id is not null and (tg_op = 'INSERT' or new.room_id is distinct from old.room_id)
     and exists (select 1 from public.rooms where id = new.room_id and archived_at is not null) then
    raise exception 'That room is archived' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.refuse_archived_room() from public, anon, authenticated;
drop trigger if exists residents_no_archived_room on public.residents;
create trigger residents_no_archived_room
  before insert or update of room_id on public.residents
  for each row execute function public.refuse_archived_room();

-- The occupancy view carries the new columns and says whether a room is archived.
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
      'id', v.id, 'full_name', v.full_name, 'presence', v.presence, 'is_adult', v.is_adult,
      'evac_need', r.evac_need, 'household_id', r.household_id)
    order by r.household_id nulls last, v.last_name, v.first_name) filter (where v.id is not null), '[]'::jsonb) as residents,
  -- New columns go last: a view's existing columns cannot be reordered in place.
  rm.contracted_capacity,
  rm.bed_config,
  (rm.archived_at is not null) as archived
from public.buildings b
join public.rooms rm on rm.building_id = b.id
left join public.residents r on r.room_id = rm.id and r.status = 'active'
left join public.v_resident_status v on v.id = r.id
where public.is_staff()
group by b.id, b.name, b.sort, rm.id, rm.floor, rm.number, rm.capacity, rm.contracted_capacity, rm.bed_config, rm.archived_at, rm.sort;

revoke all on public.v_room_occupancy from anon, public;
grant select on public.v_room_occupancy to authenticated;
