-- ---------------------------------------------------------------------------
-- 006_drop_rooms_and_notes.sql — stop tracking rooms and free-text notes.
-- ---------------------------------------------------------------------------
--
-- Rooms change too often to be trusted as identity, so the register stops
-- recording them: residents are found by name alone. The free-text note
-- columns go with them — the operational note on residents, the unused note
-- on gate and check-in events, and the missed-day annotation subsystem
-- (compliance_annotations, annotate_compliance_day, the noted_breaches count
-- and the breach_noted state). A missed day is now simply an open breach
-- until the retention purge takes it; nothing about the outcome changes,
-- only the ability to attach prose to it.
--
-- Order matters. The functions returning setof view types go first, then the
-- views, then the columns (search_key is generated from room_ref, so it is
-- rebuilt without it), then everything is recreated. Every recreated-after-
-- drop function needs its grants restated: 001's default privileges hand
-- execute to anon, which 002 revoked per function, and a dropped function
-- loses that revoke.

-- Same session search_path as 002: unqualified gin_trgm_ops and
-- immutable_unaccent resolve whether the extensions ended up in `extensions`
-- or in `public`.
set search_path = public, extensions;

-- 1. Functions that name the dropped columns or return setof a view type.
--    Both the old signatures and the ones this file creates are listed, so a
--    re-run (a half-recorded tracking table after a restored backup) finds
--    the function under either shape and the view drops below stay possible.
drop function if exists public.search_residents(text, boolean, integer);
drop function if exists public.record_check(uuid, text, text);
drop function if exists public.record_check(uuid, text);
drop function if exists public.record_checkin(uuid, text);
drop function if exists public.record_checkin(uuid);
drop function if exists public.attention_list(integer);
drop function if exists public.annotate_compliance_day(uuid, date, text);

-- 2. Views that project the dropped columns.
drop view if exists public.v_resident_status;
drop view if exists public.v_check_log;
drop view if exists public.v_resident_compliance;

-- 3. The annotation subsystem (its RLS policy drops with the table).
drop table if exists public.compliance_annotations;

-- 4. Columns. search_key is generated from room_ref and must be rebuilt.
alter table public.residents      drop column if exists search_key;
alter table public.residents      drop column if exists room_ref;
alter table public.residents      drop column if exists note;
alter table public.gate_events    drop column if exists note;
alter table public.checkin_events drop column if exists note;

-- Same normalisation as before, minus the room: lower-cased, unaccented, the
-- name in both orders so "smith john" and "john smith" both hit.
alter table public.residents add column if not exists search_key text generated always as (
  lower(public.immutable_unaccent(
    btrim(first_name) || ' ' || btrim(last_name) || ' ' ||
    btrim(last_name)  || ' ' || btrim(first_name)
  ))
) stored;

create index if not exists residents_search_key_trgm_idx
  on public.residents using gin (search_key gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- 5. Views, recreated without rooms, notes or annotations.
-- ---------------------------------------------------------------------------

create or replace view public.v_resident_status as
with s as (
  select * from public.app_settings where id
),
last_event as (
  select distinct on (resident_id)
    resident_id, kind, occurred_at, guard_id
  from public.gate_events
  order by resident_id, occurred_at desc, id desc
)
select
  r.id,
  r.first_name,
  r.last_name,
  btrim(r.first_name) || ' ' || btrim(r.last_name) as full_name,
  r.status,
  r.search_key,
  -- Age only. The date of birth itself never leaves the residents table.
  (date_part('year', age(r.date_of_birth)))::integer as age_years,
  (r.date_of_birth <= current_date - make_interval(years => s.adult_age_years)) as is_adult,
  -- Current presence. Someone with no history at all is treated as "out".
  coalesce(le.kind, 'out') as presence,
  le.occurred_at as last_event_at,
  le.guard_id    as last_event_guard_id
from public.residents r
cross join s
left join last_event le on le.resident_id = r.id
where public.is_staff();

comment on view public.v_resident_status is
  'Guard-facing projection of residents. Exposes age_years and is_adult but never date_of_birth.';


create or replace view public.v_check_log as
select
  e.id,
  e.resident_id,
  e.kind,
  e.occurred_at,
  btrim(r.first_name) || ' ' || btrim(r.last_name) as resident_name,
  e.guard_id,
  g.full_name as guard_name
from public.gate_events e
join public.residents r on r.id = e.resident_id
join public.profiles  g on g.id = e.guard_id
where public.is_staff();

comment on view public.v_check_log is
  'Human-readable event feed. Filter by occurred_at range for "today''s log".';


create or replace view public.v_resident_compliance as
with s as (select * from public.app_settings where id),
today as (select public.site_today() as d),
tally as (
  select
    dc.resident_id,
    count(*) filter (where dc.required and not dc.presented)::integer as open_breaches,
    max(dc.compliance_date) filter (where dc.presented) as last_seen_on
  from public.daily_compliance dc
  where dc.closed_at is not null
  group by dc.resident_id
),
-- Consecutive required-and-missed days counting back from the last completed
-- day. A day that was never required (under 18, before registration, after
-- departure) must be transparent to the streak: it neither counts towards it
-- nor breaks it — required=false rows are filtered out of the window first;
-- only required rows are ranked, and the running sum of "presented" among
-- just those decides where the streak ends.
streak as (
  select d.resident_id,
         count(*)::integer as consecutive_missed
  from (
    select dc.*,
           sum(case when dc.presented then 1 else 0 end)
             over (partition by dc.resident_id order by dc.compliance_date desc
                   rows between unbounded preceding and current row) as breaks
    from public.daily_compliance dc
    where dc.closed_at is not null and dc.required
  ) d
  where d.breaks = 0
  group by d.resident_id
),
todayrow as (
  select dc.resident_id, dc.presented, dc.checkin_count, dc.required
  from public.daily_compliance dc, today
  where dc.compliance_date = today.d
)
select
  r.id,
  btrim(r.first_name) || ' ' || btrim(r.last_name) as full_name,
  r.status,
  (date_part('year', age(r.date_of_birth)))::integer as age_years,
  public.compliance_required(r.date_of_birth, (r.registered_at at time zone s.local_timezone)::date,
                             r.departed_on, today.d, s.adult_age_years) as required_today,
  coalesce(tr.presented, false) as seen_today,
  coalesce(tr.checkin_count, 0) as checkins_today,
  coalesce(t.open_breaches, 0)  as open_breaches,
  coalesce(st.consecutive_missed, 0) as consecutive_missed,
  t.last_seen_on,
  case
    when r.status <> 'active' then 'not_required'
    when not public.compliance_required(r.date_of_birth, (r.registered_at at time zone s.local_timezone)::date,
                                        r.departed_on, today.d, s.adult_age_years) then 'exempt'
    when coalesce(t.open_breaches, 0) > 0 then 'breach_open'
    when coalesce(tr.presented, false) then 'seen_today'
    when not exists (select 1 from public.daily_compliance x
                      where x.resident_id = r.id and x.presented) then 'never'
    when date_part('hour', now() at time zone s.local_timezone) >= s.due_soon_after_hour then 'due_today'
    else 'expected'
  end as state
from public.residents r
cross join s
cross join today
left join tally    t  on t.resident_id  = r.id
left join streak   st on st.resident_id = r.id
left join todayrow tr on tr.resident_id = r.id
where public.is_staff();

comment on view public.v_resident_compliance is
  'State precedence is deliberate: an open breach outranks seen_today, because '
  'clearing today does not clear a missed Tuesday. The front end shows state '
  'for the badge and seen_today for the tick, separately.';

-- ---------------------------------------------------------------------------
-- 6. Functions, recreated on the new shapes.
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
  -- Normalise the query exactly the way search_key was normalised.
  cross join (select lower(public.immutable_unaccent(btrim(coalesce(q, '')))) as nq) n
  where public.is_staff()
    and (include_departed or v.status = 'active')
    and (
      n.nq = ''
      or v.search_key like '%' || n.nq || '%'
      -- Fuzzy matches are a fallback, not a supplement: they are offered only
      -- when nothing matches literally, so a card the guard expected is never
      -- crowded out by lookalikes at the moment they are about to tap a name.
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
    -- Prefix match beats substring match beats fuzzy match.
    case when v.search_key like n.nq || '%'         then 0
         when v.search_key like '%' || n.nq || '%'  then 1
         else 2 end,
    word_similarity(n.nq, v.search_key) desc,
    v.last_name, v.first_name
  limit greatest(1, least(coalesce(max_results, 20), 1000));
$$;


-- The only write path a guard has. SECURITY DEFINER is required, not
-- incidental: guards deliberately hold no SELECT on public.residents, so an
-- invoker-rights version could not even read the resident's status. Safe to
-- elevate because it is closed — it re-checks is_staff() itself and takes the
-- guard identity from auth.uid(), never from an argument.
create or replace function public.record_check(
  p_resident_id uuid,
  p_direction   text
)
returns setof public.v_resident_status
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_guard  uuid := auth.uid();
  v_status text;
  v_last   public.gate_events;
begin
  if not public.is_staff() then
    raise exception 'Not authorised to record check events'
      using errcode = '42501';
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
  end if;

  return query
    select * from public.v_resident_status where id = p_resident_id;
end;
$$;


-- The only write path a guard has to the register. SECURITY DEFINER for the
-- same reason as record_check; closed for the same reason.
create or replace function public.record_checkin(
  p_resident_id uuid
)
returns public.daily_compliance
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_tz     text;
  v_adult  integer;
  v_now    timestamptz := now();
  v_day    date;
  v_res    public.residents;
  v_last   timestamptz;
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

  v_day := (v_now at time zone v_tz)::date;

  -- Must agree with compliance_required(), which treats p_day <= departed_on
  -- as still required. A departed resident's final day is a day they must
  -- still be able to satisfy here — otherwise it becomes an unclearable
  -- statutory breach, since no role can UPDATE daily_compliance.
  if v_res.status <> 'active'
     and (v_res.departed_on is null or v_day > v_res.departed_on) then
    raise exception 'Resident is not active and cannot check in' using errcode = '23514';
  end if;

  -- Touchscreens double-fire. A repeat inside 60 seconds is one presentation.
  -- Scoped to the site-local day: a check-in at 23:59:30 followed by one at
  -- 00:00:10 is 40 seconds apart but a genuine new-day presentation, not a
  -- double tap, and must not be swallowed together with the previous day's row.
  select max(occurred_at) into v_last
  from public.checkin_events
  where resident_id = p_resident_id
    and (occurred_at at time zone v_tz)::date = v_day;

  if v_last is null or v_last < v_now - interval '60 seconds' then
    insert into public.checkin_events (resident_id, guard_id, occurred_at)
    values (p_resident_id, auth.uid(), v_now);

    insert into public.daily_compliance as dc
      (resident_id, compliance_date, required, presented, first_seen_at, checkin_count)
    values (
      p_resident_id, v_day,
      public.compliance_required(
        v_res.date_of_birth,
        (v_res.registered_at at time zone v_tz)::date,
        v_res.departed_on, v_day, v_adult),
      true, v_now, 1)
    on conflict (resident_id, compliance_date) do update
      set presented     = true,
          first_seen_at = least(dc.first_seen_at, excluded.first_seen_at),
          checkin_count = dc.checkin_count + 1;
  end if;

  select * into v_out from public.daily_compliance
  where resident_id = p_resident_id and compliance_date = v_day;
  if not found then
    -- The insert/on-conflict above is unconditional whenever the dedupe guard
    -- lets the branch run, and once a row exists for (resident_id, v_day) it
    -- is never deleted. Reaching here means that invariant broke — surface it
    -- loudly rather than hand the guard's screen a silent NULL.
    raise exception 'record_checkin: no daily_compliance row for resident % on %; this is a bug',
      p_resident_id, v_day using errcode = 'XX000';
  end if;
  return v_out;
end;
$$;


-- The guard's worklist: who needs attention right now. With annotations gone
-- there are three admissible states — an open breach always outranks a
-- resident never yet seen, who outranks someone merely due today.
--
-- The cap is exempt for breach_open rows: applying LIMIT uniformly would let
-- a big enough 'never' bucket push a breach past max_results and off the
-- list entirely — the one place "flag but never suppress" would otherwise be
-- violated by a plain LIMIT. rn is ranked WITHIN the capped partition
-- (never/due_today) only, so the cap always admits exactly
-- min(max_results, count of never/due_today rows) regardless of how many
-- breach rows precede them.
create or replace function public.attention_list(max_results integer default 200)
returns setof public.v_resident_compliance
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with ranked as (
    select v.*,
           case v.state when 'breach_open' then 0 when 'never' then 1 else 2 end as bucket,
           row_number() over (
             partition by (v.state = 'breach_open')
             order by case v.state when 'breach_open' then 0 when 'never' then 1 else 2 end,
                      v.consecutive_missed desc, v.open_breaches desc, v.full_name
           ) as rn
    from public.v_resident_compliance v
    where public.is_staff()
      and v.status = 'active'
      and v.state in ('breach_open', 'never', 'due_today')
  )
  -- Column order here must match v_resident_compliance's physical SELECT
  -- list order, because a language-sql function returning setof a view type
  -- is matched positionally, not by name.
  select id, full_name, status, age_years, required_today, seen_today,
         checkins_today, open_breaches, consecutive_missed,
         last_seen_on, state
  from ranked
  where state = 'breach_open'                                            -- never truncated
     or rn <= greatest(1, least(coalesce(max_results, 200), 500))
  order by bucket, consecutive_missed desc, open_breaches desc, full_name;
$$;


-- Art. 15 / Art. 20: everything held about one resident, as portable JSON.
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
               'recorded_by', g.full_name
             ) order by e.occurred_at)
      from public.gate_events e
      join public.profiles g on g.id = e.guard_id
      where e.resident_id = r.id
    ), '[]'::jsonb),
    'checkin_events', coalesce((
      select jsonb_agg(jsonb_build_object(
               'occurred_at', c.occurred_at,
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
-- 7. Grants. Dropped-and-recreated objects lost theirs, and 001's default
--    privileges would otherwise hand the new functions to anon.
-- ---------------------------------------------------------------------------

revoke all on public.v_resident_status     from anon, public;
revoke all on public.v_check_log           from anon, public;
revoke all on public.v_resident_compliance from anon, public;
grant select on public.v_resident_status     to authenticated;
grant select on public.v_check_log           to authenticated;
grant select on public.v_resident_compliance to authenticated;

revoke all on function public.search_residents(text, boolean, integer) from anon, public;
revoke all on function public.record_check(uuid, text)                 from anon, public;
revoke all on function public.record_checkin(uuid)                     from anon, public;
revoke all on function public.attention_list(integer)                  from anon, public;
revoke all on function public.export_resident_record(uuid)             from anon, public;

grant execute on function public.search_residents(text, boolean, integer) to authenticated;
grant execute on function public.record_check(uuid, text)                 to authenticated;
grant execute on function public.record_checkin(uuid)                     to authenticated;
grant execute on function public.attention_list(integer)                  to authenticated;
grant execute on function public.export_resident_record(uuid)             to authenticated;
