-- 015: v_resident_compliance without the full-table window function.
--
-- The register page loads this view for every resident on every visit and
-- once a minute after that. Migration 008's version computed the streak of
-- consecutive missed days with a window function over EVERY closed register
-- row in the table, and the other tallies with three GROUP BYs over the same
-- table — fine at 6 ms on a laptop, seven seconds on a 0.1-CPU, 256 MB
-- database (docs/KNOWN-ISSUES.md 19d), and enough to push that instance out
-- of memory on 4 September 2026 (19c).
--
-- Same columns, same values, same order (attention_list() returns setof this
-- view and depends on the physical column order). Each number is now a short
-- index probe under one resident's own rows:
--
--   open_breaches      count of required-and-missed closed days
--   last_seen_on       the latest closed day they presented
--   absent_in_window   required-and-missed closed days in the rolling window
--   consecutive_missed required-and-missed closed days AFTER the latest
--                      required-and-presented closed day — exactly what the
--                      old running sum counted, without sorting the table
--
-- The partial index below serves last_seen_on and the streak boundary; the
-- existing daily_compliance_breach_idx serves the three counts.

create index if not exists daily_compliance_seen_idx
  on public.daily_compliance (resident_id, compliance_date desc)
  where presented;

create or replace view public.v_resident_compliance as
with s as (select * from public.app_settings where id),
today as (select public.site_today() as d)
select
  r.id,
  btrim(r.first_name) || ' ' || btrim(r.last_name) as full_name,
  r.id_type,
  r.id_number,
  r.status,
  (date_part('year', age(r.date_of_birth)))::integer as age_years,
  req.required_today,
  coalesce(tr.presented, false) as seen_today,
  coalesce(tr.checkin_count, 0) as checkins_today,
  b.open_breaches,
  st.consecutive_missed,
  wt.absent_in_window,
  s.absence_window_days,
  s.absence_window_limit,
  s.warn_after_consecutive_nights,
  ls.last_seen_on,
  case
    when r.status <> 'active' then 'not_required'
    when not req.required_today then 'exempt'
    when b.open_breaches > 0 then 'breach_open'
    when coalesce(tr.presented, false) then 'seen_today'
    when ls.last_seen_on is null and not coalesce(tr.presented, false) then 'never'
    when date_part('hour', now() at time zone s.local_timezone) >= s.due_soon_after_hour then 'due_today'
    else 'expected'
  end as state
from public.residents r
cross join s
cross join today
cross join lateral (
  select public.compliance_required(r.date_of_birth, (r.registered_at at time zone s.local_timezone)::date,
                                    r.departed_on, today.d, s.adult_age_years) as required_today
) req
left join public.daily_compliance tr
  on tr.resident_id = r.id and tr.compliance_date = today.d
cross join lateral (
  select count(*)::integer as open_breaches
    from public.daily_compliance x
   where x.resident_id = r.id and x.required and not x.presented and x.closed_at is not null
) b
cross join lateral (
  select max(x.compliance_date) as last_seen_on
    from public.daily_compliance x
   where x.resident_id = r.id and x.presented and x.closed_at is not null
) ls
cross join lateral (
  select count(*)::integer as absent_in_window
    from public.daily_compliance x
   where x.resident_id = r.id and x.required and not x.presented and x.closed_at is not null
     and x.compliance_date >= today.d - s.absence_window_days
     and x.compliance_date <  today.d
) wt
cross join lateral (
  select count(*)::integer as consecutive_missed
    from public.daily_compliance x
   where x.resident_id = r.id and x.required and not x.presented and x.closed_at is not null
     and x.compliance_date > coalesce((
           select max(y.compliance_date) from public.daily_compliance y
            where y.resident_id = r.id and y.required and y.presented and y.closed_at is not null
         ), date '1900-01-01')
) st
where public.is_staff();

comment on view public.v_resident_compliance is
  'State precedence is deliberate: an open breach outranks seen_today, because '
  'clearing today does not clear a missed Tuesday. absent_in_window and '
  'consecutive_missed are reported against the configured thresholds; reaching '
  'one is a fact the register states, never a verdict it delivers. Use state '
  'for the badge and seen_today for the tick, separately. Rewritten in 015 as '
  'per-resident index probes; see that file.';

revoke all on public.v_resident_compliance from anon, public;
grant select on public.v_resident_compliance to authenticated;

-- Fresh statistics for the tables every view cross-joins. app_settings has
-- one row and is never analysed by autovacuum (its threshold is ~50 changed
-- rows), so the planner had been guessing ~300 rows for it, costing this
-- view at 85,000 rows and JIT-compiling it on every run. jobs.js repeats
-- this nightly; database.js turns JIT off for the app regardless.
analyze public.app_settings;
analyze public.residents;
analyze public.profiles;
analyze public.daily_compliance;
