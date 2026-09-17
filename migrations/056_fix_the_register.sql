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
  v_next timestamptz;
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
  v_status text; v_id bigint; v_day date; v_next timestamptz; v_dup boolean;
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
  select status into v_status from public.residents where id = p_resident_id;
  if v_status is null then raise exception 'Resident not found' using errcode = 'P0002'; end if;
  v_day := (p_at at time zone v_tz)::date;

  if p_register = 'checkin' then
    -- record_checkin_at() places the day, repairs a closed day, and applies
    -- the 60-second double-tap rule; by_hand is set on the row it made.
    perform public.record_checkin_at(p_resident_id, p_at, false, null, 'desk');
    select max(id) into v_id from public.checkin_events
     where resident_id = p_resident_id and occurred_at = p_at;
    if v_id is null then
      raise exception 'A check-in within a minute of that time is already on the register' using errcode = '23505';
    end if;
    update public.checkin_events set by_hand = true where id = v_id and by_hand = false and guard_id = auth.uid();
  else
    if v_status <> 'active' then
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
