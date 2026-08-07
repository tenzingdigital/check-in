\set ON_ERROR_STOP on
\pset pager off

-- Assertion helper. RLS does not raise on SELECT, it silently filters rows to
-- zero, so reporting on success/failure alone would call a blocked read
-- "ALLOWED". Report the affected row count too.
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

-- ---------------------------------------------------------------- staff
insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'guard@hut.example',  '{"full_name":"Gina Guard","role":"guard"}'),
  ('22222222-2222-2222-2222-222222222222', 'super@hut.example',  '{"full_name":"Sam Supervisor","role":"supervisor"}'),
  ('33333333-3333-3333-3333-333333333333', 'admin@hut.example',  '{"full_name":"Ada Admin","role":"admin"}'),
  ('44444444-4444-4444-4444-444444444444', 'nobody@hut.example', '{"full_name":"Suspended Sid"}');

update public.profiles set active = false where id = '44444444-4444-4444-4444-444444444444';

\echo '### profiles auto-created by the auth trigger'
select full_name, role, active from public.profiles order by full_name;

\i :seed_path

-- Capture ids while still superuser. A guard cannot run
-- "select id from public.residents" at all -- that is the whole point of the
-- minimisation policy -- so tests must not depend on being able to.
select id as okonkwo_id from public.residents where last_name='Okonkwo' \gset
select id as nair_id    from public.residents where last_name='Nair'    \gset
select id as mensah_id  from public.residents where last_name='Mensah'  \gset

\echo ''
\echo '=========== A. WHAT A GUARD SEES ==========='
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

\echo '--- A1: guard-facing view (note: no date_of_birth column exists here)'
select full_name, room_ref, age_years, is_adult, presence, compliance
from public.v_resident_status order by last_name;

\echo '--- A2: data minimisation — rows of residents.date_of_birth each role sees'
select 'guard' as role, count(*) as dob_rows_visible from public.residents;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select 'supervisor' as role, count(*) as dob_rows_visible from public.residents;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select 'admin' as role, count(*) as dob_rows_visible from public.residents;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
\echo '    (the guard still sees all 10 residents through v_resident_status —'
\echo '     just without their dates of birth)'

\echo ''
\echo '--- A3: search (typo, reversed name order, accents, room number)'
select 'okonkwo'              as query, full_name from public.search_residents('okonkwo')
union all select 'brennan aoife',         full_name from public.search_residents('brennan aoife')
union all select 'novak (typo→Nowak)',    full_name from public.search_residents('novak')
union all select 'okonkow (typo)',        full_name from public.search_residents('okonkow')
union all select 'suilleabhain (accents)',full_name from public.search_residents('suilleabhain')
union all select 'fitz (prefix)',         full_name from public.search_residents('fitz')
union all select 'B-11 (room)',           full_name from public.search_residents('B-11')
union all select 'zzzz (no match)',       full_name from public.search_residents('zzzz');

\echo ''
\echo '=========== B. THE SIGN-IN FLOW ==========='
\echo '--- B1: sign Okonkwo in; RPC returns her refreshed status'
select full_name, presence, compliance,
       round(extract(epoch from (due_by - now()))/3600, 1) as hours_until_next_due
from public.record_check(:'okonkwo_id', 'in');

\echo '--- B2: double-tap protection (two more taps inside 60s)'
select count(*) as in_events_before from public.check_events
 where resident_id=:'okonkwo_id' and direction='in';
select 1 as _ from public.record_check(:'okonkwo_id','in') limit 1;
select 1 as _ from public.record_check(:'okonkwo_id','in') limit 1;
select count(*) as in_events_after from public.check_events
 where resident_id=:'okonkwo_id' and direction='in';

\echo '--- B3: attribution — every event carries the guard who did it'
select resident_name, direction, guard_name,
       to_char(occurred_at,'HH24:MI:SS') as at
from public.v_check_log order by occurred_at desc limit 3;

\echo ''
\echo '=========== C. THE 24-HOUR RULE ==========='
\echo '--- C1: who owes a check-in (adults only)'
select full_name, age_years, compliance,
       coalesce(round(extract(epoch from (now()-last_in_at))/3600,1)::text,'never') as hrs_since_in
from public.overdue_residents() order by compliance, full_name;

\echo '--- C2: the 17-year-old is exempt and never appears above'
select full_name, age_years, is_adult, compliance
from public.v_resident_status where last_name='Marchetti';

\echo '--- C3: the 24h boundary itself, and the 18th-birthday boundary'
reset role;
insert into public.residents (id, first_name, last_name, date_of_birth, room_ref) values
  ('aaaaaaaa-0000-0000-0000-000000000001','Edge','Nineteen59', current_date - interval '30 years', 'T-01'),
  ('aaaaaaaa-0000-0000-0000-000000000002','Edge','TwentyFour01',current_date - interval '30 years', 'T-02'),
  ('aaaaaaaa-0000-0000-0000-000000000003','Edge','TurnsEighteenToday', current_date - interval '18 years', 'T-03'),
  ('aaaaaaaa-0000-0000-0000-000000000004','Edge','EighteenTomorrow',
     current_date - interval '18 years' + interval '1 day', 'T-04');
insert into public.check_events (resident_id, guard_id, direction, occurred_at) values
  ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','in', now() - interval '23 hours 59 minutes'),
  ('aaaaaaaa-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','in', now() - interval '24 hours 1 minute');
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select last_name, age_years, is_adult, compliance,
       coalesce(round(extract(epoch from (now()-last_in_at))/3600, 2)::text,'—') as hrs_since_in
from public.v_resident_status where first_name='Edge' order by last_name;

\echo '--- C4: header summary counters'
select * from public.hut_summary();

\echo ''
\echo '=========== D. INTEGRITY OF THE AUDIT TRAIL ==========='
select pg_temp.try('guard UPDATEs an event',
                   'update public.check_events set direction=''out'' where id=(select min(id) from public.check_events)');
select (select count(*) from public.check_events) as events_still_present;
select pg_temp.try('guard DELETEs all events',
                   'delete from public.check_events where true');
select (select count(*) from public.check_events) as events_still_present_after_delete;
select pg_temp.try('guard forges attribution to the admin',
                   'insert into public.check_events (resident_id,guard_id,direction) values ('
                   || quote_literal(:'okonkwo_id') || ',''33333333-3333-3333-3333-333333333333'',''in'')');
select pg_temp.try('guard promotes self to admin',
                   'update public.profiles set role=''admin'' where id=auth.uid()');
select full_name, role from public.profiles where id='11111111-1111-1111-1111-111111111111';
select pg_temp.try('guard edits a resident record',
                   'update public.residents set last_name=''Hacked'' where true');
select pg_temp.try('guard widens the compliance window to 999h',
                   'update public.app_settings set compliance_window_hours=168');

\echo ''
\echo '=========== E. SUSPENDED ACCOUNT ==========='
set request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
select count(*) as rows_visible_to_suspended_account from public.v_resident_status;
select pg_temp.try('suspended account records a check',
                   'select public.record_check(' || quote_literal(:'okonkwo_id') || ',''in'')');

\echo ''
\echo '=========== F. GDPR OPERATIONS ==========='
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select pg_temp.try('guard runs an Art.15 export',
                   'select public.export_resident_record(' || quote_literal(:'okonkwo_id') || ')');
select pg_temp.try('guard erases a resident',
                   'select public.erase_resident(' || quote_literal(:'okonkwo_id') || ')');

set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
\echo '--- F1: admin Art.15 / Art.20 export'
select jsonb_pretty(public.export_resident_record(
         :'nair_id')) as portable_export;

\echo '--- F2: admin Art.17 erasure'
select count(*) as nair_events_before from public.check_events
 where resident_id=:'nair_id';
select public.erase_resident(:'nair_id',
                             'DSR: erasure requested 2026-08-07') as result;
select count(*) as nair_resident_rows_after from public.residents where last_name='Nair';
select count(*) as orphan_events_after from public.check_events e
 where not exists (select 1 from public.residents r where r.id=e.resident_id);
\echo '    erasure_log keeps proof but not the person:'
select events_removed, reason, left(resident_digest,20)||'…' as digest from public.erasure_log;

\echo ''
\echo '=========== G. RETENTION PURGE ==========='
reset role;
update public.app_settings set event_retention_days = 1;
insert into public.check_events (resident_id, guard_id, direction, occurred_at)
values (:'mensah_id',
        '11111111-1111-1111-1111-111111111111','in', now() - interval '10 days');
select count(*) as before_purge from public.check_events;
select public.purge_expired_check_events() as rows_purged;
select count(*) as after_purge from public.check_events;
update public.app_settings set event_retention_days = 90;

\echo ''
\echo '=========== H. LOGGED-OUT (anon key only) ==========='
reset role;
set request.jwt.claim.sub = '';   -- logged out: auth.uid() is null
set role anon;
select pg_temp.try('anon reads the resident view',   'select * from public.v_resident_status');
select pg_temp.try('anon reads the log view',        'select * from public.v_check_log');
select pg_temp.try('anon searches residents',        'select public.search_residents(''a'')');
select pg_temp.try('anon reads residents table',     'select * from public.residents');
select pg_temp.try('anon inserts a check event',     'insert into public.check_events (resident_id,guard_id,direction) values (''11111111-2222-3333-4444-555555555555'',''11111111-2222-3333-4444-555555555555'',''in'')');
reset role;

\echo ''
\echo '=========== DONE ==========='
