-- 018: households — Stage 3 of docs/PRODUCT-ROADMAP.md.
--
-- A household is nothing but a shared id: the residents who belong to one
-- family. It carries no name (the family's surname is on the members) and
-- no free text. It lets a child appear with a parent on the roll call, a
-- family evacuate as one group, and a room's occupants read as a family.
-- Behind the feature_households switch, off by default, like the rest.
--
-- A household with nobody left in it is deleted by trigger, so the table
-- never accumulates empty ids and "leave the household" is just setting the
-- column to null.

alter table public.app_settings
  add column if not exists feature_households boolean not null default false;
comment on column public.app_settings.feature_households is 'Show households: link family members, group them on the roll call and in rooms.';

create table if not exists public.households (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);

alter table public.residents
  add column if not exists household_id uuid references public.households (id) on delete set null;
create index if not exists residents_household_idx on public.residents (household_id) where household_id is not null;

comment on table public.households is 'A family: an id shared by its members and nothing else.';
comment on column public.residents.household_id is 'The family this resident belongs to, if any. Null for a single adult.';

alter table public.households enable row level security;
drop policy if exists households_read       on public.households;
drop policy if exists households_supervisor on public.households;
create policy households_read       on public.households for select using (public.is_staff());
create policy households_supervisor on public.households for all    using (public.is_supervisor()) with check (public.is_supervisor());
revoke all on public.households from anon, public;
grant select, insert, delete on public.households to authenticated;

-- An empty household disappears. Runs as the table owner (security definer)
-- because the supervisor moving the last member out may not otherwise see
-- the household row to delete it.
create or replace function public.prune_empty_households()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') and old.household_id is not null
     and (tg_op = 'DELETE' or new.household_id is distinct from old.household_id) then
    delete from public.households h
     where h.id = old.household_id
       and not exists (select 1 from public.residents r where r.household_id = h.id);
  end if;
  return null;
end;
$$;
drop trigger if exists residents_prune_households on public.residents;
create trigger residents_prune_households
  after update of household_id or delete on public.residents
  for each row execute function public.prune_empty_households();

-- Put a resident in the same household as another, creating one if the
-- other has none. Supervisor only (the residents policy enforces it: a
-- guard's update touches no row).
create or replace function public.join_household(p_resident_id uuid, p_with_resident_id uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_household uuid;
begin
  if not public.is_supervisor() then raise exception 'Only a supervisor or admin can change households' using errcode = '42501'; end if;
  if p_resident_id = p_with_resident_id then raise exception 'A resident cannot be their own household' using errcode = '22023'; end if;
  select household_id into v_household from public.residents where id = p_with_resident_id;
  if not found then raise exception 'Resident not found' using errcode = 'P0002'; end if;
  if v_household is null then
    insert into public.households default values returning id into v_household;
    update public.residents set household_id = v_household where id = p_with_resident_id;
  end if;
  update public.residents set household_id = v_household where id = p_resident_id;
  if not found then raise exception 'Resident not found' using errcode = 'P0002'; end if;
  return v_household;
end;
$$;
revoke all on function public.join_household(uuid, uuid) from public, anon;
grant execute on function public.join_household(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------- views
-- Household on the per-resident row: the id, how many share it, and the
-- family's surname(s) for a label like "Adebayo family (4)".
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
  r.evac_need,
  r.household_id,
  h.size  as household_size,
  h.label as household_label
from public.residents r
left join public.rooms rm     on rm.id = r.room_id
left join public.buildings b  on b.id = rm.building_id
left join lateral (
  select count(*)::integer as size,
         string_agg(distinct btrim(m.last_name), ' / ' order by btrim(m.last_name)) || ' family (' || count(*) || ')' as label
    from public.residents m
   where m.household_id = r.household_id and m.status = 'active'
) h on r.household_id is not null
where public.is_staff();

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
  b.sort as building_sort,
  x.household_id,
  x.household_size,
  x.household_label
from public.residents r
join public.v_resident_status v on v.id = r.id
left join public.v_resident_room x on x.id = r.id
left join public.buildings b on b.id = x.building_id
where r.status = 'active' and public.is_staff()
order by b.sort nulls last, x.building nulls last, (r.evac_need <> 'none') desc, v.last_name, v.first_name;

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
    order by r.household_id nulls last, v.last_name, v.first_name) filter (where v.id is not null), '[]'::jsonb) as residents
from public.buildings b
join public.rooms rm on rm.building_id = b.id
left join public.residents r on r.room_id = rm.id and r.status = 'active'
left join public.v_resident_status v on v.id = r.id
where public.is_staff()
group by b.id, b.name, b.sort, rm.id, rm.floor, rm.number, rm.capacity, rm.sort;

revoke all on public.v_resident_room, public.v_room_occupancy, public.v_evacuation_list from anon, public;
grant select on public.v_resident_room, public.v_room_occupancy, public.v_evacuation_list to authenticated;

analyze public.app_settings;
