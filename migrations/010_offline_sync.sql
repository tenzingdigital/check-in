-- ---------------------------------------------------------------------------
-- 010_offline_sync.sql — events recorded while the terminal was offline.
-- ---------------------------------------------------------------------------
--
-- The centre's internet drops for minutes to hours at a time. Until now every
-- tap was a request to the server, so an outage meant nothing could be
-- recorded at all. The front end now queues gate events and check-ins on the
-- terminal while it is offline and replays them when the link returns. This
-- migration is the server side of that: a way to record an event that
-- happened EARLIER than now, that is honest about having done so.
--
-- Three rules, each enforced here rather than in JavaScript (Tao 5):
--
--   1. THE ORIGINAL TIME IS KEPT, AND BOUNDED. occurred_at is the terminal's
--      clock at the moment of the tap. It may not be in the future (beyond a
--      few minutes of clock skew) and may not be older than
--      app_settings.late_entry_window_hours. Inside that window a check-in
--      lands on the calendar day it actually happened, which is the whole
--      point: a presentation at 23:50 that syncs at 00:10 must satisfy
--      yesterday, not today, or the register manufactures a breach.
--
--   2. IT IS FLAGGED. late_entry = true and recorded_at = the server clock at
--      the moment of sync, so a reader of the register can always separate
--      "recorded live" from "recorded later". Tao 9 says the site's clock is
--      the one that counts; a late entry is the one place a terminal's clock
--      is trusted, and the flag is what makes that visible.
--
--   3. REPLAYING IS SAFE. Each queued event carries a client_ref, a random uuid
--      minted on the terminal. A replay that reaches the server twice — the
--      first response lost in the same outage — records one event, not two.
--
-- What does NOT change: identity still comes from the session (Tao 6), the
-- resident must still be active on the day in question, the double-tap
-- dedupe still applies, and nothing here can edit or delete an existing row.
-- A late check-in landing on a day that close-out has already written as
-- missed flips that day's `presented` to true — the same on-conflict path a
-- live check-in has always used — and leaves closed_at as it was. Item 4 in
-- docs/KNOWN-ISSUES.md described that path as unreachable; it is reachable
-- now, and the register content is right either way.

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. Settings
-- ---------------------------------------------------------------------------

alter table public.app_settings
  add column if not exists late_entry_window_hours integer not null default 48
    check (late_entry_window_hours between 1 and 168);

comment on column public.app_settings.late_entry_window_hours is
  'How far back a synced-later event may be dated. Bounds the terminal clock; the flag on the event does the rest.';

-- ---------------------------------------------------------------------------
-- 2. The two ledgers gain provenance
-- ---------------------------------------------------------------------------
-- recorded_at is backfilled from occurred_at for existing rows: every row
-- before this migration was recorded live, so the two were the same instant.

alter table public.gate_events
  add column if not exists recorded_at timestamptz,
  add column if not exists late_entry  boolean not null default false,
  add column if not exists client_ref  uuid;
update public.gate_events set recorded_at = occurred_at where recorded_at is null;
alter table public.gate_events
  alter column recorded_at set not null,
  alter column recorded_at set default now();
create unique index if not exists gate_events_client_ref_key
  on public.gate_events (client_ref) where client_ref is not null;

alter table public.checkin_events
  add column if not exists recorded_at timestamptz,
  add column if not exists late_entry  boolean not null default false,
  add column if not exists client_ref  uuid;
update public.checkin_events set recorded_at = occurred_at where recorded_at is null;
alter table public.checkin_events
  alter column recorded_at set not null,
  alter column recorded_at set default now();
create unique index if not exists checkin_events_client_ref_key
  on public.checkin_events (client_ref) where client_ref is not null;

comment on column public.checkin_events.late_entry is
  'True when the event was recorded on a terminal while offline and synced later. occurred_at is then the terminal clock; recorded_at is the server clock at sync.';
comment on column public.gate_events.late_entry is
  'True when the event was recorded on a terminal while offline and synced later. occurred_at is then the terminal clock; recorded_at is the server clock at sync.';

-- ---------------------------------------------------------------------------
-- 3. The window check, in one place
-- ---------------------------------------------------------------------------

create or replace function public.assert_late_entry_window(p_occurred_at timestamptz)
returns void
language plpgsql
stable
set search_path = public, extensions
as $$
declare v_hours integer;
begin
  if p_occurred_at is null then
    raise exception 'occurred_at is required' using errcode = '22023';
  end if;
  if p_occurred_at > now() + interval '5 minutes' then
    raise exception 'occurred_at is in the future — check the terminal clock'
      using errcode = '22023';
  end if;
  select late_entry_window_hours into v_hours from public.app_settings where id;
  if p_occurred_at < now() - make_interval(hours => v_hours) then
    raise exception 'occurred_at is older than the %-hour late-entry window', v_hours
      using errcode = '22023';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Check-ins: one implementation, two doors
-- ---------------------------------------------------------------------------
-- record_checkin_at() is the day-placement logic that used to live inside
-- record_checkin(). It is NOT granted to any request role: the two wrappers
-- below are SECURITY DEFINER and reach it as the owner, and each wrapper is
-- what decides which timestamp is allowed.

create or replace function public.record_checkin_at(
  p_resident_id uuid,
  p_at          timestamptz,
  p_late        boolean,
  p_client_ref  uuid
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
    insert into public.checkin_events (resident_id, guard_id, occurred_at, recorded_at, late_entry, client_ref)
    values (p_resident_id, auth.uid(), p_at, now(), p_late, p_client_ref);

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

-- The live door: the same signature and behaviour as before.
create or replace function public.record_checkin(p_resident_id uuid)
returns public.daily_compliance
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  return public.record_checkin_at(p_resident_id, now(), false, null);
end;
$$;

-- The offline door: a bounded past timestamp, flagged, idempotent.
create or replace function public.record_checkin_late(
  p_resident_id uuid,
  p_occurred_at timestamptz,
  p_client_ref  uuid
)
returns public.daily_compliance
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.is_staff() then
    raise exception 'Not authorised to record check-ins' using errcode = '42501';
  end if;
  if p_client_ref is null then
    raise exception 'client_ref is required for a late entry' using errcode = '22023';
  end if;
  perform public.assert_late_entry_window(p_occurred_at);
  return public.record_checkin_at(p_resident_id, p_occurred_at, true, p_client_ref);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Gate events: the offline door
-- ---------------------------------------------------------------------------
-- record_check() is unchanged. This is the same operation with a supplied,
-- bounded, flagged timestamp and a client_ref.

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
  end if;

  return query select * from public.v_resident_status where id = p_resident_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. The log view and the export show provenance
-- ---------------------------------------------------------------------------
-- Columns are appended, so `create or replace` is enough and nothing that
-- selects by name from these needs to change.

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
  e.recorded_at
from public.gate_events e
join public.residents r on r.id = e.resident_id
join public.profiles  g on g.id = e.guard_id
where public.is_staff();

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

-- ---------------------------------------------------------------------------
-- 7. Grants (Tao 7: re-close after every change)
-- ---------------------------------------------------------------------------
-- 001's default privileges hand every NEW function to anon and authenticated.
-- record_checkin_at() must be reachable only through its two wrappers, so it
-- is revoked from everything; the wrappers run as the owner and need no grant
-- to call it.

revoke all on function public.assert_late_entry_window(timestamptz)                      from public, anon, authenticated, service_role;
revoke all on function public.record_checkin_at(uuid, timestamptz, boolean, uuid)         from public, anon, authenticated, service_role;
revoke all on function public.record_checkin_late(uuid, timestamptz, uuid)                from public, anon;
revoke all on function public.record_check_late(uuid, text, timestamptz, uuid)            from public, anon;

grant execute on function public.record_checkin_late(uuid, timestamptz, uuid)     to authenticated;
grant execute on function public.record_check_late(uuid, text, timestamptz, uuid) to authenticated;

revoke all on public.v_check_log from anon, public;
grant select on public.v_check_log to authenticated;
