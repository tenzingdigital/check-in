// Reports — Stage 4 of docs/PRODUCT-ROADMAP.md.
//
//   GET /api/reports/:name?from=YYYY-MM-DD&to=YYYY-MM-DD&reason=…&format=csv|json
//
//   register    one row per resident per day in the range: required, presented, first seen
//   attendance  one row per resident: days required, presented, missed, streak, last seen
//   movements   the door log for the range
//   occupancy   every room with its occupants and who is on site now
//   evacuation  everyone active: room, presence, evacuation need, household
//   roll-calls  drills and incidents in the range, with how many were accounted for
//   absent      everyone off site now, with when and by whom they were signed out
//   overnight   who was off site at midnight, night by night (migration 027)
//   away        every sign OUT with the sign IN that followed: the check-out/check-in list
//   absences    authorised absences overlapping the range (migration 028)
//   roll-call-marks  who was marked safe on each roll call, by whom
//   room-history     every room each resident has had
//   breaches    breach reports issued to IPAS in the range (migration 029)
//   weekly      the Sunday Weekly Register Update: absence spans, weekend, removals, rooms (migration 035); also as a Word document (format=docx): the Sunday return in the centre manager's layout (052)
//   missed      who missed the daily register over a range, one row per resident with the dates (the Absences tab's export)
//   supervision  Appendix 5 child-supervision arrangements in the range (053)
//   guardian-gaps      households that had children on site, no guardian on site and no arrangement at the midnight snapshot, night by night (054)
//   checkin-conflicts  daily check-ins recorded while the In & out register had the person out (054)
//
// Supervisors and admins. A reason is required and every export is written
// to admin_audit by note_report() in the same transaction, so an inspection
// pack has a trail. CSV is the default; format=json is for the printable
// page in the browser (and the tests).
//
//   GET /api/reports/inspection-pack?from=&to=&reason=
//
// The one-click inspection pack: the weekly register update, vacancies,
// breach reports and the evacuation list, run together and handed back as
// one document instead of four separate exports. It is not a row in REPORTS
// above because it has no single query of its own — it is a fixed bundle of
// the four reports a HIQA/IPAS visit actually asks for, each still run
// against its own query so a change to one of those four is a change to the
// pack for free. One note_report() call audits the whole pack under the name
// "inspection-pack"; it is JSON-only, since the point is a single printed
// document, not a spreadsheet. No migration: note_report() already accepts
// any report name, so nothing in the database needed to change.
//
//   GET /api/missed?from=&to=
//
// The Absences tab's range: the same query as the "missed" report, without
// the reason or the audit row — looking at the tab is not audited, as the
// resident list it read before was not. Named for the report it shares its
// query with — "absences" is already the Authorised absences report, and the
// two mean opposite things. It also returns closed_through, the
// last register date the nightly job has closed, so the tab can say when a
// range reaches into a night that is not closed yet rather than show an
// empty table that reads as "nobody missed".

const express = require('express');
const { wrap } = require('../lib/asyncRoute');
const db = require('../database');
const { HttpError, dateParam } = require('../lib/api');
const weekly = require('../lib/weeklyReport');

const router = express.Router();

// from/to for a ranged query: YYYY-MM-DD each, to defaults to from, at most
// a year. Shared by /reports/:name and /absences so the two never drift.
function rangeParams(query) {
  const from = dateParam(query.from, 'from');
  const to = dateParam(query.to || query.from, 'to');
  if (to < from) throw new HttpError(400, 'to must not be before from');
  const days = (Date.parse(to) - Date.parse(from)) / 86400000;
  if (days > 366) throw new HttpError(400, 'A range covers at most a year');
  return { from, to };
}

// Who missed the daily register between $1 and $2, one row per active
// resident with at least one miss. A miss is a closed day that was required
// and not presented — nothing else decides it: an authorised absence is
// written required = false by close_out_compliance_days(), a child is never
// required, and today's row is open until the nightly job closes it, so
// none of them can appear here. nights_required is the resident's own
// closed required days in the range, so someone who arrived on Thursday
// reads "2 of 3", not "2 of 7". `flat` swaps the text[] of dates for one
// comma-separated column, for csv/xlsx.
function missedSql({ flat = false } = {}) {
  return `
    with days as (
      select dc.resident_id,
             count(*) filter (where dc.required and not dc.presented)::int as nights_missed,
             count(*) filter (where dc.required)::int                     as nights_required,
             array_agg(dc.compliance_date::text order by dc.compliance_date)
               filter (where dc.required and not dc.presented)            as missed_dates
        from daily_compliance dc
       where dc.compliance_date between $1 and $2
         and dc.closed_at is not null
       group by dc.resident_id
    ),
    breach as (
      select distinct on (resident_id) resident_id, kind, issued_on
        from breach_reports order by resident_id, issued_on desc, id desc
    )
    select ${flat ? "lpad(r.ref::text, 4, '0') as ref" : 'r.id, r.ref'}, btrim(r.first_name) || ' ' || btrim(r.last_name) as ${flat ? 'resident' : 'full_name'},
           rm.building, rm.room,
           d.nights_missed, d.nights_required,
           ${flat ? "array_to_string(d.missed_dates, ', ') as dates" : 'd.missed_dates'},
           c.consecutive_missed, c.absent_in_window,
           c.last_seen_on::text as ${flat ? 'last_seen' : 'last_seen_on'},
           ${flat ? '' : 'c.seen_today, '}
           b.kind as last_breach_kind, b.issued_on::text as last_breach_on
      from days d
      join residents r on r.id = d.resident_id and r.status = 'active'
      left join v_resident_room rm on rm.id = r.id
      left join v_resident_compliance c on c.id = r.id
      left join breach b on b.resident_id = r.id
     where d.nights_missed > 0
     order by d.nights_missed desc, c.consecutive_missed desc nulls last, r.last_name, r.first_name`;
}

const REPORTS = {
  register: {
    title: 'Daily register',
    ranged: true,
    sql: `select dc.compliance_date as date, v.full_name as resident, v.age_years as age,
                 dc.required, dc.presented,
                 to_char(dc.first_seen_at at time zone s.local_timezone, 'HH24:MI') as first_seen,
                 dc.checkin_count as check_ins, (dc.closed_at is not null) as closed
            from daily_compliance dc
            join v_resident_status v on v.id = dc.resident_id
            cross join (select local_timezone from app_settings where id) s
           where dc.compliance_date between $1 and $2
           order by dc.compliance_date, v.last_name, v.first_name`,
  },
  attendance: {
    title: 'Attendance summary',
    ranged: true,
    sql: `select v.full_name as resident, v.age_years as age, v.status,
                 count(*) filter (where dc.required)                                as days_required,
                 count(*) filter (where dc.required and dc.presented)               as days_presented,
                 count(*) filter (where dc.required and not dc.presented and dc.closed_at is not null) as days_missed,
                 max(dc.compliance_date) filter (where dc.presented)                 as last_seen,
                 c.consecutive_missed as current_streak_missed
            from v_resident_status v
            left join daily_compliance dc on dc.resident_id = v.id and dc.compliance_date between $1 and $2
            left join v_resident_compliance c on c.id = v.id
           group by v.id, v.full_name, v.age_years, v.status, v.last_name, v.first_name, c.consecutive_missed
           order by v.last_name, v.first_name`,
  },
  movements: {
    title: 'Movement log',
    ranged: true,
    sql: `select to_char(l.occurred_at at time zone s.local_timezone, 'YYYY-MM-DD HH24:MI') as at,
                 l.resident_name as resident, upper(l.kind) as direction, l.guard_name as recorded_by,
                 l.late_entry as recorded_later
            from v_check_log l
            cross join (select local_timezone from app_settings where id) s
           where (l.occurred_at at time zone s.local_timezone)::date between $1 and $2
           order by l.occurred_at`,
  },
  occupancy: {
    title: 'Occupancy by building and room',
    ranged: false,
    sql: `select o.building, o.floor, o.room, o.capacity, o.occupants, o.on_site,
                 (select string_agg(p->>'full_name' || case when (p->>'presence') = 'in' then ' (on site)' else '' end, '; ')
                    from jsonb_array_elements(o.residents) p) as residents
            from v_room_occupancy o
           where not o.archived
           order by o.building_sort, o.building, o.room_sort, o.floor, o.room`,
  },
  // Vacancies against the contracted capacity, with the bed configuration:
  // the figures the weekly IPAS return asks for (migration 031).
  vacancies: {
    title: 'Vacancies against contracted capacity',
    ranged: false,
    sql: `select o.building, o.floor, o.room, o.bed_config as beds,
                 o.capacity as physical_beds, coalesce(o.contracted_capacity, o.capacity) as contracted_beds,
                 o.occupants, coalesce(o.contracted_capacity, o.capacity) - o.occupants as vacancies,
                 o.status, o.note
            from v_room_occupancy o
           where not o.archived
           order by o.building_sort, o.building, o.room_sort, o.floor, o.room`,
  },
  evacuation: {
    title: 'Evacuation list',
    ranged: false,
    sql: `select e.building, e.room_label as room, e.full_name as resident,
                 case when e.is_adult then 'adult' else 'child' end as age_group,
                 case when e.presence = 'in' then 'on site' else 'off site' end as now,
                 case e.evac_need when 'none' then '' when 'mobility' then 'needs help to move'
                      when 'hearing' then 'needs help to hear the alarm' when 'sight' then 'needs help to find the way'
                      when 'carer' then 'infant or carer' else 'needs help' end as assistance,
                 e.household_label as family
            from v_evacuation_list e`,
  },
  'roll-calls': {
    title: 'Drills and roll calls',
    ranged: true,
    sql: `select to_char(rc.started_at at time zone s.local_timezone, 'YYYY-MM-DD HH24:MI') as started,
                 rc.kind, p.full_name as started_by,
                 to_char(rc.ended_at at time zone s.local_timezone, 'HH24:MI') as ended,
                 (select count(*)::int from roll_call_marks m where m.roll_call_id = rc.id) as accounted_for,
                 round(extract(epoch from (rc.ended_at - rc.started_at)) / 60)::int as minutes,
                 rc.note
            from roll_calls rc
            left join profiles p on p.id = rc.started_by
            cross join (select local_timezone from app_settings where id) s
           where (rc.started_at at time zone s.local_timezone)::date between $1 and $2
           order by rc.started_at desc`,
  },
};

// Everyone off site right now, whatever the date they left (the "absent
// list" the centre managers asked for), and who was off site at midnight
// on each night in a range (migration 027).
REPORTS.absent = {
  title: 'Absent now',
  ranged: false,
  sql: `select rm.building, rm.room, v.full_name as resident, case when v.is_adult then '' else 'child' end as child,
               to_char(v.last_event_at at time zone s.local_timezone, 'YYYY-MM-DD') as date_out,
               to_char(v.last_event_at at time zone s.local_timezone, 'HH24:MI') as time_out,
               g.full_name as signed_out_by,
               concat_ws('; ', case when v.last_event_at is null then 'never signed in' end,
                         (select 'authorised: ' || a.reason || ' until ' || coalesce(a.ended_on, a.to_date)
                            from authorised_absences a where a.resident_id = v.id
                             and site_today() between a.from_date and coalesce(a.ended_on, a.to_date) limit 1)) as note
          from v_resident_status v
          left join v_resident_room rm on rm.id = v.id
          left join lateral (
            select e.guard_id from gate_events e
             where e.resident_id = v.id order by e.occurred_at desc, e.id desc limit 1) le on true
          left join profiles g on g.id = le.guard_id
          cross join (select local_timezone from app_settings where id) s
         where v.status = 'active' and v.presence = 'out'
         order by v.last_event_at nulls first, v.last_name, v.first_name`,
};
REPORTS.overnight = {
  title: 'Absent overnight',
  ranged: true,
  sql: `select o.night::text as night, rm.building, rm.room,
               lpad(r.ref::text, 4, '0') as ref, btrim(r.first_name) || ' ' || btrim(r.last_name) as resident,
               case when vs.is_adult then '' else 'child' end as child,
               -- The report already held both halves of this and never put
               -- them together: a child was a 'child' cell beside an empty
               -- 'note' cell, sorted by surname among authorised adults, so a
               -- manager had to read two columns, combine them, and notice the
               -- ABSENCE of a word. An under-18 is exempt from the daily rule
               -- (v_resident_compliance evaluates 'exempt' before everything
               -- else), so they never reach Not seen or attention_list either
               -- — this column is the only place the app says it.
               --
               -- Children only. An adult away without authorisation is a
               -- compliance matter with machinery already: the absence window,
               -- the breach report, the Sunday return. For a child it is a
               -- safeguarding matter with no rule behind it, and one column
               -- carrying both would blur two different meanings.
               case
                 when vs.is_adult then ''
                 when absence_authorised(o.resident_id, o.night) then ''
                 when o.off_site_since is null then 'CHILD — NEVER SIGNED IN'
                 else 'CHILD AWAY — NOT AUTHORISED'
               end as concern,
               to_char(o.off_site_since at time zone s.local_timezone, 'YYYY-MM-DD') as date_out,
               to_char(o.off_site_since at time zone s.local_timezone, 'HH24:MI') as time_out,
               concat_ws('; ', case when o.off_site_since is null then 'never signed in' end,
                         case when absence_authorised(o.resident_id, o.night) then 'authorised' end) as note
          from overnight_absences o
          join residents r on r.id = o.resident_id
          left join v_resident_status vs on vs.id = r.id
          left join v_resident_room rm on rm.id = r.id
          cross join (select local_timezone from app_settings where id) s
         where o.night between $1 and $2
         -- Flagged rows first within each night, so the thing being looked
         -- for is the first line on the page rather than alphabetical among
         -- everyone who was properly signed out.
         order by o.night desc,
                  (not vs.is_adult and not absence_authorised(o.resident_id, o.night)) desc,
                  r.last_name, r.first_name`,
};

// Every sign OUT in the range with the sign IN that followed it, one row
// per absence: the "check-out and check-in list" the centres keep by hand.
// An OUT with no IN yet has the in-columns blank. Pairing is by order of
// occurrence for the same resident (window functions over gate_events).
REPORTS.away = {
  title: 'Out and back',
  ranged: true,
  sql: `with s as (select local_timezone as tz from app_settings where id),
            ev as (
              select e.resident_id, e.kind, e.occurred_at, e.guard_id,
                     lead(e.kind)        over w as next_kind,
                     lead(e.occurred_at) over w as next_at,
                     lead(e.guard_id)    over w as next_guard
                from gate_events e
              window w as (partition by e.resident_id order by e.occurred_at, e.id))
       select rm.building, rm.room, lpad(r.ref::text, 4, '0') as ref, btrim(r.first_name) || ' ' || btrim(r.last_name) as resident,
              case when vs.is_adult then '' else 'child' end as child,
              to_char(ev.occurred_at at time zone s.tz, 'YYYY-MM-DD') as date_out,
              to_char(ev.occurred_at at time zone s.tz, 'HH24:MI') as time_out,
              to_char(ev.next_at at time zone s.tz, 'YYYY-MM-DD') as date_in,
              to_char(ev.next_at at time zone s.tz, 'HH24:MI') as time_in,
              case when ev.next_at is null then null
                   else round(extract(epoch from (ev.next_at - ev.occurred_at)) / 3600, 1) end as hours_away,
              g1.full_name as signed_out_by, g2.full_name as signed_in_by
         from ev
         join residents r on r.id = ev.resident_id
         left join v_resident_status vs on vs.id = r.id
         left join v_resident_room rm on rm.id = r.id
         left join profiles g1 on g1.id = ev.guard_id
         left join profiles g2 on g2.id = ev.next_guard
         cross join s
        where ev.kind = 'out' and (ev.next_kind is null or ev.next_kind = 'in')
          and ev.occurred_at >= ($1::date::timestamp) at time zone s.tz
          and ev.occurred_at <  (($2::date + 1)::timestamp) at time zone s.tz
        order by ev.occurred_at desc, r.last_name, r.first_name`,
};

// The Sunday Weekly Register Update (migration 035): absences as spans of
// nights with approval in words, the weekend's on their own, the week's
// departures, and rooms under maintenance or with free beds. The sentence
// in `line` is what head office reads; the other columns are the facts.
REPORTS.weekly = {
  title: 'Weekly register update',
  ranged: true,
  sql: `select * from weekly_register_rows($1, $2)`,
};

// The Absences tab's export: who missed the register over the range, with
// the dates (migration-free; see missedSql above).
REPORTS.missed = {
  title: 'Missed register',
  ranged: true,
  sql: missedSql({ flat: true }),
};

// Appendix 5 arrangements in the range (053): which children were in whose
// care, when, whether overnight was approved, who recorded it. Facts only.
REPORTS.supervision = {
  title: 'Child supervision arrangements',
  ranged: true,
  sql: `select rm.household_label as household,
               (select string_agg(btrim(k.first_name) || ' ' || btrim(k.last_name), ', ' order by k.last_name, k.first_name)
                  from residents k cross join (select adult_age_years from app_settings where id) s
                 where k.household_id = a.household_id and k.status = 'active'
                   and k.date_of_birth > current_date - make_interval(years => s.adult_age_years)) as children,
               btrim(c.first_name) || ' ' || btrim(c.last_name) as carer, crm.room_label as carer_room,
               to_char(a.from_at at time zone tz.local_timezone, 'YYYY-MM-DD HH24:MI') as "from",
               to_char(a.to_at at time zone tz.local_timezone, 'YYYY-MM-DD HH24:MI') as "to",
               a.overnight, p.full_name as recorded_by,
               case when a.ended_at is not null then to_char(a.ended_at at time zone tz.local_timezone, 'YYYY-MM-DD HH24:MI') end as ended_early
          from supervision_arrangements a
          join residents c on c.id = a.carer_id
          left join v_resident_room crm on crm.id = c.id
          left join lateral (select household_label from v_resident_room where household_id = a.household_id limit 1) rm on true
          left join profiles p on p.id = a.recorded_by
          cross join (select local_timezone from app_settings where id) tz
         where (a.from_at at time zone tz.local_timezone)::date <= $2 and (a.to_at at time zone tz.local_timezone)::date >= $1
         order by a.from_at desc`,
};

// The nightly snapshot's record of households that had children on site
// with no guardian on site and no supervision arrangement running (054).
// The row is counts and a time; the household, room and children are read
// from the register as it is at the export, not as it was that night — a
// child who has since turned eight reads (8), a family since moved reads the
// new room. That is what a supervisor opening this in the morning wants
// (who do I go and see), and the night's own numbers are in the two count
// columns untouched. Every child in the household is listed, not only those
// who were on site, because the snapshot recorded how many, not which.
REPORTS['guardian-gaps'] = {
  title: 'Children on site without a guardian',
  ranged: true,
  sql: `select g.night::text as night,
               hh.household_label as household,
               (select string_agg(distinct rr.room_label, ', ' order by rr.room_label)
                  from v_resident_room rr where rr.household_id = g.household_id and rr.room_label is not null) as room,
               (select string_agg(btrim(k.first_name) || ' ' || btrim(k.last_name) || ' (' || date_part('year', age(k.date_of_birth))::integer || ')', ', ' order by k.date_of_birth)
                  from residents k
                 where k.household_id = g.household_id and k.status = 'active'
                   and k.date_of_birth > current_date - make_interval(years => s.adult_age_years)) as children,
               g.guardians_out,
               to_char(g.first_out_at at time zone s.local_timezone, 'YYYY-MM-DD HH24:MI') as first_out_at
          from overnight_guardian_gaps g
          left join lateral (select household_label from v_resident_room where household_id = g.household_id limit 1) hh on true
          cross join (select local_timezone, adult_age_years from app_settings where id) s
         where g.night between $1 and $2
         order by g.night desc, hh.household_label`,
};

// Check-ins recorded while the In & out register had the person out (054):
// v_checkin_conflicts, ranged on the check-in's site date. The register is
// append-only, so the check-in stands; this list is the correction. A
// last_gate_movement of 'never signed in' is a person the gate has no
// record of at all, which is the same conflict with less to go on.
REPORTS['checkin-conflicts'] = {
  title: 'Check-ins recorded while signed out',
  ranged: true,
  sql: `select to_char(c.occurred_at at time zone s.local_timezone, 'YYYY-MM-DD') as date,
               btrim(r.first_name) || ' ' || btrim(r.last_name) as resident,
               to_char(c.occurred_at at time zone s.local_timezone, 'HH24:MI') as time,
               p.full_name as recorded_by,
               c.source,
               coalesce(c.last_gate_kind, 'never signed in') as last_gate_movement,
               to_char(c.last_gate_at at time zone s.local_timezone, 'YYYY-MM-DD HH24:MI') as last_gate_at
          from v_checkin_conflicts c
          join residents r on r.id = c.resident_id
          left join profiles p on p.id = c.guard_id
          cross join (select local_timezone from app_settings where id) s
         where c.occurred_at >= ($1::date::timestamp) at time zone s.local_timezone
           and c.occurred_at <  (($2::date + 1)::timestamp) at time zone s.local_timezone
         order by c.occurred_at desc, r.last_name, r.first_name`,
};

// Authorised absences overlapping the range, and who was marked safe on
// each roll call, and every room a resident has had (migration 028).
REPORTS.absences = {
  title: 'Authorised absences',
  ranged: true,
  sql: `select lpad(r.ref::text, 4, '0') as ref, btrim(r.first_name) || ' ' || btrim(r.last_name) as resident, rm.building, rm.room,
               a.from_date::text as "from", coalesce(a.ended_on, a.to_date)::text as "to",
               case when a.ended_on is not null and a.ended_on < a.to_date then 'cut short (planned to ' || a.to_date || ')' else '' end as note,
               a.reason, a.guardian_agreed, p.full_name as approved_by,
               to_char(a.created_at at time zone s.local_timezone, 'YYYY-MM-DD HH24:MI') as recorded
          from authorised_absences a
          join residents r on r.id = a.resident_id
          left join v_resident_room rm on rm.id = r.id
          left join profiles p on p.id = a.approved_by
          cross join (select local_timezone from app_settings where id) s
         where daterange(a.from_date, coalesce(a.ended_on, a.to_date), '[]') && daterange($1::date, $2::date, '[]')
         order by a.from_date desc, r.last_name, r.first_name`,
};
REPORTS['roll-call-marks'] = {
  title: 'Roll call: who was marked safe',
  ranged: true,
  sql: `with s as (select local_timezone as tz from app_settings where id)
        select to_char(rc.started_at at time zone s.tz, 'YYYY-MM-DD HH24:MI') as roll_call, rc.kind,
               x.who, x.name, x.room,
               to_char(x.marked_at at time zone s.tz, 'HH24:MI') as marked_safe_at, x.marked_by
          from roll_calls rc
          cross join s
          join lateral (
            select 'resident' as who, btrim(r.first_name) || ' ' || btrim(r.last_name) as name,
                   (select ra.room_label from room_assignments ra
                     where ra.resident_id = r.id and ra.from_at <= m.marked_at and (ra.to_at is null or ra.to_at > m.marked_at)
                     order by ra.from_at desc limit 1) as room,
                   m.marked_at, p.full_name as marked_by
              from roll_call_marks m join residents r on r.id = m.resident_id left join profiles p on p.id = m.marked_by
             where m.roll_call_id = rc.id
            union all
            select v.kind, v.name, v.company, vm.marked_at, p.full_name
              from roll_call_visit_marks vm join visits v on v.id = vm.visit_id left join profiles p on p.id = vm.marked_by
             where vm.roll_call_id = rc.id
          ) x on true
         where (rc.started_at at time zone s.tz)::date between $1 and $2
         order by rc.started_at desc, x.marked_at`,
};
REPORTS['room-history'] = {
  title: 'Room history',
  ranged: true,
  sql: `select lpad(r.ref::text, 4, '0') as ref, btrim(r.first_name) || ' ' || btrim(r.last_name) as resident, ra.room_label as room,
               to_char(ra.from_at at time zone s.local_timezone, 'YYYY-MM-DD HH24:MI') as "from",
               to_char(ra.to_at at time zone s.local_timezone, 'YYYY-MM-DD HH24:MI') as "to",
               p.full_name as moved_by
          from room_assignments ra
          join residents r on r.id = ra.resident_id
          left join profiles p on p.id = ra.changed_by
          cross join (select local_timezone from app_settings where id) s
         where (ra.from_at at time zone s.local_timezone)::date <= $2
           and (ra.to_at is null or (ra.to_at at time zone s.local_timezone)::date >= $1)
         order by ra.from_at desc, r.last_name, r.first_name`,
};

// Breach reports issued in the range (migration 029).
REPORTS.breaches = {
  title: 'Breach reports issued',
  ranged: true,
  sql: `select b.issued_on::text as issued_on, lpad(r.ref::text, 4, '0') as ref, btrim(r.first_name) || ' ' || btrim(r.last_name) as resident, rm.building, rm.room,
               case b.kind when 'house_rules' then 'breach of house rules' else 'misuse of the verification system' end as kind,
               b.reference, p.full_name as issued_by
          from breach_reports b
          join residents r on r.id = b.resident_id
          left join v_resident_room rm on rm.id = r.id
          left join profiles p on p.id = b.issued_by
         where b.issued_on between $1 and $2
         order by b.issued_on desc, r.last_name, r.first_name`,
};

// Staff, visitors, contractors and suppliers on site (migration 024).
REPORTS.visits = {
  title: 'Visitors, staff and contractors',
  ranged: true,
  sql: `select to_char(v.arrived_at at time zone s.local_timezone, 'YYYY-MM-DD HH24:MI') as arrived,
               to_char(v.left_at at time zone s.local_timezone, 'YYYY-MM-DD HH24:MI') as "left",
               v.kind, v.name, v.company, a.full_name as signed_in_by, l.full_name as signed_out_by
          from visits v
          left join profiles a on a.id = v.arrived_by
          left join profiles l on l.id = v.left_by
          cross join (select local_timezone from app_settings where id) s
         where (v.arrived_at at time zone s.local_timezone)::date between $1 and $2
         order by v.arrived_at desc`,
};

// Administrators only: who opened which resident's record (migration 023).
REPORTS.access = {
  title: 'Who viewed which record',
  ranged: true,
  admin: true,
  sql: `select * from resident_views_between($1, $2)`,
};

const { csv } = require('../lib/csv');
const { xlsx } = require('../lib/xlsx');

router.get('/reports', wrap(async (req, res) => {
  res.json(Object.entries(REPORTS).map(([name, r]) => ({ name, title: r.title, ranged: r.ranged, admin: !!r.admin })));
}));

// Registered ahead of GET /reports/:name so the literal path wins.
const INSPECTION_PACK = ['weekly', 'vacancies', 'breaches', 'evacuation'];
router.get('/reports/inspection-pack', wrap(async (req, res) => {
  const reason = String(req.query.reason || '').trim();
  if (!reason || reason.length > 200) throw new HttpError(400, 'Give the reason for the export (up to 200 characters)');
  const from = dateParam(req.query.from, 'from');
  const to = dateParam(req.query.to || req.query.from, 'to');
  if (to < from) throw new HttpError(400, 'to must not be before from');
  const days = (Date.parse(to) - Date.parse(from)) / 86400000;
  if (days > 366) throw new HttpError(400, 'A report covers at most a year');

  const sections = await db.withIdentity(req.session.userId, async (client) => {
    await client.query('select note_report($1, $2, $3, $4)', ['inspection-pack', reason, from, to]);
    const out = [];
    for (const name of INSPECTION_PACK) {
      const def = REPORTS[name];
      const { rows } = await client.query(def.sql, def.ranged ? [from, to] : []);
      out.push({ name, title: def.title, rows, from: def.ranged ? from : null, to: def.ranged ? to : null });
    }
    return out;
  }).catch((err) => {
    if (err && err.code === '42501') throw new HttpError(403, 'Only a supervisor or admin can export a report');
    throw err;
  });

  res.json({ title: 'Inspection pack', from, to, sections });
}));

router.get('/missed', wrap(async (req, res) => {
  if (req.session.role !== 'supervisor' && req.session.role !== 'admin') {
    throw new HttpError(403, 'Only a supervisor or admin can see who missed the register');
  }
  const { from, to } = rangeParams(req.query);
  const out = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query(missedSql(), [from, to]);
    const closed = await client.query(
      `select max(compliance_date)::text as d from daily_compliance where closed_at is not null`);
    return { closed_through: closed.rows[0].d, rows };
  });
  res.json({
    from, to, closed_through: out.closed_through,
    rows: out.rows.map(({ last_breach_kind, last_breach_on, ...r }) => ({
      ...r,
      last_breach: last_breach_kind ? { kind: last_breach_kind, issued_on: last_breach_on } : null,
    })),
  });
}));

router.get('/reports/:name', wrap(async (req, res) => {
  const def = REPORTS[req.params.name];
  if (!def) throw new HttpError(404, 'No such report');
  const reason = String(req.query.reason || '').trim();
  if (!reason || reason.length > 200) throw new HttpError(400, 'Give the reason for the export (up to 200 characters)');
  const format = req.query.format === 'json' ? 'json'
              : req.query.format === 'xlsx' ? 'xlsx'
              : req.query.format === 'docx' ? 'docx'
              : 'csv';
  // The Word document is the Sunday return in the centre manager's own
  // layout (lib/weeklyReport.js document()); it exists for that report and
  // no other, so any other report asked for as Word is a mistake, not CSV.
  if (format === 'docx' && req.params.name !== 'weekly') {
    throw new HttpError(400, 'Only the Weekly register update is available as a Word document');
  }
  let from = null, to = null;
  if (def.ranged) ({ from, to } = rangeParams(req.query));

  const { rows, site } = await db.withIdentity(req.session.userId, async (client) => {
    await client.query('select note_report($1, $2, $3, $4)', [req.params.name, reason, from, to]);
    const { rows } = await client.query(def.sql, def.ranged ? [from, to] : []);
    const site = format === 'docx'
      ? (await client.query(`select site_name, to_char(site_today(), 'YYYY-MM-DD') as today from app_settings where id`)).rows[0]
      : null;
    return { rows, site };
  }).catch((err) => {
    if (err && err.code === '42501') throw new HttpError(403, def.admin ? 'Only an administrator can see who viewed a record' : 'Only a supervisor or admin can export a report');
    throw err;
  });

  const stamp = new Date().toISOString().slice(0, 10);
  const range = def.ranged ? `-${from}-to-${to}` : '';
  if (format === 'json') return res.json({ name: req.params.name, title: def.title, from, to, rows });
  if (format === 'xlsx') {
    // note_report() already ran inside the transaction above. The format a
    // report was taken in does not change that it was taken, so the audit
    // record is identical either way.
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.name}${range}-${stamp}.xlsx"`);
    return res.send(xlsx(rows, { sheetName: def.title }));
  }
  if (format === 'docx') {
    const doc = weekly.document({ siteName: site.site_name, from, to, rows, generatedOn: site.today });
    res.setHeader('Content-Type', doc.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${doc.filename}"`);
    return res.send(doc.buffer);
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.name}${range}-${stamp}.csv"`);
  res.send('\ufeff' + csv(rows));
}));

module.exports = router;
