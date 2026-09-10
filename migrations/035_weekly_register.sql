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

-- ---------------------------------------------------------------------------
-- 2. Absence spans
-- ---------------------------------------------------------------------------
-- Consecutive nights in overnight_absences become one span per resident.
-- back_on is the day on whose midnight the resident was on site again, or
-- null while the span reaches p_to. Approval is by construction: a night
-- inside an authorised absence is approved. Base tables only: the nightly
-- job runs this as owner, and the v_* views filter on is_staff().
create or replace function public.weekly_absence_spans(p_from date, p_to date)
returns table (
  resident_id uuid, resident text, building text, room text, child boolean,
  first_night date, last_night date, nights integer, back_on date,
  authorised_nights integer, approval text, weekend boolean,
  last_name text, first_name text
)
language sql stable security definer set search_path = public
as $$
  with nights as (
    select o.resident_id, o.night,
           o.night - (row_number() over (partition by o.resident_id order by o.night))::integer as grp
      from public.overnight_absences o
     where o.night between p_from and p_to
  ),
  spans as (
    select n.resident_id, min(n.night) as first_night, max(n.night) as last_night, count(*)::integer as nights,
           count(*) filter (where public.absence_authorised(n.resident_id, n.night))::integer as authorised_nights
      from nights n
     group by n.resident_id, n.grp
  )
  select s.resident_id,
         btrim(r.first_name) || ' ' || btrim(r.last_name),
         b.name, rm.number,
         (r.date_of_birth > (s.first_night - make_interval(years => st.adult_age_years))::date),
         s.first_night, s.last_night, s.nights,
         case when s.last_night < p_to then s.last_night + 1 end,
         s.authorised_nights,
         case when s.authorised_nights = s.nights then 'approved'
              when s.authorised_nights = 0       then 'not approved'
              else 'partly approved' end,
         extract(isodow from s.first_night) in (5, 6),
         r.last_name, r.first_name
    from spans s
    join public.residents r on r.id = s.resident_id
    left join public.rooms rm on rm.id = r.room_id
    left join public.buildings b on b.id = rm.building_id
    cross join (select adult_age_years from public.app_settings where id) st;
$$;
revoke all on function public.weekly_absence_spans(date, date) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The report rows, sentences included
-- ---------------------------------------------------------------------------
-- Four sections in a fixed order. The sentence is built here so the CSV,
-- the printable page and the Sunday email can never disagree.
create or replace function public.weekly_register_rows_unchecked(p_from date, p_to date)
returns table (
  section text, building text, room text, resident text, child text,
  from_date date, to_date date, nights integer, back_on date, status text, line text
)
language sql stable security definer set search_path = public
as $$
  select q.section, q.building, q.room, q.resident, q.child, q.from_date, q.to_date, q.nights, q.back_on, q.status, q.line
    from (
      -- Absences, then the weekend
      select case when s.weekend then 2 else 1 end as seq,
             s.first_night::text as k1, s.last_name as k2, s.first_name as k3,
             case when s.weekend then 'Updates from the weekend' else 'Resident absences' end as section,
             s.building, s.room, s.resident, case when s.child then 'child' else '' end as child,
             s.first_night as from_date, s.last_night as to_date, s.nights, s.back_on,
             s.approval as status,
             s.resident || case when s.child then ' (child)' else '' end
               || case when s.room is not null then ' from ' || s.building || ' ' || s.room else '' end
               || ' was absent from ' || to_char(s.first_night, 'FMDay FMDD FMMonth')
               || ' to ' || to_char(s.last_night, 'FMDay FMDD FMMonth YYYY')
               || ' (' || s.nights || ' night' || case when s.nights = 1 then '' else 's' end || '), '
               || case when s.back_on is null then 'still away' else 'back on ' || to_char(s.back_on, 'FMDay FMDD FMMonth') end
               || '. '
               || case s.approval when 'approved' then 'Approved by management.'
                                  when 'not approved' then 'Not approved.'
                                  else 'Partly approved (' || s.authorised_nights || ' of ' || s.nights || ' nights).' end as line
        from public.weekly_absence_spans(p_from, p_to) s
      union all
      -- Removals
      select 3, r.departed_on::text, r.last_name, r.first_name,
             'Resident removals', b.name, rm.number,
             btrim(r.first_name) || ' ' || btrim(r.last_name),
             case when r.date_of_birth > (r.departed_on - make_interval(years => st.adult_age_years))::date then 'child' else '' end,
             r.departed_on, r.departed_on, null::integer, null::date, 'departed',
             btrim(r.first_name) || ' ' || btrim(r.last_name)
               || case when r.date_of_birth > (r.departed_on - make_interval(years => st.adult_age_years))::date then ' (child)' else '' end
               || case when rm.id is not null then ' from ' || b.name || ' ' || rm.number else '' end
               || ' departed on ' || to_char(r.departed_on, 'FMDay FMDD FMMonth YYYY') || '.'
        from public.residents r
        left join public.rooms rm on rm.id = r.room_id
        left join public.buildings b on b.id = rm.building_id
        cross join (select adult_age_years from public.app_settings where id) st
       where r.status = 'departed' and r.departed_on between p_from and p_to
      union all
      -- Rooms under maintenance or with free contracted beds
      select 4, lpad(b.sort::text, 6, '0') || b.name, lpad(rm.sort::text, 6, '0') || rm.floor, rm.number,
             'Room updates', b.name, rm.number, null, '',
             null, null, null, null,
             case when rm.status = 'maintenance' then 'maintenance' else x.free || ' free' end,
             case when rm.status = 'maintenance'
                  then b.name || ' ' || rm.number || ' is under maintenance' || coalesce(': ' || rm.note, '') || '.'
                  else b.name || ' ' || rm.number || ': ' || x.free || ' of ' || x.contracted || ' bed' || case when x.contracted = 1 then '' else 's' end || ' free'
                       || coalesce(' (' || rm.bed_config || ')', '') || coalesce(': ' || rm.note, '') || '.' end
        from public.rooms rm
        join public.buildings b on b.id = rm.building_id
        cross join lateral (
          select coalesce(rm.contracted_capacity, rm.capacity) as contracted,
                 coalesce(rm.contracted_capacity, rm.capacity)
                   - (select count(*)::integer from public.residents r where r.room_id = rm.id and r.status = 'active') as free
        ) x
       where rm.archived_at is null and (rm.status = 'maintenance' or x.free > 0)
    ) q
   order by q.seq, q.k1, q.k2, q.k3;
$$;
revoke all on function public.weekly_register_rows_unchecked(date, date) from public, anon, authenticated;

-- What the API calls: a supervisor's report, refused to a guard.
create or replace function public.weekly_register_rows(p_from date, p_to date)
returns table (
  section text, building text, room text, resident text, child text,
  from_date date, to_date date, nights integer, back_on date, status text, line text
)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_supervisor() then
    raise exception 'Only a supervisor or admin may run the weekly register' using errcode = '42501';
  end if;
  return query select * from public.weekly_register_rows_unchecked(p_from, p_to);
end;
$$;
revoke all on function public.weekly_register_rows(date, date) from public, anon;
grant execute on function public.weekly_register_rows(date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Sent on a Sunday
-- ---------------------------------------------------------------------------
-- Off by default. On, the nightly job (jobs.js) emails the addresses below
-- the report for the previous Sunday night through Saturday night, early on
-- Sunday morning, after Saturday night's snapshot. Needs email configured.
alter table public.app_settings
  add column if not exists weekly_report_email boolean not null default false,
  add column if not exists weekly_report_recipients text check (weekly_report_recipients is null or length(weekly_report_recipients) <= 400);
comment on column public.app_settings.weekly_report_email is 'Email the Weekly register update every Sunday (jobs.js).';
comment on column public.app_settings.weekly_report_recipients is 'Comma-separated addresses that receive it. Null: nobody.';
