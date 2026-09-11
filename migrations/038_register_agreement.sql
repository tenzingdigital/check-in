-- 038: three writers that disagreed with each other, and one cap that counted
-- the wrong thing.
--
-- 1 and 2 are the same defect from both ends. Migration 028 taught close-out
--   that a day inside an authorised absence is a day the rule did not apply,
--   but record_checkin_at() -- which writes the row FIRST whenever anybody
--   presents -- was never told, and close-out's `on conflict do nothing` meant
--   it never looked again. So on a day a resident was authorised absent and
--   checked in anyway, the durable register said the day was required while
--   the absence record said it was not, and routes/checkins.js applied the
--   exemption to the live tile -- screen and record disagreeing about the same
--   day, in the statutory record. Both functions below are the 026/028 text
--   with only that change made.
--
-- 3 measures the holiday cap across the merged run instead of one row.
-- 4 gives the weekly-report recipient column a shape of its own.
--
-- Note what is deliberately NOT here: a repair for days close-out already
-- wrote before an absence was authorised retroactively. authorise_absence()
-- puts no lower bound on its start date, so that case is real -- but rewriting
-- a closed statutory row is the correction RPC the open decisions already
-- contemplate, and it needs a decision about who may do it and what it
-- records, not a quiet UPDATE in a migration.


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
    -- without touching presented, first_seen_at or checkin_count -- but DO
    -- recompute `required`.
    --
    -- Migration 038: the insert above carries the absence exemption and lands
    -- `on conflict do nothing`, so on a day a resident both checked in and was
    -- authorised absent, the row record_checkin_at had already written stood
    -- unexamined with the pre-028 value. The register said the day was
    -- required while the absence record said the rule did not apply, and the
    -- live tile (routes/checkins.js) applied the exemption -- so the screen and
    -- the record disagreed about the same day. Recomputing at close time is
    -- what makes the durable row the authority, whichever writer got there
    -- first, and it also picks up an absence authorised later the same day.
    update public.daily_compliance dc
       set closed_at = now(),
           required  = public.compliance_required(
                         r.date_of_birth,
                         (r.registered_at at time zone v_tz)::date,
                         r.departed_on, v_day, v_adult)
                       and not public.absence_authorised(r.id, v_day)
      from public.residents r
     where r.id = dc.resident_id
       and dc.compliance_date = v_day and dc.closed_at is null;
  end loop;

  return v_written;
end;
$$;

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
  v_holiday integer;
  v_row   public.authorised_absences;
  v_lo    date;
  v_hi    date;
  v_lo2   date;
  v_hi2   date;
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
  select adult_age_years, holiday_max_days into v_adult, v_holiday from public.app_settings where id;
  -- Migration 038: measure the cap across the whole run, not one row.
  -- The check was per row while the overlap guard below uses inclusive
  -- ranges, which permits ADJACENT rows -- so 1-14 followed by 15-28 passed
  -- two separate 14-day checks and produced a 28-day authorised holiday
  -- against an IPAS figure of 14. Absences cannot overlap, so the run this
  -- new range would join is found by widening a day either side and
  -- repeating until it stops growing; that terminates because the span only
  -- ever grows and is bounded by the rows that exist.
  if p_reason = 'holiday' then
    v_lo := p_from;
    v_hi := p_to;
    loop
      select least(v_lo, min(a.from_date)),
             greatest(v_hi, max(coalesce(a.ended_on, a.to_date)))
        into v_lo2, v_hi2
        from public.authorised_absences a
       where a.resident_id = p_resident_id
         and a.reason = 'holiday'
         and daterange(a.from_date, coalesce(a.ended_on, a.to_date), '[]')
             && daterange(v_lo - 1, v_hi + 1, '[]');
      v_lo2 := coalesce(v_lo2, v_lo);
      v_hi2 := coalesce(v_hi2, v_hi);
      exit when v_lo2 = v_lo and v_hi2 = v_hi;
      v_lo := v_lo2;
      v_hi := v_hi2;
    end loop;
    if v_hi - v_lo + 1 > v_holiday then
      raise exception 'A holiday covers at most % consecutive days (Settings); this would make % in a row', v_holiday, v_hi - v_lo + 1 using errcode = '22023';
    end if;
  end if;
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


-- ---------------------------------------------------------------------------
-- 4. The recipient list decides where residents' names, rooms, child markers
--    and absence history are emailed every Sunday. It had `length <= 400` and
--    nothing else, while home_countries -- added three migrations earlier --
--    gets a real regex. routes/settings.js validates well, but Tao 5 says the
--    database is the thing deciding, and jobs.js splits this column on commas
--    with no re-validation, so any other writer reaches a `to:` header.
--    Empty is allowed: it is how the feature is switched off.
-- ---------------------------------------------------------------------------
alter table public.app_settings
  drop constraint if exists weekly_report_recipients_shape;
alter table public.app_settings
  add constraint weekly_report_recipients_shape
  check (
    coalesce(weekly_report_recipients, '') = ''
    or weekly_report_recipients ~ '^[^[:space:],@]+@[^[:space:],@]+\.[^[:space:],@]+(,[^[:space:],@]+@[^[:space:],@]+\.[^[:space:],@]+)*$'
  );


-- ---------------------------------------------------------------------------
-- 5. erase_resident() counted two tables and reported the total as the proof
--    of what an erasure removed. Five more have cascaded off a resident since.
--    Text is 012's, with only the count changed.
-- ---------------------------------------------------------------------------
create or replace function public.erase_resident(p_resident_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions   -- digest() comes from pgcrypto
as $$
declare
  v_events   integer;
  v_register integer;
  v_audit    integer;
  v_digest   text;
begin
  if not public.is_admin() then
    raise exception 'Only an admin may erase a resident' using errcode = '42501';
  end if;

  if not exists (select 1 from public.residents where id = p_resident_id) then
    raise exception 'Resident not found' using errcode = 'P0002';
  end if;

  -- Migration 038: count everything the cascades take, not two tables. Five
  -- child tables have been added since this was written (023 resident_views,
  -- 027 overnight_absences, 028 authorised_absences and room_assignments,
  -- 029 breach_reports), all `on delete cascade`, so `events_removed` -- the
  -- number docs/GDPR.md calls the proof of what an erasure removed -- has been
  -- undercounting. resident_views is deliberately excluded from the total and
  -- named separately below: it is a record of who LOOKED at the person, not
  -- something they did.
  select (select count(*) from public.gate_events         where resident_id = p_resident_id)
       + (select count(*) from public.checkin_events      where resident_id = p_resident_id)
       + (select count(*) from public.overnight_absences  where resident_id = p_resident_id)
       + (select count(*) from public.authorised_absences where resident_id = p_resident_id)
       + (select count(*) from public.room_assignments    where resident_id = p_resident_id)
       + (select count(*) from public.breach_reports      where resident_id = p_resident_id)
    into v_events;

  select count(*)::integer into v_register
  from public.daily_compliance where resident_id = p_resident_id;

  v_digest := encode(digest(p_resident_id::text, 'sha256'), 'hex');

  -- The audit rows carry the name and date of birth the erasure is removing.
  -- They go first, as the owner (this function is invoker-rights, so an
  -- admin's own DELETE would be refused by RLS): a definer helper does it.
  v_audit := public.erase_audit_rows(p_resident_id);

  -- Cascades to gate_events, checkin_events, daily_compliance.
  delete from public.residents where id = p_resident_id;

  insert into public.erasure_log (resident_digest, events_removed, reason, performed_by)
  values (v_digest, v_events, nullif(btrim(p_reason), ''), auth.uid());

  return jsonb_build_object(
    'erased', true,
    'events_removed', v_events,
    'register_rows_removed', v_register,
    'audit_rows_removed', v_audit,
    'digest', v_digest
  );
end;
$$;
