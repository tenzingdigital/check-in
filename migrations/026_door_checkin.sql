-- 026: a Door sign-in counts as the day's check-in, when the site says so.
--
-- TAO 13: a sign-in is not a check-in, because the duty is to present, not
-- merely to be seen leaving. That stays the default. This switch lets a
-- centre say that at its door a sign IN *is* the presentation — the person
-- is seen and their card is checked there — while a sign OUT never counts.
-- The register keeps the difference: every check-in event carries a source,
-- 'desk' or 'door', so a manager can tell them apart and turning the switch
-- off later leaves the record honest.
set search_path = public, extensions;

alter table public.app_settings
  add column if not exists feature_door_checkin boolean not null default false;
comment on column public.app_settings.feature_door_checkin is
  'A sign IN at the Door also records today''s check-in, marked source=door. A sign OUT never does. Off: the two acts stay separate.';

alter table public.checkin_events
  add column if not exists source text not null default 'desk'
    check (source in ('desk', 'door'));
comment on column public.checkin_events.source is
  'Where the presentation was recorded: desk (the register) or door (a Door sign-in, feature_door_checkin).';

-- record_checkin_at() gains p_source. One function, not an overload: the old
-- signature goes first, and the two callers resolve to the default.
drop function if exists public.record_checkin_at(uuid, timestamptz, boolean, uuid);

-- record_checkin_at() is the day-placement logic that used to live inside
-- record_checkin(). It is NOT granted to any request role: the two wrappers
-- below are SECURITY DEFINER and reach it as the owner, and each wrapper is
-- what decides which timestamp is allowed.

create or replace function public.record_checkin_at(
  p_resident_id uuid,
  p_at          timestamptz,
  p_late        boolean,
  p_client_ref  uuid,
  p_source      text default 'desk'
)
returns public.daily_compliance
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_tz     text;
  v_adult  integer;
  v_day    date;
  v_res    public.residents;
  v_dup    boolean;
  v_out    public.daily_compliance;
begin
  if not public.is_staff() then
    raise exception 'Not authorised to record check-ins' using errcode = '42501';
  end if;

  select local_timezone, adult_age_years into v_tz, v_adult
  from public.app_settings where id;

  select * into v_res from public.residents where id = p_resident_id;
  if not found then
    raise exception 'Resident not found' using errcode = 'P0002';
  end if;

  v_day := (p_at at time zone v_tz)::date;

  -- Must agree with compliance_required(), which treats p_day <= departed_on
  -- as still required. A departed resident's final day is a day they must
  -- still be able to satisfy here — otherwise it becomes an unclearable
  -- statutory breach, since no role can UPDATE daily_compliance.
  if v_res.status <> 'active'
     and (v_res.departed_on is null or v_day > v_res.departed_on) then
    raise exception 'Resident is not active and cannot check in' using errcode = '23514';
  end if;

  -- A replay of an event already recorded is answered with the row it made,
  -- and records nothing. This is what lets the terminal retry a sync whose
  -- response was lost.
  if p_client_ref is not null and exists (
    select 1 from public.checkin_events where client_ref = p_client_ref
  ) then
    select dc.* into v_out from public.daily_compliance dc
    join public.checkin_events e on e.resident_id = dc.resident_id
    where e.client_ref = p_client_ref
      and dc.compliance_date = (e.occurred_at at time zone v_tz)::date;
    return v_out;
  end if;

  -- Touchscreens double-fire. A repeat inside 60 seconds is one presentation.
  -- Scoped to the site-local day: a check-in at 23:59:30 followed by one at
  -- 00:00:10 is 40 seconds apart but a genuine new-day presentation, not a
  -- double tap, and must not be swallowed together with the previous day's row.
  select exists (
    select 1 from public.checkin_events
    where resident_id = p_resident_id
      and (occurred_at at time zone v_tz)::date = v_day
      and abs(extract(epoch from (occurred_at - p_at))) < 60
  ) into v_dup;

  if not v_dup then
    insert into public.checkin_events (resident_id, guard_id, occurred_at, recorded_at, late_entry, client_ref, source)
    values (p_resident_id, auth.uid(), p_at, now(), p_late, p_client_ref, p_source);

    -- The on-conflict branch is also how a late check-in corrects a day that
    -- close-out already wrote as missed: presented becomes true and
    -- first_seen_at is set (least() ignores the null it had). closed_at is
    -- left alone — the day stays closed, its content is now right.
    insert into public.daily_compliance as dc
      (resident_id, compliance_date, required, presented, first_seen_at, checkin_count)
    values (
      p_resident_id, v_day,
      public.compliance_required(
        v_res.date_of_birth,
        (v_res.registered_at at time zone v_tz)::date,
        v_res.departed_on, v_day, v_adult),
      true, p_at, 1)
    on conflict (resident_id, compliance_date) do update
      set presented     = true,
          first_seen_at = least(dc.first_seen_at, excluded.first_seen_at),
          checkin_count = dc.checkin_count + 1;
  end if;

  select * into v_out from public.daily_compliance
  where resident_id = p_resident_id and compliance_date = v_day;
  if not found then
    raise exception 'record_checkin_at: no daily_compliance row for resident % on %; this is a bug',
      p_resident_id, v_day using errcode = 'XX000';
  end if;
  return v_out;
end;
$$;

revoke all on function public.record_checkin_at(uuid, timestamptz, boolean, uuid, text) from public, anon, authenticated, service_role;

-- Unchanged in behaviour except for the door's presentation, below. It is
-- here only because it returns setof v_resident_status, so it had to be
-- dropped for the view to be rebuilt (008).
create or replace function public.record_check(
  p_resident_id uuid,
  p_direction   text
)
returns setof public.v_resident_status
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  v_guard  uuid := auth.uid();
  v_status text;
  v_last   public.gate_events;
begin
  if not public.is_staff() then
    raise exception 'Not authorised to record check events' using errcode = '42501';
  end if;

  if p_direction not in ('in', 'out') then
    raise exception 'direction must be ''in'' or ''out''' using errcode = '22023';
  end if;

  select status into v_status from public.residents where id = p_resident_id;
  if v_status is null then
    raise exception 'Resident not found' using errcode = 'P0002';
  end if;
  if v_status <> 'active' then
    raise exception 'Resident is not active and cannot be signed in or out'
      using errcode = '23514';
  end if;

  -- Ignore an identical repeat within 60 seconds (double tap on a touchscreen).
  select * into v_last
  from public.gate_events
  where resident_id = p_resident_id
  order by occurred_at desc, id desc
  limit 1;

  if v_last.id is null
     or v_last.kind <> p_direction
     or v_last.occurred_at < now() - interval '60 seconds'
  then
    insert into public.gate_events (resident_id, guard_id, kind)
    values (p_resident_id, v_guard, p_direction);

    -- The door as the presentation (feature_door_checkin). Only a sign IN,
    -- only when the event was really recorded, and through the same
    -- function the desk uses, so the 60-second rule and the day's row are
    -- the register's own. The source says it came from the door.
    if p_direction = 'in'
       and (select feature_door_checkin from public.app_settings where id) then
      perform public.record_checkin_at(p_resident_id, now(), false, null, 'door');
    end if;
  end if;

  return query
    select * from public.v_resident_status where id = p_resident_id;
end;
$fn$;

revoke all on function public.record_check(uuid, text) from anon, public;
grant execute on function public.record_check(uuid, text) to authenticated;

-- record_check_late() is unchanged except for the door's presentation, below.
create or replace function public.record_check_late(
  p_resident_id uuid,
  p_direction   text,
  p_occurred_at timestamptz,
  p_client_ref  uuid
)
returns setof public.v_resident_status
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_status text;
  v_dup    boolean;
begin
  if not public.is_staff() then
    raise exception 'Not authorised to record check events' using errcode = '42501';
  end if;
  if p_direction not in ('in', 'out') then
    raise exception 'direction must be ''in'' or ''out''' using errcode = '22023';
  end if;
  if p_client_ref is null then
    raise exception 'client_ref is required for a late entry' using errcode = '22023';
  end if;
  perform public.assert_late_entry_window(p_occurred_at);

  -- Already replayed once: answer, record nothing.
  if exists (select 1 from public.gate_events where client_ref = p_client_ref) then
    return query select * from public.v_resident_status where id = p_resident_id;
    return;
  end if;

  select status into v_status from public.residents where id = p_resident_id;
  if v_status is null then
    raise exception 'Resident not found' using errcode = 'P0002';
  end if;
  if v_status <> 'active' then
    raise exception 'Resident is not active and cannot be signed in or out'
      using errcode = '23514';
  end if;

  -- The same 60-second double-tap rule as record_check(), measured against
  -- the event's own time rather than the server clock.
  select exists (
    select 1 from public.gate_events
    where resident_id = p_resident_id
      and kind = p_direction
      and abs(extract(epoch from (occurred_at - p_occurred_at))) < 60
  ) into v_dup;

  if not v_dup then
    insert into public.gate_events (resident_id, guard_id, kind, occurred_at, recorded_at, late_entry, client_ref)
    values (p_resident_id, auth.uid(), p_direction, p_occurred_at, now(), true, p_client_ref);

    -- The offline door as the presentation, same rule as record_check().
    -- The gate event's client_ref is reused so a replay is idempotent on
    -- both tables.
    if p_direction = 'in'
       and (select feature_door_checkin from public.app_settings where id) then
      perform public.record_checkin_at(p_resident_id, p_occurred_at, true, p_client_ref, 'door');
    end if;
  end if;

  return query select * from public.v_resident_status where id = p_resident_id;
end;
$$;

revoke all on function public.record_check_late(uuid, text, timestamptz, uuid) from public, anon;
grant execute on function public.record_check_late(uuid, text, timestamptz, uuid) to authenticated;
