-- Weekly register change was missing one way a resident's room can change:
-- being cleared back to no room at all, rather than moved to a different
-- one. residents_room_history (migration 028) only opens a NEW
-- room_assignments row when the resident is given a room; clearing one just
-- closes the open row (sets to_at) and opens nothing. Migration 042's "move"
-- section only ever looked at newly-opened rows, so this case produced no
-- line anywhere — a resident could go room-less mid-week and the report
-- would say nothing happened.
--
-- Restricted to an active resident: departing also closes the open
-- room_assignments row (same trigger), and that closure is already the
-- Resident removals line — counting it again here would be a duplicate.
-- A true move is excluded the same way migration 042 excludes a first-ever
-- assignment from looking like a move: the trigger closes the old row and
-- opens the new one in the same instant, so "no row opened at exactly this
-- closing moment" is what tells an unassignment apart from a move.

create or replace function public.weekly_register_rows_unchecked(p_from date, p_to date)
returns table (
  section text, building text, room text, ref text, resident text, child text,
  from_date date, to_date date, nights integer, back_on date, status text, line text
)
language sql stable security definer set search_path = public set lc_time = 'C'
as $$
  select q.section, q.building, q.room, q.ref, q.resident, q.child, q.from_date, q.to_date, q.nights, q.back_on, q.status, q.line
    from (
      -- Rooms under maintenance or with free contracted beds
      select 1 as seq, lpad(b.sort::text, 6, '0') || b.name as k1, lpad(rm.sort::text, 6, '0') || rm.floor as k2, rm.number as k3,
             'Room updates' as section, b.name as building, rm.number as room, null::text as ref, null::text as resident, ''::text as child,
             null::date as from_date, null::date as to_date, null::integer as nights, null::date as back_on,
             case when rm.status = 'maintenance' then 'maintenance' else x.free || ' free' end as status,
             case when rm.status = 'maintenance'
                  then b.name || ' ' || rm.number || ' is under maintenance' || coalesce(': ' || rm.note, '') || '.'
                  else b.name || ' ' || rm.number || ': ' || x.free || ' of ' || x.contracted || ' bed' || case when x.contracted = 1 then '' else 's' end || ' free'
                       || coalesce(' (' || rm.bed_config || ')', '') || coalesce(': ' || rm.note, '') || '.' end as line
        from public.rooms rm
        join public.buildings b on b.id = rm.building_id
        cross join lateral (
          select coalesce(rm.contracted_capacity, rm.capacity) as contracted,
                 coalesce(rm.contracted_capacity, rm.capacity)
                   - (select count(*)::integer from public.residents r where r.room_id = rm.id and r.status = 'active') as free
        ) x
       where rm.archived_at is null and (rm.status = 'maintenance' or x.free > 0)
      union all
      -- Absences, then the weekend
      select case when s.weekend then 3 else 2 end, s.first_night::text, s.last_name, s.first_name,
             case when s.weekend then 'Updates from the weekend' else 'Resident absences' end,
             s.building, s.room, lpad(r2.ref::text, 4, '0'), s.resident, case when s.child then 'child' else '' end,
             s.first_night, s.last_night, s.nights, s.back_on,
             s.approval,
             s.resident || case when s.child then ' (child)' else '' end
               || case when s.room is not null then ' from ' || s.building || ' ' || s.room else '' end
               || ' was absent from ' || to_char(s.first_night, 'FMDay FMDD FMMonth')
               || ' to ' || to_char(s.last_night, 'FMDay FMDD FMMonth YYYY')
               || ' (' || s.nights || ' night' || case when s.nights = 1 then '' else 's' end || '), '
               || case when s.back_on is null then 'still away' else 'back on ' || to_char(s.back_on, 'FMDay FMDD FMMonth') end
               || '. '
               || case s.approval when 'approved' then 'Approved by management.'
                                  when 'not approved' then 'Not approved.'
                                  else 'Partly approved (' || s.authorised_nights || ' of ' || s.nights || ' nights).' end
        from public.weekly_absence_spans(p_from, p_to) s
        join public.residents r2 on r2.id = s.resident_id
      union all
      -- Removals
      select 4, r.departed_on::text, r.last_name, r.first_name,
             'Resident removals', b.name, rm.number, lpad(r.ref::text, 4, '0'),
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
      -- Weekly register change: new admissions
      select 5, (r.registered_at at time zone st.tz)::date::text, r.last_name, r.first_name,
             'Weekly register change', b.name, rm.number, lpad(r.ref::text, 4, '0'),
             btrim(r.first_name) || ' ' || btrim(r.last_name),
             case when r.date_of_birth > ((r.registered_at at time zone st.tz)::date - make_interval(years => st.adult_age_years))::date then 'child' else '' end,
             (r.registered_at at time zone st.tz)::date, (r.registered_at at time zone st.tz)::date, null::integer, null::date, 'admitted',
             btrim(r.first_name) || ' ' || btrim(r.last_name)
               || case when r.date_of_birth > ((r.registered_at at time zone st.tz)::date - make_interval(years => st.adult_age_years))::date then ' (child)' else '' end
               || case when rm.id is not null then ' moved into ' || b.name || ' ' || rm.number else ' was registered' end
               || ' on ' || to_char((r.registered_at at time zone st.tz)::date, 'FMDay FMDD FMMonth YYYY') || '.'
        from public.residents r
        left join public.rooms rm on rm.id = r.room_id
        left join public.buildings b on b.id = rm.building_id
        cross join (select adult_age_years, local_timezone as tz from public.app_settings where id) st
       where (r.registered_at at time zone st.tz)::date between p_from and p_to
      union all
      -- Weekly register change: a room or building move mid-stay (not the
      -- first-ever assignment — that is the admission line above). The "from"
      -- and "to" room read as "Building Number", the same style as every
      -- other line in this report; room_assignments.room_label (its own
      -- "Building · Number" form, used by the Room history report) is the
      -- fallback for a room since deleted or renumbered.
      select 5, (ra.from_at at time zone st.tz)::date::text, r.last_name, r.first_name,
             'Weekly register change', b.name, rm.number, lpad(r.ref::text, 4, '0'),
             btrim(r.first_name) || ' ' || btrim(r.last_name),
             case when r.date_of_birth > ((ra.from_at at time zone st.tz)::date - make_interval(years => st.adult_age_years))::date then 'child' else '' end,
             (ra.from_at at time zone st.tz)::date, (ra.from_at at time zone st.tz)::date, null::integer, null::date, 'moved',
             btrim(r.first_name) || ' ' || btrim(r.last_name)
               || case when r.date_of_birth > ((ra.from_at at time zone st.tz)::date - make_interval(years => st.adult_age_years))::date then ' (child)' else '' end
               || ' moved from ' || coalesce(pb.name || ' ' || prm.number, prev.room_label)
               || ' to ' || coalesce(b.name || ' ' || rm.number, ra.room_label)
               || ' on ' || to_char((ra.from_at at time zone st.tz)::date, 'FMDay FMDD FMMonth YYYY') || '.'
        from public.room_assignments ra
        join public.residents r on r.id = ra.resident_id
        left join public.rooms rm on rm.id = ra.room_id
        left join public.buildings b on b.id = rm.building_id
        cross join (select adult_age_years, local_timezone as tz from public.app_settings where id) st
        cross join lateral (
          select ra2.room_id, ra2.room_label from public.room_assignments ra2
           where ra2.resident_id = ra.resident_id and ra2.from_at < ra.from_at
           order by ra2.from_at desc limit 1
        ) prev
        left join public.rooms prm on prm.id = prev.room_id
        left join public.buildings pb on pb.id = prm.building_id
       where (ra.from_at at time zone st.tz)::date between p_from and p_to
      union all
      -- Weekly register change: unassigned from a room, with no room to
      -- replace it. Restricted to a resident still active (a departure's
      -- closure is the Resident removals line, not this) and excludes a true
      -- move by requiring that nothing opened at exactly the moment this
      -- one closed.
      select 5, (ra.to_at at time zone st.tz)::date::text, r.last_name, r.first_name,
             'Weekly register change', pb2.name, prm2.number, lpad(r.ref::text, 4, '0'),
             btrim(r.first_name) || ' ' || btrim(r.last_name),
             case when r.date_of_birth > ((ra.to_at at time zone st.tz)::date - make_interval(years => st.adult_age_years))::date then 'child' else '' end,
             (ra.to_at at time zone st.tz)::date, (ra.to_at at time zone st.tz)::date, null::integer, null::date, 'unassigned',
             btrim(r.first_name) || ' ' || btrim(r.last_name)
               || case when r.date_of_birth > ((ra.to_at at time zone st.tz)::date - make_interval(years => st.adult_age_years))::date then ' (child)' else '' end
               || ' was unassigned from ' || coalesce(pb2.name || ' ' || prm2.number, ra.room_label)
               || ' on ' || to_char((ra.to_at at time zone st.tz)::date, 'FMDay FMDD FMMonth YYYY') || '.'
        from public.room_assignments ra
        join public.residents r on r.id = ra.resident_id and r.status = 'active'
        left join public.rooms prm2 on prm2.id = ra.room_id
        left join public.buildings pb2 on pb2.id = prm2.building_id
        cross join (select adult_age_years, local_timezone as tz from public.app_settings where id) st
       where ra.to_at is not null
         and (ra.to_at at time zone st.tz)::date between p_from and p_to
         and not exists (
           select 1 from public.room_assignments ra2
            where ra2.resident_id = ra.resident_id and ra2.from_at = ra.to_at
         )
    ) q
   order by q.seq, q.k1, q.k2, q.k3;
$$;
revoke all on function public.weekly_register_rows_unchecked(date, date) from public, anon, authenticated;
