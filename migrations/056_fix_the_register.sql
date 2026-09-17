-- 056_fix_the_register.sql — a wrong entry comes off the register; a
-- missed one goes on at the time it happened.
--
-- 17 September 2026, the owner: staff must be able to fix an incorrect
-- check-in or movement and record one that was missed, and guards too —
-- "flexibility is better because of human error". The register is the
-- inspection evidence, so nothing is edited in place: a removal copies the
-- whole row to admin_audit (action delete, the reason as the note) and then
-- deletes it, so every reader of the register is right without change and
-- the audit trail still says what was recorded, by whom, and why it went.
-- Two stored derivations have to follow the change by hand: the day's
-- daily_compliance row (a removed check-in can make a day missed again; a
-- check-in added to a closed day is what record_checkin_at() already does)
-- and overnight_absences for the nights a movement decides (027's snapshot,
-- re-derived for that resident over the nights between the changed event
-- and the next one). overnight_guardian_gaps (054) is NOT re-derived: it is
-- the record of what the register said at midnight, the nightly email has
-- already gone, and the correction is on the resident's history and the
-- audit trail. docs/KNOWN-ISSUES.md says so.
--
-- Who may:
--   remove, same site-day       any staff; no reason for your own entry
--                               within 15 minutes, a reason otherwise
--   remove, an earlier day      supervisor or admin, with a reason
--   add, within the late-entry  any staff, with a reason
--       window (48h default)
--   add, older, up to 28 nights supervisor or admin, with a reason
--
-- by_hand marks an entry added this way, as late_entry marks one synced
-- from an offline terminal; the history and the log say "entered by hand".

alter table public.checkin_events add column if not exists by_hand boolean not null default false;
alter table public.gate_events    add column if not exists by_hand boolean not null default false;
do $$
declare s text;
begin
  for s in select nspname from pg_namespace where nspname like 't\_%' escape '\' loop
    execute format('alter table %I.checkin_events add column if not exists by_hand boolean not null default false', s);
    execute format('alter table %I.gate_events    add column if not exists by_hand boolean not null default false', s);
  end loop;
end $$;

-- Re-derive one resident's overnight_absences rows for a run of nights, with
-- the predicate of snapshot_overnight_absences() (027): off site at the
-- midnight that ends the night if the latest movement before it is OUT or
-- there is none. Only nights already past (night < site_today()) are
-- touched; tonight is the snapshot's to write.
create or replace function public.recompute_overnight_absences(p_resident_id uuid, p_from date, p_to date)
returns integer language plpgsql security definer set search_path = public as $$
declare v_tz text; v_night date; v_end timestamptz; v_kind text; v_since timestamptz; v_res public.residents; n integer := 0;
begin
  select local_timezone into v_tz from public.app_settings where id;
  select * into v_res from public.residents where id = p_resident_id;
  if not found then return 0; end if;
  v_night := p_from;
  while v_night <= least(p_to, public.site_today() - 1) loop
    v_end := ((v_night + 1)::timestamp) at time zone v_tz;
    select e.kind, e.occurred_at into v_kind, v_since
      from public.gate_events e
     where e.resident_id = p_resident_id and e.occurred_at < v_end
     order by e.occurred_at desc, e.id desc limit 1;
    delete from public.overnight_absences where resident_id = p_resident_id and night = v_night;
    if v_res.registered_at < v_end
       and (v_res.status = 'active' or (v_res.status = 'departed' and v_res.departed_on is not null and v_res.departed_on > v_night))
       and (v_kind is null or v_kind = 'out') then
      insert into public.overnight_absences (night, resident_id, off_site_since) values (v_night, p_resident_id, v_since)
      on conflict do nothing;
    end if;
    n := n + 1;
    v_night := v_night + 1;
  end loop;
  return n;
end $$;
revoke all on function public.recompute_overnight_absences(uuid, date, date) from public, anon, authenticated;

-- Re-derive one day's daily_compliance row from the check-ins that remain.
-- The row stays (closed_at untouched): presented, first_seen_at and
-- checkin_count now describe what is on the register.
create or replace function public.recompute_daily_compliance(p_resident_id uuid, p_day date)
returns void language plpgsql security definer set search_path = public as $$
declare v_tz text;
begin
  select local_timezone into v_tz from public.app_settings where id;
  update public.daily_compliance dc
     set presented     = agg.n > 0,
         first_seen_at = agg.first_at,
         checkin_count = agg.n
    from (select count(*)::integer as n, min(e.occurred_at) as first_at
            from public.checkin_events e
           where e.resident_id = p_resident_id
             and (e.occurred_at at time zone v_tz)::date = p_day) agg
   where dc.resident_id = p_resident_id and dc.compliance_date = p_day;
end $$;
revoke all on function public.recompute_daily_compliance(uuid, date) from public, anon, authenticated;

create or replace function public.remove_register_entry(p_register text, p_id bigint, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_tz text; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_chk public.checkin_events; v_gate public.gate_events;
  v_resident uuid; v_guard uuid; v_at timestamptz; v_recorded timestamptz; v_day date; v_row jsonb;
  v_next timestamptz; v_twin bigint;
begin
  if not public.is_staff() then
    raise exception 'Not authorised to change the register' using errcode = '42501';
  end if;
  if p_register not in ('checkin', 'gate') then
    raise exception 'register must be ''checkin'' or ''gate''' using errcode = '22023';
  end if;
  if v_reason is not null and length(v_reason) > 200 then
    raise exception 'The reason is at most 200 characters' using errcode = '22023';
  end if;
  select local_timezone into v_tz from public.app_settings where id;

  if p_register = 'checkin' then
    select * into v_chk from public.checkin_events where id = p_id;
    if not found then raise exception 'No such check-in' using errcode = 'P0002'; end if;
    v_resident := v_chk.resident_id; v_guard := v_chk.guard_id; v_at := v_chk.occurred_at;
    v_recorded := coalesce(v_chk.recorded_at, v_chk.occurred_at); v_row := to_jsonb(v_chk);
  else
    select * into v_gate from public.gate_events where id = p_id;
    if not found then raise exception 'No such movement' using errcode = 'P0002'; end if;
    v_resident := v_gate.resident_id; v_guard := v_gate.guard_id; v_at := v_gate.occurred_at;
    v_recorded := coalesce(v_gate.recorded_at, v_gate.occurred_at); v_row := to_jsonb(v_gate);
  end if;
  v_day := (v_at at time zone v_tz)::date;

  if v_day < public.site_today() then
    if not public.is_supervisor() then
      raise exception 'Only a supervisor or admin can remove an entry from an earlier day' using errcode = '42501';
    end if;
    if v_reason is null then
      raise exception 'A reason is required to remove an entry from an earlier day' using errcode = '22023';
    end if;
  elsif v_reason is null and not (v_guard = auth.uid() and v_recorded > now() - interval '15 minutes') then
    raise exception 'A reason is required unless it is your own entry from the last 15 minutes' using errcode = '22023';
  end if;

  insert into public.admin_audit (actor_id, table_name, row_id, action, old_row, note)
  values (auth.uid(), case when p_register = 'checkin' then 'checkin_events' else 'gate_events' end, p_id::text, 'delete', v_row,
          coalesce(v_reason, 'own entry, within 15 minutes'));

  if p_register = 'checkin' then
    delete from public.checkin_events where id = p_id;
    perform public.recompute_daily_compliance(v_resident, v_day);
  else
    delete from public.gate_events where id = p_id;

    -- feature_door_checkin (026): a sign IN also writes a checkin_events row,
    -- source = 'door', through the same call and so at the same occurred_at
    -- (one now() for the whole transaction). Removing the IN without its
    -- twin would leave the day reading as presented on evidence the register
    -- has just declared wrong — the door's tap *was* the sign-in being
    -- removed, not a second presentation. Found by resident and the shared
    -- timestamp: only a sign IN ever makes one, so the match is exact.
    select id into v_twin from public.checkin_events
     where resident_id = v_resident and source = 'door' and occurred_at = v_at;
    if v_twin is not null then
      insert into public.admin_audit (actor_id, table_name, row_id, action, old_row, note)
      select auth.uid(), 'checkin_events', v_twin::text, 'delete', to_jsonb(c),
             coalesce(v_reason, 'own entry, within 15 minutes') || ' (door check-in recorded with the removed sign-in)'
        from public.checkin_events c where c.id = v_twin;
      delete from public.checkin_events where id = v_twin;
      perform public.recompute_daily_compliance(v_resident, v_day);
    end if;

    -- The nights this movement decided: from its own night up to the night
    -- before the next remaining movement (or last night).
    select min(e.occurred_at) into v_next from public.gate_events e where e.resident_id = v_resident and e.occurred_at > v_at;
    perform public.recompute_overnight_absences(v_resident, v_day,
      least(public.site_today() - 1, coalesce((v_next at time zone v_tz)::date, public.site_today() - 1)));
  end if;
end $$;
revoke all on function public.remove_register_entry(text, bigint, text) from public, anon;
grant execute on function public.remove_register_entry(text, bigint, text) to authenticated;

create or replace function public.add_register_entry(p_register text, p_resident_id uuid, p_direction text, p_at timestamptz, p_reason text)
returns bigint language plpgsql security definer set search_path = public, extensions as $$
declare
  v_tz text; v_hours integer; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_status text; v_departed date; v_id bigint; v_day date; v_next timestamptz; v_dup boolean; v_before integer; v_dc public.daily_compliance;
begin
  if not public.is_staff() then
    raise exception 'Not authorised to change the register' using errcode = '42501';
  end if;
  if p_register not in ('checkin', 'gate') then
    raise exception 'register must be ''checkin'' or ''gate''' using errcode = '22023';
  end if;
  if p_register = 'gate' and p_direction not in ('in', 'out') then
    raise exception 'direction must be ''in'' or ''out''' using errcode = '22023';
  end if;
  if v_reason is null or length(v_reason) > 200 then
    raise exception 'A reason of 1 to 200 characters is required' using errcode = '22023';
  end if;
  if p_at is null then raise exception 'When it happened is required' using errcode = '22023'; end if;
  if p_at > now() + interval '5 minutes' then
    raise exception 'That time is in the future' using errcode = '22023';
  end if;
  select local_timezone, late_entry_window_hours into v_tz, v_hours from public.app_settings where id;
  if p_at < now() - make_interval(hours => v_hours) then
    if not public.is_supervisor() then
      raise exception 'Only a supervisor or admin can add an entry older than % hours', v_hours using errcode = '42501';
    end if;
    if (p_at at time zone v_tz)::date < public.site_today() - 28 then
      raise exception 'An entry can be added for the last 28 nights only' using errcode = '22023';
    end if;
  end if;
  select status, departed_on into v_status, v_departed from public.residents where id = p_resident_id;
  if v_status is null then raise exception 'Resident not found' using errcode = 'P0002'; end if;
  v_day := (p_at at time zone v_tz)::date;

  if p_register = 'checkin' then
    -- record_checkin_at() places the day, repairs a closed day, and applies
    -- the 60-second double-tap rule. Whether it inserted is read off the
    -- day's row it returns: a count that did not move means the rule
    -- swallowed a double submit, and that is a refusal here, not a second
    -- audit row about the first call's event.
    select checkin_count into v_before from public.daily_compliance
     where resident_id = p_resident_id and compliance_date = v_day;
    v_dc := public.record_checkin_at(p_resident_id, p_at, false, null, 'desk');
    if v_dc.checkin_count = coalesce(v_before, 0) then
      raise exception 'A check-in within a minute of that time is already on the register' using errcode = '23505';
    end if;
    -- The row this call made: same second (now() is fixed for the
    -- transaction), this caller, this time.
    select max(id) into v_id from public.checkin_events
     where resident_id = p_resident_id and occurred_at = p_at and guard_id = auth.uid() and recorded_at = now();
    update public.checkin_events set by_hand = true where id = v_id;
  else
    -- The same rule as record_checkin_at(): a departed resident's days up
    -- to and including departed_on are still theirs to correct.
    if v_status <> 'active' and (v_departed is null or v_day > v_departed) then
      raise exception 'Resident is not active and cannot be signed in or out' using errcode = '23514';
    end if;
    select exists (select 1 from public.gate_events
                    where resident_id = p_resident_id and kind = p_direction
                      and abs(extract(epoch from (occurred_at - p_at))) < 60) into v_dup;
    if v_dup then
      raise exception 'A movement within a minute of that time is already on the register' using errcode = '23505';
    end if;
    insert into public.gate_events (resident_id, guard_id, kind, occurred_at, recorded_at, late_entry, by_hand)
    values (p_resident_id, auth.uid(), p_direction, p_at, now(), false, true)
    returning id into v_id;
    select min(e.occurred_at) into v_next from public.gate_events e where e.resident_id = p_resident_id and e.occurred_at > p_at;
    perform public.recompute_overnight_absences(p_resident_id, v_day,
      least(public.site_today() - 1, coalesce((v_next at time zone v_tz)::date, public.site_today() - 1)));
  end if;

  insert into public.admin_audit (actor_id, table_name, row_id, action, new_row, note)
  select auth.uid(), case when p_register = 'checkin' then 'checkin_events' else 'gate_events' end, v_id::text, 'insert',
         case when p_register = 'checkin' then (select to_jsonb(c) from public.checkin_events c where c.id = v_id)
              else (select to_jsonb(g) from public.gate_events g where g.id = v_id) end,
         v_reason;
  return v_id;
end $$;
revoke all on function public.add_register_entry(text, uuid, text, timestamptz, text) from public, anon;
grant execute on function public.add_register_entry(text, uuid, text, timestamptz, text) to authenticated;

-- The log view and the history show "entered by hand" alongside "recorded
-- offline": columns appended, so create or replace is enough. Re-created
-- here from its latest definition (010_offline_sync.sql). by_hand is
-- appended after recorded_at, not inserted after late_entry as prose would
-- put it: CREATE OR REPLACE VIEW only allows adding columns at the end,
-- never in the middle of the existing list, without dropping the view,
-- which the brief for this migration rules out. The view is not dropped,
-- so nothing that reads it by name has to change.
create or replace view public.v_check_log as
select
  e.id,
  e.resident_id,
  e.kind,
  e.occurred_at,
  btrim(r.first_name) || ' ' || btrim(r.last_name) as resident_name,
  e.guard_id,
  g.full_name as guard_name,
  e.late_entry,
  e.recorded_at,
  e.by_hand
from public.gate_events e
join public.residents r on r.id = e.resident_id
join public.profiles  g on g.id = e.guard_id
where public.is_staff();

-- ---------------------------------------------------------------------------
-- 5. Corrections are erased and exported with the resident; a supervisor
--    can read them (review findings I-2 and I-4)
-- ---------------------------------------------------------------------------
--
-- remove_register_entry() / add_register_entry() write admin_audit rows
-- shaped differently from every other write to that table: table_name is
-- 'checkin_events' or 'gate_events', row_id is the event's own id, and the
-- resident is only inside old_row/new_row, not in row_id. erase_audit_rows()
-- and export_resident_record() only ever looked at rows where
-- table_name = 'residents' — the resident's own edits — so an erasure left
-- the resident's id, times and a free-text reason sitting in admin_audit
-- after "erased", and a subject access export never showed a correction at
-- all. Both are widened here to find the resident inside the event too.

-- Copied verbatim from 012_audit_and_health.sql and extended: the same
-- admin-only guard, the same residents delete, plus every
-- checkin_events/gate_events audit row that names this resident inside
-- old_row or new_row (a removal carries old_row, an addition new_row).
create or replace function public.erase_audit_rows(p_resident_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_n integer; v_n2 integer;
begin
  if not public.is_admin() then
    raise exception 'Only an admin may erase a resident' using errcode = '42501';
  end if;
  delete from public.admin_audit
   where table_name = 'residents' and row_id = p_resident_id::text;
  get diagnostics v_n = row_count;
  delete from public.admin_audit
   where table_name in ('checkin_events', 'gate_events')
     and (old_row->>'resident_id' = p_resident_id::text or new_row->>'resident_id' = p_resident_id::text);
  get diagnostics v_n2 = row_count;
  return v_n + v_n2;
end;
$$;
revoke all on function public.erase_audit_rows(uuid) from public, anon;
grant execute on function public.erase_audit_rows(uuid) to authenticated;

-- Copied verbatim from its latest definition (029_holiday_cap_breaches_prefix.sql)
-- and extended with one more key: every register correction naming this
-- resident, so an Art. 15 export ("everything held about me") includes what
-- was taken off the register and what was added by hand, the same way it
-- already includes every change to the resident's own row.
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
    'breach_reports', coalesce((
      select jsonb_agg(jsonb_build_object(
               'kind', b.kind, 'issued_on', b.issued_on, 'reference', b.reference,
               'issued_by', p.full_name, 'recorded_at', b.created_at
             ) order by b.issued_on)
      from public.breach_reports b
      left join public.profiles p on p.id = b.issued_by
      where b.resident_id = r.id
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
    ), '[]'::jsonb),
    -- Migration 056: a wrong check-in or movement taken off the register, or
    -- a missed one added by hand. Keyed by the event, not the resident, so
    -- it is found the same way erase_audit_rows() now finds it — inside
    -- old_row/new_row rather than row_id.
    'register_corrections', coalesce((
      select jsonb_agg(jsonb_build_object(
               'at', a.at,
               'register', case a.table_name when 'checkin_events' then 'checkin' else 'gate' end,
               'action', case a.action when 'delete' then 'removed' else 'added' end,
               'entry', coalesce(a.old_row, a.new_row),
               'by', p.full_name,
               'reason', a.note
             ) order by a.at)
      from public.admin_audit a
      left join public.profiles p on p.id = a.actor_id
      where a.table_name in ('checkin_events', 'gate_events')
        and (a.old_row->>'resident_id' = r.id::text or a.new_row->>'resident_id' = r.id::text)
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
revoke all on function public.export_resident_record(uuid) from anon, public;
grant execute on function public.export_resident_record(uuid) to authenticated;

-- A supervisor can already read every other report; admin_audit itself is
-- admin-only (012's admin_audit_admin_read), because most of what it holds
-- is wider than a register correction. This function is the narrow door: it
-- hands back only the two tables' correction rows, in the shape the report
-- prints, and nothing else in admin_audit — a supervisor gets these rows and
-- nothing more from the table the review found unreadable (I-4).
create or replace function public.register_corrections(p_from date, p_to date)
returns table (
  "date"     text,
  "time"     text,
  action     text,
  register   text,
  entry      text,
  entry_time text,
  resident   text,
  entered_by text,
  by         text,
  reason     text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_supervisor() then
    raise exception 'Only a supervisor or admin can see register corrections' using errcode = '42501';
  end if;
  return query
    select to_char(a.at at time zone s.tz, 'YYYY-MM-DD'),
           to_char(a.at at time zone s.tz, 'HH24:MI'),
           case a.action when 'delete' then 'removed' else 'added' end,
           case a.table_name when 'checkin_events' then 'Daily register' else 'In & out' end,
           case a.table_name
             when 'checkin_events' then 'Check-in'
             else upper(coalesce(a.old_row, a.new_row)->>'kind')
           end,
           to_char(((coalesce(a.old_row, a.new_row)->>'occurred_at')::timestamptz) at time zone s.tz, 'YYYY-MM-DD HH24:MI'),
           coalesce(btrim(r.first_name) || ' ' || btrim(r.last_name), '(erased)'),
           g.full_name,
           p.full_name,
           a.note
      from public.admin_audit a
      cross join (select local_timezone as tz from public.app_settings where id) s
      left join public.residents r on r.id = nullif(coalesce(a.old_row, a.new_row)->>'resident_id', '')::uuid
      left join public.profiles  g on g.id = nullif(coalesce(a.old_row, a.new_row)->>'guard_id', '')::uuid
      left join public.profiles  p on p.id = a.actor_id
     where a.table_name in ('checkin_events', 'gate_events')
       and (a.at at time zone s.tz)::date between p_from and p_to
     order by a.at desc;
end;
$$;
revoke all on function public.register_corrections(date, date) from public, anon;
grant execute on function public.register_corrections(date, date) to authenticated;
