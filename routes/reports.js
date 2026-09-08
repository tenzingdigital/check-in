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
//
// Supervisors and admins. A reason is required and every export is written
// to admin_audit by note_report() in the same transaction, so an inspection
// pack has a trail. CSV is the default; format=json is for the printable
// page in the browser (and the tests).

const express = require('express');
const { wrap } = require('../lib/asyncRoute');
const db = require('../database');
const { HttpError, dateParam } = require('../lib/api');

const router = express.Router();

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
                 round(extract(epoch from (rc.ended_at - rc.started_at)) / 60)::int as minutes
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
               btrim(r.first_name) || ' ' || btrim(r.last_name) as resident,
               case when vs.is_adult then '' else 'child' end as child,
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
         order by o.night desc, r.last_name, r.first_name`,
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
       select rm.building, rm.room, btrim(r.first_name) || ' ' || btrim(r.last_name) as resident,
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

// Authorised absences overlapping the range, and who was marked safe on
// each roll call, and every room a resident has had (migration 028).
REPORTS.absences = {
  title: 'Authorised absences',
  ranged: true,
  sql: `select btrim(r.first_name) || ' ' || btrim(r.last_name) as resident, rm.building, rm.room,
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
  sql: `select btrim(r.first_name) || ' ' || btrim(r.last_name) as resident, ra.room_label as room,
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
  sql: `select b.issued_on::text as issued_on, btrim(r.first_name) || ' ' || btrim(r.last_name) as resident, rm.building, rm.room,
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

function csv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    const s = v instanceof Date ? v.toISOString() : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n') + '\r\n';
}

router.get('/reports', wrap(async (req, res) => {
  res.json(Object.entries(REPORTS).map(([name, r]) => ({ name, title: r.title, ranged: r.ranged, admin: !!r.admin })));
}));

router.get('/reports/:name', wrap(async (req, res) => {
  const def = REPORTS[req.params.name];
  if (!def) throw new HttpError(404, 'No such report');
  const reason = String(req.query.reason || '').trim();
  if (!reason || reason.length > 200) throw new HttpError(400, 'Give the reason for the export (up to 200 characters)');
  const format = req.query.format === 'json' ? 'json' : 'csv';
  let from = null, to = null;
  if (def.ranged) {
    from = dateParam(req.query.from, 'from');
    to = dateParam(req.query.to || req.query.from, 'to');
    if (to < from) throw new HttpError(400, 'to must not be before from');
    const days = (Date.parse(to) - Date.parse(from)) / 86400000;
    if (days > 366) throw new HttpError(400, 'A report covers at most a year');
  }

  const rows = await db.withIdentity(req.session.userId, async (client) => {
    await client.query('select note_report($1, $2, $3, $4)', [req.params.name, reason, from, to]);
    const { rows } = await client.query(def.sql, def.ranged ? [from, to] : []);
    return rows;
  }).catch((err) => {
    if (err && err.code === '42501') throw new HttpError(403, def.admin ? 'Only an administrator can see who viewed a record' : 'Only a supervisor or admin can export a report');
    throw err;
  });

  const stamp = new Date().toISOString().slice(0, 10);
  const range = def.ranged ? `-${from}-to-${to}` : '';
  if (format === 'json') return res.json({ name: req.params.name, title: def.title, from, to, rows });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.name}${range}-${stamp}.csv"`);
  res.send('\ufeff' + csv(rows));
}));

module.exports = router;
