\set ON_ERROR_STOP on
\pset pager off

create or replace function pg_temp.expect(label text, actual anyelement, expected anyelement)
returns void language plpgsql as $$
begin
  if actual is distinct from expected then
    raise exception 'ASSERTION FAILED: % — expected %, got %', label, expected, actual;
  end if;
  raise notice '  ok  %', label;
end;
$$;

-- Assertion helper. RLS does not raise on SELECT, it silently filters rows to
-- zero, so reporting on success/failure alone would call a blocked read
-- "ALLOWED". Report the affected row count too.
-- Copied verbatim from 01_acceptance.sql: pg_temp does not carry across
-- separate psql sessions, and each `psql -f` invocation is its own session.
create or replace function pg_temp.try(label text, stmt text) returns text
language plpgsql as $$
declare n bigint;
begin
  execute stmt;
  get diagnostics n = row_count;
  if n = 0 then
    return format('  no-op    %s  (0 rows)', label);
  end if;
  return format('  ALLOWED  %s  (%s row(s))', label, n);
exception when others then
  return format('  blocked  %s  (%s)', label, sqlerrm);
end $$;

\echo '=========== CALENDAR-DAY HELPERS ==========='
\echo '--- site_today() follows app_settings.local_timezone, not the server clock'
update public.app_settings set local_timezone = 'Pacific/Kiritimati';  -- UTC+14
select public.site_today() as kiritimati_today;
update public.app_settings set local_timezone = 'Pacific/Midway';      -- UTC-11
select public.site_today() as midway_today;
update public.app_settings set local_timezone = 'Europe/Dublin';

-- Don't assert literal dates — they rot daily. Assert the invariant instead:
-- Kiritimati (UTC+14) is never behind Midway (UTC-11), and the two are at
-- most one day apart.
do $$
declare
  v_kiritimati date;
  v_midway     date;
begin
  update public.app_settings set local_timezone = 'Pacific/Kiritimati';
  select public.site_today() into v_kiritimati;
  update public.app_settings set local_timezone = 'Pacific/Midway';
  select public.site_today() into v_midway;
  update public.app_settings set local_timezone = 'Europe/Dublin';

  perform pg_temp.expect(
    'kiritimati_today >= midway_today',
    v_kiritimati >= v_midway,
    true
  );
  perform pg_temp.expect(
    'kiritimati_today and midway_today differ by at most one day',
    (v_kiritimati - v_midway) <= 1,
    true
  );

  -- Later tasks depend on this being Europe/Dublin — confirm the restore stuck.
  perform pg_temp.expect(
    'local_timezone restored to Europe/Dublin',
    (select local_timezone from public.app_settings where id),
    'Europe/Dublin'
  );
end $$;

\echo '--- compliance_required: the 18th-birthday boundary, computed per day'
select
  public.compliance_required(date '2008-08-10', date '2020-01-01', null, date '2026-08-09', 18) as day_before_18th,
  public.compliance_required(date '2008-08-10', date '2020-01-01', null, date '2026-08-10', 18) as on_18th_birthday,
  public.compliance_required(date '2008-08-10', date '2020-01-01', null, date '2026-08-11', 18) as day_after_18th;

do $$
begin
  perform pg_temp.expect('day_before_18th = false',
    public.compliance_required(date '2008-08-10', date '2020-01-01', null, date '2026-08-09', 18), false);
  perform pg_temp.expect('on_18th_birthday = true',
    public.compliance_required(date '2008-08-10', date '2020-01-01', null, date '2026-08-10', 18), true);
  perform pg_temp.expect('day_after_18th = true',
    public.compliance_required(date '2008-08-10', date '2020-01-01', null, date '2026-08-11', 18), true);
end $$;

\echo '--- compliance_required: registration and departure bound the duty'
select
  public.compliance_required(date '1990-01-01', date '2026-08-05', null,             date '2026-08-04', 18) as before_registration,
  public.compliance_required(date '1990-01-01', date '2026-08-05', null,             date '2026-08-05', 18) as on_registration_day,
  public.compliance_required(date '1990-01-01', date '2026-08-05', date '2026-08-20', date '2026-08-20', 18) as on_departure_day,
  public.compliance_required(date '1990-01-01', date '2026-08-05', date '2026-08-20', date '2026-08-21', 18) as after_departure;

do $$
begin
  perform pg_temp.expect('before_registration = false',
    public.compliance_required(date '1990-01-01', date '2026-08-05', null, date '2026-08-04', 18), false);
  perform pg_temp.expect('on_registration_day = true',
    public.compliance_required(date '1990-01-01', date '2026-08-05', null, date '2026-08-05', 18), true);
  perform pg_temp.expect('on_departure_day = true',
    public.compliance_required(date '1990-01-01', date '2026-08-05', date '2026-08-20', date '2026-08-20', 18), true);
  perform pg_temp.expect('after_departure = false',
    public.compliance_required(date '1990-01-01', date '2026-08-05', date '2026-08-20', date '2026-08-21', 18), false);
end $$;

\echo ''
\echo '=========== LEDGER INTEGRITY ==========='
do $$
begin
  -- Without these, the try() probes below are vacuous: try() swallows
  -- "relation does not exist" and reports it as "blocked", so a dropped table
  -- would look exactly like a working RLS denial.
  perform pg_temp.expect('checkin_events exists',
    to_regclass('public.checkin_events') is not null, true);
  perform pg_temp.expect('daily_compliance exists',
    to_regclass('public.daily_compliance') is not null, true);

  perform pg_temp.expect('RLS enabled on checkin_events',
    (select relrowsecurity from pg_class where oid = 'public.checkin_events'::regclass), true);
  perform pg_temp.expect('RLS enabled on daily_compliance',
    (select relrowsecurity from pg_class where oid = 'public.daily_compliance'::regclass), true);

  -- The append-only property, asserted directly rather than inferred from a
  -- swallowed error: exactly one SELECT policy and no write policies at all.
  perform pg_temp.expect('checkin_events has exactly 1 select policy',
    (select count(*)::integer from pg_policies
      where schemaname='public' and tablename='checkin_events' and cmd='SELECT'), 1);
  perform pg_temp.expect('checkin_events has no write policies',
    (select count(*)::integer from pg_policies
      where schemaname='public' and tablename='checkin_events' and cmd <> 'SELECT'), 0);
  perform pg_temp.expect('daily_compliance has exactly 1 select policy',
    (select count(*)::integer from pg_policies
      where schemaname='public' and tablename='daily_compliance' and cmd='SELECT'), 1);
  perform pg_temp.expect('daily_compliance has no write policies',
    (select count(*)::integer from pg_policies
      where schemaname='public' and tablename='daily_compliance' and cmd <> 'SELECT'), 0);
end $$;

set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select pg_temp.try('guard UPDATEs a checkin event',
                   'update public.checkin_events set note=''x'' where true');
select pg_temp.try('guard DELETEs a checkin event',
                   'delete from public.checkin_events where true');
select pg_temp.try('guard UPDATEs the register directly',
                   'update public.daily_compliance set presented=true where true');
select pg_temp.try('guard DELETEs a register row',
                   'delete from public.daily_compliance where true');
reset role;

\echo ''
\echo '=========== RECORD_CHECKIN ==========='
reset role;
select id as adult_id from public.residents where last_name='Brennan'  \gset
select id as minor_id from public.residents where last_name='Marchetti' \gset
delete from public.daily_compliance;
delete from public.checkin_events;

set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

\echo '--- first check-in creates the row'
select compliance_date = public.site_today() as dated_today, required, presented, checkin_count
from public.record_checkin(:'adult_id') \gset first_

select pg_temp.expect('first check-in: dated_today', (:'first_dated_today')::boolean, true);
select pg_temp.expect('first check-in: required', (:'first_required')::boolean, true);
select pg_temp.expect('first check-in: presented', (:'first_presented')::boolean, true);
select pg_temp.expect('first check-in: checkin_count', (:'first_checkin_count')::integer, 1);

\echo '--- a second check-in 2 minutes later increments the count, keeps first_seen_at'
reset role;
update public.checkin_events set occurred_at = now() - interval '2 minutes';
update public.daily_compliance set first_seen_at = now() - interval '2 minutes';
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select checkin_count, first_seen_at < now() - interval '1 minute' as kept_earliest
from public.record_checkin(:'adult_id') \gset second_

select pg_temp.expect('second check-in: checkin_count', (:'second_checkin_count')::integer, 2);
select pg_temp.expect('second check-in: kept_earliest', (:'second_kept_earliest')::boolean, true);

\echo '--- double tap within 60s does NOT inflate the count'
select checkin_count as after_double_tap from public.record_checkin(:'adult_id') \gset dtap_

select pg_temp.expect('double tap does not inflate count', (:'dtap_after_double_tap')::integer, 2);

\echo '--- a minor gets a row with required=false'
select required as minor_required, presented as minor_presented
from public.record_checkin(:'minor_id') \gset minor_

select pg_temp.expect('minor: required = false', (:'minor_minor_required')::boolean, false);
select pg_temp.expect('minor: presented = true', (:'minor_minor_presented')::boolean, true);

\echo '--- append-only probes, now that real rows exist'
-- Task 3's LEDGER INTEGRITY probes run against empty tables, so they report
-- "no-op (0 rows)" whether or not a write policy exists — they prove nothing on
-- their own. Repeat them here, where record_checkin has just created real rows,
-- so a stray UPDATE or DELETE policy would actually show up as ALLOWED.
select pg_temp.try('guard UPDATEs a populated checkin_events',
                   'update public.checkin_events set note=''x'' where true');
select pg_temp.try('guard DELETEs from a populated checkin_events',
                   'delete from public.checkin_events where true');
select pg_temp.try('guard UPDATEs a populated daily_compliance',
                   'update public.daily_compliance set presented=false where true');
select pg_temp.try('guard DELETEs from a populated daily_compliance',
                   'delete from public.daily_compliance where true');
do $$
begin
  perform pg_temp.expect('checkin_events still populated after guard write attempts',
    (select count(*) > 0 from public.checkin_events), true);
  perform pg_temp.expect('daily_compliance still populated after guard write attempts',
    (select count(*) > 0 from public.daily_compliance), true);
end $$;

\echo '--- attribution and authorisation'
select count(*) as events_attributed_to_guard from public.checkin_events
 where guard_id = '11111111-1111-1111-1111-111111111111' \gset attr_
select count(*) as total from public.checkin_events \gset allev_

select pg_temp.expect('all check-in events attributed to the acting guard',
  (:'attr_events_attributed_to_guard')::integer, (:'allev_total')::integer);

set request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
select pg_temp.try('suspended account records a check-in',
                   'select public.record_checkin(' || quote_literal(:'adult_id') || ')');
reset role;

\echo ''
\echo '=========== RECORD_CHECKIN: DAY BOUNDARY ==========='
-- A repeat within 60 seconds is a double tap only if it is the SAME site-local
-- day. A check-in at 23:59:30 followed by one at 00:00:10 the next day is 40
-- seconds apart in real time but a genuine new-day presentation. If the
-- dedupe query is not scoped to the day, both the event and the register row
-- for the new day are silently swallowed, and the guard sees a blank result
-- with no error.
--
-- This is exercised without waiting for real midnight: app_settings.
-- local_timezone is set to a synthetic UTC offset that places "right now" a
-- few seconds after local midnight, a presentation is seeded 30 real seconds
-- earlier (landing just before that synthetic midnight, i.e. on the previous
-- site-local day), and record_checkin() is called immediately after. The
-- offset is derived from clock_timestamp() at run time, so this does not
-- depend on the wall-clock time the suite happens to run at.
reset role;
select id as boundary_id from public.residents where last_name='Brennan' \gset
delete from public.daily_compliance where resident_id = :'boundary_id';
delete from public.checkin_events   where resident_id = :'boundary_id';

do $$
declare
  v_epoch_of_day double precision;
  v_n            double precision;
  v_sign         text;
  v_abs          integer;
  v_offset       text;
begin
  v_epoch_of_day := extract(epoch from (clock_timestamp()::time));
  v_n := v_epoch_of_day - 20;  -- put local time-of-day at 00:00:20
  if v_n > 43200 then
    v_n := v_n - 86400;
  elsif v_n < -43200 then
    v_n := v_n + 86400;
  end if;
  v_sign := case when v_n < 0 then '-' else '+' end;
  v_abs  := round(abs(v_n))::integer;
  v_offset := v_sign || lpad((v_abs / 3600)::text, 2, '0') || ':' ||
              lpad(((v_abs % 3600) / 60)::text, 2, '0') || ':' ||
              lpad((v_abs % 60)::text, 2, '0');
  update public.app_settings set local_timezone = v_offset;
end $$;

select public.site_today() as boundary_today \gset
select (clock_timestamp() - interval '30 seconds') as seed_ts \gset
select ((:'seed_ts'::timestamptz) at time zone
          (select local_timezone from public.app_settings))::date as seed_local_date \gset

select pg_temp.expect('day boundary: seed timestamp lands on the day before the synthetic today',
  (:'seed_local_date')::date, (:'boundary_today')::date - 1);

insert into public.checkin_events (resident_id, guard_id, occurred_at)
values (:'boundary_id', '11111111-1111-1111-1111-111111111111', :'seed_ts'::timestamptz);

insert into public.daily_compliance (resident_id, compliance_date, required, presented, first_seen_at, checkin_count)
values (:'boundary_id', :'seed_local_date'::date, true, true, :'seed_ts'::timestamptz, 1);

set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

\echo '--- a check-in 30 real seconds later, but on the new site-local day, is recorded, not swallowed'
with r as (
  select public.record_checkin(:'boundary_id') as rec
)
select (r.rec).compliance_date as compliance_date,
       (r.rec).required        as required,
       (r.rec).presented       as presented,
       (r.rec).checkin_count   as checkin_count,
       ((r.rec).resident_id is not null) as returned_row
from r \gset newday_

select pg_temp.expect('day boundary: record_checkin does not return a null row',
  (:'newday_returned_row')::boolean, true);
select pg_temp.expect('day boundary: new row is dated the synthetic today, not yesterday',
  (:'newday_compliance_date')::date, (:'boundary_today')::date);
select pg_temp.expect('day boundary: new day presented = true',
  (:'newday_presented')::boolean, true);
select pg_temp.expect('day boundary: new day checkin_count = 1, not swallowed as a double tap',
  (:'newday_checkin_count')::integer, 1);

reset role;
select checkin_count as cnt, presented as pres
from public.daily_compliance
where resident_id = :'boundary_id' and compliance_date = (:'boundary_today')::date - 1 \gset prior_

select pg_temp.expect('day boundary: the previous day''s row keeps its own separate count',
  (:'prior_cnt')::integer, 1);
select pg_temp.expect('day boundary: the previous day''s row is untouched',
  (:'prior_pres')::boolean, true);

update public.app_settings set local_timezone = 'Europe/Dublin';

\echo ''
\echo '=========== RESIDENT DEPARTURE INVARIANT ==========='
-- departed_on_matches_status is biconditional: without it, a resident could be
-- marked departed with no date and would then be treated by close-out as still
-- subject to the rule forever (departed_on is null passes its window check
-- unconditionally), collecting an unclearable statutory breach every night,
-- since record_checkin() refuses non-active residents and can never clear it.
reset role;
do $$
declare
  v_raised boolean := false;
begin
  begin
    insert into public.residents (first_name, last_name, date_of_birth, status)
    values ('Invalid', 'NoDepartureDate', '1980-01-01', 'departed');
  exception when check_violation then
    v_raised := true;
  end;
  perform pg_temp.expect(
    'status=''departed'' with departed_on null violates departed_on_matches_status',
    v_raised, true);
  -- Defensive cleanup in case the insert unexpectedly succeeded (i.e. the
  -- constraint has regressed) — do not let a bad row leak into later counts.
  delete from public.residents where first_name = 'Invalid' and last_name = 'NoDepartureDate';
end $$;

\echo ''
\echo '=========== RECORD_CHECKIN AND A DEPARTED RESIDENT''S FINAL DAY ==========='
-- compliance_required() treats p_day <= departed_on as still required, and
-- close_out_compliance_days() writes a daily_compliance row for that day
-- (its filter is departed_on >= v_day). record_checkin() must therefore still
-- accept a check-in on that final day, or it becomes an unclearable
-- statutory breach: no role holds UPDATE on daily_compliance.
reset role;
insert into public.residents (first_name, last_name, date_of_birth, status, departed_on)
values ('Fiona', 'Leaving', '1980-01-01', 'departed', public.site_today());
select id as leaving_id from public.residents where last_name='Leaving' \gset

set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

\echo '--- a resident departed as of TODAY can still check in today (the bug)'
select presented, compliance_date = public.site_today() as dated_today
from public.record_checkin(:'leaving_id') \gset leave_today_

select pg_temp.expect('departed today: check-in succeeds', (:'leave_today_presented')::boolean, true);
select pg_temp.expect('departed today: dated today', (:'leave_today_dated_today')::boolean, true);

reset role;
update public.residents set departed_on = public.site_today() - 1 where id = :'leaving_id';
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

\echo '--- the same resident, a day after their departure, cannot check in'
select pg_temp.try('departed-yesterday resident attempts a check-in today',
                   'select public.record_checkin(' || quote_literal(:'leaving_id') || ')') as leave_after_result \gset

select pg_temp.expect('departed after their day: blocked',
  (:'leave_after_result' like '%blocked%'), true);

reset role;
\echo '--- an active resident is unaffected by the departed-resident branch'
select id as active_probe_id from public.residents where last_name='Brennan' \gset
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select presented from public.record_checkin(:'active_probe_id') \gset active_probe_

select pg_temp.expect('active resident: check-in still succeeds', (:'active_probe_presented')::boolean, true);

reset role;
delete from public.residents where id = :'leaving_id';

\echo ''
\echo '=========== CLOSE-OUT AND BACKFILL ==========='
reset role;
delete from public.daily_compliance;
delete from public.checkin_events;

-- A resident who departed partway through the outage window, to prove the
-- departed_on upper bound is inclusive of the departure day and exclusive of
-- the day after (>= not >).
insert into public.residents (first_name, last_name, date_of_birth, status, departed_on)
values ('Cormac', 'Doyle', '1980-06-15', 'departed', public.site_today() - 3);

update public.residents set registered_at = now() - interval '10 days';

select id as adult_id    from public.residents where last_name='Brennan' \gset
select id as departed_id from public.residents where last_name='Doyle'    \gset

-- Expected population per backfilled day is computed the same way
-- close_out_compliance_days() computes it — a registration/departure window
-- join, not a headcount — because the headcount itself is not stable: Nair was
-- erased by 01_acceptance.sql before this file runs, and Doyle above is
-- deliberately departed mid-window with a shorter valid range than everyone
-- else.
select count(*) as expected_backfill_rows
from public.residents r
cross join generate_series(public.site_today() - 10, public.site_today() - 1, interval '1 day') gs(d)
where (r.registered_at at time zone (select local_timezone from public.app_settings where id))::date <= gs.d::date
  and (r.departed_on is null or r.departed_on >= gs.d::date) \gset

\echo '--- a check-in recorded today, before close-out runs, to prove the day-in-progress clamp for real'
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select public.record_checkin(:'adult_id');
reset role;

\echo '--- a 10-day outage: one run backfills every missing day'
select public.close_out_compliance_days() as rows_written \gset
-- Scoped to compliance_date < today so the check-in seeded above (today,
-- presented=true) cannot be mistaken for a backfilled day.
select count(*) as distinct_days, count(*) filter (where presented) as any_presented
from (select distinct compliance_date, presented from public.daily_compliance
       where compliance_date < public.site_today()) d \gset

select pg_temp.expect('backfill: distinct_days = 10', (:distinct_days)::integer, 10);
select pg_temp.expect('backfill: any_presented = 0', (:any_presented)::integer, 0);
select pg_temp.expect('backfill: rows_written = expected_backfill_rows (registration/departure window, not a headcount)',
  (:rows_written)::integer, (:expected_backfill_rows)::integer);

\echo '--- a departed resident is required only up to and including their departure day'
select exists (
  select 1 from public.daily_compliance
  where resident_id = :'departed_id' and compliance_date = public.site_today() - 3
) as has_row_on_departure_day \gset
select exists (
  select 1 from public.daily_compliance
  where resident_id = :'departed_id' and compliance_date = public.site_today() - 2
) as has_row_after_departure \gset

select pg_temp.expect('departed resident: has a register row ON their departure day',
  (:'has_row_on_departure_day')::boolean, true);
select pg_temp.expect('departed resident: no register row for the day AFTER departure',
  (:'has_row_after_departure')::boolean, false);

\echo '--- idempotency: a second run writes nothing and overwrites nothing'
select public.close_out_compliance_days() as second_run_rows \gset

select pg_temp.expect('idempotent second run: second_run_rows = 0', (:second_run_rows)::integer, 0);

\echo '--- close-out never overwrites a recorded presence'
delete from public.daily_compliance where resident_id = :'adult_id' and compliance_date = public.site_today() - 1;
insert into public.daily_compliance (resident_id, compliance_date, required, presented, first_seen_at, checkin_count)
values (:'adult_id', public.site_today() - 1, true, true, now() - interval '1 day', 1);
select public.close_out_compliance_days() as third_run_rows \gset
select presented as still_presented from public.daily_compliance
 where resident_id = :'adult_id' and compliance_date = public.site_today() - 1 \gset

select pg_temp.expect('overwrite-safety: third_run_rows = 0', (:third_run_rows)::integer, 0);
select pg_temp.expect('overwrite-safety: still_presented = true', (:'still_presented')::boolean, true);

\echo '--- today is left open; only completed days are closed'
-- Not a bare count-of-zero (that passes whether today is correctly skipped OR
-- wrongly closed-then-reopened by nobody touching it). Anchor on the row
-- seeded via record_checkin() above and prove close-out left it alone.
select closed_at is null as today_checkin_still_open from public.daily_compliance
 where resident_id = :'adult_id' and compliance_date = public.site_today() \gset
select count(*) as today_row_count from public.daily_compliance
 where compliance_date = public.site_today() \gset
select count(*) as unclosed_past_rows from public.daily_compliance
 where compliance_date < public.site_today() and closed_at is null \gset

select pg_temp.expect('today''s check-in stays open after three close-out runs',
  (:'today_checkin_still_open')::boolean, true);
select pg_temp.expect('close-out wrote no row for today besides the seeded check-in',
  (:today_row_count)::integer, 1);
select pg_temp.expect('all past days are closed: unclosed_past_rows = 0', (:unclosed_past_rows)::integer, 0);

\echo '--- the minor is required=false on every backfilled day'
select bool_and(required = false) as minor_never_required
from public.daily_compliance dc
join public.residents r on r.id = dc.resident_id
where r.last_name = 'Marchetti' \gset

select pg_temp.expect('minor: required = false on every backfilled day',
  (:'minor_never_required')::boolean, true);

\echo ''
\echo '=========== STATES AND ATTENTION LIST ==========='
reset role;
delete from public.daily_compliance;
delete from public.checkin_events;
select id as adult_id from public.residents where last_name='Brennan' \gset
select id as other_id from public.residents where last_name='Haddad'  \gset

-- Brennan: missed the last 3 completed days. Haddad: missed 1.
insert into public.daily_compliance (resident_id, compliance_date, required, presented, checkin_count, closed_at)
select :'adult_id', public.site_today() - g, true, false, 0, now() from generate_series(1,3) g;
insert into public.daily_compliance (resident_id, compliance_date, required, presented, checkin_count, closed_at)
values (:'other_id', public.site_today() - 1, true, false, 0, now());

set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

\echo '--- states and consecutive-miss ordering'
select full_name, state, open_breaches, consecutive_missed
from public.attention_list() order by consecutive_missed desc, full_name;

select state, open_breaches, consecutive_missed
from public.v_resident_compliance where id = :'adult_id' \gset brennan_

select pg_temp.expect('Brennan: state = breach_open', (:'brennan_state')::text, 'breach_open');
select pg_temp.expect('Brennan: open_breaches = 3', (:'brennan_open_breaches')::integer, 3);
select pg_temp.expect('Brennan: consecutive_missed = 3', (:'brennan_consecutive_missed')::integer, 3);

select state, open_breaches, consecutive_missed
from public.v_resident_compliance where id = :'other_id' \gset haddad_

select pg_temp.expect('Haddad: state = breach_open', (:'haddad_state')::text, 'breach_open');
select pg_temp.expect('Haddad: open_breaches = 1', (:'haddad_open_breaches')::integer, 1);

\echo '--- attention_list: breaches rank ahead of never-seen residents, deeper streaks first'
with ordered as (
  select id, row_number() over () as rn from public.attention_list()
)
select
  (select rn from ordered where id = :'adult_id') as brennan_rank,
  (select rn from ordered where id = :'other_id') as haddad_rank
\gset ordrank_

-- Direct value assertions, not "is not null": with \gset, a NULL column
-- leaves the psql variable unset, so referencing it with :'var' would leave
-- the literal text unexpanded and fail the query with a SQL syntax error
-- rather than a clean assertion failure — "is not null" could never itself
-- report false. Asserting the exact rank both proves presence (a NULL would
-- error before the comparison ever ran) and proves the ordering.
select pg_temp.expect('attention_list: Brennan (3-day streak) ranks first',
  (:'ordrank_brennan_rank')::integer, 1);
select pg_temp.expect('attention_list: Haddad (1-day streak) ranks second, ahead of every never-seen resident',
  (:'ordrank_haddad_rank')::integer, 2);

\echo '--- attention_list: the cap never drops a breach'
-- There are 6 never-seen residents in play here (their history was wiped
-- above) — more than enough to fill a small max_results if the LIMIT were
-- applied uniformly across buckets. The product rule is "flag but never
-- suppress": a breach row must never vanish under a cap.
--
-- Two cap values, deliberately either side of the breach count (2 breach
-- rows: Brennan and Haddad):
--   cap=1 is SMALLER than the breach count, so if the two breach rows
--   were not exempt from the cap at all, at most one of them could survive
--   — this is the only value that actually exercises the exemption clause.
--   A cap of 2 or more can't distinguish "exempted" from "coincidentally
--   fit inside the cap anyway", since both breach rows would rank 1 and 2
--   within their own partition regardless.
--   cap=2 proves the cap still does real work on the less-critical rows
--   once the exempt ones are accounted for.
select count(*) filter (where id = :'adult_id') as brennan_present,
       count(*) filter (where id = :'other_id') as haddad_present,
       count(*) as total_returned
from public.attention_list(1) \gset cap1_

select pg_temp.expect('attention_list(1): Brennan''s breach is never dropped by a cap smaller than the breach count',
  (:'cap1_brennan_present')::integer, 1);
select pg_temp.expect('attention_list(1): Haddad''s breach is never dropped by a cap smaller than the breach count',
  (:'cap1_haddad_present')::integer, 1);
select pg_temp.expect('attention_list(1): both breaches plus exactly 1 never-seen row (the cap) get through',
  (:'cap1_total_returned')::integer, 3);

select count(*) filter (where id = :'adult_id') as brennan_present,
       count(*) filter (where id = :'other_id') as haddad_present,
       count(*) as total_returned
from public.attention_list(2) \gset cap_

select pg_temp.expect('attention_list(2): Brennan''s breach is never dropped by the cap',
  (:'cap_brennan_present')::integer, 1);
select pg_temp.expect('attention_list(2): Haddad''s breach is never dropped by the cap',
  (:'cap_haddad_present')::integer, 1);
select pg_temp.expect('attention_list(2): the cap still limits the less-critical never/due_today rows',
  (:'cap_total_returned')::integer, 4);

\echo '--- checking in flips today''s state'
select state as before_checkin from public.v_resident_compliance where id = :'adult_id' \gset

select pg_temp.expect('before check-in: state = breach_open', (:'before_checkin')::text, 'breach_open');

select 1 as _ from public.record_checkin(:'adult_id') limit 1;

select state as after_checkin, seen_today from public.v_resident_compliance where id = :'adult_id' \gset

select pg_temp.expect('after check-in: state stays breach_open (past breach unresolved)',
  (:'after_checkin')::text, 'breach_open');
select pg_temp.expect('after check-in: seen_today = true (today satisfied)',
  (:'seen_today')::boolean, true);

\echo '--- streak: a day that was not required is skipped, not a break'
-- This is the highest-risk part of consecutive_missed: a not-required day
-- (under 18 / before registration / after departure) must be transparent to
-- the streak, neither counted nor able to end it. Synthetic rows isolate the
-- CTE from Brennan's real age/registration facts.
reset role;
delete from public.daily_compliance where resident_id = :'adult_id';
insert into public.daily_compliance (resident_id, compliance_date, required, presented, first_seen_at, checkin_count, closed_at) values
  (:'adult_id', public.site_today() - 1, true,  false, null, 0, now()),  -- missed, required: counts
  (:'adult_id', public.site_today() - 2, false, false, null, 0, now()),  -- not required: must be skipped
  (:'adult_id', public.site_today() - 3, true,  false, null, 0, now()),  -- missed, required: counts
  (:'adult_id', public.site_today() - 4, true,  true,  now(), 1, now()),  -- presented: breaks the streak
  (:'adult_id', public.site_today() - 5, true,  false, null, 0, now()); -- before the break: must not count

select consecutive_missed from public.v_resident_compliance where id = :'adult_id' \gset streak_

select pg_temp.expect(
  'streak: a not-required day between two missed required days neither counts nor breaks the streak',
  (:'streak_consecutive_missed')::integer, 2);

set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

\echo '--- hut_summary() still reports the gate counters'
-- Restores coverage lost when Task 1 deleted acceptance-suite section C, which
-- held the only test of this function. Its signature changed in Task 1 and no
-- other task touches it, so without this it would ship untested.
select on_site, events_today from public.hut_summary() \gset hut_

select pg_temp.expect('hut_summary: on_site is a non-negative count',
  (:'hut_on_site')::integer >= 0, true);
select pg_temp.expect('hut_summary: events_today is a non-negative count',
  (:'hut_events_today')::integer >= 0, true);
reset role;

\echo ''
\echo '=========== RETENTION AND GDPR ==========='
reset role;
select id as adult_id from public.residents where last_name='Brennan' \gset

-- One old check-in event and one old register row, both beyond the event window.
insert into public.checkin_events (resident_id, guard_id, occurred_at)
values (:'adult_id', '11111111-1111-1111-1111-111111111111', now() - interval '200 days');
insert into public.daily_compliance (resident_id, compliance_date, required, presented, first_seen_at, checkin_count, closed_at)
values (:'adult_id', public.site_today() - 200, true, true, now() - interval '200 days', 1, now())
on conflict do nothing;

\echo '--- the movement log is purged at 90 days'
select public.purge_expired_checkin_events() as events_purged \gset
select count(*) as old_events_left from public.checkin_events
 where occurred_at < now() - interval '100 days' \gset

select pg_temp.expect('purge_expired_checkin_events: no check-in events older than 100 days remain',
  (:'old_events_left')::integer, 0);

\echo '--- but the register survives: this is the defect the spec fixes'
select count(*) as old_register_rows_kept from public.daily_compliance
 where compliance_date = public.site_today() - 200 \gset

select pg_temp.expect('the 200-day-old register row survives the event purge',
  (:'old_register_rows_kept')::integer, 1);

\echo '--- the register is purged at its own, longer horizon'
update public.app_settings set compliance_retention_days = 30;
select public.purge_expired_compliance() as register_rows_purged \gset
select count(*) as old_register_rows_left from public.daily_compliance
 where compliance_date < public.site_today() - 30 \gset
update public.app_settings set compliance_retention_days = 2555;

select pg_temp.expect('purge_expired_compliance: no register rows older than the (temporarily lowered) horizon remain',
  (:'old_register_rows_left')::integer, 0);

\echo '--- export includes the register; erasure removes it'
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select public.export_resident_record(:'adult_id') ? 'daily_compliance' as export_has_register \gset
select public.erase_resident(:'adult_id', 'test') is not null as erased \gset
reset role;
select count(*) as register_rows_after_erasure from public.daily_compliance where resident_id = :'adult_id' \gset

select pg_temp.expect('export_resident_record includes a daily_compliance key',
  (:'export_has_register')::boolean, true);
select pg_temp.expect('erase_resident returns a non-null result',
  (:'erased')::boolean, true);
select pg_temp.expect('erase_resident cascades: no register rows remain for the erased resident',
  (:'register_rows_after_erasure')::integer, 0);

\echo ''
\echo '=========== LATE ENTRY (OFFLINE SYNC) ==========='
-- A terminal that lost its link queues events and replays them later through
-- record_checkin_late() / record_check_late(). Four things must hold: the
-- event lands on the day it HAPPENED (not the day it synced), it is flagged,
-- a replay is a no-op, and the terminal clock is bounded.
reset role;
update public.app_settings set local_timezone = 'Europe/Dublin';
select id as late_id from public.residents where last_name='Nowak' \gset
delete from public.checkin_events   where resident_id = :'late_id';
delete from public.gate_events      where resident_id = :'late_id';
delete from public.daily_compliance where resident_id = :'late_id';

select pg_temp.expect('late_entry_window_hours defaults to 48',
  (select late_entry_window_hours from public.app_settings where id), 48);

-- The event "happened" 25 hours ago: inside the window, on the previous
-- site-local day. Close-out has already written that day as missed.
select (now() - interval '25 hours') as late_ts \gset
select ((:'late_ts'::timestamptz) at time zone 'Europe/Dublin')::date as late_day \gset
insert into public.daily_compliance (resident_id, compliance_date, required, presented, first_seen_at, checkin_count, closed_at)
values (:'late_id', :'late_day'::date, true, false, null, 0, now());

set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

\echo '--- a synced check-in lands on the day it happened and corrects the closed row'
with r as (
  select public.record_checkin_late(:'late_id', :'late_ts'::timestamptz,
                                    'aaaaaaaa-0000-4000-8000-000000000001') as rec
)
select (r.rec).compliance_date as day, (r.rec).presented as presented,
       (r.rec).checkin_count as cnt, (r.rec).closed_at is not null as still_closed,
       (r.rec).first_seen_at = :'late_ts'::timestamptz as seen_at_event_time
from r \gset late1_

select pg_temp.expect('late check-in: dated the day it happened, not today',
  (:'late1_day')::date, (:'late_day')::date);
select pg_temp.expect('late check-in: the missed day is now presented',
  (:'late1_presented')::boolean, true);
select pg_temp.expect('late check-in: checkin_count = 1',
  (:'late1_cnt')::integer, 1);
select pg_temp.expect('late check-in: the day stays closed',
  (:'late1_still_closed')::boolean, true);
select pg_temp.expect('late check-in: first_seen_at is the terminal time, not the sync time',
  (:'late1_seen_at_event_time')::boolean, true);

reset role;
select late_entry, recorded_at >= occurred_at as recorded_after, guard_id::text as guard,
       client_ref::text as ref
from public.checkin_events where resident_id = :'late_id' \gset ev1_
select pg_temp.expect('late check-in: event is flagged late_entry',
  (:'ev1_late_entry')::boolean, true);
select pg_temp.expect('late check-in: recorded_at is not before occurred_at',
  (:'ev1_recorded_after')::boolean, true);
select pg_temp.expect('late check-in: attributed to the session, never to an argument',
  :'ev1_guard'::text, '11111111-1111-1111-1111-111111111111'::text);
select pg_temp.expect('late check-in: client_ref stored',
  :'ev1_ref'::text, 'aaaaaaaa-0000-4000-8000-000000000001'::text);

\echo '--- replaying the same client_ref records nothing'
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select (public.record_checkin_late(:'late_id', :'late_ts'::timestamptz,
                                   'aaaaaaaa-0000-4000-8000-000000000001')).checkin_count as cnt \gset replay_
reset role;
select count(*) as n from public.checkin_events where resident_id = :'late_id' \gset replay_
select pg_temp.expect('replay: still one event', (:'replay_n')::integer, 1);
select pg_temp.expect('replay: checkin_count unchanged', (:'replay_cnt')::integer, 1);

\echo '--- a second ref inside 60 seconds is a double tap, not a second presentation'
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select (public.record_checkin_late(:'late_id', :'late_ts'::timestamptz + interval '20 seconds',
                                   'aaaaaaaa-0000-4000-8000-000000000002')).checkin_count as cnt \gset dtap_
reset role;
select count(*) as n from public.checkin_events where resident_id = :'late_id' \gset dtap_
select pg_temp.expect('double tap: still one event', (:'dtap_n')::integer, 1);

\echo '--- the terminal clock is bounded'
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select pg_temp.try('late check-in older than the window',
  'select public.record_checkin_late(' || quote_literal(:'late_id') || ', now() - interval ''49 hours'', ''aaaaaaaa-0000-4000-8000-000000000003'')');
select pg_temp.try('late check-in dated in the future',
  'select public.record_checkin_late(' || quote_literal(:'late_id') || ', now() + interval ''10 minutes'', ''aaaaaaaa-0000-4000-8000-000000000004'')');
select pg_temp.try('late check-in without a client_ref',
  'select public.record_checkin_late(' || quote_literal(:'late_id') || ', now() - interval ''1 hour'', null)');
reset role;
select count(*) as n from public.checkin_events where resident_id = :'late_id' \gset bound_
select pg_temp.expect('bounded: none of the refused calls recorded anything', (:'bound_n')::integer, 1);

\echo '--- a gate event synced later is flagged and idempotent'
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select presence as presence
from public.record_check_late(:'late_id', 'in', now() - interval '2 hours',
                              'bbbbbbbb-0000-4000-8000-000000000001') \gset gate1_
select presence as presence
from public.record_check_late(:'late_id', 'in', now() - interval '2 hours',
                              'bbbbbbbb-0000-4000-8000-000000000001') \gset gate2_
select count(*) as n from public.v_check_log where resident_id = :'late_id' and late_entry \gset gatelog_
reset role;
select count(*) as n, bool_and(late_entry) as all_late, bool_and(kind = 'in') as all_in
from public.gate_events where resident_id = :'late_id' \gset gate_
select pg_temp.expect('late gate event: presence is in', :'gate1_presence'::text, 'in'::text);
select pg_temp.expect('late gate event: replay leaves one row', (:'gate_n')::integer, 1);
select pg_temp.expect('late gate event: flagged late_entry', (:'gate_all_late')::boolean, true);
select pg_temp.expect('late gate event: v_check_log shows the flag to staff', (:'gatelog_n')::integer, 1);

\echo '--- a live check-in is still recorded as live'
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select (public.record_checkin(:'late_id')).checkin_count as cnt \gset live_
reset role;
select late_entry, recorded_at = occurred_at as same_instant
from public.checkin_events where resident_id = :'late_id' order by occurred_at desc limit 1 \gset live_
select pg_temp.expect('live check-in: late_entry = false', (:'live_late_entry')::boolean, false);
select pg_temp.expect('live check-in: recorded_at = occurred_at', (:'live_same_instant')::boolean, true);

\echo '--- the inner function and the window check are not doors'
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select pg_temp.try('guard calls record_checkin_at directly',
  'select public.record_checkin_at(' || quote_literal(:'late_id') || ', now() - interval ''30 hours'', false, null)');
select pg_temp.try('guard calls assert_late_entry_window directly',
  'select public.assert_late_entry_window(now())');
set request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
select pg_temp.try('suspended account syncs a late check-in',
  'select public.record_checkin_late(' || quote_literal(:'late_id') || ', now() - interval ''1 hour'', ''cccccccc-0000-4000-8000-000000000001'')');
reset role;
set request.jwt.claim.sub = '';
set role anon;
select pg_temp.try('anon syncs a late check-in',
  'select public.record_checkin_late(' || quote_literal(:'late_id') || ', now() - interval ''1 hour'', ''cccccccc-0000-4000-8000-000000000002'')');
select pg_temp.try('anon syncs a late gate event',
  'select public.record_check_late(' || quote_literal(:'late_id') || ', ''in'', now() - interval ''1 hour'', ''cccccccc-0000-4000-8000-000000000003'')');
reset role;
select count(*) as n from public.checkin_events where resident_id = :'late_id' \gset closed_
select pg_temp.expect('no side door recorded anything', (:'closed_n')::integer, 2);

\echo ''
\echo '=========== G. BUILDINGS AND ROOMS (migration 016) ==========='
reset role;
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
insert into public.buildings (name) values ('Castle') returning id as castle_id \gset
insert into public.rooms (building_id, floor, number, capacity) values (:'castle_id', '1F', '12', 2) returning id as room_id \gset
update public.residents set room_id = :'room_id' where id = :'late_id';
reset role;

\echo '--- a guard reads the room on the card and the occupancy, but changes nothing'
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select room_label from public.v_resident_room where id = :'late_id' \gset g_
select pg_temp.expect('guard sees the room on the resident', :'g_room_label'::text, 'Castle · 1F · 12'::text);
select occupants, on_site from public.v_room_occupancy where room_id = :'room_id' \gset o_
select pg_temp.expect('occupancy counts the resident', (:'o_occupants')::integer, 1);
select pg_temp.try('guard adds a building',   'insert into public.buildings (name) values (''Annex'')');
select pg_temp.try('guard adds a room',       'insert into public.rooms (building_id, number) values (' || quote_literal(:'castle_id') || ', ''99'')');
select pg_temp.try('guard moves a resident',  'update public.residents set room_id = null where id = ' || quote_literal(:'late_id'));
select pg_temp.try('guard deletes a building','delete from public.buildings where id = ' || quote_literal(:'castle_id'));
reset role;
set request.jwt.claim.sub = '';
set role anon;
select pg_temp.try('anon reads occupancy',    'select * from public.v_room_occupancy');
select pg_temp.try('anon reads rooms',        'select * from public.rooms');
reset role;

\echo '--- building and room changes are on the record'
select count(*) as n from public.admin_audit where table_name in ('buildings', 'rooms') \gset a_
select pg_temp.expect('building and room inserts are audited', (:'a_n')::integer, 2);
select count(*) as n from public.admin_audit where table_name = 'residents' and row_id = :'late_id'::text and new_row->>'room_id' = :'room_id' \gset m_
select pg_temp.expect('the move is audited on the resident', (:'m_n')::integer, 1);

\echo '--- a departed resident no longer occupies the room'
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
update public.residents set status = 'departed', departed_on = public.site_today() where id = :'late_id';
select occupants from public.v_room_occupancy where room_id = :'room_id' \gset d_
select pg_temp.expect('departed resident is not counted', (:'d_occupants')::integer, 0);
update public.residents set status = 'active', departed_on = null where id = :'late_id';
reset role;

\echo ''
\echo '=========== H. EVACUATION AND ROLL CALL (migration 017) ==========='
reset role;
select feature_buildings, feature_evacuation from public.app_settings \gset f_
select pg_temp.expect('features default off: buildings',  (:'f_feature_buildings')::boolean, false);
select pg_temp.expect('features default off: evacuation', (:'f_feature_evacuation')::boolean, false);

\echo '--- the need is one code from a fixed list'
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
update public.residents set evac_need = 'mobility' where id = :'late_id';
select pg_temp.try('supervisor sets a need outside the list', 'update public.residents set evac_need = ''diabetic'' where id = ' || quote_literal(:'late_id'));
reset role;

\echo '--- a guard reads the evacuation list, needs first, but not the need on the status view'
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select evac_need from public.v_evacuation_list where id = :'late_id' \gset e_
select pg_temp.expect('guard sees the need on the evacuation list', :'e_evac_need'::text, 'mobility'::text);
select count(*) as n from information_schema.columns where table_name = 'v_resident_status' and column_name = 'evac_need' \gset c_
select pg_temp.expect('the status view (gate cards, search) carries no need', (:'c_n')::integer, 0);
select pg_temp.try('guard changes a need', 'update public.residents set evac_need = ''none'' where id = ' || quote_literal(:'late_id'));

\echo '--- any staff member runs a roll call; marks are idempotent; anon cannot'
select (public.start_roll_call('dddddddd-0000-4000-8000-000000000001', 'drill')).kind as k \gset rc_
select pg_temp.expect('guard starts a drill', :'rc_k'::text, 'drill'::text);
select (public.start_roll_call('dddddddd-0000-4000-8000-000000000001', 'incident')).kind as k \gset rc2_
select pg_temp.expect('a replayed start keeps the original', :'rc2_k'::text, 'drill'::text);
select public.mark_roll_call('dddddddd-0000-4000-8000-000000000001', :'late_id', 'eeeeeeee-0000-4000-8000-000000000001');
select public.mark_roll_call('dddddddd-0000-4000-8000-000000000001', :'late_id', 'eeeeeeee-0000-4000-8000-000000000002');
select count(*) as n from public.roll_call_marks where roll_call_id = 'dddddddd-0000-4000-8000-000000000001' \gset m_
select pg_temp.expect('two marks for one resident are one row', (:'m_n')::integer, 1);
select pg_temp.try('guard deletes a mark', 'delete from public.roll_call_marks where roll_call_id = ''dddddddd-0000-4000-8000-000000000001''');
select pg_temp.try('guard inserts a mark directly', 'insert into public.roll_call_marks (roll_call_id, resident_id) values (''dddddddd-0000-4000-8000-000000000001'', ' || quote_literal(:'late_id') || ')');
select pg_temp.try('guard starts a roll call of an unknown kind', 'select public.start_roll_call(''dddddddd-0000-4000-8000-000000000009'', ''party'')');
select (public.end_roll_call('dddddddd-0000-4000-8000-000000000001')).ended_at is not null as ended \gset end_
select pg_temp.expect('the roll call is ended', (:'end_ended')::boolean, true);
reset role;
set request.jwt.claim.sub = '';
set role anon;
select pg_temp.try('anon starts a roll call', 'select public.start_roll_call(''dddddddd-0000-4000-8000-000000000002'', ''drill'')');
select pg_temp.try('anon reads the evacuation list', 'select * from public.v_evacuation_list');
select pg_temp.try('anon reads roll calls', 'select * from public.roll_calls');
reset role;

\echo '--- erasing the resident removes their marks'
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select public.erase_resident(:'late_id', 'test');
reset role;
select count(*) as n from public.roll_call_marks where resident_id = :'late_id' \gset gone_
select pg_temp.expect('marks go with the resident', (:'gone_n')::integer, 0);

\echo ''
\echo '=========== I. HOUSEHOLDS (migration 018) ==========='
reset role;
-- Nair, Brennan and Nowak were erased by earlier sections; these three survive.
select id as hh_a from public.residents where last_name = 'Fitzgerald' \gset
select id as hh_b from public.residents where last_name = 'Mensah'     \gset
select id as hh_c from public.residents where last_name = 'Haddad'     \gset
select feature_households from public.app_settings \gset f_
select pg_temp.expect('households default off', (:'f_feature_households')::boolean, false);

\echo '--- a supervisor links two residents; a third joins; the label counts them'
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select public.join_household(:'hh_a', :'hh_b') as hh \gset
select public.join_household(:'hh_c', :'hh_b') as hh2 \gset
select pg_temp.expect('the third joined the same household', :'hh2'::text, :'hh'::text);
select household_size from public.v_resident_room where id = :'hh_a' \gset s_
select pg_temp.expect('three in the household', (:'s_household_size')::integer, 3);
select pg_temp.try('a resident joins their own household', 'select public.join_household(' || quote_literal(:'hh_a') || ', ' || quote_literal(:'hh_a') || ')');
reset role;

\echo '--- a guard sees the family on the list but cannot change it'
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select household_label from public.v_evacuation_list where id = :'hh_a' \gset g_
select pg_temp.expect('guard sees the family label', :'g_household_label'::text like '%family (3)', true);
select pg_temp.try('guard links residents',   'select public.join_household(' || quote_literal(:'hh_a') || ', ' || quote_literal(:'hh_b') || ')');
select pg_temp.try('guard creates a household', 'insert into public.households default values');
reset role;

\echo '--- leaving empties and prunes; erasure leaves the rest of the family intact'
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
update public.residents set household_id = null where id = :'hh_c';
reset role;
select count(*) as n from public.households where id = :'hh' \gset still_
select pg_temp.expect('a household with members remains', (:'still_n')::integer, 1);
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select public.erase_resident(:'hh_a', 'test');
reset role;
select household_id = :'hh' as same from public.residents where id = :'hh_b' \gset b_
select pg_temp.expect('the remaining member keeps the household', (:'b_same')::boolean, true);
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
update public.residents set household_id = null where id = :'hh_b';
reset role;
select count(*) as n from public.households where id = :'hh' \gset gone_
select pg_temp.expect('the empty household is pruned', (:'gone_n')::integer, 0);

\echo ''
\echo '=========== J. REPORTS ARE LOGGED (migration 019) ==========='
reset role;
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select pg_temp.try('guard logs a report export', 'select public.note_report(''register'', ''test'', current_date, current_date)');
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select pg_temp.try('supervisor logs a report without a reason', 'select public.note_report(''register'', ''  '', current_date, current_date)');
select public.note_report('register', 'inspection', current_date - 7, current_date);
reset role;
select count(*) as n from public.admin_audit where table_name = 'reports' and row_id = 'register' and action = 'export' and note like 'inspection [%' \gset rp_
select pg_temp.expect('the export is on the record with its range', (:'rp_n')::integer, 1);
