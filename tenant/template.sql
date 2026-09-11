-- ---------------------------------------------------------------------------
-- tenant/template.sql — GENERATED. Do not edit by hand.
-- ---------------------------------------------------------------------------
--
-- One copy of this is applied into every tenant's schema at provisioning.
-- It deliberately does NOT live in migrations/: the migration runner applies
-- every .sql file it finds there, and this one is a template full of
-- __TENANT__ placeholders that is meaningless until substituted.
-- Regenerate with ./tools/gen-tenant-template.sh after changing any migration
-- that touches a per-tenant object; test/api.test.js fails if a provisioned
-- schema drifts from the reference schema in public.
--
-- __TENANT__ is replaced with the tenant's schema name, quoted, by
-- lib/tenancy.js. Nothing else in this file is substituted.
--
-- Objects deliberately absent because they are shared across tenants:
--   tenants
--   schema_migrations
--   immutable_unaccent
--   touch_updated_at
--   tenant_may_write
--   expire_lapsed_trials
--   handle_new_user
--   signup_requests
--   tenant_demo_rows
--   sweep_signup_requests

-- pg_dump sets this in its own preamble and it is not optional here either.
-- SQL-language functions are parsed at CREATE time, and pg_dump orders
-- functions alphabetically: is_staff() is created before my_role(), which it
-- calls. Without this, provisioning fails on the second function every time.
-- SET LOCAL, not SET: this runs on a pooled connection and must not outlive
-- the transaction that provisions the schema.
set local check_function_bodies = false;

-- Name: absence_authorised(uuid, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.absence_authorised(p_resident_id uuid, p_day date) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
  select exists (
    select 1 from __TENANT__.authorised_absences a
     where a.resident_id = p_resident_id
       and p_day between a.from_date and coalesce(a.ended_on, a.to_date)
  );
$$;


--

-- Name: admin_create_staff(text, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.admin_create_staff(p_email text, p_password text, p_full_name text, p_role text DEFAULT 'guard'::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
begin
  if not __TENANT__.is_admin() then
    raise exception 'Only an administrator can create staff accounts'
      using errcode = '42501';
  end if;
  if position('@' in coalesce(btrim(p_email), '')) < 2 then
    raise exception 'A valid email address is required' using errcode = '22023';
  end if;
  if length(coalesce(btrim(p_full_name), '')) = 0 then
    raise exception 'A name is required' using errcode = '22023';
  end if;

  return auth.create_user(p_email, p_password, btrim(p_full_name), p_role);
exception when unique_violation then
  raise exception 'An account with that email already exists'
    using errcode = '22023';
end;
$$;


--

-- Name: admin_invite_staff(text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.admin_invite_staff(p_email text, p_full_name text, p_role text DEFAULT 'guard'::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
begin
  if not __TENANT__.is_admin() then
    raise exception 'Only an administrator can create staff accounts' using errcode = '42501';
  end if;
  return auth.create_user_invited(p_email, p_full_name, p_role);
end;
$$;


--

-- Name: admin_set_staff_password(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.admin_set_staff_password(p_user_id uuid, p_password text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
begin
  if not __TENANT__.is_admin() then
    raise exception 'Only an administrator can reset passwords'
      using errcode = '42501';
  end if;
  if length(coalesce(p_password, '')) < 12 then
    raise exception 'password must be at least 12 characters'
      using errcode = '22023';
  end if;

  update auth.users
     set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf', 12))
   where id = p_user_id;
  if not found then
    return false;
  end if;

  delete from auth.sessions where user_id = p_user_id;
  return true;
end;
$$;


--

-- Name: assert_late_entry_window(timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.assert_late_entry_window(p_occurred_at timestamp with time zone) RETURNS void
    LANGUAGE plpgsql STABLE
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
declare v_hours integer;
begin
  if p_occurred_at is null then
    raise exception 'occurred_at is required' using errcode = '22023';
  end if;
  if p_occurred_at > now() + interval '5 minutes' then
    raise exception 'occurred_at is in the future — check the terminal clock'
      using errcode = '22023';
  end if;
  select late_entry_window_hours into v_hours from __TENANT__.app_settings where id;
  if p_occurred_at < now() - make_interval(hours => v_hours) then
    raise exception 'occurred_at is older than the %-hour late-entry window', v_hours
      using errcode = '22023';
  end if;
end;
$$;


--

-- Name: compliance_required(date, date, date, date, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.compliance_required(p_dob date, p_registered_on date, p_departed_on date, p_day date, p_adult_age integer) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
  select p_day >= p_registered_on
     and (p_departed_on is null or p_day <= p_departed_on)
     and p_dob <= (p_day - make_interval(years => p_adult_age))::date;
$$;


--

-- Name: is_staff(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.is_staff() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
  select __TENANT__.my_role() in ('guard', 'supervisor', 'admin');
$$;


--

-- Name: site_today(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.site_today() RETURNS date
    LANGUAGE sql STABLE
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
  select (now() at time zone (select local_timezone from __TENANT__.app_settings where id))::date;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--

-- Name: app_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE __TENANT__.app_settings (
    id boolean DEFAULT true NOT NULL,
    site_name text DEFAULT 'Security Hut'::text NOT NULL,
    local_timezone text DEFAULT 'Europe/Dublin'::text NOT NULL,
    due_soon_after_hour integer DEFAULT 18 NOT NULL,
    compliance_retention_days integer DEFAULT 180 NOT NULL,
    adult_age_years integer DEFAULT 18 NOT NULL,
    event_retention_days integer DEFAULT 90 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    absence_window_days integer DEFAULT 28 NOT NULL,
    absence_window_limit integer DEFAULT 10 NOT NULL,
    warn_after_consecutive_nights integer DEFAULT 3 NOT NULL,
    late_entry_window_hours integer DEFAULT 48 NOT NULL,
    idle_lock_minutes integer DEFAULT 20 NOT NULL,
    feature_buildings boolean DEFAULT false NOT NULL,
    feature_evacuation boolean DEFAULT false NOT NULL,
    feature_households boolean DEFAULT false NOT NULL,
    mfa_email boolean DEFAULT false NOT NULL,
    home_countries text DEFAULT 'IE'::text NOT NULL,
    feature_visitors boolean DEFAULT false NOT NULL,
    feature_door_checkin boolean DEFAULT false NOT NULL,
    holiday_max_days integer DEFAULT 14 NOT NULL,
    notify_thresholds_email boolean DEFAULT false NOT NULL,
    weekly_report_email boolean DEFAULT false NOT NULL,
    CONSTRAINT app_settings_absence_window_days_check CHECK (((absence_window_days >= 7) AND (absence_window_days <= 365))),
    CONSTRAINT app_settings_absence_window_limit_check CHECK (((absence_window_limit >= 1) AND (absence_window_limit <= 365))),
    CONSTRAINT app_settings_adult_age_years_check CHECK (((adult_age_years >= 1) AND (adult_age_years <= 30))),
    CONSTRAINT app_settings_compliance_retention_days_check CHECK (((compliance_retention_days >= 1) AND (compliance_retention_days <= 36500))),
    CONSTRAINT app_settings_due_soon_after_hour_check CHECK (((due_soon_after_hour >= 0) AND (due_soon_after_hour <= 23))),
    CONSTRAINT app_settings_event_retention_days_check CHECK (((event_retention_days >= 1) AND (event_retention_days <= 3650))),
    CONSTRAINT app_settings_holiday_max_days_check CHECK (((holiday_max_days >= 1) AND (holiday_max_days <= 90))),
    CONSTRAINT app_settings_home_countries_check CHECK ((home_countries ~ '^[A-Z]{2}(,[A-Z]{2})*$'::text)),
    CONSTRAINT app_settings_id_check CHECK (id),
    CONSTRAINT app_settings_idle_lock_minutes_check CHECK (((idle_lock_minutes >= 1) AND (idle_lock_minutes <= 720))),
    CONSTRAINT app_settings_late_entry_window_hours_check CHECK (((late_entry_window_hours >= 1) AND (late_entry_window_hours <= 168))),
    CONSTRAINT app_settings_warn_after_consecutive_nights_check CHECK (((warn_after_consecutive_nights >= 1) AND (warn_after_consecutive_nights <= 90)))
);


--

-- Name: daily_compliance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE __TENANT__.daily_compliance (
    resident_id uuid NOT NULL,
    compliance_date date NOT NULL,
    required boolean NOT NULL,
    presented boolean NOT NULL,
    first_seen_at timestamp with time zone,
    checkin_count integer DEFAULT 0 NOT NULL,
    closed_at timestamp with time zone,
    CONSTRAINT presented_implies_seen CHECK ((presented = (first_seen_at IS NOT NULL)))
);


--

-- Name: resident_ref_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE __TENANT__.resident_ref_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--

-- Name: residents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE __TENANT__.residents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    first_name text NOT NULL,
    last_name text NOT NULL,
    date_of_birth date NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    departed_on date,
    registered_at timestamp with time zone DEFAULT now() NOT NULL,
    registered_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    id_type text,
    id_number text,
    search_key text GENERATED ALWAYS AS (lower(public.immutable_unaccent(((((((((btrim(first_name) || ' '::text) || btrim(last_name)) || ' '::text) || btrim(last_name)) || ' '::text) || btrim(first_name)) || ' '::text) || COALESCE(id_number, ''::text))))) STORED,
    room_id uuid,
    evac_need text DEFAULT 'none'::text NOT NULL,
    household_id uuid,
    ref integer DEFAULT nextval('__TENANT__.resident_ref_seq'::regclass) NOT NULL,
    CONSTRAINT departed_on_matches_status CHECK (((status = 'departed'::text) = (departed_on IS NOT NULL))),
    CONSTRAINT residents_date_of_birth_check CHECK (((date_of_birth > '1900-01-01'::date) AND (date_of_birth <= CURRENT_DATE))),
    CONSTRAINT residents_evac_need_check CHECK ((evac_need = ANY (ARRAY['none'::text, 'mobility'::text, 'hearing'::text, 'sight'::text, 'carer'::text, 'other'::text]))),
    CONSTRAINT residents_first_name_check CHECK ((length(btrim(first_name)) > 0)),
    CONSTRAINT residents_id_pair CHECK (((id_type IS NULL) = (id_number IS NULL))),
    CONSTRAINT residents_id_type_known CHECK (((id_type IS NULL) OR (id_type = ANY (ARRAY['TRC'::text, 'IRP'::text])))),
    CONSTRAINT residents_last_name_check CHECK ((length(btrim(last_name)) > 0)),
    CONSTRAINT residents_status_check CHECK ((status = ANY (ARRAY['active'::text, 'departed'::text])))
);


--

-- Name: v_resident_compliance; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW __TENANT__.v_resident_compliance AS
 WITH s AS (
         SELECT app_settings.id,
            app_settings.site_name,
            app_settings.local_timezone,
            app_settings.due_soon_after_hour,
            app_settings.compliance_retention_days,
            app_settings.adult_age_years,
            app_settings.event_retention_days,
            app_settings.updated_at,
            app_settings.absence_window_days,
            app_settings.absence_window_limit,
            app_settings.warn_after_consecutive_nights,
            app_settings.late_entry_window_hours,
            app_settings.idle_lock_minutes
           FROM __TENANT__.app_settings
          WHERE app_settings.id
        ), today AS (
         SELECT __TENANT__.site_today() AS d
        )
 SELECT r.id,
    ((btrim(r.first_name) || ' '::text) || btrim(r.last_name)) AS full_name,
    r.id_type,
    r.id_number,
    r.status,
    (date_part('year'::text, age((r.date_of_birth)::timestamp with time zone)))::integer AS age_years,
    req.required_today,
    COALESCE(tr.presented, false) AS seen_today,
    COALESCE(tr.checkin_count, 0) AS checkins_today,
    b.open_breaches,
    st.consecutive_missed,
    wt.absent_in_window,
    s.absence_window_days,
    s.absence_window_limit,
    s.warn_after_consecutive_nights,
    ls.last_seen_on,
        CASE
            WHEN (r.status <> 'active'::text) THEN 'not_required'::text
            WHEN (NOT req.required_today) THEN 'exempt'::text
            WHEN (b.open_breaches > 0) THEN 'breach_open'::text
            WHEN COALESCE(tr.presented, false) THEN 'seen_today'::text
            WHEN ((ls.last_seen_on IS NULL) AND (NOT COALESCE(tr.presented, false))) THEN 'never'::text
            WHEN (date_part('hour'::text, (now() AT TIME ZONE s.local_timezone)) >= (s.due_soon_after_hour)::double precision) THEN 'due_today'::text
            ELSE 'expected'::text
        END AS state
   FROM ((((((((__TENANT__.residents r
     CROSS JOIN s)
     CROSS JOIN today)
     CROSS JOIN LATERAL ( SELECT __TENANT__.compliance_required(r.date_of_birth, ((r.registered_at AT TIME ZONE s.local_timezone))::date, r.departed_on, today.d, s.adult_age_years) AS required_today) req)
     LEFT JOIN __TENANT__.daily_compliance tr ON (((tr.resident_id = r.id) AND (tr.compliance_date = today.d))))
     CROSS JOIN LATERAL ( SELECT (count(*))::integer AS open_breaches
           FROM __TENANT__.daily_compliance x
          WHERE ((x.resident_id = r.id) AND x.required AND (NOT x.presented) AND (x.closed_at IS NOT NULL))) b)
     CROSS JOIN LATERAL ( SELECT max(x.compliance_date) AS last_seen_on
           FROM __TENANT__.daily_compliance x
          WHERE ((x.resident_id = r.id) AND x.presented AND (x.closed_at IS NOT NULL))) ls)
     CROSS JOIN LATERAL ( SELECT (count(*))::integer AS absent_in_window
           FROM __TENANT__.daily_compliance x
          WHERE ((x.resident_id = r.id) AND x.required AND (NOT x.presented) AND (x.closed_at IS NOT NULL) AND (x.compliance_date >= (today.d - s.absence_window_days)) AND (x.compliance_date < today.d))) wt)
     CROSS JOIN LATERAL ( SELECT (count(*))::integer AS consecutive_missed
           FROM __TENANT__.daily_compliance x
          WHERE ((x.resident_id = r.id) AND x.required AND (NOT x.presented) AND (x.closed_at IS NOT NULL) AND (x.compliance_date > COALESCE(( SELECT max(y.compliance_date) AS max
                   FROM __TENANT__.daily_compliance y
                  WHERE ((y.resident_id = r.id) AND y.required AND y.presented AND (y.closed_at IS NOT NULL))), '1900-01-01'::date)))) st)
  WHERE __TENANT__.is_staff();


--

-- Name: attention_list(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.attention_list(max_results integer DEFAULT 200) RETURNS SETOF __TENANT__.v_resident_compliance
    LANGUAGE sql STABLE
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
  with ranked as (
    select v.*,
           case v.state when 'breach_open' then 0 when 'never' then 1 else 2 end as bucket,
           row_number() over (
             partition by (v.state = 'breach_open')
             order by case v.state when 'breach_open' then 0 when 'never' then 1 else 2 end,
                      v.consecutive_missed desc, v.absent_in_window desc,
                      v.open_breaches desc, v.full_name
           ) as rn
    from __TENANT__.v_resident_compliance v
    where __TENANT__.is_staff()
      and v.status = 'active'
      and v.state in ('breach_open', 'never', 'due_today')
  )
  -- Column order must match v_resident_compliance's physical SELECT list: a
  -- language-sql function returning setof a view type is matched positionally.
  select id, full_name, id_type, id_number, status, age_years, required_today,
         seen_today, checkins_today, open_breaches, consecutive_missed,
         absent_in_window, absence_window_days, absence_window_limit,
         warn_after_consecutive_nights, last_seen_on, state
  from ranked
  where state = 'breach_open'
     or rn <= greatest(1, least(coalesce(max_results, 200), 500))
  order by bucket, consecutive_missed desc, absent_in_window desc,
           open_breaches desc, full_name;
$$;


--

-- Name: audit_row(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.audit_row() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
declare
  v_old jsonb;
  v_new jsonb;
  v_id  text;
begin
  if tg_op = 'DELETE' then
    v_id := old.id::text;
    -- A residents DELETE is an erasure: keep no copy of what was erased.
    if tg_table_name <> 'residents' then v_old := to_jsonb(old); end if;
  elsif tg_op = 'INSERT' then
    v_id := new.id::text;
    v_new := to_jsonb(new);
  else
    v_id := new.id::text;
    v_old := to_jsonb(old);
    v_new := to_jsonb(new);
  end if;

  -- Derived and noisy columns add nothing to "what changed".
  v_old := v_old - 'search_key' - 'updated_at';
  v_new := v_new - 'search_key' - 'updated_at';
  if tg_op = 'UPDATE' and v_old = v_new then
    return new;
  end if;

  insert into __TENANT__.admin_audit (actor_id, table_name, row_id, action, old_row, new_row)
  values (auth.uid(), tg_table_name, v_id, lower(tg_op), v_old, v_new);

  return coalesce(new, old);
end;
$$;


--

-- Name: authorised_absences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE __TENANT__.authorised_absences (
    id bigint NOT NULL,
    resident_id uuid NOT NULL,
    from_date date NOT NULL,
    to_date date NOT NULL,
    reason text NOT NULL,
    guardian_agreed boolean DEFAULT false NOT NULL,
    approved_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_on date,
    CONSTRAINT authorised_absences_check CHECK ((to_date >= from_date)),
    CONSTRAINT authorised_absences_check1 CHECK (((ended_on IS NULL) OR ((ended_on >= from_date) AND (ended_on <= to_date)))),
    CONSTRAINT authorised_absences_check2 CHECK (((to_date - from_date) <= 366)),
    CONSTRAINT authorised_absences_reason_check CHECK ((reason = ANY (ARRAY['holiday'::text, 'family'::text, 'medical'::text, 'interview'::text, 'education'::text, 'work'::text, 'other'::text])))
);


--

-- Name: authorise_absence(uuid, date, date, text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.authorise_absence(p_resident_id uuid, p_from date, p_to date, p_reason text, p_guardian_agreed boolean DEFAULT false) RETURNS __TENANT__.authorised_absences
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
declare
  v_res   __TENANT__.residents;
  v_adult integer;
  v_holiday integer;
  v_row   __TENANT__.authorised_absences;
  v_lo    date;
  v_hi    date;
  v_lo2   date;
  v_hi2   date;
begin
  if not __TENANT__.is_supervisor() then
    raise exception 'Only a supervisor or admin can authorise an absence' using errcode = '42501';
  end if;
  select * into v_res from __TENANT__.residents where id = p_resident_id;
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
  select adult_age_years, holiday_max_days into v_adult, v_holiday from __TENANT__.app_settings where id;
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
        from __TENANT__.authorised_absences a
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
  if exists (select 1 from __TENANT__.authorised_absences a
              where a.resident_id = p_resident_id
                and daterange(a.from_date, coalesce(a.ended_on, a.to_date), '[]') && daterange(p_from, p_to, '[]')) then
    raise exception 'Overlaps an authorised absence already recorded' using errcode = '23505';
  end if;
  insert into __TENANT__.authorised_absences (resident_id, from_date, to_date, reason, guardian_agreed, approved_by)
  values (p_resident_id, p_from, p_to, p_reason, coalesce(p_guardian_agreed, false), auth.uid())
  returning * into v_row;
  return v_row;
end;
$$;


--

-- Name: close_out_compliance_days(date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.close_out_compliance_days(p_through date DEFAULT NULL::date) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
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
  from __TENANT__.app_settings where id;

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
             (select max(compliance_date) + 1 from __TENANT__.daily_compliance where closed_at is not null),
             (select min((registered_at at time zone v_tz)::date) from __TENANT__.residents)
           ),
           coalesce(
             (select min(compliance_date) from __TENANT__.daily_compliance
               where closed_at is null and compliance_date <= v_through),
             'infinity'
           )
         )
    into v_from;

  if v_from is null or v_from > v_through then
    return 0;
  end if;

  for v_day in select d::date from generate_series(v_from, v_through, interval '1 day') d loop
    insert into __TENANT__.daily_compliance
      (resident_id, compliance_date, required, presented, first_seen_at, checkin_count, closed_at)
    select
      r.id, v_day,
      __TENANT__.compliance_required(
        r.date_of_birth, (r.registered_at at time zone v_tz)::date,
        r.departed_on, v_day, v_adult)
        -- Migration 028: a day inside an authorised absence is a day the
        -- rule did not apply. The row is still written, so the register
        -- shows the day as not required rather than missing.
        and not __TENANT__.absence_authorised(r.id, v_day),
      false, null, 0, now()
    from __TENANT__.residents r
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
    update __TENANT__.daily_compliance dc
       set closed_at = now(),
           required  = __TENANT__.compliance_required(
                         r.date_of_birth,
                         (r.registered_at at time zone v_tz)::date,
                         r.departed_on, v_day, v_adult)
                       and not __TENANT__.absence_authorised(r.id, v_day)
      from __TENANT__.residents r
     where r.id = dc.resident_id
       and dc.compliance_date = v_day and dc.closed_at is null;
  end loop;

  return v_written;
end;
$$;


--

-- Name: close_out_due_through(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.close_out_due_through() RETURNS date
    LANGUAGE sql STABLE
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
  select case
    when date_part('hour', now() at time zone (select local_timezone from __TENANT__.app_settings where id)) < 2
      then __TENANT__.site_today() - 2
    else __TENANT__.site_today() - 1
  end;
$$;


--

-- Name: end_absence(bigint, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.end_absence(p_id bigint, p_last_day date DEFAULT NULL::date) RETURNS __TENANT__.authorised_absences
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
declare
  v_row  __TENANT__.authorised_absences;
  v_last date := coalesce(p_last_day, __TENANT__.site_today() - 1);
begin
  if not __TENANT__.is_supervisor() then
    raise exception 'Only a supervisor or admin can change an authorised absence' using errcode = '42501';
  end if;
  select * into v_row from __TENANT__.authorised_absences where id = p_id;
  if not found then
    raise exception 'Absence not found' using errcode = 'P0002';
  end if;
  if v_last < v_row.from_date then
    delete from __TENANT__.authorised_absences where id = p_id;
    v_row.ended_on := v_row.from_date - 1;   -- signals "cancelled" to the caller
    return v_row;
  end if;
  update __TENANT__.authorised_absences
     set ended_on = least(v_last, to_date)
   where id = p_id
   returning * into v_row;
  return v_row;
end;
$$;


--

-- Name: roll_calls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE __TENANT__.roll_calls (
    id uuid NOT NULL,
    kind text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    started_by uuid,
    ended_at timestamp with time zone,
    ended_by uuid,
    note text,
    CONSTRAINT roll_calls_kind_check CHECK ((kind = ANY (ARRAY['drill'::text, 'incident'::text]))),
    CONSTRAINT roll_calls_note_check CHECK (((note IS NULL) OR (length(note) <= 200)))
);


--

-- Name: end_roll_call(uuid, timestamp with time zone, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.end_roll_call(p_id uuid, p_at timestamp with time zone DEFAULT now(), p_note text DEFAULT NULL::text) RETURNS __TENANT__.roll_calls
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
declare v __TENANT__.roll_calls;
begin
  if not __TENANT__.is_staff() then raise exception 'Not authorised to end a roll call' using errcode = '42501'; end if;
  update __TENANT__.roll_calls
     set ended_at = least(coalesce(p_at, now()), now()), ended_by = auth.uid(),
         note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), note)
   where id = p_id and ended_at is null;
  select * into v from __TENANT__.roll_calls where id = p_id;
  if v.id is null then raise exception 'No such roll call' using errcode = 'P0002'; end if;
  return v;
end;
$$;


--

-- Name: end_sessions_on_deactivate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.end_sessions_on_deactivate() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
begin
  if old.active and not new.active then
    delete from auth.sessions where user_id = new.id;
  end if;
  return new;
end;
$$;


--

-- Name: erase_audit_rows(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.erase_audit_rows(p_resident_id uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
declare v_n integer;
begin
  if not __TENANT__.is_admin() then
    raise exception 'Only an admin may erase a resident' using errcode = '42501';
  end if;
  delete from __TENANT__.admin_audit
   where table_name = 'residents' and row_id = p_resident_id::text;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;


--

-- Name: erase_resident(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.erase_resident(p_resident_id uuid, p_reason text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
declare
  v_events   integer;
  v_register integer;
  v_audit    integer;
  v_digest   text;
begin
  if not __TENANT__.is_admin() then
    raise exception 'Only an admin may erase a resident' using errcode = '42501';
  end if;

  if not exists (select 1 from __TENANT__.residents where id = p_resident_id) then
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
  select (select count(*) from __TENANT__.gate_events         where resident_id = p_resident_id)
       + (select count(*) from __TENANT__.checkin_events      where resident_id = p_resident_id)
       + (select count(*) from __TENANT__.overnight_absences  where resident_id = p_resident_id)
       + (select count(*) from __TENANT__.authorised_absences where resident_id = p_resident_id)
       + (select count(*) from __TENANT__.room_assignments    where resident_id = p_resident_id)
       + (select count(*) from __TENANT__.breach_reports      where resident_id = p_resident_id)
    into v_events;

  select count(*)::integer into v_register
  from __TENANT__.daily_compliance where resident_id = p_resident_id;

  v_digest := encode(digest(p_resident_id::text, 'sha256'), 'hex');

  -- The audit rows carry the name and date of birth the erasure is removing.
  -- They go first, as the owner (this function is invoker-rights, so an
  -- admin's own DELETE would be refused by RLS): a definer helper does it.
  v_audit := __TENANT__.erase_audit_rows(p_resident_id);

  -- Cascades to gate_events, checkin_events, daily_compliance.
  delete from __TENANT__.residents where id = p_resident_id;

  insert into __TENANT__.erasure_log (resident_digest, events_removed, reason, performed_by)
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


--

-- Name: export_resident_record(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.export_resident_record(p_resident_id uuid) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
declare
  v_out jsonb;
begin
  if not __TENANT__.is_admin() then
    raise exception 'Only an admin may export a resident record' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'exported_at', now(),
    'exported_by', (select full_name from __TENANT__.profiles where id = auth.uid()),
    'resident', to_jsonb(r) - 'search_key',
    'gate_events', coalesce((
      select jsonb_agg(jsonb_build_object(
               'kind', e.kind,
               'occurred_at', e.occurred_at,
               'recorded_at', e.recorded_at,
               'late_entry', e.late_entry,
               'recorded_by', g.full_name
             ) order by e.occurred_at)
      from __TENANT__.gate_events e
      join __TENANT__.profiles g on g.id = e.guard_id
      where e.resident_id = r.id
    ), '[]'::jsonb),
    'checkin_events', coalesce((
      select jsonb_agg(jsonb_build_object(
               'occurred_at', c.occurred_at,
               'recorded_at', c.recorded_at,
               'late_entry', c.late_entry,
               'recorded_by', g.full_name
             ) order by c.occurred_at)
      from __TENANT__.checkin_events c
      join __TENANT__.profiles g on g.id = c.guard_id
      where c.resident_id = r.id
    ), '[]'::jsonb),
    'daily_compliance', coalesce((
      select jsonb_agg(jsonb_build_object(
               'date', dc.compliance_date,
               'required', dc.required,
               'presented', dc.presented,
               'checkins', dc.checkin_count
             ) order by dc.compliance_date)
      from __TENANT__.daily_compliance dc where dc.resident_id = r.id
    ), '[]'::jsonb),
    -- Who opened this record and when (migration 023). Part of "everything
    -- held about me", and the reason the access log exists.
    'views', coalesce((
      select jsonb_agg(jsonb_build_object(
               'at', v.viewed_at,
               'by', p.full_name,
               'where', v.surface
             ) order by v.viewed_at)
      from __TENANT__.resident_views v
      left join __TENANT__.profiles p on p.id = v.actor_id
      where v.resident_id = r.id
    ), '[]'::jsonb),
    -- Authorised absences and the rooms they have had (migration 028).
    'authorised_absences', coalesce((
      select jsonb_agg(jsonb_build_object(
               'from', a.from_date, 'to', a.to_date, 'reason', a.reason,
               'guardian_agreed', a.guardian_agreed, 'ended_on', a.ended_on,
               'approved_by', p.full_name, 'recorded_at', a.created_at
             ) order by a.from_date)
      from __TENANT__.authorised_absences a
      left join __TENANT__.profiles p on p.id = a.approved_by
      where a.resident_id = r.id
    ), '[]'::jsonb),
    'rooms', coalesce((
      select jsonb_agg(jsonb_build_object(
               'room', ra.room_label, 'from', ra.from_at, 'to', ra.to_at,
               'changed_by', p.full_name
             ) order by ra.from_at)
      from __TENANT__.room_assignments ra
      left join __TENANT__.profiles p on p.id = ra.changed_by
      where ra.resident_id = r.id
    ), '[]'::jsonb),
    'breach_reports', coalesce((
      select jsonb_agg(jsonb_build_object(
               'kind', b.kind, 'issued_on', b.issued_on, 'reference', b.reference,
               'issued_by', p.full_name, 'recorded_at', b.created_at
             ) order by b.issued_on)
      from __TENANT__.breach_reports b
      left join __TENANT__.profiles p on p.id = b.issued_by
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
      from __TENANT__.admin_audit a
      left join __TENANT__.profiles p on p.id = a.actor_id
      where a.table_name = 'residents' and a.row_id = r.id::text
    ), '[]'::jsonb)
  )
  into v_out
  from __TENANT__.residents r
  where r.id = p_resident_id;

  if v_out is null then
    raise exception 'Resident not found' using errcode = 'P0002';
  end if;

  return v_out;
end;
$$;


--

-- Name: hut_summary(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.hut_summary() RETURNS TABLE(on_site integer, events_today integer)
    LANGUAGE sql STABLE
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
  select
    count(*) filter (where presence = 'in' and status = 'active')::integer,
    (select count(*)::integer from __TENANT__.gate_events e
      where e.occurred_at >= date_trunc('day',
              now() at time zone (select local_timezone from __TENANT__.app_settings where id)
            ) at time zone (select local_timezone from __TENANT__.app_settings where id))
  from __TENANT__.v_resident_status
  where __TENANT__.is_staff();
$$;


--

-- Name: inside_absence_window(date, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.inside_absence_window(p_from date, p_to date) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
  select exists (select 1 from __TENANT__.absence_windows w
                  where daterange(w.from_date, w.to_date, '[]') @> daterange(p_from, p_to, '[]'));
$$;


--

-- Name: is_admin(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.is_admin() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
  select __TENANT__.my_role() = 'admin';
$$;


--

-- Name: is_supervisor(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.is_supervisor() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
  select __TENANT__.my_role() in ('supervisor', 'admin');
$$;


--

-- Name: breach_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE __TENANT__.breach_reports (
    id bigint NOT NULL,
    resident_id uuid NOT NULL,
    kind text NOT NULL,
    issued_on date NOT NULL,
    issued_by uuid,
    reference text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT breach_reports_kind_check CHECK ((kind = ANY (ARRAY['house_rules'::text, 'misuse'::text]))),
    CONSTRAINT breach_reports_reference_check CHECK (((reference IS NULL) OR (length(reference) <= 60)))
);


--

-- Name: issue_breach(uuid, text, date, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.issue_breach(p_resident_id uuid, p_kind text, p_issued_on date DEFAULT NULL::date, p_reference text DEFAULT NULL::text) RETURNS __TENANT__.breach_reports
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
declare
  v_row __TENANT__.breach_reports;
begin
  if not __TENANT__.is_supervisor() then
    raise exception 'Only a supervisor or admin can record a breach report' using errcode = '42501';
  end if;
  if not exists (select 1 from __TENANT__.residents where id = p_resident_id) then
    raise exception 'Resident not found' using errcode = 'P0002';
  end if;
  insert into __TENANT__.breach_reports (resident_id, kind, issued_on, issued_by, reference)
  values (p_resident_id, p_kind, coalesce(p_issued_on, __TENANT__.site_today()), auth.uid(), nullif(btrim(coalesce(p_reference, '')), ''))
  returning * into v_row;
  return v_row;
end;
$$;


--

-- Name: join_household(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.join_household(p_resident_id uuid, p_with_resident_id uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
declare v_household uuid;
begin
  if not __TENANT__.is_supervisor() then raise exception 'Only a supervisor or admin can change households' using errcode = '42501'; end if;
  if p_resident_id = p_with_resident_id then raise exception 'A resident cannot be their own household' using errcode = '22023'; end if;
  select household_id into v_household from __TENANT__.residents where id = p_with_resident_id;
  if not found then raise exception 'Resident not found' using errcode = 'P0002'; end if;
  if v_household is null then
    insert into __TENANT__.households default values returning id into v_household;
    update __TENANT__.residents set household_id = v_household where id = p_with_resident_id;
  end if;
  update __TENANT__.residents set household_id = v_household where id = p_resident_id;
  if not found then raise exception 'Resident not found' using errcode = 'P0002'; end if;
  return v_household;
end;
$$;


--

-- Name: roll_call_marks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE __TENANT__.roll_call_marks (
    roll_call_id uuid NOT NULL,
    resident_id uuid NOT NULL,
    marked_at timestamp with time zone DEFAULT now() NOT NULL,
    marked_by uuid,
    client_ref uuid
);


--

-- Name: mark_roll_call(uuid, uuid, uuid, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.mark_roll_call(p_roll_call_id uuid, p_resident_id uuid, p_client_ref uuid DEFAULT NULL::uuid, p_at timestamp with time zone DEFAULT now()) RETURNS __TENANT__.roll_call_marks
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
declare v __TENANT__.roll_call_marks;
begin
  if not __TENANT__.is_staff() then raise exception 'Not authorised to mark a roll call' using errcode = '42501'; end if;
  if not exists (select 1 from __TENANT__.roll_calls where id = p_roll_call_id) then
    raise exception 'No such roll call' using errcode = 'P0002';
  end if;
  if not exists (select 1 from __TENANT__.residents where id = p_resident_id) then
    raise exception 'Resident not found' using errcode = 'P0002';
  end if;
  insert into __TENANT__.roll_call_marks (roll_call_id, resident_id, marked_at, marked_by, client_ref)
  values (p_roll_call_id, p_resident_id, least(coalesce(p_at, now()), now()), auth.uid(), p_client_ref)
  on conflict do nothing;
  select * into v from __TENANT__.roll_call_marks where roll_call_id = p_roll_call_id and resident_id = p_resident_id;
  return v;
end;
$$;


--

-- Name: roll_call_visit_marks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE __TENANT__.roll_call_visit_marks (
    roll_call_id uuid NOT NULL,
    visit_id uuid NOT NULL,
    marked_at timestamp with time zone DEFAULT now() NOT NULL,
    marked_by uuid,
    client_ref uuid
);


--

-- Name: mark_roll_call_visit(uuid, uuid, uuid, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.mark_roll_call_visit(p_roll_call_id uuid, p_visit_id uuid, p_client_ref uuid DEFAULT NULL::uuid, p_at timestamp with time zone DEFAULT now()) RETURNS __TENANT__.roll_call_visit_marks
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
declare v __TENANT__.roll_call_visit_marks;
begin
  if not __TENANT__.is_staff() then raise exception 'Not authorised to mark a roll call' using errcode = '42501'; end if;
  if not exists (select 1 from __TENANT__.roll_calls where id = p_roll_call_id) then
    raise exception 'No such roll call' using errcode = 'P0002';
  end if;
  if not exists (select 1 from __TENANT__.visits where id = p_visit_id) then
    raise exception 'No such visit' using errcode = 'P0002';
  end if;
  insert into __TENANT__.roll_call_visit_marks (roll_call_id, visit_id, marked_at, marked_by, client_ref)
  values (p_roll_call_id, p_visit_id, least(coalesce(p_at, now()), now()), auth.uid(), p_client_ref)
  on conflict do nothing;
  select * into v from __TENANT__.roll_call_visit_marks where roll_call_id = p_roll_call_id and visit_id = p_visit_id;
  return v;
end;
$$;


--

-- Name: my_role(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.my_role() RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
  select coalesce((select p.role from __TENANT__.profiles p where p.id = auth.uid() and p.active), 'none');
$$;


--

-- Name: note_disclosure(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.note_disclosure(p_resident_id uuid, p_reason text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
begin
  if not __TENANT__.is_admin() then
    raise exception 'Only an admin may export a resident record' using errcode = '42501';
  end if;
  if length(coalesce(btrim(p_reason), '')) = 0 then
    raise exception 'A reason for the export is required' using errcode = '22023';
  end if;
  insert into __TENANT__.admin_audit (actor_id, table_name, row_id, action, note)
  values (auth.uid(), 'residents', p_resident_id::text, 'export', btrim(p_reason));
end;
$$;


--

-- Name: note_report(text, text, date, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.note_report(p_report text, p_reason text, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
begin
  if not __TENANT__.is_supervisor() then
    raise exception 'Only a supervisor or admin may export a report' using errcode = '42501';
  end if;
  if length(coalesce(btrim(p_reason), '')) = 0 then
    raise exception 'A reason for the export is required' using errcode = '22023';
  end if;
  insert into __TENANT__.admin_audit (actor_id, table_name, row_id, action, note)
  values (auth.uid(), 'reports', p_report,
          'export',
          btrim(p_reason) || case when p_from is not null then ' [' || p_from::text || ' to ' || coalesce(p_to, p_from)::text || ']' else '' end);
end;
$$;


--

-- Name: note_view(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.note_view(p_resident_id uuid, p_surface text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
begin
  if not __TENANT__.is_staff() then
    raise exception 'Not a staff member' using errcode = '42501';
  end if;
  -- A lookup of an id that is not on the register is not a view of anyone;
  -- the route answers 404 and there is nothing to log.
  insert into __TENANT__.resident_views (actor_id, resident_id, surface)
  select auth.uid(), p_resident_id, p_surface
   where exists (select 1 from __TENANT__.residents where id = p_resident_id);
end;
$$;


--

-- Name: overnight_safeguarding_count(date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.overnight_safeguarding_count(p_night date) RETURNS integer
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
  select count(*)::integer
    from __TENANT__.overnight_absences o
    join __TENANT__.residents r on r.id = o.resident_id
   where o.night = p_night
     and r.date_of_birth > (o.night - make_interval(years => (select adult_age_years from __TENANT__.app_settings where id)))::date
     and not __TENANT__.absence_authorised(o.resident_id, o.night);
$$;


--

-- Name: profiles_clear_safeguarding_alert_for_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.profiles_clear_safeguarding_alert_for_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
begin
  if new.role = 'guard' and (tg_op = 'INSERT' or old.role is distinct from new.role) then
    new.safeguarding_alert := false;
  end if;
  return new;
end;
$$;


--

-- Name: profiles_clear_weekly_report_for_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.profiles_clear_weekly_report_for_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
begin
  if new.role = 'guard' and (tg_op = 'INSERT' or old.role is distinct from new.role) then
    new.weekly_report := false;
  end if;
  return new;
end;
$$;


--

-- Name: prune_empty_households(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.prune_empty_households() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
begin
  if tg_op in ('UPDATE', 'DELETE') and old.household_id is not null
     and (tg_op = 'DELETE' or new.household_id is distinct from old.household_id) then
    delete from __TENANT__.households h
     where h.id = old.household_id
       and not exists (select 1 from __TENANT__.residents r where r.household_id = h.id);
  end if;
  return null;
end;
$$;


--

-- Name: purge_expired_audit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.purge_expired_audit() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
declare v_days integer; v_n integer;
begin
  select compliance_retention_days into v_days from __TENANT__.app_settings where id;
  delete from __TENANT__.admin_audit where at < now() - make_interval(days => v_days);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;


--

-- Name: purge_expired_authorised_absences(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.purge_expired_authorised_absences() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
declare v_days integer; v_n integer;
begin
  select compliance_retention_days into v_days from __TENANT__.app_settings where id;
  delete from __TENANT__.authorised_absences where to_date < __TENANT__.site_today() - v_days;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;


--

-- Name: purge_expired_breach_reports(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.purge_expired_breach_reports() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
declare v_days integer; v_n integer;
begin
  select compliance_retention_days into v_days from __TENANT__.app_settings where id;
  delete from __TENANT__.breach_reports where issued_on < __TENANT__.site_today() - v_days;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;


--

-- Name: purge_expired_checkin_events(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.purge_expired_checkin_events() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
declare v_days integer; v_deleted integer;
begin
  select event_retention_days into v_days from __TENANT__.app_settings where id;
  delete from __TENANT__.checkin_events where occurred_at < now() - make_interval(days => v_days);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;


--

-- Name: purge_expired_compliance(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.purge_expired_compliance() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
declare v_days integer; v_deleted integer;
begin
  select compliance_retention_days into v_days from __TENANT__.app_settings where id;
  delete from __TENANT__.daily_compliance
   where compliance_date < (__TENANT__.site_today() - v_days);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;


--

-- Name: purge_expired_gate_events(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.purge_expired_gate_events() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
declare
  v_days    integer;
  v_deleted integer;
begin
  select event_retention_days into v_days from __TENANT__.app_settings where id;
  delete from __TENANT__.gate_events where occurred_at < now() - make_interval(days => v_days);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;


--

-- Name: purge_expired_job_runs(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.purge_expired_job_runs() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
declare v_n integer;
begin
  delete from __TENANT__.job_runs where ran_at < now() - interval '90 days';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;


--

-- Name: purge_expired_overnight_absences(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.purge_expired_overnight_absences() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
declare v_days integer; v_n integer;
begin
  select compliance_retention_days into v_days from __TENANT__.app_settings where id;
  delete from __TENANT__.overnight_absences where night < __TENANT__.site_today() - v_days;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;


--

-- Name: purge_expired_roll_calls(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.purge_expired_roll_calls() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
declare v_days integer; v_n integer;
begin
  select compliance_retention_days into v_days from __TENANT__.app_settings where id;
  delete from __TENANT__.roll_calls where started_at < now() - make_interval(days => v_days);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;


--

-- Name: purge_expired_visits(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.purge_expired_visits() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
declare v_days integer; v_n integer;
begin
  select event_retention_days into v_days from __TENANT__.app_settings where id;
  delete from __TENANT__.visits where arrived_at < now() - make_interval(days => v_days) and left_at is not null;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;


--

-- Name: purge_resident_views(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.purge_resident_views() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
declare v_days integer; v_n integer;
begin
  select compliance_retention_days into v_days from __TENANT__.app_settings where id;
  delete from __TENANT__.resident_views where viewed_at < now() - make_interval(days => v_days);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;


--

-- Name: gate_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE __TENANT__.gate_events (
    id bigint NOT NULL,
    resident_id uuid NOT NULL,
    guard_id uuid NOT NULL,
    kind text NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    late_entry boolean DEFAULT false NOT NULL,
    client_ref uuid,
    CONSTRAINT gate_events_kind_check CHECK ((kind = ANY (ARRAY['in'::text, 'out'::text])))
);


--

-- Name: v_resident_status; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW __TENANT__.v_resident_status AS
 WITH s AS (
         SELECT app_settings.id,
            app_settings.site_name,
            app_settings.local_timezone,
            app_settings.due_soon_after_hour,
            app_settings.compliance_retention_days,
            app_settings.adult_age_years,
            app_settings.event_retention_days,
            app_settings.updated_at,
            app_settings.absence_window_days,
            app_settings.absence_window_limit,
            app_settings.warn_after_consecutive_nights
           FROM __TENANT__.app_settings
          WHERE app_settings.id
        ), last_event AS (
         SELECT DISTINCT ON (gate_events.resident_id) gate_events.resident_id,
            gate_events.kind,
            gate_events.occurred_at,
            gate_events.guard_id
           FROM __TENANT__.gate_events
          ORDER BY gate_events.resident_id, gate_events.occurred_at DESC, gate_events.id DESC
        )
 SELECT r.id,
    r.first_name,
    r.last_name,
    ((btrim(r.first_name) || ' '::text) || btrim(r.last_name)) AS full_name,
    r.id_type,
    r.id_number,
    r.status,
    r.search_key,
    (date_part('year'::text, age((r.date_of_birth)::timestamp with time zone)))::integer AS age_years,
    (r.date_of_birth <= (CURRENT_DATE - make_interval(years => s.adult_age_years))) AS is_adult,
    COALESCE(le.kind, 'out'::text) AS presence,
    le.occurred_at AS last_event_at,
    le.guard_id AS last_event_guard_id
   FROM ((__TENANT__.residents r
     CROSS JOIN s)
     LEFT JOIN last_event le ON ((le.resident_id = r.id)))
  WHERE __TENANT__.is_staff();


--

-- Name: record_check(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.record_check(p_resident_id uuid, p_direction text) RETURNS SETOF __TENANT__.v_resident_status
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
declare
  v_guard  uuid := auth.uid();
  v_status text;
  v_last   __TENANT__.gate_events;
begin
  if not __TENANT__.is_staff() then
    raise exception 'Not authorised to record check events' using errcode = '42501';
  end if;

  if p_direction not in ('in', 'out') then
    raise exception 'direction must be ''in'' or ''out''' using errcode = '22023';
  end if;

  select status into v_status from __TENANT__.residents where id = p_resident_id;
  if v_status is null then
    raise exception 'Resident not found' using errcode = 'P0002';
  end if;
  if v_status <> 'active' then
    raise exception 'Resident is not active and cannot be signed in or out'
      using errcode = '23514';
  end if;

  -- Ignore an identical repeat within 60 seconds (double tap on a touchscreen).
  select * into v_last
  from __TENANT__.gate_events
  where resident_id = p_resident_id
  order by occurred_at desc, id desc
  limit 1;

  if v_last.id is null
     or v_last.kind <> p_direction
     or v_last.occurred_at < now() - interval '60 seconds'
  then
    insert into __TENANT__.gate_events (resident_id, guard_id, kind)
    values (p_resident_id, v_guard, p_direction);

    -- The door as the presentation (feature_door_checkin). Only a sign IN,
    -- only when the event was really recorded, and through the same
    -- function the desk uses, so the 60-second rule and the day's row are
    -- the register's own. The source says it came from the door.
    if p_direction = 'in'
       and (select feature_door_checkin from __TENANT__.app_settings where id) then
      perform __TENANT__.record_checkin_at(p_resident_id, now(), false, null, 'door');
    end if;
  end if;

  return query
    select * from __TENANT__.v_resident_status where id = p_resident_id;
end;
$$;


--

-- Name: record_check_late(uuid, text, timestamp with time zone, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.record_check_late(p_resident_id uuid, p_direction text, p_occurred_at timestamp with time zone, p_client_ref uuid) RETURNS SETOF __TENANT__.v_resident_status
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
declare
  v_status text;
  v_dup    boolean;
begin
  if not __TENANT__.is_staff() then
    raise exception 'Not authorised to record check events' using errcode = '42501';
  end if;
  if p_direction not in ('in', 'out') then
    raise exception 'direction must be ''in'' or ''out''' using errcode = '22023';
  end if;
  if p_client_ref is null then
    raise exception 'client_ref is required for a late entry' using errcode = '22023';
  end if;
  perform __TENANT__.assert_late_entry_window(p_occurred_at);

  -- Already replayed once: answer, record nothing.
  if exists (select 1 from __TENANT__.gate_events where client_ref = p_client_ref) then
    return query select * from __TENANT__.v_resident_status where id = p_resident_id;
    return;
  end if;

  select status into v_status from __TENANT__.residents where id = p_resident_id;
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
    select 1 from __TENANT__.gate_events
    where resident_id = p_resident_id
      and kind = p_direction
      and abs(extract(epoch from (occurred_at - p_occurred_at))) < 60
  ) into v_dup;

  if not v_dup then
    insert into __TENANT__.gate_events (resident_id, guard_id, kind, occurred_at, recorded_at, late_entry, client_ref)
    values (p_resident_id, auth.uid(), p_direction, p_occurred_at, now(), true, p_client_ref);

    -- The offline door as the presentation, same rule as record_check().
    -- The gate event's client_ref is reused so a replay is idempotent on
    -- both tables.
    if p_direction = 'in'
       and (select feature_door_checkin from __TENANT__.app_settings where id) then
      perform __TENANT__.record_checkin_at(p_resident_id, p_occurred_at, true, p_client_ref, 'door');
    end if;
  end if;

  return query select * from __TENANT__.v_resident_status where id = p_resident_id;
end;
$$;


--

-- Name: record_checkin(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.record_checkin(p_resident_id uuid) RETURNS __TENANT__.daily_compliance
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
begin
  return __TENANT__.record_checkin_at(p_resident_id, now(), false, null);
end;
$$;


--

-- Name: record_checkin_at(uuid, timestamp with time zone, boolean, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.record_checkin_at(p_resident_id uuid, p_at timestamp with time zone, p_late boolean, p_client_ref uuid, p_source text DEFAULT 'desk'::text) RETURNS __TENANT__.daily_compliance
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
declare
  v_tz     text;
  v_adult  integer;
  v_day    date;
  v_res    __TENANT__.residents;
  v_dup    boolean;
  v_out    __TENANT__.daily_compliance;
begin
  if not __TENANT__.is_staff() then
    raise exception 'Not authorised to record check-ins' using errcode = '42501';
  end if;

  select local_timezone, adult_age_years into v_tz, v_adult
  from __TENANT__.app_settings where id;

  select * into v_res from __TENANT__.residents where id = p_resident_id;
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
    select 1 from __TENANT__.checkin_events where client_ref = p_client_ref
  ) then
    select dc.* into v_out from __TENANT__.daily_compliance dc
    join __TENANT__.checkin_events e on e.resident_id = dc.resident_id
    where e.client_ref = p_client_ref
      and dc.compliance_date = (e.occurred_at at time zone v_tz)::date;
    return v_out;
  end if;

  -- Touchscreens double-fire. A repeat inside 60 seconds is one presentation.
  -- Scoped to the site-local day: a check-in at 23:59:30 followed by one at
  -- 00:00:10 is 40 seconds apart but a genuine new-day presentation, not a
  -- double tap, and must not be swallowed together with the previous day's row.
  select exists (
    select 1 from __TENANT__.checkin_events
    where resident_id = p_resident_id
      and (occurred_at at time zone v_tz)::date = v_day
      and abs(extract(epoch from (occurred_at - p_at))) < 60
  ) into v_dup;

  if not v_dup then
    insert into __TENANT__.checkin_events (resident_id, guard_id, occurred_at, recorded_at, late_entry, client_ref, source)
    values (p_resident_id, auth.uid(), p_at, now(), p_late, p_client_ref, p_source);

    -- The on-conflict branch is also how a late check-in corrects a day that
    -- close-out already wrote as missed: presented becomes true and
    -- first_seen_at is set (least() ignores the null it had). closed_at is
    -- left alone — the day stays closed, its content is now right.
    insert into __TENANT__.daily_compliance as dc
      (resident_id, compliance_date, required, presented, first_seen_at, checkin_count)
    values (
      p_resident_id, v_day,
      __TENANT__.compliance_required(
        v_res.date_of_birth,
        (v_res.registered_at at time zone v_tz)::date,
        v_res.departed_on, v_day, v_adult)
        -- Migration 038: the same exemption close-out has applied since 028.
        -- Without it this writer and that one disagreed about the same day.
        and not __TENANT__.absence_authorised(p_resident_id, v_day),
      true, p_at, 1)
    on conflict (resident_id, compliance_date) do update
      set presented     = true,
          first_seen_at = least(dc.first_seen_at, excluded.first_seen_at),
          checkin_count = dc.checkin_count + 1;
  end if;

  select * into v_out from __TENANT__.daily_compliance
  where resident_id = p_resident_id and compliance_date = v_day;
  if not found then
    raise exception 'record_checkin_at: no daily_compliance row for resident % on %; this is a bug',
      p_resident_id, v_day using errcode = 'XX000';
  end if;
  return v_out;
end;
$$;


--

-- Name: record_checkin_late(uuid, timestamp with time zone, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.record_checkin_late(p_resident_id uuid, p_occurred_at timestamp with time zone, p_client_ref uuid) RETURNS __TENANT__.daily_compliance
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
begin
  if not __TENANT__.is_staff() then
    raise exception 'Not authorised to record check-ins' using errcode = '42501';
  end if;
  if p_client_ref is null then
    raise exception 'client_ref is required for a late entry' using errcode = '22023';
  end if;
  perform __TENANT__.assert_late_entry_window(p_occurred_at);
  return __TENANT__.record_checkin_at(p_resident_id, p_occurred_at, true, p_client_ref);
end;
$$;


--

-- Name: visits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE __TENANT__.visits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    name text NOT NULL,
    company text,
    arrived_at timestamp with time zone DEFAULT now() NOT NULL,
    arrived_by uuid,
    left_at timestamp with time zone,
    left_by uuid,
    roster_id uuid,
    CONSTRAINT visits_company_check CHECK (((company IS NULL) OR (length(company) <= 80))),
    CONSTRAINT visits_kind_check CHECK ((kind = ANY (ARRAY['staff'::text, 'visitor'::text, 'contractor'::text, 'supplier'::text]))),
    CONSTRAINT visits_left_after_arrival CHECK (((left_at IS NULL) OR (left_at >= arrived_at))),
    CONSTRAINT visits_name_check CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 80)))
);


--

-- Name: record_staff_arrival(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.record_staff_arrival(p_roster_id uuid) RETURNS __TENANT__.visits
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
declare r __TENANT__.staff_roster; v __TENANT__.visits;
begin
  if not __TENANT__.is_staff() then raise exception 'Not authorised to sign a staff member in' using errcode = '42501'; end if;
  select * into r from __TENANT__.staff_roster where id = p_roster_id and active;
  if not found then raise exception 'Not on the staff list' using errcode = 'P0002'; end if;
  if exists (select 1 from __TENANT__.visits where roster_id = p_roster_id and left_at is null) then
    raise exception 'Already signed in' using errcode = '23505';
  end if;
  insert into __TENANT__.visits (kind, name, company, arrived_by, roster_id)
  values ('staff', btrim(r.name), r.role, auth.uid(), r.id)
  returning * into v;
  return v;
end;
$$;


--

-- Name: record_visit_arrival(text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.record_visit_arrival(p_kind text, p_name text, p_company text DEFAULT NULL::text) RETURNS __TENANT__.visits
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
declare v __TENANT__.visits;
begin
  if not __TENANT__.is_staff() then raise exception 'Not authorised to sign a visitor in' using errcode = '42501'; end if;
  if p_kind not in ('staff', 'visitor', 'contractor', 'supplier') then
    raise exception 'kind must be staff, visitor, contractor or supplier' using errcode = '22023';
  end if;
  if length(coalesce(btrim(p_name), '')) = 0 then raise exception 'A name is required' using errcode = '22023'; end if;
  insert into __TENANT__.visits (kind, name, company, arrived_by)
  values (p_kind, btrim(p_name), nullif(btrim(coalesce(p_company, '')), ''), auth.uid())
  returning * into v;
  return v;
end;
$$;


--

-- Name: record_visit_departure(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.record_visit_departure(p_id uuid) RETURNS __TENANT__.visits
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
declare v __TENANT__.visits;
begin
  if not __TENANT__.is_staff() then raise exception 'Not authorised to sign a visitor out' using errcode = '42501'; end if;
  update __TENANT__.visits set left_at = now(), left_by = auth.uid()
   where id = p_id and left_at is null;
  select * into v from __TENANT__.visits where id = p_id;
  if v.id is null then raise exception 'No such visit' using errcode = 'P0002'; end if;
  return v;
end;
$$;


--

-- Name: refuse_archived_room(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.refuse_archived_room() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
begin
  if new.room_id is not null and (tg_op = 'INSERT' or new.room_id is distinct from old.room_id)
     and exists (select 1 from __TENANT__.rooms where id = new.room_id and archived_at is not null) then
    raise exception 'That room is archived' using errcode = '23514';
  end if;
  return new;
end;
$$;


--

-- Name: resident_views_between(date, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.resident_views_between(p_from date, p_to date) RETURNS TABLE(at text, staff text, resident text, "where" text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
declare v_tz text;
begin
  if not __TENANT__.is_admin() then
    raise exception 'Only an administrator may see who viewed a record' using errcode = '42501';
  end if;
  select local_timezone into v_tz from __TENANT__.app_settings where id;
  return query
    select to_char(v.viewed_at at time zone v_tz, 'YYYY-MM-DD HH24:MI') as at,
           coalesce(p.full_name, '(account removed)') as staff,
           r.first_name || ' ' || r.last_name as resident,
           v.surface as "where"
      from __TENANT__.resident_views v
      left join __TENANT__.profiles p on p.id = v.actor_id
      join __TENANT__.residents r on r.id = v.resident_id
     where (v.viewed_at at time zone v_tz)::date between p_from and p_to
     order by v.viewed_at desc;
end;
$$;


--

-- Name: room_label_of(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.room_label_of(p_room_id uuid) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
  select b.name || case when rm.floor <> '' then ' · ' || rm.floor else '' end || ' · ' || rm.number
    from __TENANT__.rooms rm join __TENANT__.buildings b on b.id = rm.building_id
   where rm.id = p_room_id;
$$;


--

-- Name: search_residents(text, boolean, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.search_residents(q text, include_departed boolean DEFAULT false, max_results integer DEFAULT 20) RETURNS SETOF __TENANT__.v_resident_status
    LANGUAGE sql STABLE
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
  select v.*
  from __TENANT__.v_resident_status v
  cross join (select lower(public.immutable_unaccent(btrim(coalesce(q, '')))) as nq) n
  where __TENANT__.is_staff()
    and (include_departed or v.status = 'active')
    and (
      n.nq = ''
      or v.search_key like '%' || n.nq || '%'
      -- Migration 028: the room as painted on the door (B1, K12), or any
      -- part of the building-and-room label. Security works by room.
      or exists (select 1 from __TENANT__.v_resident_room x
                  where x.id = v.id
                    and (lower(x.room) = n.nq
                         -- A prefix too: "B" lists Manor House, "K1" K1 and K10-K18.
                         or lower(x.room) like n.nq || '%'
                         or lower(x.room_label) like '%' || n.nq || '%'
                         or lower(x.building || ' ' || x.room) like '%' || n.nq || '%'))
      or (
        word_similarity(n.nq, v.search_key) >= 0.4
        and not exists (
          select 1 from __TENANT__.v_resident_status v2
          where (include_departed or v2.status = 'active')
            and v2.search_key like '%' || n.nq || '%'
        )
      )
    )
  order by
    case when exists (select 1 from __TENANT__.v_resident_room x where x.id = v.id and (lower(x.room) = n.nq or lower(x.room) like n.nq || '%')) then 0
         when v.search_key like n.nq || '%'         then 0
         when v.search_key like '%' || n.nq || '%'  then 1
         else 2 end,
    word_similarity(n.nq, v.search_key) desc,
    v.last_name, v.first_name
  limit greatest(1, least(coalesce(max_results, 20), 1000));
$$;


--

-- Name: snapshot_overnight_absences(date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.snapshot_overnight_absences(p_night date DEFAULT NULL::date) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
declare
  v_night date := coalesce(p_night, __TENANT__.site_today() - 1);
  v_tz    text;
  v_end   timestamptz;
  v_n     integer;
begin
  select local_timezone into v_tz from __TENANT__.app_settings where id;
  v_end := ((v_night + 1)::timestamp) at time zone v_tz;   -- midnight at the end of that night, site time
  insert into __TENANT__.overnight_absences (night, resident_id, off_site_since)
  select v_night, r.id, le.occurred_at
    from __TENANT__.residents r
    left join lateral (
      select e.kind, e.occurred_at
        from __TENANT__.gate_events e
       where e.resident_id = r.id and e.occurred_at < v_end
       order by e.occurred_at desc, e.id desc
       limit 1
    ) le on true
   where r.registered_at < v_end
     and (r.status = 'active' or (r.status = 'departed' and r.departed_on is not null and r.departed_on > v_night))
     and (le.kind is null or le.kind = 'out')
  on conflict do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;


--

-- Name: start_roll_call(uuid, text, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.start_roll_call(p_id uuid, p_kind text, p_started_at timestamp with time zone DEFAULT now()) RETURNS __TENANT__.roll_calls
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
declare v __TENANT__.roll_calls;
begin
  if not __TENANT__.is_staff() then raise exception 'Not authorised to start a roll call' using errcode = '42501'; end if;
  if p_kind not in ('drill', 'incident') then raise exception 'kind must be drill or incident' using errcode = '22023'; end if;
  insert into __TENANT__.roll_calls (id, kind, started_at, started_by)
  values (p_id, p_kind, least(coalesce(p_started_at, now()), now()), auth.uid())
  on conflict (id) do nothing;
  select * into v from __TENANT__.roll_calls where id = p_id;
  return v;
end;
$$;


--

-- Name: track_room_assignment(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.track_room_assignment() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
declare
  v_was_open boolean;
begin
  if tg_op = 'INSERT' then
    if new.room_id is not null and new.status = 'active' then
      insert into __TENANT__.room_assignments (resident_id, room_id, room_label, changed_by)
      values (new.id, new.room_id, __TENANT__.room_label_of(new.room_id), auth.uid());
    end if;
    return new;
  end if;
  -- UPDATE: nothing to do unless the room or the status moved.
  if new.room_id is not distinct from old.room_id and new.status = old.status then
    return new;
  end if;
  v_was_open := old.room_id is not null and old.status = 'active';
  if v_was_open and (new.room_id is distinct from old.room_id or new.status <> 'active') then
    update __TENANT__.room_assignments set to_at = now()
     where resident_id = new.id and to_at is null;
  end if;
  if new.room_id is not null and new.status = 'active'
     and (new.room_id is distinct from old.room_id or old.status <> 'active') then
    insert into __TENANT__.room_assignments (resident_id, room_id, room_label, changed_by)
    values (new.id, new.room_id, __TENANT__.room_label_of(new.room_id), auth.uid());
  end if;
  return new;
end;
$$;


--

-- Name: weekly_absence_spans(date, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.weekly_absence_spans(p_from date, p_to date) RETURNS TABLE(resident_id uuid, resident text, building text, room text, child boolean, first_night date, last_night date, nights integer, back_on date, authorised_nights integer, approval text, weekend boolean, last_name text, first_name text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    SET lc_time TO 'C'
    AS $$
  with nights as (
    select o.resident_id, o.night,
           o.night - (row_number() over (partition by o.resident_id order by o.night))::integer as grp
      from __TENANT__.overnight_absences o
     where o.night between p_from and p_to
  ),
  spans as (
    select n.resident_id, min(n.night) as first_night, max(n.night) as last_night, count(*)::integer as nights,
           count(*) filter (where __TENANT__.absence_authorised(n.resident_id, n.night))::integer as authorised_nights
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
    join __TENANT__.residents r on r.id = s.resident_id
    left join __TENANT__.rooms rm on rm.id = r.room_id
    left join __TENANT__.buildings b on b.id = rm.building_id
    cross join (select adult_age_years from __TENANT__.app_settings where id) st;
$$;


--

-- Name: weekly_register_rows(date, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.weekly_register_rows(p_from date, p_to date) RETURNS TABLE(section text, building text, room text, ref text, resident text, child text, from_date date, to_date date, nights integer, back_on date, status text, line text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    AS $$
begin
  if not __TENANT__.is_supervisor() then
    raise exception 'Only a supervisor or admin may run the weekly register' using errcode = '42501';
  end if;
  return query select * from __TENANT__.weekly_register_rows_unchecked(p_from, p_to);
end;
$$;


--

-- Name: weekly_register_rows_unchecked(date, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.weekly_register_rows_unchecked(p_from date, p_to date) RETURNS TABLE(section text, building text, room text, ref text, resident text, child text, from_date date, to_date date, nights integer, back_on date, status text, line text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO '__TENANT__', 'public', 'extensions'
    SET lc_time TO 'C'
    AS $$
  select q.section, q.building, q.room, q.ref, q.resident, q.child, q.from_date, q.to_date, q.nights, q.back_on, q.status, q.line
    from (
      -- Rooms under maintenance, fully empty, or with some free contracted beds
      select 1 as seq, lpad(b.sort::text, 6, '0') || b.name as k1, lpad(rm.sort::text, 6, '0') || rm.floor as k2, rm.number as k3,
             'Room updates' as section, b.name as building, rm.number as room, null::text as ref, null::text as resident, ''::text as child,
             null::date as from_date, null::date as to_date, null::integer as nights, null::date as back_on,
             case when rm.status = 'maintenance' then 'maintenance'
                  when x.free = x.contracted then 'available'
                  else x.free || ' free' end as status,
             case when rm.status = 'maintenance'
                  then b.name || ' ' || rm.number || ' is under maintenance' || coalesce(': ' || rm.note, '') || '.'
                  when x.free = x.contracted
                  then b.name || ' ' || rm.number || ' is available immediately for new families'
                       || coalesce(' (' || rm.bed_config || ')', '') || coalesce(': ' || rm.note, '') || '.'
                  else b.name || ' ' || rm.number || ': ' || x.free || ' of ' || x.contracted || ' bed' || case when x.contracted = 1 then '' else 's' end || ' free'
                       || coalesce(' (' || rm.bed_config || ')', '') || coalesce(': ' || rm.note, '') || '.' end as line
        from __TENANT__.rooms rm
        join __TENANT__.buildings b on b.id = rm.building_id
        cross join lateral (
          select coalesce(rm.contracted_capacity, rm.capacity) as contracted,
                 coalesce(rm.contracted_capacity, rm.capacity)
                   - (select count(*)::integer from __TENANT__.residents r where r.room_id = rm.id and r.status = 'active') as free
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
        from __TENANT__.weekly_absence_spans(p_from, p_to) s
        join __TENANT__.residents r2 on r2.id = s.resident_id
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
        from __TENANT__.residents r
        left join __TENANT__.rooms rm on rm.id = r.room_id
        left join __TENANT__.buildings b on b.id = rm.building_id
        cross join (select adult_age_years from __TENANT__.app_settings where id) st
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
        from __TENANT__.residents r
        left join __TENANT__.rooms rm on rm.id = r.room_id
        left join __TENANT__.buildings b on b.id = rm.building_id
        cross join (select adult_age_years, local_timezone as tz from __TENANT__.app_settings where id) st
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
        from __TENANT__.room_assignments ra
        join __TENANT__.residents r on r.id = ra.resident_id
        left join __TENANT__.rooms rm on rm.id = ra.room_id
        left join __TENANT__.buildings b on b.id = rm.building_id
        cross join (select adult_age_years, local_timezone as tz from __TENANT__.app_settings where id) st
        cross join lateral (
          select ra2.room_id, ra2.room_label from __TENANT__.room_assignments ra2
           where ra2.resident_id = ra.resident_id and ra2.from_at < ra.from_at
           order by ra2.from_at desc limit 1
        ) prev
        left join __TENANT__.rooms prm on prm.id = prev.room_id
        left join __TENANT__.buildings pb on pb.id = prm.building_id
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
        from __TENANT__.room_assignments ra
        join __TENANT__.residents r on r.id = ra.resident_id and r.status = 'active'
        left join __TENANT__.rooms prm2 on prm2.id = ra.room_id
        left join __TENANT__.buildings pb2 on pb2.id = prm2.building_id
        cross join (select adult_age_years, local_timezone as tz from __TENANT__.app_settings where id) st
       where ra.to_at is not null
         and (ra.to_at at time zone st.tz)::date between p_from and p_to
         and not exists (
           select 1 from __TENANT__.room_assignments ra2
            where ra2.resident_id = ra.resident_id and ra2.from_at = ra.to_at
         )
    ) q
   order by q.seq, q.k1, q.k2, q.k3;
$$;


--

-- Name: absence_windows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE __TENANT__.absence_windows (
    id bigint NOT NULL,
    name text NOT NULL,
    from_date date NOT NULL,
    to_date date NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT absence_windows_check CHECK ((to_date >= from_date)),
    CONSTRAINT absence_windows_name_check CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 60)))
);


--

-- Name: absence_windows_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE __TENANT__.absence_windows_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--

-- Name: absence_windows_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE __TENANT__.absence_windows_id_seq OWNED BY __TENANT__.absence_windows.id;


--

-- Name: admin_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE __TENANT__.admin_audit (
    id bigint NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    actor_id uuid,
    table_name text NOT NULL,
    row_id text NOT NULL,
    action text NOT NULL,
    old_row jsonb,
    new_row jsonb,
    note text,
    CONSTRAINT admin_audit_action_check CHECK ((action = ANY (ARRAY['insert'::text, 'update'::text, 'delete'::text, 'export'::text])))
);


--

-- Name: admin_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE __TENANT__.admin_audit ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME __TENANT__.admin_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--

-- Name: authorised_absences_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE __TENANT__.authorised_absences_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--

-- Name: authorised_absences_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE __TENANT__.authorised_absences_id_seq OWNED BY __TENANT__.authorised_absences.id;


--

-- Name: breach_reports_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE __TENANT__.breach_reports_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--

-- Name: breach_reports_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE __TENANT__.breach_reports_id_seq OWNED BY __TENANT__.breach_reports.id;


--

-- Name: buildings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE __TENANT__.buildings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    sort integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT buildings_name_check CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 60)))
);


--

-- Name: checkin_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE __TENANT__.checkin_events (
    id bigint NOT NULL,
    resident_id uuid NOT NULL,
    guard_id uuid NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    late_entry boolean DEFAULT false NOT NULL,
    client_ref uuid,
    source text DEFAULT 'desk'::text NOT NULL,
    CONSTRAINT checkin_events_source_check CHECK ((source = ANY (ARRAY['desk'::text, 'door'::text])))
);


--

-- Name: checkin_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE __TENANT__.checkin_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME __TENANT__.checkin_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--

-- Name: erasure_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE __TENANT__.erasure_log (
    id bigint NOT NULL,
    resident_digest text NOT NULL,
    events_removed integer NOT NULL,
    reason text,
    performed_by uuid,
    performed_at timestamp with time zone DEFAULT now() NOT NULL
);


--

-- Name: erasure_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE __TENANT__.erasure_log ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME __TENANT__.erasure_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--

-- Name: gate_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE __TENANT__.gate_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME __TENANT__.gate_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--

-- Name: households; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE __TENANT__.households (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--

-- Name: job_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE __TENANT__.job_runs (
    id bigint NOT NULL,
    job text NOT NULL,
    ran_at timestamp with time zone DEFAULT now() NOT NULL,
    ok boolean NOT NULL,
    result text
);


--

-- Name: job_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE __TENANT__.job_runs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME __TENANT__.job_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--

-- Name: overnight_absences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE __TENANT__.overnight_absences (
    night date NOT NULL,
    resident_id uuid NOT NULL,
    off_site_since timestamp with time zone,
    snapshot_at timestamp with time zone DEFAULT now() NOT NULL
);


--

-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE __TENANT__.profiles (
    id uuid NOT NULL,
    full_name text NOT NULL,
    role text DEFAULT 'guard'::text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    weekly_report boolean DEFAULT false NOT NULL,
    safeguarding_alert boolean DEFAULT false NOT NULL,
    CONSTRAINT profiles_role_check CHECK ((role = ANY (ARRAY['guard'::text, 'supervisor'::text, 'admin'::text]))),
    CONSTRAINT profiles_safeguarding_alert_not_guard CHECK ((NOT (safeguarding_alert AND (role = 'guard'::text)))),
    CONSTRAINT profiles_weekly_report_not_guard CHECK ((NOT (weekly_report AND (role = 'guard'::text))))
);


--

-- Name: resident_views; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE __TENANT__.resident_views (
    id bigint NOT NULL,
    viewed_at timestamp with time zone DEFAULT now() NOT NULL,
    actor_id uuid,
    resident_id uuid NOT NULL,
    surface text NOT NULL,
    CONSTRAINT resident_views_surface_check CHECK ((surface = ANY (ARRAY['register'::text, 'admin'::text, 'export'::text])))
);


--

-- Name: resident_views_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE __TENANT__.resident_views ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME __TENANT__.resident_views_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--

-- Name: room_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE __TENANT__.room_assignments (
    id bigint NOT NULL,
    resident_id uuid NOT NULL,
    room_id uuid,
    room_label text NOT NULL,
    from_at timestamp with time zone DEFAULT now() NOT NULL,
    to_at timestamp with time zone,
    changed_by uuid,
    CONSTRAINT room_assignments_check CHECK (((to_at IS NULL) OR (to_at >= from_at)))
);


--

-- Name: room_assignments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE __TENANT__.room_assignments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--

-- Name: room_assignments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE __TENANT__.room_assignments_id_seq OWNED BY __TENANT__.room_assignments.id;


--

-- Name: rooms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE __TENANT__.rooms (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    building_id uuid NOT NULL,
    floor text DEFAULT ''::text NOT NULL,
    number text NOT NULL,
    capacity integer DEFAULT 1 NOT NULL,
    sort integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    contracted_capacity integer,
    bed_config text,
    status text DEFAULT 'open'::text NOT NULL,
    note text,
    CONSTRAINT rooms_bed_config_check CHECK (((bed_config IS NULL) OR (length(bed_config) <= 80))),
    CONSTRAINT rooms_capacity_check CHECK (((capacity >= 1) AND (capacity <= 30))),
    CONSTRAINT rooms_contracted_capacity_check CHECK (((contracted_capacity IS NULL) OR ((contracted_capacity >= 0) AND (contracted_capacity <= 30)))),
    CONSTRAINT rooms_floor_check CHECK ((length(floor) <= 20)),
    CONSTRAINT rooms_note_check CHECK (((note IS NULL) OR (length(note) <= 120))),
    CONSTRAINT rooms_number_check CHECK (((length(btrim(number)) >= 1) AND (length(btrim(number)) <= 20))),
    CONSTRAINT rooms_status_check CHECK ((status = ANY (ARRAY['open'::text, 'maintenance'::text])))
);


--

-- Name: staff_roster; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE __TENANT__.staff_roster (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    role text,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT staff_roster_name_check CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 80))),
    CONSTRAINT staff_roster_role_check CHECK (((role IS NULL) OR (length(role) <= 80)))
);


--

-- Name: v_check_log; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW __TENANT__.v_check_log AS
 SELECT e.id,
    e.resident_id,
    e.kind,
    e.occurred_at,
    ((btrim(r.first_name) || ' '::text) || btrim(r.last_name)) AS resident_name,
    e.guard_id,
    g.full_name AS guard_name,
    e.late_entry,
    e.recorded_at
   FROM ((__TENANT__.gate_events e
     JOIN __TENANT__.residents r ON ((r.id = e.resident_id)))
     JOIN __TENANT__.profiles g ON ((g.id = e.guard_id)))
  WHERE __TENANT__.is_staff();


--

-- Name: v_resident_room; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW __TENANT__.v_resident_room AS
 SELECT r.id,
    r.room_id,
    rm.building_id,
    b.name AS building,
    rm.floor,
    rm.number AS room,
        CASE
            WHEN (rm.id IS NULL) THEN NULL::text
            ELSE (((b.name ||
            CASE
                WHEN (rm.floor <> ''::text) THEN (' · '::text || rm.floor)
                ELSE ''::text
            END) || ' · '::text) || rm.number)
        END AS room_label,
    r.evac_need,
    r.household_id,
    h.size AS household_size,
    h.label AS household_label
   FROM (((__TENANT__.residents r
     LEFT JOIN __TENANT__.rooms rm ON ((rm.id = r.room_id)))
     LEFT JOIN __TENANT__.buildings b ON ((b.id = rm.building_id)))
     LEFT JOIN LATERAL ( SELECT (count(*))::integer AS size,
            (((string_agg(DISTINCT btrim(m.last_name), ' / '::text ORDER BY (btrim(m.last_name))) || ' family ('::text) || count(*)) || ')'::text) AS label
           FROM __TENANT__.residents m
          WHERE ((m.household_id = r.household_id) AND (m.status = 'active'::text))) h ON ((r.household_id IS NOT NULL)))
  WHERE __TENANT__.is_staff();


--

-- Name: v_evacuation_list; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW __TENANT__.v_evacuation_list AS
 SELECT v.id,
    v.full_name,
    v.presence,
    v.last_event_at,
    v.is_adult,
    x.building_id,
    x.building,
    x.floor,
    x.room,
    x.room_label,
    r.evac_need,
    b.sort AS building_sort,
    x.household_id,
    x.household_size,
    x.household_label
   FROM (((__TENANT__.residents r
     JOIN __TENANT__.v_resident_status v ON ((v.id = r.id)))
     LEFT JOIN __TENANT__.v_resident_room x ON ((x.id = r.id)))
     LEFT JOIN __TENANT__.buildings b ON ((b.id = x.building_id)))
  WHERE ((r.status = 'active'::text) AND __TENANT__.is_staff())
  ORDER BY b.sort, x.building, (r.evac_need <> 'none'::text) DESC, v.last_name, v.first_name;


--

-- Name: v_room_occupancy; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW __TENANT__.v_room_occupancy AS
 SELECT b.id AS building_id,
    b.name AS building,
    b.sort AS building_sort,
    rm.id AS room_id,
    rm.floor,
    rm.number AS room,
    rm.capacity,
    rm.sort AS room_sort,
    (count(v.id))::integer AS occupants,
    (count(v.id) FILTER (WHERE (v.presence = 'in'::text)))::integer AS on_site,
    COALESCE(jsonb_agg(jsonb_build_object('id', v.id, 'full_name', v.full_name, 'presence', v.presence, 'is_adult', v.is_adult, 'evac_need', r.evac_need, 'household_id', r.household_id) ORDER BY r.household_id, v.last_name, v.first_name) FILTER (WHERE (v.id IS NOT NULL)), '[]'::jsonb) AS residents,
    rm.contracted_capacity,
    rm.bed_config,
    (rm.archived_at IS NOT NULL) AS archived,
    rm.status,
    rm.note
   FROM (((__TENANT__.buildings b
     JOIN __TENANT__.rooms rm ON ((rm.building_id = b.id)))
     LEFT JOIN __TENANT__.residents r ON (((r.room_id = rm.id) AND (r.status = 'active'::text))))
     LEFT JOIN __TENANT__.v_resident_status v ON ((v.id = r.id)))
  WHERE __TENANT__.is_staff()
  GROUP BY b.id, b.name, b.sort, rm.id, rm.floor, rm.number, rm.capacity, rm.contracted_capacity, rm.bed_config, rm.archived_at, rm.status, rm.note, rm.sort;


--

-- Name: v_system_health; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW __TENANT__.v_system_health AS
 SELECT ( SELECT max(daily_compliance.compliance_date) AS max
           FROM __TENANT__.daily_compliance
          WHERE (daily_compliance.closed_at IS NOT NULL)) AS last_closed_day,
    __TENANT__.site_today() AS site_today,
    ( SELECT max(job_runs.ran_at) AS max
           FROM __TENANT__.job_runs
          WHERE ((job_runs.job = 'close-out-compliance-days'::text) AND job_runs.ok)) AS last_close_out_run,
    ( SELECT max(job_runs.ran_at) AS max
           FROM __TENANT__.job_runs
          WHERE job_runs.ok) AS last_job_run,
    ( SELECT (count(*))::integer AS count
           FROM __TENANT__.job_runs
          WHERE ((NOT job_runs.ok) AND (job_runs.ran_at > (now() - '2 days'::interval)))) AS recent_failures,
    COALESCE((( SELECT max(daily_compliance.compliance_date) AS max
           FROM __TENANT__.daily_compliance
          WHERE (daily_compliance.closed_at IS NOT NULL)) < __TENANT__.close_out_due_through()), (EXISTS ( SELECT 1
           FROM __TENANT__.daily_compliance
          WHERE (daily_compliance.compliance_date < __TENANT__.close_out_due_through())))) AS close_out_behind
  WHERE __TENANT__.is_staff();


--

-- Name: absence_windows id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.absence_windows ALTER COLUMN id SET DEFAULT nextval('__TENANT__.absence_windows_id_seq'::regclass);


--

-- Name: authorised_absences id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.authorised_absences ALTER COLUMN id SET DEFAULT nextval('__TENANT__.authorised_absences_id_seq'::regclass);


--

-- Name: breach_reports id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.breach_reports ALTER COLUMN id SET DEFAULT nextval('__TENANT__.breach_reports_id_seq'::regclass);


--

-- Name: room_assignments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.room_assignments ALTER COLUMN id SET DEFAULT nextval('__TENANT__.room_assignments_id_seq'::regclass);


--

-- Name: absence_windows absence_windows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.absence_windows
    ADD CONSTRAINT absence_windows_pkey PRIMARY KEY (id);


--

-- Name: admin_audit admin_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.admin_audit
    ADD CONSTRAINT admin_audit_pkey PRIMARY KEY (id);


--

-- Name: app_settings app_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.app_settings
    ADD CONSTRAINT app_settings_pkey PRIMARY KEY (id);


--

-- Name: authorised_absences authorised_absences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.authorised_absences
    ADD CONSTRAINT authorised_absences_pkey PRIMARY KEY (id);


--

-- Name: breach_reports breach_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.breach_reports
    ADD CONSTRAINT breach_reports_pkey PRIMARY KEY (id);


--

-- Name: buildings buildings_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.buildings
    ADD CONSTRAINT buildings_name_key UNIQUE (name);


--

-- Name: buildings buildings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.buildings
    ADD CONSTRAINT buildings_pkey PRIMARY KEY (id);


--

-- Name: checkin_events checkin_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.checkin_events
    ADD CONSTRAINT checkin_events_pkey PRIMARY KEY (id);


--

-- Name: daily_compliance daily_compliance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.daily_compliance
    ADD CONSTRAINT daily_compliance_pkey PRIMARY KEY (resident_id, compliance_date);


--

-- Name: erasure_log erasure_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.erasure_log
    ADD CONSTRAINT erasure_log_pkey PRIMARY KEY (id);


--

-- Name: gate_events gate_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.gate_events
    ADD CONSTRAINT gate_events_pkey PRIMARY KEY (id);


--

-- Name: households households_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.households
    ADD CONSTRAINT households_pkey PRIMARY KEY (id);


--

-- Name: job_runs job_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.job_runs
    ADD CONSTRAINT job_runs_pkey PRIMARY KEY (id);


--

-- Name: overnight_absences overnight_absences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.overnight_absences
    ADD CONSTRAINT overnight_absences_pkey PRIMARY KEY (night, resident_id);


--

-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--

-- Name: resident_views resident_views_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.resident_views
    ADD CONSTRAINT resident_views_pkey PRIMARY KEY (id);


--

-- Name: residents residents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.residents
    ADD CONSTRAINT residents_pkey PRIMARY KEY (id);


--

-- Name: residents residents_ref_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.residents
    ADD CONSTRAINT residents_ref_unique UNIQUE (ref);


--

-- Name: roll_call_marks roll_call_marks_client_ref_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.roll_call_marks
    ADD CONSTRAINT roll_call_marks_client_ref_key UNIQUE (client_ref);


--

-- Name: roll_call_marks roll_call_marks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.roll_call_marks
    ADD CONSTRAINT roll_call_marks_pkey PRIMARY KEY (roll_call_id, resident_id);


--

-- Name: roll_call_visit_marks roll_call_visit_marks_client_ref_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.roll_call_visit_marks
    ADD CONSTRAINT roll_call_visit_marks_client_ref_key UNIQUE (client_ref);


--

-- Name: roll_call_visit_marks roll_call_visit_marks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.roll_call_visit_marks
    ADD CONSTRAINT roll_call_visit_marks_pkey PRIMARY KEY (roll_call_id, visit_id);


--

-- Name: roll_calls roll_calls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.roll_calls
    ADD CONSTRAINT roll_calls_pkey PRIMARY KEY (id);


--

-- Name: room_assignments room_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.room_assignments
    ADD CONSTRAINT room_assignments_pkey PRIMARY KEY (id);


--

-- Name: rooms rooms_building_floor_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.rooms
    ADD CONSTRAINT rooms_building_floor_number_key UNIQUE (building_id, floor, number);


--

-- Name: rooms rooms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.rooms
    ADD CONSTRAINT rooms_pkey PRIMARY KEY (id);


--

-- Name: staff_roster staff_roster_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.staff_roster
    ADD CONSTRAINT staff_roster_pkey PRIMARY KEY (id);


--

-- Name: visits visits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.visits
    ADD CONSTRAINT visits_pkey PRIMARY KEY (id);


--

-- Name: admin_audit_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_audit_at_idx ON __TENANT__.admin_audit USING btree (at);


--

-- Name: admin_audit_row_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_audit_row_idx ON __TENANT__.admin_audit USING btree (table_name, row_id);


--

-- Name: authorised_absences_resident_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX authorised_absences_resident_idx ON __TENANT__.authorised_absences USING btree (resident_id, from_date, to_date);


--

-- Name: breach_reports_resident_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX breach_reports_resident_idx ON __TENANT__.breach_reports USING btree (resident_id, issued_on DESC);


--

-- Name: checkin_events_client_ref_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX checkin_events_client_ref_key ON __TENANT__.checkin_events USING btree (client_ref) WHERE (client_ref IS NOT NULL);


--

-- Name: checkin_events_resident_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX checkin_events_resident_time_idx ON __TENANT__.checkin_events USING btree (resident_id, occurred_at DESC, id DESC);


--

-- Name: checkin_events_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX checkin_events_time_idx ON __TENANT__.checkin_events USING btree (occurred_at DESC);


--

-- Name: daily_compliance_breach_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX daily_compliance_breach_idx ON __TENANT__.daily_compliance USING btree (resident_id, compliance_date DESC) WHERE (required AND (NOT presented));


--

-- Name: daily_compliance_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX daily_compliance_date_idx ON __TENANT__.daily_compliance USING btree (compliance_date DESC);


--

-- Name: daily_compliance_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX daily_compliance_open_idx ON __TENANT__.daily_compliance USING btree (compliance_date) WHERE (closed_at IS NULL);


--

-- Name: daily_compliance_seen_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX daily_compliance_seen_idx ON __TENANT__.daily_compliance USING btree (resident_id, compliance_date DESC) WHERE presented;


--

-- Name: gate_events_client_ref_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX gate_events_client_ref_key ON __TENANT__.gate_events USING btree (client_ref) WHERE (client_ref IS NOT NULL);


--

-- Name: gate_events_resident_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gate_events_resident_time_idx ON __TENANT__.gate_events USING btree (resident_id, occurred_at DESC, id DESC);


--

-- Name: gate_events_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gate_events_time_idx ON __TENANT__.gate_events USING btree (occurred_at DESC);


--

-- Name: job_runs_job_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX job_runs_job_idx ON __TENANT__.job_runs USING btree (job, ran_at DESC);


--

-- Name: overnight_absences_night_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX overnight_absences_night_idx ON __TENANT__.overnight_absences USING btree (night DESC);


--

-- Name: resident_views_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX resident_views_at_idx ON __TENANT__.resident_views USING btree (viewed_at);


--

-- Name: resident_views_resident_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX resident_views_resident_idx ON __TENANT__.resident_views USING btree (resident_id, viewed_at);


--

-- Name: residents_household_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX residents_household_idx ON __TENANT__.residents USING btree (household_id) WHERE (household_id IS NOT NULL);


--

-- Name: residents_room_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX residents_room_idx ON __TENANT__.residents USING btree (room_id) WHERE (room_id IS NOT NULL);


--

-- Name: residents_search_key_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX residents_search_key_trgm_idx ON __TENANT__.residents USING gin (search_key extensions.gin_trgm_ops);


--

-- Name: residents_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX residents_status_idx ON __TENANT__.residents USING btree (status);


--

-- Name: roll_calls_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX roll_calls_open_idx ON __TENANT__.roll_calls USING btree (started_at DESC) WHERE (ended_at IS NULL);


--

-- Name: room_assignments_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX room_assignments_open_idx ON __TENANT__.room_assignments USING btree (resident_id) WHERE (to_at IS NULL);


--

-- Name: room_assignments_resident_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX room_assignments_resident_idx ON __TENANT__.room_assignments USING btree (resident_id, from_at DESC);


--

-- Name: room_assignments_room_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX room_assignments_room_idx ON __TENANT__.room_assignments USING btree (room_id, from_at DESC);


--

-- Name: rooms_building_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rooms_building_idx ON __TENANT__.rooms USING btree (building_id, sort, floor, number);


--

-- Name: staff_roster_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX staff_roster_name_idx ON __TENANT__.staff_roster USING btree (lower(btrim(name)));


--

-- Name: visits_arrived_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX visits_arrived_idx ON __TENANT__.visits USING btree (arrived_at DESC);


--

-- Name: visits_on_site_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX visits_on_site_idx ON __TENANT__.visits USING btree (arrived_at DESC) WHERE (left_at IS NULL);


--

-- Name: visits_roster_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX visits_roster_open_idx ON __TENANT__.visits USING btree (roster_id) WHERE (left_at IS NULL);


--

-- Name: absence_windows absence_windows_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER absence_windows_audit AFTER INSERT OR DELETE OR UPDATE ON __TENANT__.absence_windows FOR EACH ROW EXECUTE FUNCTION __TENANT__.audit_row();


--

-- Name: app_settings app_settings_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER app_settings_audit AFTER UPDATE ON __TENANT__.app_settings FOR EACH ROW EXECUTE FUNCTION __TENANT__.audit_row();


--

-- Name: authorised_absences authorised_absences_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER authorised_absences_audit AFTER INSERT OR DELETE OR UPDATE ON __TENANT__.authorised_absences FOR EACH ROW EXECUTE FUNCTION __TENANT__.audit_row();


--

-- Name: breach_reports breach_reports_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER breach_reports_audit AFTER INSERT OR DELETE OR UPDATE ON __TENANT__.breach_reports FOR EACH ROW EXECUTE FUNCTION __TENANT__.audit_row();


--

-- Name: buildings buildings_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER buildings_audit AFTER INSERT OR DELETE OR UPDATE ON __TENANT__.buildings FOR EACH ROW EXECUTE FUNCTION __TENANT__.audit_row();


--

-- Name: profiles profiles_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER profiles_audit AFTER INSERT OR DELETE OR UPDATE ON __TENANT__.profiles FOR EACH ROW EXECUTE FUNCTION __TENANT__.audit_row();


--

-- Name: profiles profiles_end_sessions_on_deactivate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER profiles_end_sessions_on_deactivate AFTER UPDATE OF active ON __TENANT__.profiles FOR EACH ROW EXECUTE FUNCTION __TENANT__.end_sessions_on_deactivate();


--

-- Name: profiles profiles_safeguarding_alert_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER profiles_safeguarding_alert_guard BEFORE INSERT OR UPDATE ON __TENANT__.profiles FOR EACH ROW EXECUTE FUNCTION __TENANT__.profiles_clear_safeguarding_alert_for_guard();


--

-- Name: profiles profiles_weekly_report_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER profiles_weekly_report_guard BEFORE INSERT OR UPDATE ON __TENANT__.profiles FOR EACH ROW EXECUTE FUNCTION __TENANT__.profiles_clear_weekly_report_for_guard();


--

-- Name: residents residents_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER residents_audit AFTER INSERT OR DELETE OR UPDATE ON __TENANT__.residents FOR EACH ROW EXECUTE FUNCTION __TENANT__.audit_row();


--

-- Name: residents residents_no_archived_room; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER residents_no_archived_room BEFORE INSERT OR UPDATE OF room_id ON __TENANT__.residents FOR EACH ROW EXECUTE FUNCTION __TENANT__.refuse_archived_room();


--

-- Name: residents residents_prune_households; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER residents_prune_households AFTER DELETE OR UPDATE OF household_id ON __TENANT__.residents FOR EACH ROW EXECUTE FUNCTION __TENANT__.prune_empty_households();


--

-- Name: residents residents_room_history; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER residents_room_history AFTER INSERT OR UPDATE OF room_id, status ON __TENANT__.residents FOR EACH ROW EXECUTE FUNCTION __TENANT__.track_room_assignment();


--

-- Name: residents residents_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER residents_touch_updated_at BEFORE UPDATE ON __TENANT__.residents FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--

-- Name: rooms rooms_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER rooms_audit AFTER INSERT OR DELETE OR UPDATE ON __TENANT__.rooms FOR EACH ROW EXECUTE FUNCTION __TENANT__.audit_row();


--

-- Name: staff_roster staff_roster_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER staff_roster_audit AFTER INSERT OR DELETE OR UPDATE ON __TENANT__.staff_roster FOR EACH ROW EXECUTE FUNCTION __TENANT__.audit_row();


--

-- Name: absence_windows absence_windows_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.absence_windows
    ADD CONSTRAINT absence_windows_created_by_fkey FOREIGN KEY (created_by) REFERENCES __TENANT__.profiles(id) ON DELETE SET NULL;


--

-- Name: admin_audit admin_audit_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.admin_audit
    ADD CONSTRAINT admin_audit_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES __TENANT__.profiles(id) ON DELETE SET NULL;


--

-- Name: authorised_absences authorised_absences_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.authorised_absences
    ADD CONSTRAINT authorised_absences_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES __TENANT__.profiles(id) ON DELETE SET NULL;


--

-- Name: authorised_absences authorised_absences_resident_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.authorised_absences
    ADD CONSTRAINT authorised_absences_resident_id_fkey FOREIGN KEY (resident_id) REFERENCES __TENANT__.residents(id) ON DELETE CASCADE;


--

-- Name: breach_reports breach_reports_issued_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.breach_reports
    ADD CONSTRAINT breach_reports_issued_by_fkey FOREIGN KEY (issued_by) REFERENCES __TENANT__.profiles(id) ON DELETE SET NULL;


--

-- Name: breach_reports breach_reports_resident_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.breach_reports
    ADD CONSTRAINT breach_reports_resident_id_fkey FOREIGN KEY (resident_id) REFERENCES __TENANT__.residents(id) ON DELETE CASCADE;


--

-- Name: checkin_events checkin_events_guard_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.checkin_events
    ADD CONSTRAINT checkin_events_guard_id_fkey FOREIGN KEY (guard_id) REFERENCES __TENANT__.profiles(id) ON DELETE RESTRICT;


--

-- Name: checkin_events checkin_events_resident_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.checkin_events
    ADD CONSTRAINT checkin_events_resident_id_fkey FOREIGN KEY (resident_id) REFERENCES __TENANT__.residents(id) ON DELETE CASCADE;


--

-- Name: daily_compliance daily_compliance_resident_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.daily_compliance
    ADD CONSTRAINT daily_compliance_resident_id_fkey FOREIGN KEY (resident_id) REFERENCES __TENANT__.residents(id) ON DELETE CASCADE;


--

-- Name: erasure_log erasure_log_performed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.erasure_log
    ADD CONSTRAINT erasure_log_performed_by_fkey FOREIGN KEY (performed_by) REFERENCES __TENANT__.profiles(id) ON DELETE SET NULL;


--

-- Name: gate_events gate_events_guard_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.gate_events
    ADD CONSTRAINT gate_events_guard_id_fkey FOREIGN KEY (guard_id) REFERENCES __TENANT__.profiles(id) ON DELETE RESTRICT;


--

-- Name: gate_events gate_events_resident_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.gate_events
    ADD CONSTRAINT gate_events_resident_id_fkey FOREIGN KEY (resident_id) REFERENCES __TENANT__.residents(id) ON DELETE CASCADE;


--

-- Name: overnight_absences overnight_absences_resident_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.overnight_absences
    ADD CONSTRAINT overnight_absences_resident_id_fkey FOREIGN KEY (resident_id) REFERENCES __TENANT__.residents(id) ON DELETE CASCADE;


--

-- Name: profiles profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.profiles
    ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;


--

-- Name: resident_views resident_views_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.resident_views
    ADD CONSTRAINT resident_views_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES __TENANT__.profiles(id) ON DELETE SET NULL;


--

-- Name: resident_views resident_views_resident_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.resident_views
    ADD CONSTRAINT resident_views_resident_id_fkey FOREIGN KEY (resident_id) REFERENCES __TENANT__.residents(id) ON DELETE CASCADE;


--

-- Name: residents residents_household_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.residents
    ADD CONSTRAINT residents_household_id_fkey FOREIGN KEY (household_id) REFERENCES __TENANT__.households(id) ON DELETE SET NULL;


--

-- Name: residents residents_registered_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.residents
    ADD CONSTRAINT residents_registered_by_fkey FOREIGN KEY (registered_by) REFERENCES __TENANT__.profiles(id) ON DELETE SET NULL;


--

-- Name: residents residents_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.residents
    ADD CONSTRAINT residents_room_id_fkey FOREIGN KEY (room_id) REFERENCES __TENANT__.rooms(id) ON DELETE SET NULL;


--

-- Name: roll_call_marks roll_call_marks_marked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.roll_call_marks
    ADD CONSTRAINT roll_call_marks_marked_by_fkey FOREIGN KEY (marked_by) REFERENCES __TENANT__.profiles(id) ON DELETE SET NULL;


--

-- Name: roll_call_marks roll_call_marks_resident_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.roll_call_marks
    ADD CONSTRAINT roll_call_marks_resident_id_fkey FOREIGN KEY (resident_id) REFERENCES __TENANT__.residents(id) ON DELETE CASCADE;


--

-- Name: roll_call_marks roll_call_marks_roll_call_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.roll_call_marks
    ADD CONSTRAINT roll_call_marks_roll_call_id_fkey FOREIGN KEY (roll_call_id) REFERENCES __TENANT__.roll_calls(id) ON DELETE CASCADE;


--

-- Name: roll_call_visit_marks roll_call_visit_marks_marked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.roll_call_visit_marks
    ADD CONSTRAINT roll_call_visit_marks_marked_by_fkey FOREIGN KEY (marked_by) REFERENCES __TENANT__.profiles(id) ON DELETE SET NULL;


--

-- Name: roll_call_visit_marks roll_call_visit_marks_roll_call_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.roll_call_visit_marks
    ADD CONSTRAINT roll_call_visit_marks_roll_call_id_fkey FOREIGN KEY (roll_call_id) REFERENCES __TENANT__.roll_calls(id) ON DELETE CASCADE;


--

-- Name: roll_call_visit_marks roll_call_visit_marks_visit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.roll_call_visit_marks
    ADD CONSTRAINT roll_call_visit_marks_visit_id_fkey FOREIGN KEY (visit_id) REFERENCES __TENANT__.visits(id) ON DELETE CASCADE;


--

-- Name: roll_calls roll_calls_ended_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.roll_calls
    ADD CONSTRAINT roll_calls_ended_by_fkey FOREIGN KEY (ended_by) REFERENCES __TENANT__.profiles(id) ON DELETE SET NULL;


--

-- Name: roll_calls roll_calls_started_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.roll_calls
    ADD CONSTRAINT roll_calls_started_by_fkey FOREIGN KEY (started_by) REFERENCES __TENANT__.profiles(id) ON DELETE SET NULL;


--

-- Name: room_assignments room_assignments_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.room_assignments
    ADD CONSTRAINT room_assignments_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES __TENANT__.profiles(id) ON DELETE SET NULL;


--

-- Name: room_assignments room_assignments_resident_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.room_assignments
    ADD CONSTRAINT room_assignments_resident_id_fkey FOREIGN KEY (resident_id) REFERENCES __TENANT__.residents(id) ON DELETE CASCADE;


--

-- Name: room_assignments room_assignments_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.room_assignments
    ADD CONSTRAINT room_assignments_room_id_fkey FOREIGN KEY (room_id) REFERENCES __TENANT__.rooms(id) ON DELETE SET NULL;


--

-- Name: rooms rooms_building_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.rooms
    ADD CONSTRAINT rooms_building_id_fkey FOREIGN KEY (building_id) REFERENCES __TENANT__.buildings(id) ON DELETE CASCADE;


--

-- Name: staff_roster staff_roster_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.staff_roster
    ADD CONSTRAINT staff_roster_created_by_fkey FOREIGN KEY (created_by) REFERENCES __TENANT__.profiles(id) ON DELETE SET NULL;


--

-- Name: visits visits_arrived_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.visits
    ADD CONSTRAINT visits_arrived_by_fkey FOREIGN KEY (arrived_by) REFERENCES __TENANT__.profiles(id) ON DELETE SET NULL;


--

-- Name: visits visits_left_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.visits
    ADD CONSTRAINT visits_left_by_fkey FOREIGN KEY (left_by) REFERENCES __TENANT__.profiles(id) ON DELETE SET NULL;


--

-- Name: visits visits_roster_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.visits
    ADD CONSTRAINT visits_roster_id_fkey FOREIGN KEY (roster_id) REFERENCES __TENANT__.staff_roster(id) ON DELETE SET NULL;


--

-- Name: absence_windows; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE __TENANT__.absence_windows ENABLE ROW LEVEL SECURITY;

--

-- Name: absence_windows absence_windows_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY absence_windows_admin ON __TENANT__.absence_windows USING (__TENANT__.is_admin()) WITH CHECK (__TENANT__.is_admin());


--

-- Name: absence_windows absence_windows_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY absence_windows_read ON __TENANT__.absence_windows FOR SELECT USING (__TENANT__.is_staff());


--

-- Name: admin_audit; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE __TENANT__.admin_audit ENABLE ROW LEVEL SECURITY;

--

-- Name: admin_audit admin_audit_admin_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_audit_admin_read ON __TENANT__.admin_audit FOR SELECT USING (__TENANT__.is_admin());


--

-- Name: app_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE __TENANT__.app_settings ENABLE ROW LEVEL SECURITY;

--

-- Name: app_settings app_settings_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY app_settings_read ON __TENANT__.app_settings FOR SELECT USING (__TENANT__.is_staff());


--

-- Name: app_settings app_settings_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY app_settings_write ON __TENANT__.app_settings FOR UPDATE USING (__TENANT__.is_admin()) WITH CHECK (__TENANT__.is_admin());


--

-- Name: authorised_absences; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE __TENANT__.authorised_absences ENABLE ROW LEVEL SECURITY;

--

-- Name: authorised_absences authorised_absences_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authorised_absences_read ON __TENANT__.authorised_absences FOR SELECT USING (__TENANT__.is_staff());


--

-- Name: breach_reports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE __TENANT__.breach_reports ENABLE ROW LEVEL SECURITY;

--

-- Name: breach_reports breach_reports_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY breach_reports_read ON __TENANT__.breach_reports FOR SELECT USING (__TENANT__.is_staff());


--

-- Name: buildings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE __TENANT__.buildings ENABLE ROW LEVEL SECURITY;

--

-- Name: buildings buildings_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY buildings_read ON __TENANT__.buildings FOR SELECT USING (__TENANT__.is_staff());


--

-- Name: buildings buildings_supervisor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY buildings_supervisor ON __TENANT__.buildings USING (__TENANT__.is_supervisor()) WITH CHECK (__TENANT__.is_supervisor());


--

-- Name: checkin_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE __TENANT__.checkin_events ENABLE ROW LEVEL SECURITY;

--

-- Name: checkin_events checkin_events_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY checkin_events_read ON __TENANT__.checkin_events FOR SELECT USING (__TENANT__.is_staff());


--

-- Name: daily_compliance; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE __TENANT__.daily_compliance ENABLE ROW LEVEL SECURITY;

--

-- Name: daily_compliance daily_compliance_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY daily_compliance_read ON __TENANT__.daily_compliance FOR SELECT USING (__TENANT__.is_staff());


--

-- Name: erasure_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE __TENANT__.erasure_log ENABLE ROW LEVEL SECURITY;

--

-- Name: erasure_log erasure_log_append; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY erasure_log_append ON __TENANT__.erasure_log FOR INSERT WITH CHECK (__TENANT__.is_admin());


--

-- Name: erasure_log erasure_log_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY erasure_log_read ON __TENANT__.erasure_log FOR SELECT USING (__TENANT__.is_admin());


--

-- Name: gate_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE __TENANT__.gate_events ENABLE ROW LEVEL SECURITY;

--

-- Name: gate_events gate_events_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY gate_events_insert ON __TENANT__.gate_events FOR INSERT WITH CHECK ((__TENANT__.is_staff() AND (guard_id = auth.uid())));


--

-- Name: gate_events gate_events_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY gate_events_read ON __TENANT__.gate_events FOR SELECT USING (__TENANT__.is_staff());


--

-- Name: households; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE __TENANT__.households ENABLE ROW LEVEL SECURITY;

--

-- Name: households households_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY households_read ON __TENANT__.households FOR SELECT USING (__TENANT__.is_staff());


--

-- Name: households households_supervisor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY households_supervisor ON __TENANT__.households USING (__TENANT__.is_supervisor()) WITH CHECK (__TENANT__.is_supervisor());


--

-- Name: overnight_absences; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE __TENANT__.overnight_absences ENABLE ROW LEVEL SECURITY;

--

-- Name: overnight_absences overnight_absences_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY overnight_absences_read ON __TENANT__.overnight_absences FOR SELECT USING (__TENANT__.is_staff());


--

-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE __TENANT__.profiles ENABLE ROW LEVEL SECURITY;

--

-- Name: profiles profiles_admin_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_admin_all ON __TENANT__.profiles USING (__TENANT__.is_admin()) WITH CHECK (__TENANT__.is_admin());


--

-- Name: profiles profiles_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_read ON __TENANT__.profiles FOR SELECT USING ((__TENANT__.is_staff() OR (id = auth.uid())));


--

-- Name: resident_views; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE __TENANT__.resident_views ENABLE ROW LEVEL SECURITY;

--

-- Name: resident_views resident_views_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY resident_views_admin ON __TENANT__.resident_views FOR SELECT USING (__TENANT__.is_admin());


--

-- Name: residents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE __TENANT__.residents ENABLE ROW LEVEL SECURITY;

--

-- Name: residents residents_admin_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY residents_admin_delete ON __TENANT__.residents FOR DELETE USING (__TENANT__.is_admin());


--

-- Name: residents residents_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY residents_read ON __TENANT__.residents FOR SELECT USING (__TENANT__.is_supervisor());


--

-- Name: residents residents_supervisor_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY residents_supervisor_insert ON __TENANT__.residents FOR INSERT WITH CHECK (__TENANT__.is_supervisor());


--

-- Name: residents residents_supervisor_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY residents_supervisor_update ON __TENANT__.residents FOR UPDATE USING (__TENANT__.is_supervisor()) WITH CHECK (__TENANT__.is_supervisor());


--

-- Name: roll_call_marks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE __TENANT__.roll_call_marks ENABLE ROW LEVEL SECURITY;

--

-- Name: roll_call_marks roll_call_marks_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY roll_call_marks_read ON __TENANT__.roll_call_marks FOR SELECT USING (__TENANT__.is_staff());


--

-- Name: roll_call_visit_marks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE __TENANT__.roll_call_visit_marks ENABLE ROW LEVEL SECURITY;

--

-- Name: roll_call_visit_marks roll_call_visit_marks_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY roll_call_visit_marks_read ON __TENANT__.roll_call_visit_marks FOR SELECT USING (__TENANT__.is_staff());


--

-- Name: roll_calls; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE __TENANT__.roll_calls ENABLE ROW LEVEL SECURITY;

--

-- Name: roll_calls roll_calls_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY roll_calls_read ON __TENANT__.roll_calls FOR SELECT USING (__TENANT__.is_staff());


--

-- Name: room_assignments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE __TENANT__.room_assignments ENABLE ROW LEVEL SECURITY;

--

-- Name: room_assignments room_assignments_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY room_assignments_read ON __TENANT__.room_assignments FOR SELECT USING (__TENANT__.is_staff());


--

-- Name: rooms; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE __TENANT__.rooms ENABLE ROW LEVEL SECURITY;

--

-- Name: rooms rooms_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rooms_read ON __TENANT__.rooms FOR SELECT USING (__TENANT__.is_staff());


--

-- Name: rooms rooms_supervisor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rooms_supervisor ON __TENANT__.rooms USING (__TENANT__.is_supervisor()) WITH CHECK (__TENANT__.is_supervisor());


--

-- Name: staff_roster; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE __TENANT__.staff_roster ENABLE ROW LEVEL SECURITY;

--

-- Name: staff_roster staff_roster_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY staff_roster_read ON __TENANT__.staff_roster FOR SELECT USING (__TENANT__.is_staff());


--

-- Name: staff_roster staff_roster_supervisor_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY staff_roster_supervisor_insert ON __TENANT__.staff_roster FOR INSERT WITH CHECK (__TENANT__.is_supervisor());


--

-- Name: staff_roster staff_roster_supervisor_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY staff_roster_supervisor_update ON __TENANT__.staff_roster FOR UPDATE USING (__TENANT__.is_supervisor()) WITH CHECK (__TENANT__.is_supervisor());


--

-- Name: visits; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE __TENANT__.visits ENABLE ROW LEVEL SECURITY;

--

-- Name: visits visits_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY visits_read ON __TENANT__.visits FOR SELECT USING (__TENANT__.is_staff());


--

-- Name: FUNCTION absence_authorised(p_resident_id uuid, p_day date); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.absence_authorised(p_resident_id uuid, p_day date) FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.absence_authorised(p_resident_id uuid, p_day date) TO authenticated;
GRANT ALL ON FUNCTION __TENANT__.absence_authorised(p_resident_id uuid, p_day date) TO service_role;


--

-- Name: FUNCTION admin_create_staff(p_email text, p_password text, p_full_name text, p_role text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.admin_create_staff(p_email text, p_password text, p_full_name text, p_role text) FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.admin_create_staff(p_email text, p_password text, p_full_name text, p_role text) TO anon;
GRANT ALL ON FUNCTION __TENANT__.admin_create_staff(p_email text, p_password text, p_full_name text, p_role text) TO authenticated;
GRANT ALL ON FUNCTION __TENANT__.admin_create_staff(p_email text, p_password text, p_full_name text, p_role text) TO service_role;


--

-- Name: FUNCTION admin_invite_staff(p_email text, p_full_name text, p_role text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.admin_invite_staff(p_email text, p_full_name text, p_role text) FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.admin_invite_staff(p_email text, p_full_name text, p_role text) TO authenticated;
GRANT ALL ON FUNCTION __TENANT__.admin_invite_staff(p_email text, p_full_name text, p_role text) TO service_role;


--

-- Name: FUNCTION admin_set_staff_password(p_user_id uuid, p_password text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.admin_set_staff_password(p_user_id uuid, p_password text) FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.admin_set_staff_password(p_user_id uuid, p_password text) TO anon;
GRANT ALL ON FUNCTION __TENANT__.admin_set_staff_password(p_user_id uuid, p_password text) TO authenticated;
GRANT ALL ON FUNCTION __TENANT__.admin_set_staff_password(p_user_id uuid, p_password text) TO service_role;


--

-- Name: FUNCTION assert_late_entry_window(p_occurred_at timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.assert_late_entry_window(p_occurred_at timestamp with time zone) FROM PUBLIC;


--

-- Name: FUNCTION compliance_required(p_dob date, p_registered_on date, p_departed_on date, p_day date, p_adult_age integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.compliance_required(p_dob date, p_registered_on date, p_departed_on date, p_day date, p_adult_age integer) FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.compliance_required(p_dob date, p_registered_on date, p_departed_on date, p_day date, p_adult_age integer) TO authenticated;
GRANT ALL ON FUNCTION __TENANT__.compliance_required(p_dob date, p_registered_on date, p_departed_on date, p_day date, p_adult_age integer) TO service_role;


--

-- Name: FUNCTION is_staff(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION __TENANT__.is_staff() TO anon;
GRANT ALL ON FUNCTION __TENANT__.is_staff() TO authenticated;
GRANT ALL ON FUNCTION __TENANT__.is_staff() TO service_role;


--

-- Name: FUNCTION site_today(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.site_today() FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.site_today() TO authenticated;
GRANT ALL ON FUNCTION __TENANT__.site_today() TO service_role;


--

-- Name: TABLE app_settings; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.app_settings TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.app_settings TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.app_settings TO service_role;


--

-- Name: TABLE daily_compliance; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.daily_compliance TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.daily_compliance TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.daily_compliance TO service_role;


--

-- Name: SEQUENCE resident_ref_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE __TENANT__.resident_ref_seq TO anon;
GRANT ALL ON SEQUENCE __TENANT__.resident_ref_seq TO authenticated;
GRANT ALL ON SEQUENCE __TENANT__.resident_ref_seq TO service_role;


--

-- Name: TABLE residents; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.residents TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.residents TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.residents TO service_role;


--

-- Name: TABLE v_resident_compliance; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.v_resident_compliance TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.v_resident_compliance TO service_role;


--

-- Name: FUNCTION attention_list(max_results integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.attention_list(max_results integer) FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.attention_list(max_results integer) TO authenticated;
GRANT ALL ON FUNCTION __TENANT__.attention_list(max_results integer) TO service_role;


--

-- Name: FUNCTION audit_row(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.audit_row() FROM PUBLIC;


--

-- Name: TABLE authorised_absences; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.authorised_absences TO service_role;
GRANT SELECT ON TABLE __TENANT__.authorised_absences TO authenticated;


--

-- Name: FUNCTION authorise_absence(p_resident_id uuid, p_from date, p_to date, p_reason text, p_guardian_agreed boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.authorise_absence(p_resident_id uuid, p_from date, p_to date, p_reason text, p_guardian_agreed boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.authorise_absence(p_resident_id uuid, p_from date, p_to date, p_reason text, p_guardian_agreed boolean) TO authenticated;
GRANT ALL ON FUNCTION __TENANT__.authorise_absence(p_resident_id uuid, p_from date, p_to date, p_reason text, p_guardian_agreed boolean) TO service_role;


--

-- Name: FUNCTION close_out_compliance_days(p_through date); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.close_out_compliance_days(p_through date) FROM PUBLIC;


--

-- Name: FUNCTION close_out_due_through(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.close_out_due_through() FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.close_out_due_through() TO authenticated;
GRANT ALL ON FUNCTION __TENANT__.close_out_due_through() TO service_role;


--

-- Name: FUNCTION end_absence(p_id bigint, p_last_day date); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.end_absence(p_id bigint, p_last_day date) FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.end_absence(p_id bigint, p_last_day date) TO authenticated;
GRANT ALL ON FUNCTION __TENANT__.end_absence(p_id bigint, p_last_day date) TO service_role;


--

-- Name: TABLE roll_calls; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.roll_calls TO service_role;
GRANT SELECT ON TABLE __TENANT__.roll_calls TO authenticated;


--

-- Name: FUNCTION end_roll_call(p_id uuid, p_at timestamp with time zone, p_note text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.end_roll_call(p_id uuid, p_at timestamp with time zone, p_note text) FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.end_roll_call(p_id uuid, p_at timestamp with time zone, p_note text) TO authenticated;
GRANT ALL ON FUNCTION __TENANT__.end_roll_call(p_id uuid, p_at timestamp with time zone, p_note text) TO service_role;


--

-- Name: FUNCTION end_sessions_on_deactivate(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.end_sessions_on_deactivate() FROM PUBLIC;


--

-- Name: FUNCTION erase_audit_rows(p_resident_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.erase_audit_rows(p_resident_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.erase_audit_rows(p_resident_id uuid) TO authenticated;
GRANT ALL ON FUNCTION __TENANT__.erase_audit_rows(p_resident_id uuid) TO service_role;


--

-- Name: FUNCTION erase_resident(p_resident_id uuid, p_reason text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.erase_resident(p_resident_id uuid, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.erase_resident(p_resident_id uuid, p_reason text) TO authenticated;
GRANT ALL ON FUNCTION __TENANT__.erase_resident(p_resident_id uuid, p_reason text) TO service_role;


--

-- Name: FUNCTION export_resident_record(p_resident_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.export_resident_record(p_resident_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.export_resident_record(p_resident_id uuid) TO authenticated;
GRANT ALL ON FUNCTION __TENANT__.export_resident_record(p_resident_id uuid) TO service_role;


--

-- Name: FUNCTION hut_summary(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.hut_summary() FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.hut_summary() TO authenticated;
GRANT ALL ON FUNCTION __TENANT__.hut_summary() TO service_role;


--

-- Name: FUNCTION inside_absence_window(p_from date, p_to date); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.inside_absence_window(p_from date, p_to date) FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.inside_absence_window(p_from date, p_to date) TO authenticated;
GRANT ALL ON FUNCTION __TENANT__.inside_absence_window(p_from date, p_to date) TO service_role;


--

-- Name: FUNCTION is_admin(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION __TENANT__.is_admin() TO anon;
GRANT ALL ON FUNCTION __TENANT__.is_admin() TO authenticated;
GRANT ALL ON FUNCTION __TENANT__.is_admin() TO service_role;


--

-- Name: FUNCTION is_supervisor(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION __TENANT__.is_supervisor() TO anon;
GRANT ALL ON FUNCTION __TENANT__.is_supervisor() TO authenticated;
GRANT ALL ON FUNCTION __TENANT__.is_supervisor() TO service_role;


--

-- Name: TABLE breach_reports; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.breach_reports TO service_role;
GRANT SELECT ON TABLE __TENANT__.breach_reports TO authenticated;


--

-- Name: FUNCTION issue_breach(p_resident_id uuid, p_kind text, p_issued_on date, p_reference text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.issue_breach(p_resident_id uuid, p_kind text, p_issued_on date, p_reference text) FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.issue_breach(p_resident_id uuid, p_kind text, p_issued_on date, p_reference text) TO authenticated;
GRANT ALL ON FUNCTION __TENANT__.issue_breach(p_resident_id uuid, p_kind text, p_issued_on date, p_reference text) TO service_role;


--

-- Name: FUNCTION join_household(p_resident_id uuid, p_with_resident_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.join_household(p_resident_id uuid, p_with_resident_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.join_household(p_resident_id uuid, p_with_resident_id uuid) TO authenticated;
GRANT ALL ON FUNCTION __TENANT__.join_household(p_resident_id uuid, p_with_resident_id uuid) TO service_role;


--

-- Name: TABLE roll_call_marks; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.roll_call_marks TO service_role;
GRANT SELECT ON TABLE __TENANT__.roll_call_marks TO authenticated;


--

-- Name: FUNCTION mark_roll_call(p_roll_call_id uuid, p_resident_id uuid, p_client_ref uuid, p_at timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.mark_roll_call(p_roll_call_id uuid, p_resident_id uuid, p_client_ref uuid, p_at timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.mark_roll_call(p_roll_call_id uuid, p_resident_id uuid, p_client_ref uuid, p_at timestamp with time zone) TO authenticated;
GRANT ALL ON FUNCTION __TENANT__.mark_roll_call(p_roll_call_id uuid, p_resident_id uuid, p_client_ref uuid, p_at timestamp with time zone) TO service_role;


--

-- Name: TABLE roll_call_visit_marks; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.roll_call_visit_marks TO service_role;
GRANT SELECT ON TABLE __TENANT__.roll_call_visit_marks TO authenticated;


--

-- Name: FUNCTION mark_roll_call_visit(p_roll_call_id uuid, p_visit_id uuid, p_client_ref uuid, p_at timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.mark_roll_call_visit(p_roll_call_id uuid, p_visit_id uuid, p_client_ref uuid, p_at timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.mark_roll_call_visit(p_roll_call_id uuid, p_visit_id uuid, p_client_ref uuid, p_at timestamp with time zone) TO authenticated;
GRANT ALL ON FUNCTION __TENANT__.mark_roll_call_visit(p_roll_call_id uuid, p_visit_id uuid, p_client_ref uuid, p_at timestamp with time zone) TO service_role;


--

-- Name: FUNCTION my_role(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION __TENANT__.my_role() TO anon;
GRANT ALL ON FUNCTION __TENANT__.my_role() TO authenticated;
GRANT ALL ON FUNCTION __TENANT__.my_role() TO service_role;


--

-- Name: FUNCTION note_disclosure(p_resident_id uuid, p_reason text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.note_disclosure(p_resident_id uuid, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.note_disclosure(p_resident_id uuid, p_reason text) TO authenticated;
GRANT ALL ON FUNCTION __TENANT__.note_disclosure(p_resident_id uuid, p_reason text) TO service_role;


--

-- Name: FUNCTION note_report(p_report text, p_reason text, p_from date, p_to date); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.note_report(p_report text, p_reason text, p_from date, p_to date) FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.note_report(p_report text, p_reason text, p_from date, p_to date) TO authenticated;
GRANT ALL ON FUNCTION __TENANT__.note_report(p_report text, p_reason text, p_from date, p_to date) TO service_role;


--

-- Name: FUNCTION note_view(p_resident_id uuid, p_surface text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.note_view(p_resident_id uuid, p_surface text) FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.note_view(p_resident_id uuid, p_surface text) TO authenticated;
GRANT ALL ON FUNCTION __TENANT__.note_view(p_resident_id uuid, p_surface text) TO service_role;


--

-- Name: FUNCTION overnight_safeguarding_count(p_night date); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.overnight_safeguarding_count(p_night date) FROM PUBLIC;


--

-- Name: FUNCTION profiles_clear_safeguarding_alert_for_guard(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.profiles_clear_safeguarding_alert_for_guard() FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.profiles_clear_safeguarding_alert_for_guard() TO service_role;


--

-- Name: FUNCTION profiles_clear_weekly_report_for_guard(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.profiles_clear_weekly_report_for_guard() FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.profiles_clear_weekly_report_for_guard() TO service_role;


--

-- Name: FUNCTION prune_empty_households(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION __TENANT__.prune_empty_households() TO anon;
GRANT ALL ON FUNCTION __TENANT__.prune_empty_households() TO authenticated;
GRANT ALL ON FUNCTION __TENANT__.prune_empty_households() TO service_role;


--

-- Name: FUNCTION purge_expired_audit(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.purge_expired_audit() FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.purge_expired_audit() TO service_role;


--

-- Name: FUNCTION purge_expired_authorised_absences(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.purge_expired_authorised_absences() FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.purge_expired_authorised_absences() TO service_role;


--

-- Name: FUNCTION purge_expired_breach_reports(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.purge_expired_breach_reports() FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.purge_expired_breach_reports() TO service_role;


--

-- Name: FUNCTION purge_expired_checkin_events(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.purge_expired_checkin_events() FROM PUBLIC;


--

-- Name: FUNCTION purge_expired_compliance(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.purge_expired_compliance() FROM PUBLIC;


--

-- Name: FUNCTION purge_expired_gate_events(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.purge_expired_gate_events() FROM PUBLIC;


--

-- Name: FUNCTION purge_expired_job_runs(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.purge_expired_job_runs() FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.purge_expired_job_runs() TO service_role;


--

-- Name: FUNCTION purge_expired_overnight_absences(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.purge_expired_overnight_absences() FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.purge_expired_overnight_absences() TO service_role;


--

-- Name: FUNCTION purge_expired_roll_calls(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.purge_expired_roll_calls() FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.purge_expired_roll_calls() TO service_role;


--

-- Name: FUNCTION purge_expired_visits(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.purge_expired_visits() FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.purge_expired_visits() TO service_role;


--

-- Name: FUNCTION purge_resident_views(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.purge_resident_views() FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.purge_resident_views() TO service_role;


--

-- Name: TABLE gate_events; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.gate_events TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.gate_events TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.gate_events TO service_role;


--

-- Name: TABLE v_resident_status; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.v_resident_status TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.v_resident_status TO service_role;


--

-- Name: FUNCTION record_check(p_resident_id uuid, p_direction text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.record_check(p_resident_id uuid, p_direction text) FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.record_check(p_resident_id uuid, p_direction text) TO authenticated;
GRANT ALL ON FUNCTION __TENANT__.record_check(p_resident_id uuid, p_direction text) TO service_role;


--

-- Name: FUNCTION record_check_late(p_resident_id uuid, p_direction text, p_occurred_at timestamp with time zone, p_client_ref uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.record_check_late(p_resident_id uuid, p_direction text, p_occurred_at timestamp with time zone, p_client_ref uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.record_check_late(p_resident_id uuid, p_direction text, p_occurred_at timestamp with time zone, p_client_ref uuid) TO authenticated;
GRANT ALL ON FUNCTION __TENANT__.record_check_late(p_resident_id uuid, p_direction text, p_occurred_at timestamp with time zone, p_client_ref uuid) TO service_role;


--

-- Name: FUNCTION record_checkin(p_resident_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.record_checkin(p_resident_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.record_checkin(p_resident_id uuid) TO authenticated;
GRANT ALL ON FUNCTION __TENANT__.record_checkin(p_resident_id uuid) TO service_role;


--

-- Name: FUNCTION record_checkin_at(p_resident_id uuid, p_at timestamp with time zone, p_late boolean, p_client_ref uuid, p_source text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.record_checkin_at(p_resident_id uuid, p_at timestamp with time zone, p_late boolean, p_client_ref uuid, p_source text) FROM PUBLIC;


--

-- Name: FUNCTION record_checkin_late(p_resident_id uuid, p_occurred_at timestamp with time zone, p_client_ref uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.record_checkin_late(p_resident_id uuid, p_occurred_at timestamp with time zone, p_client_ref uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.record_checkin_late(p_resident_id uuid, p_occurred_at timestamp with time zone, p_client_ref uuid) TO authenticated;
GRANT ALL ON FUNCTION __TENANT__.record_checkin_late(p_resident_id uuid, p_occurred_at timestamp with time zone, p_client_ref uuid) TO service_role;


--

-- Name: TABLE visits; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.visits TO service_role;
GRANT SELECT ON TABLE __TENANT__.visits TO authenticated;


--

-- Name: FUNCTION record_staff_arrival(p_roster_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.record_staff_arrival(p_roster_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.record_staff_arrival(p_roster_id uuid) TO authenticated;
GRANT ALL ON FUNCTION __TENANT__.record_staff_arrival(p_roster_id uuid) TO service_role;


--

-- Name: FUNCTION record_visit_arrival(p_kind text, p_name text, p_company text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.record_visit_arrival(p_kind text, p_name text, p_company text) FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.record_visit_arrival(p_kind text, p_name text, p_company text) TO authenticated;
GRANT ALL ON FUNCTION __TENANT__.record_visit_arrival(p_kind text, p_name text, p_company text) TO service_role;


--

-- Name: FUNCTION record_visit_departure(p_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.record_visit_departure(p_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.record_visit_departure(p_id uuid) TO authenticated;
GRANT ALL ON FUNCTION __TENANT__.record_visit_departure(p_id uuid) TO service_role;


--

-- Name: FUNCTION refuse_archived_room(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.refuse_archived_room() FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.refuse_archived_room() TO service_role;


--

-- Name: FUNCTION resident_views_between(p_from date, p_to date); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.resident_views_between(p_from date, p_to date) FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.resident_views_between(p_from date, p_to date) TO authenticated;
GRANT ALL ON FUNCTION __TENANT__.resident_views_between(p_from date, p_to date) TO service_role;


--

-- Name: FUNCTION room_label_of(p_room_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.room_label_of(p_room_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.room_label_of(p_room_id uuid) TO service_role;


--

-- Name: FUNCTION search_residents(q text, include_departed boolean, max_results integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.search_residents(q text, include_departed boolean, max_results integer) FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.search_residents(q text, include_departed boolean, max_results integer) TO authenticated;
GRANT ALL ON FUNCTION __TENANT__.search_residents(q text, include_departed boolean, max_results integer) TO service_role;


--

-- Name: FUNCTION snapshot_overnight_absences(p_night date); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.snapshot_overnight_absences(p_night date) FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.snapshot_overnight_absences(p_night date) TO service_role;


--

-- Name: FUNCTION start_roll_call(p_id uuid, p_kind text, p_started_at timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.start_roll_call(p_id uuid, p_kind text, p_started_at timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.start_roll_call(p_id uuid, p_kind text, p_started_at timestamp with time zone) TO authenticated;
GRANT ALL ON FUNCTION __TENANT__.start_roll_call(p_id uuid, p_kind text, p_started_at timestamp with time zone) TO service_role;


--

-- Name: FUNCTION track_room_assignment(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.track_room_assignment() FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.track_room_assignment() TO service_role;


--

-- Name: FUNCTION weekly_absence_spans(p_from date, p_to date); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.weekly_absence_spans(p_from date, p_to date) FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.weekly_absence_spans(p_from date, p_to date) TO service_role;


--

-- Name: FUNCTION weekly_register_rows(p_from date, p_to date); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.weekly_register_rows(p_from date, p_to date) FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.weekly_register_rows(p_from date, p_to date) TO authenticated;
GRANT ALL ON FUNCTION __TENANT__.weekly_register_rows(p_from date, p_to date) TO service_role;


--

-- Name: FUNCTION weekly_register_rows_unchecked(p_from date, p_to date); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION __TENANT__.weekly_register_rows_unchecked(p_from date, p_to date) FROM PUBLIC;
GRANT ALL ON FUNCTION __TENANT__.weekly_register_rows_unchecked(p_from date, p_to date) TO service_role;


--

-- Name: TABLE absence_windows; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.absence_windows TO service_role;
GRANT SELECT,INSERT,DELETE ON TABLE __TENANT__.absence_windows TO authenticated;


--

-- Name: SEQUENCE absence_windows_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE __TENANT__.absence_windows_id_seq TO anon;
GRANT ALL ON SEQUENCE __TENANT__.absence_windows_id_seq TO authenticated;
GRANT ALL ON SEQUENCE __TENANT__.absence_windows_id_seq TO service_role;


--

-- Name: TABLE admin_audit; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE __TENANT__.admin_audit TO authenticated;
GRANT SELECT ON TABLE __TENANT__.admin_audit TO service_role;


--

-- Name: SEQUENCE admin_audit_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE __TENANT__.admin_audit_id_seq TO anon;
GRANT ALL ON SEQUENCE __TENANT__.admin_audit_id_seq TO authenticated;
GRANT ALL ON SEQUENCE __TENANT__.admin_audit_id_seq TO service_role;


--

-- Name: SEQUENCE authorised_absences_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE __TENANT__.authorised_absences_id_seq TO anon;
GRANT ALL ON SEQUENCE __TENANT__.authorised_absences_id_seq TO authenticated;
GRANT ALL ON SEQUENCE __TENANT__.authorised_absences_id_seq TO service_role;


--

-- Name: SEQUENCE breach_reports_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE __TENANT__.breach_reports_id_seq TO anon;
GRANT ALL ON SEQUENCE __TENANT__.breach_reports_id_seq TO authenticated;
GRANT ALL ON SEQUENCE __TENANT__.breach_reports_id_seq TO service_role;


--

-- Name: TABLE buildings; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.buildings TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.buildings TO service_role;


--

-- Name: TABLE checkin_events; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.checkin_events TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.checkin_events TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.checkin_events TO service_role;


--

-- Name: SEQUENCE checkin_events_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE __TENANT__.checkin_events_id_seq TO anon;
GRANT ALL ON SEQUENCE __TENANT__.checkin_events_id_seq TO authenticated;
GRANT ALL ON SEQUENCE __TENANT__.checkin_events_id_seq TO service_role;


--

-- Name: TABLE erasure_log; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.erasure_log TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.erasure_log TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.erasure_log TO service_role;


--

-- Name: SEQUENCE erasure_log_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE __TENANT__.erasure_log_id_seq TO anon;
GRANT ALL ON SEQUENCE __TENANT__.erasure_log_id_seq TO authenticated;
GRANT ALL ON SEQUENCE __TENANT__.erasure_log_id_seq TO service_role;


--

-- Name: SEQUENCE gate_events_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE __TENANT__.gate_events_id_seq TO anon;
GRANT ALL ON SEQUENCE __TENANT__.gate_events_id_seq TO authenticated;
GRANT ALL ON SEQUENCE __TENANT__.gate_events_id_seq TO service_role;


--

-- Name: TABLE households; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.households TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.households TO service_role;


--

-- Name: SEQUENCE job_runs_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE __TENANT__.job_runs_id_seq TO anon;
GRANT ALL ON SEQUENCE __TENANT__.job_runs_id_seq TO authenticated;
GRANT ALL ON SEQUENCE __TENANT__.job_runs_id_seq TO service_role;


--

-- Name: TABLE overnight_absences; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.overnight_absences TO service_role;
GRANT SELECT ON TABLE __TENANT__.overnight_absences TO authenticated;


--

-- Name: TABLE profiles; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.profiles TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.profiles TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.profiles TO service_role;


--

-- Name: TABLE resident_views; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE __TENANT__.resident_views TO authenticated;


--

-- Name: SEQUENCE resident_views_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE __TENANT__.resident_views_id_seq TO anon;
GRANT ALL ON SEQUENCE __TENANT__.resident_views_id_seq TO authenticated;
GRANT ALL ON SEQUENCE __TENANT__.resident_views_id_seq TO service_role;


--

-- Name: TABLE room_assignments; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.room_assignments TO service_role;
GRANT SELECT ON TABLE __TENANT__.room_assignments TO authenticated;


--

-- Name: SEQUENCE room_assignments_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE __TENANT__.room_assignments_id_seq TO anon;
GRANT ALL ON SEQUENCE __TENANT__.room_assignments_id_seq TO authenticated;
GRANT ALL ON SEQUENCE __TENANT__.room_assignments_id_seq TO service_role;


--

-- Name: TABLE rooms; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.rooms TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.rooms TO service_role;


--

-- Name: TABLE staff_roster; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE __TENANT__.staff_roster TO authenticated;


--

-- Name: TABLE v_check_log; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.v_check_log TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.v_check_log TO service_role;


--

-- Name: TABLE v_resident_room; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.v_resident_room TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.v_resident_room TO service_role;


--

-- Name: TABLE v_evacuation_list; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.v_evacuation_list TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.v_evacuation_list TO service_role;


--

-- Name: TABLE v_room_occupancy; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.v_room_occupancy TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.v_room_occupancy TO service_role;


--

-- Name: TABLE v_system_health; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.v_system_health TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE __TENANT__.v_system_health TO service_role;


--
