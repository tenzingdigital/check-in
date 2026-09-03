-- ---------------------------------------------------------------------------
-- 008_ipas_alignment.sql — identity on the register, policy thresholds, and
-- the retention the verification policy actually asks for.
-- ---------------------------------------------------------------------------
--
-- Three changes, all driven by the March 2026 IPAS verification policy and the
-- House Rules absence policy it points at.
--
-- 1. ID NUMBER. The policy requires that residents "provide their TRC/IRP card
--    to ensure the correct recording of their name and ID number", and that a
--    staff member verifies ID at sign-in. A register without the number does
--    not meet that, so residents gain id_type + id_number. This is a
--    deliberate exception to "know less": it is the minimum identifier the
--    weekly return requires, and it is shown on the detail panel only, never
--    on a list, so a number is on screen when somebody is verifying a card and
--    at no other time.
--
-- 2. POLICY THRESHOLDS. The House Rules define two: an absence of three
--    consecutive nights draws a warning letter, and ten days absent inside a
--    rolling four-week window counts as absence without authorisation. The
--    register already computes the consecutive streak; this adds the rolling
--    window count, and puts all three numbers in app_settings so a centre can
--    match its own rules rather than inheriting ours.
--
--    The view reports COUNTS and nothing else. It does not decide that a
--    threshold was met, does not label anyone, and nothing downstream sends
--    anything. These numbers end in a person losing their accommodation or
--    their allowance; the judgement stays with the centre manager, which is
--    where the House Rules put it.
--
-- 3. RETENTION. "Sign-in sheets should be held for 6 months and then
--    destroyed." The register was set to 2555 days (seven years), which is
--    now simply wrong. 180 days, and the existing row is updated too — a
--    default alone would leave every deployed site non-compliant.

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. Settings: the thresholds, and the corrected retention.
-- ---------------------------------------------------------------------------

alter table public.app_settings
  add column if not exists absence_window_days integer not null default 28
    check (absence_window_days between 7 and 365),
  add column if not exists absence_window_limit integer not null default 10
    check (absence_window_limit between 1 and 365),
  add column if not exists warn_after_consecutive_nights integer not null default 3
    check (warn_after_consecutive_nights between 1 and 90);

comment on column public.app_settings.absence_window_days is
  'Rolling window for the absence count, in days. IPAS House Rules use four weeks.';
comment on column public.app_settings.absence_window_limit is
  'Days absent within the window that reach the House Rules threshold. Reported, never enforced.';
comment on column public.app_settings.warn_after_consecutive_nights is
  'Consecutive missed nights that draw a warning letter under the House Rules.';

-- Six months, per the verification policy. Both the default and the live row:
-- changing only the default would leave existing sites keeping records for
-- seven years, which is the failure this migration exists to fix.
alter table public.app_settings alter column compliance_retention_days set default 180;
update public.app_settings set compliance_retention_days = 180
 where compliance_retention_days > 180;

-- ---------------------------------------------------------------------------
-- 2. Identity on the resident record.
-- ---------------------------------------------------------------------------
-- The dependent views and the two functions returning setof a view type come
-- down first: search_key is generated, and Postgres will not drop a column any
-- view still selects. They are rebuilt in section 3.

drop function if exists public.search_residents(text, boolean, integer);
drop function if exists public.attention_list(integer);
drop function if exists public.record_check(uuid, text);
drop view if exists public.v_resident_status;
drop view if exists public.v_resident_compliance;


alter table public.residents
  add column if not exists id_type   text,
  add column if not exists id_number text;

do $$ begin
  alter table public.residents add constraint residents_id_type_known
    check (id_type is null or id_type in ('TRC', 'IRP'));
exception when duplicate_object then null; end $$;

-- Both or neither. A number with no type cannot be checked against a card,
-- and a type with no number is not an identifier.
do $$ begin
  alter table public.residents add constraint residents_id_pair
    check ((id_type is null) = (id_number is null));
exception when duplicate_object then null; end $$;

comment on column public.residents.id_number is
  'TRC or IRP number as printed on the card. Required by the IPAS weekly register.';

-- The number joins the search key: a manager holding a card should be able to
-- type the number rather than guess the spelling of a name.
alter table public.residents drop column if exists search_key;
alter table public.residents add column search_key text generated always as (
  lower(public.immutable_unaccent(
    btrim(first_name) || ' ' || btrim(last_name) || ' ' ||
    btrim(last_name)  || ' ' || btrim(first_name) || ' ' ||
    coalesce(id_number, '')
  ))
) stored;

create index if not exists residents_search_key_trgm_idx
  on public.residents using gin (search_key gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- 3. Views and functions rebuilt on the new shape.
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
  r.id_type,
  r.id_number,
  r.status,
  r.search_key,
  (date_part('year', age(r.date_of_birth)))::integer as age_years,
  (r.date_of_birth <= current_date - make_interval(years => s.adult_age_years)) as is_adult,
  coalesce(le.kind, 'out') as presence,
  le.occurred_at as last_event_at,
  le.guard_id    as last_event_guard_id
from public.residents r
cross join s
left join last_event le on le.resident_id = r.id
where public.is_staff();

comment on view public.v_resident_status is
  'Staff-facing projection of residents. Exposes age_years and is_adult but never date_of_birth.';


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
-- The House Rules' rolling four-week test. Completed days only: today is not
-- over, so counting it would report an absence that has not happened yet.
window_tally as (
  select dc.resident_id,
         count(*) filter (where dc.required and not dc.presented)::integer as absent_in_window
  from public.daily_compliance dc
  cross join today
  cross join s
  where dc.closed_at is not null
    and dc.compliance_date >= today.d - s.absence_window_days
    and dc.compliance_date <  today.d
  group by dc.resident_id
),
-- Consecutive required-and-missed days counting back from the last completed
-- day. A day that was never required is transparent to the streak: it neither
-- counts towards it nor breaks it, so required=false rows are filtered out of
-- the window before the running sum decides where the streak ends.
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
  r.id_type,
  r.id_number,
  r.status,
  (date_part('year', age(r.date_of_birth)))::integer as age_years,
  public.compliance_required(r.date_of_birth, (r.registered_at at time zone s.local_timezone)::date,
                             r.departed_on, today.d, s.adult_age_years) as required_today,
  coalesce(tr.presented, false) as seen_today,
  coalesce(tr.checkin_count, 0) as checkins_today,
  coalesce(t.open_breaches, 0)  as open_breaches,
  coalesce(st.consecutive_missed, 0) as consecutive_missed,
  -- The two House Rules numbers, reported as facts. No labels, no verdicts.
  coalesce(wt.absent_in_window, 0) as absent_in_window,
  s.absence_window_days,
  s.absence_window_limit,
  s.warn_after_consecutive_nights,
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
left join tally       t  on t.resident_id  = r.id
left join window_tally wt on wt.resident_id = r.id
left join streak      st on st.resident_id = r.id
left join todayrow    tr on tr.resident_id = r.id
where public.is_staff();

comment on view public.v_resident_compliance is
  'State precedence is deliberate: an open breach outranks seen_today, because '
  'clearing today does not clear a missed Tuesday. absent_in_window and '
  'consecutive_missed are reported against the configured thresholds; reaching '
  'one is a fact for the centre manager, not a decision this system makes.';


-- Unchanged in behaviour. It is here only because it returns setof
-- v_resident_status, so it had to be dropped for the view to be rebuilt.
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
  end if;

  return query
    select * from public.v_resident_status where id = p_resident_id;
end;
$fn$;


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
    case when v.search_key like n.nq || '%'         then 0
         when v.search_key like '%' || n.nq || '%'  then 1
         else 2 end,
    word_similarity(n.nq, v.search_key) desc,
    v.last_name, v.first_name
  limit greatest(1, least(coalesce(max_results, 20), 1000));
$$;


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
                      v.consecutive_missed desc, v.absent_in_window desc,
                      v.open_breaches desc, v.full_name
           ) as rn
    from public.v_resident_compliance v
    where public.is_staff()
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

-- ---------------------------------------------------------------------------
-- 4. Grants, restated for everything dropped above.
-- ---------------------------------------------------------------------------

revoke all on public.v_resident_status     from anon, public;
revoke all on public.v_resident_compliance from anon, public;
grant select on public.v_resident_status     to authenticated;
grant select on public.v_resident_compliance to authenticated;

revoke all on function public.search_residents(text, boolean, integer) from anon, public;
revoke all on function public.attention_list(integer)                  from anon, public;
grant execute on function public.search_residents(text, boolean, integer) to authenticated;
grant execute on function public.attention_list(integer)                  to authenticated;

revoke all on function public.record_check(uuid, text) from anon, public;
grant execute on function public.record_check(uuid, text) to authenticated;
