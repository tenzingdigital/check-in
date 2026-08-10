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
