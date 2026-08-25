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

insert into public.checkin_events (resident_id, guard_id, occurred_at, note)
values (:'boundary_id', '11111111-1111-1111-1111-111111111111', :'seed_ts'::timestamptz, null);

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
-- statutory breach: no role holds UPDATE on daily_compliance, and
-- annotate_compliance_day() deliberately cannot flip an outcome.
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
delete from public.compliance_annotations;
delete from public.daily_compliance;
delete from public.checkin_events;
select id as adult_id from public.residents where last_name='Brennan' \gset
select id as other_id from public.residents where last_name='Haddad'  \gset

-- Brennan: missed the last 3 completed days. Haddad: missed 1, explained.
insert into public.daily_compliance (resident_id, compliance_date, required, presented, checkin_count, closed_at)
select :'adult_id', public.site_today() - g, true, false, 0, now() from generate_series(1,3) g;
insert into public.daily_compliance (resident_id, compliance_date, required, presented, checkin_count, closed_at)
values (:'other_id', public.site_today() - 1, true, false, 0, now());

set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

\echo '--- an annotation records a reason without changing the outcome'
select compliance_date = public.site_today() - 1 as dated_yesterday
from public.annotate_compliance_day(:'other_id', public.site_today() - 1, 'In hospital, ward confirmed') \gset ann_

select pg_temp.expect('annotation is dated to the day it explains',
  (:'ann_dated_yesterday')::boolean, true);

select presented as still_not_presented from public.daily_compliance
 where resident_id = :'other_id' and compliance_date = public.site_today() - 1 \gset

select pg_temp.expect('annotation does not flip presented',
  (:'still_not_presented')::boolean, false);

\echo '--- states and consecutive-miss ordering'
select full_name, state, open_breaches, noted_breaches, consecutive_missed
from public.attention_list() order by consecutive_missed desc, full_name;

select state, open_breaches, noted_breaches, consecutive_missed
from public.v_resident_compliance where id = :'adult_id' \gset brennan_

select pg_temp.expect('Brennan: state = breach_open', (:'brennan_state')::text, 'breach_open');
select pg_temp.expect('Brennan: open_breaches = 3', (:'brennan_open_breaches')::integer, 3);
select pg_temp.expect('Brennan: consecutive_missed = 3', (:'brennan_consecutive_missed')::integer, 3);

select state, open_breaches, noted_breaches, consecutive_missed
from public.v_resident_compliance where id = :'other_id' \gset haddad_

select pg_temp.expect('Haddad: state = breach_noted', (:'haddad_state')::text, 'breach_noted');
select pg_temp.expect('Haddad: open_breaches = 0', (:'haddad_open_breaches')::integer, 0);
select pg_temp.expect('Haddad: noted_breaches = 1', (:'haddad_noted_breaches')::integer, 1);

\echo '--- attention_list: explained breach is demoted below the unexplained one, never suppressed'
-- Other residents pick up a 'never' state here (their history was wiped
-- above), which legitimately outranks an explained breach per the case
-- ordering in attention_list() — so this asserts relative rank, not adjacency.
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
select pg_temp.expect('attention_list: Brennan (unexplained breach) ranks first',
  (:'ordrank_brennan_rank')::integer, 1);
select pg_temp.expect('attention_list: Haddad (explained breach) ranks last, behind every never-seen resident, but still present',
  (:'ordrank_haddad_rank')::integer, 8);

\echo '--- attention_list: the cap never drops a breach, open or annotated'
-- 'never' sorts above 'breach_noted' by deliberate product ranking (an
-- unknown outranks a human-triaged known), and there are 6 never-seen
-- residents in play here — more than enough to push Haddad's annotated
-- breach past a small max_results if the LIMIT were applied uniformly. The
-- product rule is "flag but never suppress": an annotation may demote a
-- breach in the guard's attention, but it must never make the row vanish.
--
-- Two cap values, deliberately either side of the breach count (2 breach
-- rows: Brennan open, Haddad noted):
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

select pg_temp.expect('attention_list(1): the open breach (Brennan) is never dropped by a cap smaller than the breach count',
  (:'cap1_brennan_present')::integer, 1);
select pg_temp.expect('attention_list(1): the annotated breach (Haddad) is never dropped by a cap smaller than the breach count',
  (:'cap1_haddad_present')::integer, 1);
select pg_temp.expect('attention_list(1): both breaches plus exactly 1 never-seen row (the cap) get through',
  (:'cap1_total_returned')::integer, 3);

select count(*) filter (where id = :'adult_id') as brennan_present,
       count(*) filter (where id = :'other_id') as haddad_present,
       count(*) as total_returned
from public.attention_list(2) \gset cap_

select pg_temp.expect('attention_list(2): the open breach (Brennan) is never dropped by the cap',
  (:'cap_brennan_present')::integer, 1);
select pg_temp.expect('attention_list(2): the annotated breach (Haddad) is never dropped by the cap',
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

\echo '--- annotations are append-only'
-- Printed (not \gset) so these land in run.sh's authorisation-summary grep
-- alongside every other privileged-operation probe. The positive assertion
-- below then proves the row genuinely survived, the same pattern used for
-- checkin_events / daily_compliance above, rather than string-matching the
-- try() report.
select pg_temp.try('guard edits an annotation',
                   'update public.compliance_annotations set note=''changed'' where true');
select pg_temp.try('guard deletes an annotation',
                   'delete from public.compliance_annotations where true');

select note from public.compliance_annotations
 where resident_id = :'other_id' and compliance_date = public.site_today() - 1 \gset

select pg_temp.expect('annotation survives guard UPDATE/DELETE attempts: note unchanged',
  (:'note')::text, 'In hospital, ward confirmed');

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
select count(*) as annotations_after_erasure  from public.compliance_annotations where resident_id = :'adult_id' \gset

select pg_temp.expect('export_resident_record includes a daily_compliance key',
  (:'export_has_register')::boolean, true);
select pg_temp.expect('erase_resident returns a non-null result',
  (:'erased')::boolean, true);
select pg_temp.expect('erase_resident cascades: no register rows remain for the erased resident',
  (:'register_rows_after_erasure')::integer, 0);
select pg_temp.expect('erase_resident cascades: no annotations remain for the erased resident',
  (:'annotations_after_erasure')::integer, 0);
