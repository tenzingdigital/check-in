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

-- pg_dump sets this in its own preamble and it is not optional here either.
-- SQL-language functions are parsed at CREATE time, and pg_dump orders
-- functions alphabetically: is_staff() is created before my_role(), which it
-- calls. Without this, provisioning fails on the second function every time.
-- SET LOCAL, not SET: this runs on a pooled connection and must not outlive
-- the transaction that provisions the schema.
set local check_function_bodies = false;

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
    CONSTRAINT app_settings_absence_window_days_check CHECK (((absence_window_days >= 7) AND (absence_window_days <= 365))),
    CONSTRAINT app_settings_absence_window_limit_check CHECK (((absence_window_limit >= 1) AND (absence_window_limit <= 365))),
    CONSTRAINT app_settings_adult_age_years_check CHECK (((adult_age_years >= 1) AND (adult_age_years <= 30))),
    CONSTRAINT app_settings_compliance_retention_days_check CHECK (((compliance_retention_days >= 1) AND (compliance_retention_days <= 36500))),
    CONSTRAINT app_settings_due_soon_after_hour_check CHECK (((due_soon_after_hour >= 0) AND (due_soon_after_hour <= 23))),
    CONSTRAINT app_settings_event_retention_days_check CHECK (((event_retention_days >= 1) AND (event_retention_days <= 3650))),
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
    CONSTRAINT departed_on_matches_status CHECK (((status = 'departed'::text) = (departed_on IS NOT NULL))),
    CONSTRAINT residents_date_of_birth_check CHECK (((date_of_birth > '1900-01-01'::date) AND (date_of_birth <= CURRENT_DATE))),
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
        r.departed_on, v_day, v_adult),
      false, null, 0, now()
    from __TENANT__.residents r
    where (r.registered_at at time zone v_tz)::date <= v_day
      and (r.departed_on is null or r.departed_on >= v_day)
    on conflict (resident_id, compliance_date) do nothing;

    get diagnostics v_batch = row_count;
    v_written := v_written + v_batch;

    -- Rows written during the day by record_checkin are still open. Close them
    -- without touching presented, first_seen_at or checkin_count.
    update __TENANT__.daily_compliance
       set closed_at = now()
     where compliance_date = v_day and closed_at is null;
  end loop;

  return v_written;
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

  select count(*)::integer into v_events
  from __TENANT__.gate_events where resident_id = p_resident_id;

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

-- Name: record_checkin_at(uuid, timestamp with time zone, boolean, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION __TENANT__.record_checkin_at(p_resident_id uuid, p_at timestamp with time zone, p_late boolean, p_client_ref uuid) RETURNS __TENANT__.daily_compliance
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
    insert into __TENANT__.checkin_events (resident_id, guard_id, occurred_at, recorded_at, late_entry, client_ref)
    values (p_resident_id, auth.uid(), p_at, now(), p_late, p_client_ref);

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
        v_res.departed_on, v_day, v_adult),
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
    case when v.search_key like n.nq || '%'         then 0
         when v.search_key like '%' || n.nq || '%'  then 1
         else 2 end,
    word_similarity(n.nq, v.search_key) desc,
    v.last_name, v.first_name
  limit greatest(1, least(coalesce(max_results, 20), 1000));
$$;


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

-- Name: checkin_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE __TENANT__.checkin_events (
    id bigint NOT NULL,
    resident_id uuid NOT NULL,
    guard_id uuid NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    late_entry boolean DEFAULT false NOT NULL,
    client_ref uuid
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

-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE __TENANT__.profiles (
    id uuid NOT NULL,
    full_name text NOT NULL,
    role text DEFAULT 'guard'::text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT profiles_role_check CHECK ((role = ANY (ARRAY['guard'::text, 'supervisor'::text, 'admin'::text])))
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
          WHERE (daily_compliance.closed_at IS NOT NULL)) < (__TENANT__.site_today() - 1)), (EXISTS ( SELECT 1
           FROM __TENANT__.daily_compliance
          WHERE (daily_compliance.compliance_date < (__TENANT__.site_today() - 1))))) AS close_out_behind
  WHERE __TENANT__.is_staff();


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

-- Name: job_runs job_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.job_runs
    ADD CONSTRAINT job_runs_pkey PRIMARY KEY (id);


--

-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--

-- Name: residents residents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.residents
    ADD CONSTRAINT residents_pkey PRIMARY KEY (id);


--

-- Name: admin_audit_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_audit_at_idx ON __TENANT__.admin_audit USING btree (at);


--

-- Name: admin_audit_row_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_audit_row_idx ON __TENANT__.admin_audit USING btree (table_name, row_id);


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

-- Name: residents_search_key_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX residents_search_key_trgm_idx ON __TENANT__.residents USING gin (search_key extensions.gin_trgm_ops);


--

-- Name: residents_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX residents_status_idx ON __TENANT__.residents USING btree (status);


--

-- Name: app_settings app_settings_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER app_settings_audit AFTER UPDATE ON __TENANT__.app_settings FOR EACH ROW EXECUTE FUNCTION __TENANT__.audit_row();


--

-- Name: profiles profiles_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER profiles_audit AFTER INSERT OR DELETE OR UPDATE ON __TENANT__.profiles FOR EACH ROW EXECUTE FUNCTION __TENANT__.audit_row();


--

-- Name: residents residents_audit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER residents_audit AFTER INSERT OR DELETE OR UPDATE ON __TENANT__.residents FOR EACH ROW EXECUTE FUNCTION __TENANT__.audit_row();


--

-- Name: residents residents_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER residents_touch_updated_at BEFORE UPDATE ON __TENANT__.residents FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--

-- Name: admin_audit admin_audit_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.admin_audit
    ADD CONSTRAINT admin_audit_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES __TENANT__.profiles(id) ON DELETE SET NULL;


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

-- Name: profiles profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.profiles
    ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;


--

-- Name: residents residents_registered_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY __TENANT__.residents
    ADD CONSTRAINT residents_registered_by_fkey FOREIGN KEY (registered_by) REFERENCES __TENANT__.profiles(id) ON DELETE SET NULL;


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

-- Name: erasure_log erasure_log_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY erasure_log_admin ON __TENANT__.erasure_log USING (__TENANT__.is_admin()) WITH CHECK (__TENANT__.is_admin());


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

-- Name: residents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE __TENANT__.residents ENABLE ROW LEVEL SECURITY;

--

-- Name: residents residents_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY residents_read ON __TENANT__.residents FOR SELECT USING (__TENANT__.is_supervisor());


--

-- Name: residents residents_supervisor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY residents_supervisor ON __TENANT__.residents USING (__TENANT__.is_supervisor()) WITH CHECK (__TENANT__.is_supervisor());


--
-- PostgreSQL database dump complete
--
