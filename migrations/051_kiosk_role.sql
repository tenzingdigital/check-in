-- 051_kiosk_role.sql — a fourth role that is not staff: the self check-in
-- kiosk.
--
-- Every role so far (guard, supervisor, admin) is a member of is_staff(),
-- which is the gate almost every row policy and SECURITY DEFINER function in
-- this schema tests. A shared tablet by the door, logged into once and left
-- running in Guided Access, is a different trust level entirely: nobody is
-- watching who taps it between residents, so it must never inherit anything
-- is_staff() protects — not the residents table, not a date of birth, not
-- the full register, not the weekly report or the safeguarding alert. It is
-- deliberately left OUT of is_staff() rather than given its own narrower
-- helper, so that the very large number of places that already say
-- "if not is_staff() then refuse" need no review at all: they already
-- refuse kiosk today, and will keep refusing it after every future
-- migration that reads is_staff(), with nothing here to remember to update.
-- The kiosk reaches resident data through exactly two SECURITY DEFINER
-- doors, kiosk_search() and kiosk_checkin(), built for it below, and it may
-- also be passed to record_checkin_at() with source='kiosk' — nowhere else.
set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. The role itself.
-- ---------------------------------------------------------------------------
-- Widened everywhere the four-role enum is validated: the column check, and
-- the two account-creation functions (auth.create_user / …_invited), which
-- each carry their own copy of the same check rather than trusting the
-- column. handle_new_user() defaults an unspecified role to 'guard' and does
-- no validation of its own — it always follows one of the two functions
-- below, which have already refused anything else — so it is untouched.
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check check (role in ('guard', 'supervisor', 'admin', 'kiosk'));

comment on table public.profiles is
  'Staff accounts, plus the kiosk role. role=guard: search + sign residents in/out. supervisor: also manage residents. admin: also manage staff and run GDPR export/erasure. kiosk: a shared tablet login, not staff — see kiosk_search()/kiosk_checkin() below.';

create or replace function auth.create_user(
  p_email     text,
  p_password  text,
  p_full_name text,
  p_role      text default 'guard',
  p_tenant    uuid default null
)
returns uuid
language plpgsql security definer set search_path = auth, public, extensions
as $$
declare v_id uuid;
begin
  if p_role not in ('guard', 'supervisor', 'admin', 'kiosk') then
    raise exception 'role must be guard, supervisor, admin or kiosk' using errcode = '22023';
  end if;
  if length(coalesce(p_password, '')) < 12 then
    raise exception 'password must be at least 12 characters' using errcode = '22023';
  end if;
  insert into auth.users (email, encrypted_password, raw_user_meta_data, tenant_id)
  values (btrim(p_email),
          extensions.crypt(p_password, extensions.gen_salt('bf', 12)),
          jsonb_build_object('full_name', p_full_name, 'role', p_role),
          coalesce(p_tenant, auth.current_tenant()))
  returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception 'An account with that email already exists' using errcode = '22023';
end;
$$;
revoke all on function auth.create_user(text, text, text, text, uuid) from public, anon, authenticated;

create or replace function auth.create_user_invited(
  p_email     text,
  p_full_name text,
  p_role      text default 'guard',
  p_tenant    uuid default null
)
returns uuid
language plpgsql security definer set search_path = auth, public, extensions
as $$
declare v_id uuid;
begin
  if p_role not in ('guard', 'supervisor', 'admin', 'kiosk') then
    raise exception 'role must be guard, supervisor, admin or kiosk' using errcode = '22023';
  end if;
  if position('@' in coalesce(btrim(p_email), '')) < 2 then
    raise exception 'A valid email address is required' using errcode = '22023';
  end if;
  if length(coalesce(btrim(p_full_name), '')) = 0 then
    raise exception 'A name is required' using errcode = '22023';
  end if;
  insert into auth.users (email, raw_user_meta_data, tenant_id)
  values (btrim(p_email), jsonb_build_object('full_name', btrim(p_full_name), 'role', p_role),
          coalesce(p_tenant, auth.current_tenant()))
  returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception 'An account with that email already exists' using errcode = '22023';
end;
$$;
revoke all on function auth.create_user_invited(text, text, text, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. The register learns a third source.
-- ---------------------------------------------------------------------------
-- 'kiosk': the person presented themselves and confirmed their own name on
-- the tablet screen — nobody witnessed it. Kept alongside 'desk' and 'door'
-- so the register and every export can tell the three apart, same reasoning
-- as 026.
alter table public.checkin_events drop constraint if exists checkin_events_source_check;
alter table public.checkin_events
  add constraint checkin_events_source_check check (source in ('desk', 'door', 'kiosk'));
comment on column public.checkin_events.source is
  'Where the presentation was recorded: desk (the register), door (a Door sign-in, feature_door_checkin) or kiosk (a resident self-check-in, kiosk_checkin()).';

-- record_checkin_at() is the one writer behind every check-in path (desk,
-- door, and now kiosk). Its guard is the entire security model for the
-- write: a kiosk session may reach it ONLY by way of kiosk_checkin() below,
-- and only ever with source='kiosk' — a kiosk that somehow called it
-- directly with source='desk' (or any other source) is still refused, so
-- the source a check-in carries can never be forged by the role recording
-- it. This is a full re-declaration (copied from 039) with that one line
-- changed; everything else, including the day-placement and de-dupe logic,
-- is unchanged.
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
  if not (public.is_staff() or (public.my_role() = 'kiosk' and p_source = 'kiosk')) then
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
        v_res.departed_on, v_day, v_adult)
        -- Migration 038: the same exemption close-out has applied since 028.
        -- Without it this writer and that one disagreed about the same day.
        and not public.absence_authorised(p_resident_id, v_day),
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

-- ---------------------------------------------------------------------------
-- 3. kiosk_search(q) — find one adult, never a list.
-- ---------------------------------------------------------------------------
-- Callable by kiosk (the real caller) and by supervisor/admin (so the same
-- search can be exercised and supported from a staff login without a second
-- implementation). Everyone else, including guard, is refused: a guard's
-- existing tools already do this better (full search, room browsing,
-- history) and have no business going through a function built to be safe
-- for an unattended tablet.
create or replace function public.kiosk_search(p_q text)
returns table (
  resident_id      uuid,
  full_name        text,
  room_label       text,
  checked_in_today boolean
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_role  text := public.my_role();
  v_nq    text;
  v_adult integer;
begin
  if v_role not in ('kiosk', 'supervisor', 'admin') then
    raise exception 'Not authorised to search residents' using errcode = '42501';
  end if;

  -- Two letters minimum: the point of a search, not a list. A single letter
  -- (or the empty string a cleared box sends) would return "everyone whose
  -- name starts with A" off a shared tablet — this is the line that keeps
  -- kiosk_search a search.
  v_nq := lower(public.immutable_unaccent(btrim(coalesce(p_q, ''))));
  if length(v_nq) < 2 then
    raise exception 'Type at least two letters' using errcode = '22023';
  end if;

  select adult_age_years into v_adult from public.app_settings where id;

  return query
    with matched as (
      select
        r.id                                              as m_id,
        btrim(r.first_name) || ' ' || btrim(r.last_name)   as m_full_name,
        case when rm.id is null then null
             else b.name
                  || case when rm.floor <> '' then ' · ' || rm.floor else '' end
                  || ' · ' || rm.number
        end                                                 as m_room_label,
        exists (
          select 1 from public.daily_compliance d
          where d.resident_id = r.id
            and d.compliance_date = public.site_today()
            and d.presented
        )                                                   as m_checked_in_today
      from public.residents r
      left join public.rooms     rm on rm.id = r.room_id
      left join public.buildings b  on b.id = rm.building_id
      where r.status = 'active'
        -- The daily register is an adult's duty (IPAS): a child is never on
        -- this screen at all, not merely hidden after being found — the row
        -- never enters the candidate set, so no branch below can surface one.
        and r.date_of_birth <= (public.site_today() - make_interval(years => v_adult))::date
        and (
          -- Name: prefix on either word order, so "aoi" and "brennan" both
          -- find Aoife Brennan. Deliberately NOT search_key — search_key
          -- (008) also folds in id_number, so a substring match on it would
          -- let a partial identity number through the name box. Matched on
          -- the plain names instead, word-prefix only (never a bare
          -- substring), so a person cannot be found by a fragment buried
          -- mid-name that happens to be common to many residents.
          lower(public.immutable_unaccent(btrim(r.first_name) || ' ' || btrim(r.last_name))) like v_nq || '%'
          or lower(public.immutable_unaccent(btrim(r.first_name) || ' ' || btrim(r.last_name))) like '% ' || v_nq || '%'
          or lower(public.immutable_unaccent(btrim(r.last_name) || ' ' || btrim(r.first_name))) like v_nq || '%'
          or lower(public.immutable_unaccent(btrim(r.last_name) || ' ' || btrim(r.first_name))) like '% ' || v_nq || '%'
          -- Room: the label as painted on the door, exact match only (never
          -- a prefix or substring) — a room holds several people, so a
          -- loose room match would be a mini roll-call of the whole room,
          -- which is exactly the "list" this function refuses to be.
          or (rm.id is not null and lower(
                b.name || case when rm.floor <> '' then ' · ' || rm.floor else '' end || ' · ' || rm.number
              ) = v_nq)
          -- Identity number: EXACT match only, never a prefix or substring.
          -- id_number is upper-cased on write (routes/residents.js), so both
          -- sides are upper-cased here to match regardless of how it was
          -- typed. A prefix match would let the number be enumerated one
          -- digit at a time from a shared tablet; this closes that off
          -- entirely rather than just making it slow.
          or (r.id_number is not null and upper(r.id_number) = upper(btrim(coalesce(p_q, ''))))
        )
    )
    select
      m.m_id,
      m.m_full_name,
      -- The room is shown only to tell two same-named residents apart — by
      -- default one resident's room is never revealed to whoever is standing
      -- at the tablet.
      case when count(*) over (partition by m.m_full_name) > 1 then m.m_room_label else null end,
      m.m_checked_in_today
    from matched m
    order by m.m_full_name
    limit 5;
end;
$$;
revoke all on function public.kiosk_search(text) from public, anon;
grant execute on function public.kiosk_search(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. kiosk_checkin(resident_id) — record today's presentation. Nothing else.
-- ---------------------------------------------------------------------------
create or replace function public.kiosk_checkin(p_resident_id uuid)
returns public.daily_compliance
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_role  text := public.my_role();
  v_res   public.residents;
  v_adult integer;
begin
  if v_role not in ('kiosk', 'supervisor', 'admin') then
    raise exception 'Not authorised to record check-ins' using errcode = '42501';
  end if;

  select * into v_res from public.residents where id = p_resident_id;
  -- Missing and inactive share one message and one errcode: from the
  -- tablet's point of view both are "nobody here to check in", and neither
  -- should say more than that to a screen nobody is guarding.
  if not found or v_res.status <> 'active' then
    raise exception 'Not a resident who checks in here' using errcode = 'P0002';
  end if;

  select adult_age_years into v_adult from public.app_settings where id;
  if v_res.date_of_birth > (public.site_today() - make_interval(years => v_adult))::date then
    raise exception 'Not a resident who checks in here' using errcode = 'P0002';
  end if;

  -- The only write a kiosk can make, and it is not made here: this always
  -- calls the one shared writer with source='kiosk', so record_checkin_at's
  -- own guard (above) is what actually authorises it, day-placement and
  -- de-dupe are identical to every other source, and there is no second copy
  -- of that logic to drift out of step with desk/door.
  return public.record_checkin_at(p_resident_id, now(), false, null, 'kiosk');
end;
$$;
revoke all on function public.kiosk_checkin(uuid) from public, anon;
grant execute on function public.kiosk_checkin(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. The kiosk is neither a report recipient nor a safeguarding contact.
-- ---------------------------------------------------------------------------
-- Both flags already refused a guard (037, 041) because each points at a
-- report only a supervisor or admin can run; a kiosk can run neither, so it
-- is refused for the same reason. Re-declared in full (constraint + the
-- trigger that clears the flag on a role change) rather than patched, so the
-- text in this file matches what is actually in the database.
create or replace function public.profiles_clear_weekly_report_for_guard()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.role in ('guard', 'kiosk') and (tg_op = 'INSERT' or old.role is distinct from new.role) then
    new.weekly_report := false;
  end if;
  return new;
end;
$$;
revoke all on function public.profiles_clear_weekly_report_for_guard() from public, anon, authenticated;

alter table public.profiles drop constraint if exists profiles_weekly_report_not_guard;
alter table public.profiles
  add constraint profiles_weekly_report_not_guard check (not (weekly_report and role in ('guard', 'kiosk')));

create or replace function public.profiles_clear_safeguarding_alert_for_guard()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.role in ('guard', 'kiosk') and (tg_op = 'INSERT' or old.role is distinct from new.role) then
    new.safeguarding_alert := false;
  end if;
  return new;
end;
$$;
revoke all on function public.profiles_clear_safeguarding_alert_for_guard() from public, anon, authenticated;

alter table public.profiles drop constraint if exists profiles_safeguarding_alert_not_guard;
alter table public.profiles
  add constraint profiles_safeguarding_alert_not_guard check (not (safeguarding_alert and role in ('guard', 'kiosk')));
