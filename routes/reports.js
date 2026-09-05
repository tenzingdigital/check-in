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
