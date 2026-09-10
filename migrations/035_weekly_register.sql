-- 035_weekly_register.sql — the Sunday Weekly Register Update.
--
-- Brighton Accommodation's "Weekly Register - Explanation Document"
-- (10 September 2026, docs/superpowers/specs/2026-09-10-weekly-register-update-design.md):
-- every Sunday the assistant centre manager emails head office who was
-- absent this week and whether management approved it, who left, and
-- which rooms are free or out of use. Three parts:
--
--   1. Rooms carry a status (open / maintenance) and a one-line note, the
--      only free text here, and it is about a room, never a person.
--   2. Absence spans: consecutive nights in overnight_absences (027)
--      collapsed into "from Monday to Wednesday", approved by construction
--      when every night is inside an authorised absence (028).
--   3. The report rows with their sentences, and the two settings that
--      send them on a Sunday (jobs.js).

-- ---------------------------------------------------------------------------
-- 1. Rooms: status and note
-- ---------------------------------------------------------------------------
alter table public.rooms
  add column if not exists status text not null default 'open' check (status in ('open', 'maintenance')),
  add column if not exists note   text check (note is null or length(note) <= 120);
comment on column public.rooms.status is 'open, or maintenance (out of use for now; a note for the return, not a lock).';
comment on column public.rooms.note is 'One line for the weekly return, e.g. "1 bed free for a single woman". About the room, never a resident.';

-- The occupancy view carries them. New columns go last: a view's existing
-- columns cannot be reordered in place.
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
  rm.contracted_capacity,
  rm.bed_config,
  (rm.archived_at is not null) as archived,
  rm.status,
  rm.note
from public.buildings b
join public.rooms rm on rm.building_id = b.id
left join public.residents r on r.room_id = rm.id and r.status = 'active'
left join public.v_resident_status v on v.id = r.id
where public.is_staff()
group by b.id, b.name, b.sort, rm.id, rm.floor, rm.number, rm.capacity, rm.contracted_capacity, rm.bed_config, rm.archived_at, rm.status, rm.note, rm.sort;

revoke all on public.v_room_occupancy from anon, public;
grant select on public.v_room_occupancy to authenticated;
