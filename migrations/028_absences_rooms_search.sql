-- 028: authorised absences, room history, and search by room.
--
-- Three things from the Brighton call (docs/PRODUCT-ROADMAP.md, Stage 2c):
--
--   1. Authorised absences. A resident away with the centre's agreement (a
--      holiday, a family matter, hospital) is not in breach of the daily
--      rule for those days. A supervisor records the dates and a reason from
--      a fixed list; for a child, that a parent or guardian agreed. The
--      nightly close-out then writes those days as not required. Nothing
--      else is held: no destination, no free text.
--   2. Room history. Every room a resident has had, with when and by whom,
--      kept by a trigger as the room changes and closed when they leave.
--      The audit trail already had the facts; this is the readable form.
--   3. Search by room. The Door and register find "B1" or "K12" as well as
--      a name, because security works by room number.

-- ---------------------------------------------------------------------------
-- 1. Authorised absences
-- ---------------------------------------------------------------------------

create table if not exists public.authorised_absences (
  id              bigserial primary key,
  resident_id     uuid not null references public.residents (id) on delete cascade,
  from_date       date not null,
  to_date         date not null,
  -- Fixed list on purpose: a category, never a story (GDPR Art. 5(1)(c)).
  reason          text not null check (reason in ('holiday', 'family', 'medical', 'education', 'work', 'other')),
  -- For a child: a parent or guardian agreed to the absence. Required by
  -- authorise_absence() when the resident is under the adult age.
  guardian_agreed boolean not null default false,
  approved_by     uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  -- The last day the absence covered, when it was cut short. Null: ran to
  -- to_date. Days after ended_on are required again.
  ended_on        date,
  check (to_date >= from_date),
  check (ended_on is null or (ended_on >= from_date and ended_on <= to_date)),
  check (to_date - from_date <= 366)
);
create index if not exists authorised_absences_resident_idx on public.authorised_absences (resident_id, from_date, to_date);
comment on table public.authorised_absences is 'Days a resident was away with the centre''s agreement. The daily rule does not apply on those days. Reason is a category; no free text.';

alter table public.authorised_absences enable row level security;
drop policy if exists authorised_absences_read on public.authorised_absences;
create policy authorised_absences_read on public.authorised_absences for select using (public.is_staff());
revoke all on public.authorised_absences from anon, public, authenticated;
grant select on public.authorised_absences to authenticated;
grant usage on sequence public.authorised_absences_id_seq to authenticated;

-- Approvals are administrative acts: on the audit trail like a resident edit.
drop trigger if exists authorised_absences_audit on public.authorised_absences;
create trigger authorised_absences_audit
  after insert or update or delete on public.authorised_absences
  for each row execute function public.audit_row();

-- Was this day inside an authorised absence for this resident?
create or replace function public.absence_authorised(p_resident_id uuid, p_day date)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.authorised_absences a
     where a.resident_id = p_resident_id
       and p_day between a.from_date and coalesce(a.ended_on, a.to_date)
  );
$$;
revoke all on function public.absence_authorised(uuid, date) from public, anon;
grant execute on function public.absence_authorised(uuid, date) to authenticated;

-- Record one. Supervisors and admins; the resident must be active; a child
-- needs a parent or guardian's agreement recorded; no overlap with another.
create or replace function public.authorise_absence(
  p_resident_id     uuid,
  p_from            date,
  p_to              date,
  p_reason          text,
  p_guardian_agreed boolean default false
)
returns public.authorised_absences
language plpgsql security definer set search_path = public
as $$
declare
  v_res   public.residents;
  v_adult integer;
  v_row   public.authorised_absences;
begin
  if not public.is_supervisor() then
    raise exception 'Only a supervisor or admin can authorise an absence' using errcode = '42501';
  end if;
  select * into v_res from public.residents where id = p_resident_id;
  if not found then
    raise exception 'Resident not found' using errcode = 'P0002';
  end if;
  if v_res.status <> 'active' then
    raise exception 'Only an active resident can be authorised to be away' using errcode = '23514';
  end if;
  if p_to < p_from then
    raise exception 'The last day must not be before the first' using errcode = '22023';
  end if;
  if p_to - p_from > 366 then
    raise exception 'An authorised absence covers at most a year' using errcode = '22023';
  end if;
  select adult_age_years into v_adult from public.app_settings where id;
  if v_res.date_of_birth > (p_from - make_interval(years => v_adult))::date and not coalesce(p_guardian_agreed, false) then
    raise exception 'A child''s absence needs a parent or guardian''s agreement recorded' using errcode = '23514';
  end if;
  if exists (select 1 from public.authorised_absences a
              where a.resident_id = p_resident_id
                and daterange(a.from_date, coalesce(a.ended_on, a.to_date), '[]') && daterange(p_from, p_to, '[]')) then
    raise exception 'Overlaps an authorised absence already recorded' using errcode = '23505';
  end if;
  insert into public.authorised_absences (resident_id, from_date, to_date, reason, guardian_agreed, approved_by)
  values (p_resident_id, p_from, p_to, p_reason, coalesce(p_guardian_agreed, false), auth.uid())
  returning * into v_row;
  return v_row;
end;
$$;
revoke all on function public.authorise_absence(uuid, date, date, text, boolean) from public, anon;
grant execute on function public.authorise_absence(uuid, date, date, text, boolean) to authenticated;

-- Cut one short: the last day it covered. A last day before the first day
-- means it never happened, and the row goes.
create or replace function public.end_absence(p_id bigint, p_last_day date default null)
returns public.authorised_absences
language plpgsql security definer set search_path = public
as $$
declare
  v_row  public.authorised_absences;
  v_last date := coalesce(p_last_day, public.site_today() - 1);
begin
  if not public.is_supervisor() then
    raise exception 'Only a supervisor or admin can change an authorised absence' using errcode = '42501';
  end if;
  select * into v_row from public.authorised_absences where id = p_id;
  if not found then
    raise exception 'Absence not found' using errcode = 'P0002';
  end if;
  if v_last < v_row.from_date then
    delete from public.authorised_absences where id = p_id;
    v_row.ended_on := v_row.from_date - 1;   -- signals "cancelled" to the caller
    return v_row;
  end if;
  update public.authorised_absences
     set ended_on = least(v_last, to_date)
   where id = p_id
   returning * into v_row;
  return v_row;
end;
$$;
revoke all on function public.end_absence(bigint, date) from public, anon;
grant execute on function public.end_absence(bigint, date) to authenticated;

-- Retention follows the register.
create or replace function public.purge_expired_authorised_absences()
returns integer
language plpgsql security definer set search_path = public
as $$
declare v_days integer; v_n integer;
begin
  select compliance_retention_days into v_days from public.app_settings where id;
  delete from public.authorised_absences where to_date < public.site_today() - v_days;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function public.purge_expired_authorised_absences() from public, anon, authenticated;

-- The nightly close-out, with the exemption. Same body as migration 002
-- but for the one condition marked below.
create or replace function public.close_out_compliance_days(p_through date default null)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_tz      text;
  v_adult   integer;
  v_through date;
  v_from    date;
  v_day     date;
  v_written integer := 0;
  v_batch   integer;
begin
  select local_timezone, adult_age_years into v_tz, v_adult
  from public.app_settings where id;

  -- Never close the day in progress.
  v_through := least(
    coalesce(p_through, (now() at time zone v_tz)::date - 1),
    (now() at time zone v_tz)::date - 1
  );

  -- Resume from the day after the last closed one; on a fresh database, start
  -- at the earliest registration. This fast-forward is only a lower bound,
  -- though: a day can be "mostly closed" (every resident but one) if a row was
  -- reopened after close-out — a correction landing after this job already ran,
  -- or a hand-edited row like the one this test suite seeds directly. Take the
  -- earliest of the fast-forward point and the earliest still-open past day so
  -- that case is revisited instead of silently skipped forever.
  select least(
           coalesce(
             (select max(compliance_date) + 1 from public.daily_compliance where closed_at is not null),
             (select min((registered_at at time zone v_tz)::date) from public.residents)
           ),
           coalesce(
             (select min(compliance_date) from public.daily_compliance
               where closed_at is null and compliance_date <= v_through),
             'infinity'
           )
         )
    into v_from;

  if v_from is null or v_from > v_through then
    return 0;
  end if;

  for v_day in select d::date from generate_series(v_from, v_through, interval '1 day') d loop
    insert into public.daily_compliance
      (resident_id, compliance_date, required, presented, first_seen_at, checkin_count, closed_at)
    select
      r.id, v_day,
      public.compliance_required(
        r.date_of_birth, (r.registered_at at time zone v_tz)::date,
        r.departed_on, v_day, v_adult)
        -- Migration 028: a day inside an authorised absence is a day the
        -- rule did not apply. The row is still written, so the register
        -- shows the day as not required rather than missing.
        and not public.absence_authorised(r.id, v_day),
      false, null, 0, now()
    from public.residents r
    where (r.registered_at at time zone v_tz)::date <= v_day
      and (r.departed_on is null or r.departed_on >= v_day)
    on conflict (resident_id, compliance_date) do nothing;

    get diagnostics v_batch = row_count;
    v_written := v_written + v_batch;

    -- Rows written during the day by record_checkin are still open. Close them
    -- without touching presented, first_seen_at or checkin_count.
    update public.daily_compliance
       set closed_at = now()
     where compliance_date = v_day and closed_at is null;
  end loop;

  return v_written;
end;
$$;


-- ---------------------------------------------------------------------------
-- 2. Room history
-- ---------------------------------------------------------------------------

create table if not exists public.room_assignments (
  id          bigserial primary key,
  resident_id uuid not null references public.residents (id) on delete cascade,
  -- The room row, while it exists; the label is kept so the history
  -- survives a room being removed or renumbered.
  room_id     uuid references public.rooms (id) on delete set null,
  room_label  text not null,
  from_at     timestamptz not null default now(),
  to_at       timestamptz,
  changed_by  uuid references public.profiles (id) on delete set null,
  check (to_at is null or to_at >= from_at)
);
create index if not exists room_assignments_resident_idx on public.room_assignments (resident_id, from_at desc);
create index if not exists room_assignments_open_idx on public.room_assignments (resident_id) where to_at is null;
create index if not exists room_assignments_room_idx on public.room_assignments (room_id, from_at desc);
comment on table public.room_assignments is 'Every room a resident has had: from when to when, and who moved them. Kept by a trigger on residents; closed when they leave.';

alter table public.room_assignments enable row level security;
drop policy if exists room_assignments_read on public.room_assignments;
create policy room_assignments_read on public.room_assignments for select using (public.is_staff());
revoke all on public.room_assignments from anon, public, authenticated;
grant select on public.room_assignments to authenticated;

create or replace function public.room_label_of(p_room_id uuid)
returns text
language sql stable security definer set search_path = public
as $$
  select b.name || case when rm.floor <> '' then ' · ' || rm.floor else '' end || ' · ' || rm.number
    from public.rooms rm join public.buildings b on b.id = rm.building_id
   where rm.id = p_room_id;
$$;
revoke all on function public.room_label_of(uuid) from public, anon, authenticated;

create or replace function public.track_room_assignment()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_was_open boolean;
begin
  if tg_op = 'INSERT' then
    if new.room_id is not null and new.status = 'active' then
      insert into public.room_assignments (resident_id, room_id, room_label, changed_by)
      values (new.id, new.room_id, public.room_label_of(new.room_id), auth.uid());
    end if;
    return new;
  end if;
  -- UPDATE: nothing to do unless the room or the status moved.
  if new.room_id is not distinct from old.room_id and new.status = old.status then
    return new;
  end if;
  v_was_open := old.room_id is not null and old.status = 'active';
  if v_was_open and (new.room_id is distinct from old.room_id or new.status <> 'active') then
    update public.room_assignments set to_at = now()
     where resident_id = new.id and to_at is null;
  end if;
  if new.room_id is not null and new.status = 'active'
     and (new.room_id is distinct from old.room_id or old.status <> 'active') then
    insert into public.room_assignments (resident_id, room_id, room_label, changed_by)
    values (new.id, new.room_id, public.room_label_of(new.room_id), auth.uid());
  end if;
  return new;
end;
$$;
revoke all on function public.track_room_assignment() from public, anon, authenticated;

drop trigger if exists residents_room_history on public.residents;
create trigger residents_room_history
  after insert or update of room_id, status on public.residents
  for each row execute function public.track_room_assignment();

-- Backfill: every active resident with a room gets an open row, dated from
-- the audit entry that put them there when one exists, else from their
-- registration. Runs once; a re-run finds the open rows and adds nothing.
insert into public.room_assignments (resident_id, room_id, room_label, from_at, changed_by)
select r.id, r.room_id, public.room_label_of(r.room_id),
       coalesce((select max(a.at) from public.admin_audit a
                  where a.table_name = 'residents' and a.row_id = r.id::text
                    and a.new_row->>'room_id' = r.room_id::text
                    and a.old_row->>'room_id' is distinct from a.new_row->>'room_id'),
                r.registered_at),
       (select a.actor_id from public.admin_audit a
         where a.table_name = 'residents' and a.row_id = r.id::text
           and a.new_row->>'room_id' = r.room_id::text
           and a.old_row->>'room_id' is distinct from a.new_row->>'room_id'
         order by a.at desc limit 1)
  from public.residents r
 where r.room_id is not null and r.status = 'active'
   and not exists (select 1 from public.room_assignments x where x.resident_id = r.id and x.to_at is null);

-- ---------------------------------------------------------------------------
-- 3. Search by room
-- ---------------------------------------------------------------------------

create or replace function public.search_residents(
  q                text,
  include_departed boolean default false,
  max_results      integer default 20
)
returns setof public.v_resident_status
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select v.*
  from public.v_resident_status v
  cross join (select lower(public.immutable_unaccent(btrim(coalesce(q, '')))) as nq) n
  where public.is_staff()
    and (include_departed or v.status = 'active')
    and (
      n.nq = ''
      or v.search_key like '%' || n.nq || '%'
      -- Migration 028: the room as painted on the door (B1, K12), or any
      -- part of the building-and-room label. Security works by room.
      or exists (select 1 from public.v_resident_room x
                  where x.id = v.id
                    and (lower(x.room) = n.nq
                         or lower(x.room_label) like '%' || n.nq || '%'
                         or lower(x.building || ' ' || x.room) like '%' || n.nq || '%'))
      or (
        word_similarity(n.nq, v.search_key) >= 0.4
        and not exists (
          select 1 from public.v_resident_status v2
          where (include_departed or v2.status = 'active')
            and v2.search_key like '%' || n.nq || '%'
        )
      )
    )
  order by
    case when exists (select 1 from public.v_resident_room x where x.id = v.id and lower(x.room) = n.nq) then 0
         when v.search_key like n.nq || '%'         then 0
         when v.search_key like '%' || n.nq || '%'  then 1
         else 2 end,
    word_similarity(n.nq, v.search_key) desc,
    v.last_name, v.first_name
  limit greatest(1, least(coalesce(max_results, 20), 1000));
$$;


-- ---------------------------------------------------------------------------
-- 4. The subject-access export carries both (Art. 15: everything held)
-- ---------------------------------------------------------------------------

create or replace function public.export_resident_record(p_resident_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_out jsonb;
begin
  if not public.is_admin() then
    raise exception 'Only an admin may export a resident record' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'exported_at', now(),
    'exported_by', (select full_name from public.profiles where id = auth.uid()),
    'resident', to_jsonb(r) - 'search_key',
    'gate_events', coalesce((
      select jsonb_agg(jsonb_build_object(
               'kind', e.kind,
               'occurred_at', e.occurred_at,
               'recorded_at', e.recorded_at,
               'late_entry', e.late_entry,
               'recorded_by', g.full_name
             ) order by e.occurred_at)
      from public.gate_events e
      join public.profiles g on g.id = e.guard_id
      where e.resident_id = r.id
    ), '[]'::jsonb),
    'checkin_events', coalesce((
      select jsonb_agg(jsonb_build_object(
               'occurred_at', c.occurred_at,
               'recorded_at', c.recorded_at,
               'late_entry', c.late_entry,
               'recorded_by', g.full_name
             ) order by c.occurred_at)
      from public.checkin_events c
      join public.profiles g on g.id = c.guard_id
      where c.resident_id = r.id
    ), '[]'::jsonb),
    'daily_compliance', coalesce((
      select jsonb_agg(jsonb_build_object(
               'date', dc.compliance_date,
               'required', dc.required,
               'presented', dc.presented,
               'checkins', dc.checkin_count
             ) order by dc.compliance_date)
      from public.daily_compliance dc where dc.resident_id = r.id
    ), '[]'::jsonb),
    -- Who opened this record and when (migration 023). Part of "everything
    -- held about me", and the reason the access log exists.
    'views', coalesce((
      select jsonb_agg(jsonb_build_object(
               'at', v.viewed_at,
               'by', p.full_name,
               'where', v.surface
             ) order by v.viewed_at)
      from public.resident_views v
      left join public.profiles p on p.id = v.actor_id
      where v.resident_id = r.id
    ), '[]'::jsonb),
    -- Authorised absences and the rooms they have had (migration 028).
    'authorised_absences', coalesce((
      select jsonb_agg(jsonb_build_object(
               'from', a.from_date, 'to', a.to_date, 'reason', a.reason,
               'guardian_agreed', a.guardian_agreed, 'ended_on', a.ended_on,
               'approved_by', p.full_name, 'recorded_at', a.created_at
             ) order by a.from_date)
      from public.authorised_absences a
      left join public.profiles p on p.id = a.approved_by
      where a.resident_id = r.id
    ), '[]'::jsonb),
    'rooms', coalesce((
      select jsonb_agg(jsonb_build_object(
               'room', ra.room_label, 'from', ra.from_at, 'to', ra.to_at,
               'changed_by', p.full_name
             ) order by ra.from_at)
      from public.room_assignments ra
      left join public.profiles p on p.id = ra.changed_by
      where ra.resident_id = r.id
    ), '[]'::jsonb),
    -- Every change an administrator made to this record, and every export
    -- of it. Art. 15 is "everything held about me"; that includes who
    -- edited it and when.
    'changes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'at', a.at,
               'action', a.action,
               'by', p.full_name,
               'before', a.old_row,
               'after', a.new_row,
               'note', a.note
             ) order by a.at)
      from public.admin_audit a
      left join public.profiles p on p.id = a.actor_id
      where a.table_name = 'residents' and a.row_id = r.id::text
    ), '[]'::jsonb)
  )
  into v_out
  from public.residents r
  where r.id = p_resident_id;

  if v_out is null then
    raise exception 'Resident not found' using errcode = 'P0002';
  end if;

  return v_out;
end;
$$;
