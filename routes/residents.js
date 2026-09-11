// Resident search and one resident's compliance detail.
//
// Every handler is a thin wrapper: parse the request, call the same view or RPC
// the browser used to call directly through PostgREST before this app left
// Supabase, return the rows. There is deliberately no authorisation logic here
// — the `where is_staff()` in each view and the role checks inside each
// SECURITY DEFINER function are the things deciding what a caller may see, and
// they run inside withIdentity().
//
// The rule to hold onto when adding an endpoint: pass auth.uid() implicitly
// through withIdentity(), never accept a user or guard id as a parameter. The
// RPCs take the guard identity from auth.uid() precisely so that no argument
// can be used to act as somebody else.
const express = require('express');
const { csv } = require('../lib/csv');
const { xlsx } = require('../lib/xlsx');
const { formatRef, parseRef } = require('../lib/ref');
const { wrap } = require('../lib/asyncRoute');
const db = require('../database');
const { HttpError, uuidParam, intParam, dateParam } = require('../lib/api');

const router = express.Router();

const STRIP_DAYS = 30;

/* --------------------------------------------------------------------------
   Validation for the fields a supervisor may write
   ------------------------------------------------------------------------ */

function nameParam(value, field) {
  const v = String(value || '').trim();
  if (!v || v.length > 80) throw new HttpError(400, `${field} is required (up to 80 characters)`);
  return v;
}

// A date of birth: well-formed, a real calendar date, after 1900, not in the
// future. The table constraint says the same; checking here turns a typo into
// a message rather than a constraint name.
function dobParam(value) {
  const v = dateParam(value, 'Date of birth');
  const d = new Date(v + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw new HttpError(400, 'Date of birth is not a real date');
  if (v <= '1900-01-01') throw new HttpError(400, 'Date of birth must be after 1900');
  if (v > new Date().toISOString().slice(0, 10)) throw new HttpError(400, 'Date of birth cannot be in the future');
  return v;
}

// TRC/IRP: both or neither, matching the residents_id_pair constraint.
function idParams(body) {
  const hasType = Object.prototype.hasOwnProperty.call(body, 'id_type');
  const hasNumber = Object.prototype.hasOwnProperty.call(body, 'id_number');
  if (!hasType && !hasNumber) return null;                         // not mentioned: leave alone
  const idType = body.id_type === null ? null : String(body.id_type || '').trim().toUpperCase();
  // Upper-cased: the card prints it that way, and search_key is built from it.
  const idNumber = body.id_number === null ? null : String(body.id_number || '').trim().toUpperCase();
  if (!idType && !idNumber) return { idType: null, idNumber: null };  // clearing
  if (idType !== 'TRC' && idType !== 'IRP') throw new HttpError(400, 'ID type must be TRC or IRP');
  if (!idNumber || idNumber.length > 40) throw new HttpError(400, 'Enter the number printed on the card');
  return { idType, idNumber };
}

// The row policy refuses a guard's write with 42501. Say so in words.
// room_id: a room's uuid, or null / "" to clear it. The foreign key is what
// refuses a room that does not exist; that becomes a 400 here.
function roomParam(value) {
  if (value === undefined || value === null || value === '') return null;
  return uuidParam(value, 'room_id');
}
// evac_need: one code from the fixed list in migration 017, or nothing.
const EVAC_NEEDS = ['none', 'mobility', 'hearing', 'sight', 'carer', 'other'];
function evacParam(value) {
  if (value === undefined || value === null || value === '') return null;
  const v = String(value).trim().toLowerCase();
  if (!EVAC_NEEDS.includes(v)) throw new HttpError(400, `evac_need must be one of ${EVAC_NEEDS.join(', ')}`);
  return v;
}
function roomError(err) {
  if (err && err.code === '23514' && /archived/.test(err.message || '')) return new HttpError(400, 'That room is archived');
  if (err && err.code === '23503' && /room/.test(err.constraint || '')) return new HttpError(400, 'No such room');
  return err;
}

function supervisorOnly(err) {
  if (err && err.code === '42501') return new HttpError(403, 'Only a supervisor or admin can manage residents');
  return err;
}

// GET /api/residents?q=&limit=&compliance=1
//
// `compliance=1` merges the matching v_resident_compliance rows in, which is
// what the check-in app needs on every card: the old client issued
// search_residents() and then a second `in (...)` query from the browser and
// merged them in JavaScript. Doing it in one transaction here is both fewer
// round trips and a consistent read.
router.get('/', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const limit = intParam(req.query.limit, 20, 1000);
  const wantCompliance = req.query.compliance === '1';
  // departed=1 includes residents who have left — the admin page's Departed
  // view. The gate and the register never ask for it.
  const includeDeparted = req.query.departed === '1';

  const rows = await db.withIdentity(req.session.userId, async (client) => {
    // Lists never carry the identity number (DPA Annex II: it is shown on a
    // detail view, never in a list). has_id tells the admin page whether
    // there is one to show; the number itself comes from /:id/compliance or
    // /:id/record. Searching BY number still works — search_key holds it.
    const { rows: found } = await client.query(
      `select v.*, (v.id_number is not null) as has_id
         from search_residents($1, $2, $3) v`,
      [q, includeDeparted, limit],
    );
    // search_key is a generated column: lower(unaccent(names || ' ' ||
    // coalesce(id_number, ''))). Dropping id_number while leaving search_key
    // put the whole number back in every row, lower-cased, and into each
    // terminal's offline copy — past a test that greps the response for the
    // string "id_number" and so could never fail. Nothing client-side reads
    // search_key; search happens in SQL, where the column still does its job.
    for (const r of found) { delete r.id_number; delete r.id_type; delete r.search_key; }
    if (found.length === 0) return found;
    // The room, for every card (Stage 1 of docs/PRODUCT-ROADMAP.md).
    const { rows: rooms } = await client.query(
      `select id, room_id, building_id, building, floor, room, room_label, evac_need,
              household_id, household_size, household_label
         from v_resident_room where id = any($1::uuid[])`,
      [found.map(r => r.id)],
    );
    const roomById = new Map(rooms.map(r => [r.id, r]));
    for (const r of found) {
      const rm = roomById.get(r.id) || {};
      Object.assign(r, {
        room_id: rm.room_id || null, building_id: rm.building_id || null, building: rm.building || null,
        floor: rm.floor || null, room: rm.room || null, room_label: rm.room_label || null,
        evac_need: rm.evac_need || 'none',
        household_id: rm.household_id || null, household_size: rm.household_size || null, household_label: rm.household_label || null,
      });
    }
    // Away with the centre's agreement today (migration 028): the card says
    // so, and on the register the person is not "not seen", they are away.
    // The reason is deliberately NOT selected. All three front ends render
    // only `until` (index.html, checkin.html and admin.html each print "Away
    // until ..."), so sending the reason put it on every shared tablet and
    // into each terminal's offline copy for no display purpose — and one of
    // the permitted reasons is `medical`, which docs/legal/DPA-2026-09-10
    // concludes should be treated as data concerning health. The reason is
    // still available on /:id/absences, which is the detail view that shows it.
    const { rows: away } = await client.query(
      `select a.resident_id, coalesce(a.ended_on, a.to_date) as until
         from authorised_absences a
        where a.resident_id = any($1::uuid[])
          and site_today() between a.from_date and coalesce(a.ended_on, a.to_date)`,
      [found.map(r => r.id)],
    );
    const awayById = new Map(away.map(a => [a.resident_id, a]));
    for (const r of found) {
      const a = awayById.get(r.id);
      r.away = a ? { until: String(a.until).slice(0, 10) } : null;
    }
    if (!wantCompliance) return found;

    // first_seen_at is today's row in daily_compliance, joined here rather
    // than added to the view: attention_list() returns setof the view and
    // depends on its physical column order.
    const { rows: comp } = await client.query(
      `select v.id, v.state, v.required_today, v.seen_today, v.checkins_today,
              v.open_breaches, v.consecutive_missed, v.absent_in_window,
              v.absence_window_days, v.absence_window_limit,
              v.warn_after_consecutive_nights, v.last_seen_on,
              dc.first_seen_at
         from v_resident_compliance v
         left join daily_compliance dc
           on dc.resident_id = v.id and dc.compliance_date = site_today()
        where v.id = any($1::uuid[])`,
      [found.map(r => r.id)],
    );
    const byId = new Map(comp.map(c => [c.id, c]));
    const { rows: breaches } = await client.query(
      `select distinct on (resident_id) resident_id, kind, issued_on from breach_reports
        where resident_id = any($1::uuid[]) order by resident_id, issued_on desc, id desc`,
      [found.map(r => r.id)]);
    const breachById = new Map(breaches.map(b => [b.resident_id, b]));
    return found.map(r => {
      const out = { ...r, ...(byId.get(r.id) || {}) };
      const b = breachById.get(r.id);
      out.last_breach = b ? { kind: b.kind, issued_on: String(b.issued_on).slice(0, 10) } : null;
      if (out.away && out.status === 'active') { out.required_today = false; if (out.state !== 'breach_open') out.state = 'away'; }
      return out;
    });
  });

  res.json(rows);
}));

// GET /api/residents/:id/compliance — the detail panel's row.
router.get('/:id/compliance', wrap(async (req, res) => {
  const row = await db.withIdentity(req.session.userId, async (client) => {
    // This is the detail sheet, and it carries the identity number: the
    // opening goes on the access log (migration 023) in the same transaction.
    await client.query('select note_view($1, $2)', [uuidParam(req.params.id, 'resident id'), 'register']);
    const { rows } = await client.query(
      `select v.id, v.full_name, v.id_type, v.id_number, v.age_years, v.required_today,
              v.seen_today, v.checkins_today, v.open_breaches, v.consecutive_missed,
              v.absent_in_window, v.absence_window_days, v.absence_window_limit,
              v.warn_after_consecutive_nights, v.last_seen_on, v.state,
              dc.first_seen_at
         from v_resident_compliance v
         left join daily_compliance dc
           on dc.resident_id = v.id and dc.compliance_date = site_today()
        where v.id = $1`,
      [uuidParam(req.params.id, 'resident id')],
    );
    if (!rows[0]) return null;
    // Every check-in recorded today, newest first, with the guard who
    // recorded it. This is the troubleshooting view: it says which
    // terminal's guard tapped, and when, including a double tap the
    // 60-second dedupe folded into one presentation (which is why a day
    // can say 1× with one event here and two taps at the desk).
    const { rows: events } = await client.query(
      `select e.occurred_at, e.source, p.full_name as recorded_by
         from checkin_events e
         join profiles p on p.id = e.guard_id
        cross join (select local_timezone from app_settings where id) s
        where e.resident_id = $1
          and (e.occurred_at at time zone s.local_timezone)::date = site_today()
        order by e.occurred_at desc, e.id desc`,
      [uuidParam(req.params.id, 'resident id')],
    );
    rows[0].checkins_today_events = events;
    return rows[0];
  });

  if (!row) throw new HttpError(404, 'No such resident');
  res.json(row);
}));

// GET /api/residents/:id/days — the 30-day strip under the detail panel.
//
// The window is anchored to site_today() on the server rather than to
// the terminal's clock, so the strip lines up with the register.
router.get('/:id/days', wrap(async (req, res) => {
  const rows = await db.withIdentity(req.session.userId, async (client) => {
    const { rows: days } = await client.query(
      `select compliance_date, required, presented, first_seen_at
         from daily_compliance
        where resident_id = $1
          and compliance_date >= (site_today() - ($2::integer - 1))
        order by compliance_date`,
      [uuidParam(req.params.id, 'resident id'), STRIP_DAYS],
    );
    return days;
  });

  res.json(rows);
}));

// GET /api/residents/:id/history?from=&to=&kind= — every movement and
// check-in for one resident over a range (default the last 30 days, at most
// a year), newest first, with who recorded it. What the centre managers
// asked for: "search a name and see all their history with the date and
// time". Any staff member: the same rows the log and the register already
// show, seen from the person's side.
//
// kind narrows it to one register: "gate" (In & out movements) or "checkin"
// (the daily register); anything else, or nothing, is both.
//
// With format=csv the same rows come as a file. That is an export, so it
// follows the rules every other export follows: a supervisor or admin, a
// reason, and a line in the audit record (note_report, migration 019) with
// the range — the same function the reports use, so the same 403 for a
// guard. Viewing on screen stays open to any staff member and is not logged
// here; opening the sheet is already on the access log.
const HISTORY_KINDS = new Set(['all', 'gate', 'checkin']);
router.get('/:id/history', wrap(async (req, res) => {
  const id = uuidParam(req.params.id, 'resident id');
  const to = req.query.to ? dateParam(req.query.to, 'to') : null;
  const from = req.query.from ? dateParam(req.query.from, 'from') : null;
  if (from && to && to < from) throw new HttpError(400, 'to must not be before from');
  if (from && to && (Date.parse(to) - Date.parse(from)) / 86400000 > 366) throw new HttpError(400, 'A history covers at most a year at a time');
  const kind = HISTORY_KINDS.has(req.query.kind) ? req.query.kind : 'all';
  // csv and xlsx are both exports and both need a reason on the record; json
  // is the screen. asFile is "this leaves the building", which is what the
  // audit write and the truncation marker actually care about.
  const format = req.query.format === 'csv' ? 'csv' : req.query.format === 'xlsx' ? 'xlsx' : 'json';
  const asFile = format !== 'json';
  const reason = String(req.query.reason || '').trim();
  if (asFile && (!reason || reason.length > 200)) throw new HttpError(400, 'Give the reason for the export (up to 200 characters)');

  const { rows, resident, truncated } = await db.withIdentity(req.session.userId, async (client) => {
    if (asFile) await client.query('select note_report($1, $2, $3, $4)', ['resident_history:' + id, reason, from, to]);
    const { rows } = await client.query(
      `with s as (select local_timezone as tz from app_settings where id),
            b as (select coalesce($2::date, site_today() - 29) as d0, coalesce($3::date, site_today()) as d1)
       select x.kind, x.occurred_at, x.recorded_at, x.late_entry, x.guard_name
         from (
           select e.kind, e.occurred_at, e.recorded_at, e.late_entry, g.full_name as guard_name
             from gate_events e join profiles g on g.id = e.guard_id where e.resident_id = $1
           union all
           select 'checkin', c.occurred_at, c.recorded_at, c.late_entry, g.full_name
             from checkin_events c join profiles g on g.id = c.guard_id where c.resident_id = $1
         ) x, s, b
        where x.occurred_at >= (b.d0::timestamp) at time zone s.tz
          and x.occurred_at <  ((b.d1 + 1)::timestamp) at time zone s.tz
          and ($4 = 'all' or ($4 = 'gate' and x.kind in ('in', 'out')) or ($4 = 'checkin' and x.kind = 'checkin'))
        order by x.occurred_at desc
        limit 2001`,
      [id, from, to, kind]);
    // 2001 asked, 2000 kept: the extra row is only how we learn there were
    // more. The screen already says "Showing the first 2,000" — the CSV said
    // nothing, so an evidence export for an inspection quietly dropped its
    // oldest rows. HISTORY_LIMIT rows plus a marker line is the honest file.
    const truncated = rows.length > 2000;
    if (truncated) rows.length = 2000;
    let resident = null;
    if (asFile) {
      const r = await client.query(`select first_name || ' ' || last_name as full_name from residents where id = $1`, [id]);
      resident = r.rows[0] ? r.rows[0].full_name : null;
    }
    return { rows, resident, truncated };
  }).catch((err) => {
    if (err && err.code === '42501') throw new HttpError(403, 'Only a supervisor or admin can export a history');
    throw err;
  });
  if (!asFile) return res.json(rows);

  const label = { in: 'IN', out: 'OUT', checkin: 'Check-in' };
  const out = rows.map((e) => ({
    resident: resident || '', register: e.kind === 'checkin' ? 'Daily register' : 'In & out', event: label[e.kind] || e.kind,
    occurred_at: e.occurred_at, recorded_at: e.recorded_at, recorded_offline: e.late_entry ? 'yes' : '', recorded_by: e.guard_name,
  }));
  // A file that silently stops at 2,000 is worse than one that says so: an
  // inspector cannot tell a complete history from a clipped one.
  if (truncated) {
    out.push({
      resident: resident || '', register: '', event: 'PARTIAL EXPORT — the oldest events are not included. Narrow the dates and export again.',
      occurred_at: '', recorded_at: '', recorded_offline: '', recorded_by: '',
    });
  }
  const slug = String(resident || 'resident').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'resident';
  const range = from || to ? `-${from || 'start'}-to-${to || 'today'}` : '-last-30-days';
  const which = kind === 'all' ? '' : `-${kind === 'gate' ? 'in-and-out' : 'check-ins'}`;
  if (format === 'xlsx') {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="history-${slug}${which}${range}.xlsx"`);
    return res.send(xlsx(out, { sheetName: 'History' }));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="history-${slug}${which}${range}.csv"`);
  res.send('\ufeff' + csv(out));
}));

// Authorised absences (migration 028). Any staff member sees them; only a
// supervisor or admin records or changes one, enforced by the functions.
const ABSENCE_REASONS = ['holiday', 'family', 'medical', 'interview', 'education', 'work', 'other'];
function absenceRow(a) {
  return {
    id: Number(a.id), from_date: String(a.from_date).slice(0, 10), to_date: String(a.to_date).slice(0, 10),
    ended_on: a.ended_on ? String(a.ended_on).slice(0, 10) : null,
    reason: a.reason, guardian_agreed: a.guardian_agreed, approved_by: a.approved_by_name || null, created_at: a.created_at,
  };
}
router.get('/:id/absences', wrap(async (req, res) => {
  const id = uuidParam(req.params.id, 'resident id');
  const rows = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query(
      `select a.*, p.full_name as approved_by_name
         from authorised_absences a left join profiles p on p.id = a.approved_by
        where a.resident_id = $1 order by a.from_date desc limit 200`, [id]);
    return rows;
  });
  res.json(rows.map(absenceRow));
}));
router.post('/:id/absences', wrap(async (req, res) => {
  const id = uuidParam(req.params.id, 'resident id');
  const body = req.body || {};
  const from = dateParam(body.from_date, 'from_date');
  const to = dateParam(body.to_date, 'to_date');
  const reason = String(body.reason || '');
  if (!ABSENCE_REASONS.includes(reason)) throw new HttpError(400, `reason must be one of ${ABSENCE_REASONS.join(', ')}`);
  const guardian = body.guardian_agreed === true;
  const out = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query('select * from authorise_absence($1, $2, $3, $4, $5)', [id, from, to, reason, guardian]);
    const { rows: named } = await client.query(
      `select a.*, p.full_name as approved_by_name from authorised_absences a left join profiles p on p.id = a.approved_by where a.id = $1`, [rows[0].id]);
    // Permitted absence periods (migration 036): a holiday outside every
    // window is still recorded; the answer says so.
    let warning;
    if (reason === 'holiday') {
      const { rows: [w] } = await client.query(
        `select (select count(*)::int from absence_windows) as n, inside_absence_window($1, $2) as inside`, [from, to]);
      if (w.n > 0 && !w.inside) warning = 'Outside the permitted absence periods in Settings';
    }
    return { row: named[0] || rows[0], warning };
  }).catch((err) => {
    if (err && err.code === '23505') throw new HttpError(409, err.message);
    if (err && err.code === '23514') throw new HttpError(400, err.message);
    if (err && err.code === '22023') throw new HttpError(400, err.message);
    if (err && err.code === 'P0002') throw new HttpError(404, 'No such resident');
    throw err;
  });
  res.status(201).json(out.warning ? { ...absenceRow(out.row), warning: out.warning } : absenceRow(out.row));
}));
// POST …/absences/:aid/end { last_day? } — cut it short; a last day before
// the first day removes it (it never happened).
router.post('/:id/absences/:aid/end', wrap(async (req, res) => {
  uuidParam(req.params.id, 'resident id');
  const aid = intParam(req.params.aid, 0, Number.MAX_SAFE_INTEGER);
  if (!aid) throw new HttpError(400, 'absence id');
  const body = req.body || {};
  const last = body.last_day ? dateParam(body.last_day, 'last_day') : null;
  const row = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query('select * from end_absence($1, $2)', [aid, last]);
    return rows[0];
  }).catch((err) => {
    if (err && err.code === 'P0002') throw new HttpError(404, 'No such absence');
    throw err;
  });
  const out = absenceRow(row);
  out.cancelled = row.ended_on && String(row.ended_on).slice(0, 10) < out.from_date;
  res.json(out);
}));

// Breach reports (migration 029): that a report was issued to IPAS.
const BREACH_KINDS = ['house_rules', 'misuse'];
function breachRow(b) {
  return { id: Number(b.id), kind: b.kind, issued_on: String(b.issued_on).slice(0, 10), reference: b.reference || null, issued_by: b.issued_by_name || null, created_at: b.created_at };
}
router.get('/:id/breaches', wrap(async (req, res) => {
  const id = uuidParam(req.params.id, 'resident id');
  const rows = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query(
      `select b.*, p.full_name as issued_by_name from breach_reports b left join profiles p on p.id = b.issued_by
        where b.resident_id = $1 order by b.issued_on desc, b.id desc limit 200`, [id]);
    return rows;
  });
  res.json(rows.map(breachRow));
}));
router.post('/:id/breaches', wrap(async (req, res) => {
  const id = uuidParam(req.params.id, 'resident id');
  const body = req.body || {};
  const kind = String(body.kind || '');
  if (!BREACH_KINDS.includes(kind)) throw new HttpError(400, `kind must be one of ${BREACH_KINDS.join(', ')}`);
  const on = body.issued_on ? dateParam(body.issued_on, 'issued_on') : null;
  const reference = body.reference == null ? null : String(body.reference).trim().slice(0, 60);
  const row = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query('select * from issue_breach($1, $2, $3, $4)', [id, kind, on, reference]);
    const { rows: named } = await client.query(
      `select b.*, p.full_name as issued_by_name from breach_reports b left join profiles p on p.id = b.issued_by where b.id = $1`, [rows[0].id]);
    return named[0] || rows[0];
  }).catch((err) => {
    if (err && err.code === 'P0002') throw new HttpError(404, 'No such resident');
    throw err;
  });
  res.status(201).json(breachRow(row));
}));

// GET /api/residents/:id/rooms — every room they have had (migration 028).
router.get('/:id/rooms', wrap(async (req, res) => {
  const id = uuidParam(req.params.id, 'resident id');
  const rows = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query(
      `select ra.room_label, ra.from_at, ra.to_at, p.full_name as changed_by
         from room_assignments ra left join profiles p on p.id = ra.changed_by
        where ra.resident_id = $1 order by ra.from_at desc limit 200`, [id]);
    return rows;
  });
  res.json(rows);
}));

// POST /api/residents — add a resident to the register.
//
// Authorisation is the residents_supervisor row policy: a guard's insert is
// refused by the database with 42501, which becomes a 403 here. The
// registering user is auth.uid(), never an argument.
router.post('/', wrap(async (req, res) => {
  const body = req.body || {};
  const first = nameParam(body.first_name, 'First name');
  const last = nameParam(body.last_name, 'Last name');
  const dob = dobParam(body.date_of_birth);
  const id = idParams(body) || { idType: null, idNumber: null };
  const roomId = roomParam(body.room_id);
  const evac = evacParam(body.evac_need) || 'none';

  const row = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query(
      `insert into residents (first_name, last_name, date_of_birth, id_type, id_number, room_id, evac_need, registered_by)
       values ($1, $2, $3, $4, $5, $6, $7, auth.uid())
       returning id`,
      [first, last, dob, id.idType, id.idNumber, roomId, evac],
    );
    return rows[0];
  }).catch((err) => { throw roomError(supervisorOnly(err)); });

  res.status(201).json({ id: row.id });
}));

// POST /api/residents/import — a spreadsheet's worth of residents at once.
//
// A centre coming from paper or a spreadsheet has a hundred or two hundred
// people to enter, and the add form is one at a time. The browser parses the
// CSV, then sends rows here: first with dry_run so the person sees what
// would happen to each line, then for real. Each row is judged on its own
// (a savepoint per insert), so one bad line does not lose the other
// hundred, and the answer says what happened to every line by number.
//
// Convergent on purpose: a row whose name and date of birth are already on
// the register is skipped as "exists", so the same sheet can be imported
// again after fixing the lines that failed.
const IMPORT_MAX = 200;

// Spreadsheets write dates the way the person did: DD/MM/YYYY in Ireland,
// or YYYY-MM-DD. A two-digit year is read as 19xx when it would otherwise be
// in the future — a resident born in "05" is a child, in "68" an adult.
function dobFromSheet(value) {
  const s = String(value || '').trim();
  const pad = (n) => String(n).padStart(2, '0');
  let m;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) return dobParam(`${m[1]}-${pad(m[2])}-${pad(m[3])}`);
  if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})$/.exec(s))) {
    let y = m[3];
    if (y.length === 2) { const yy = Number(y); const cur = new Date().getFullYear() % 100; y = String(yy > cur ? 1900 + yy : 2000 + yy); }
    return dobParam(`${y}-${pad(m[2])}-${pad(m[1])}`);
  }
  throw new HttpError(400, 'Date of birth must be DD/MM/YYYY or YYYY-MM-DD');
}

// The evacuation column is free text on a sheet; it becomes one code here.
function evacFromSheet(value) {
  const s = String(value || '').trim().toLowerCase();
  if (!s || /^(none|no|n|-|0|nil)$/.test(s)) return 'none';
  if (EVAC_NEEDS.includes(s)) return s;
  if (/mobil|move|wheel|walk|stair|frame/.test(s)) return 'mobility';
  if (/hear|deaf|alarm/.test(s)) return 'hearing';
  if (/sight|see|visual|blind|way/.test(s)) return 'sight';
  if (/infant|baby|carer|pregnan|child|buggy/.test(s)) return 'carer';
  if (/other|yes|y|help|assist/.test(s)) return 'other';
  throw new HttpError(400, `Evacuation need "${value}" not recognised: use none, mobility, hearing, sight, carer or other`);
}

router.post('/import', wrap(async (req, res) => {
  if (req.session.role !== 'supervisor' && req.session.role !== 'admin') {
    throw new HttpError(403, 'Only a supervisor or admin can import residents');
  }
  const body = req.body || {};
  const rows = Array.isArray(body.rows) ? body.rows : null;
  if (!rows || !rows.length || rows.length > IMPORT_MAX) throw new HttpError(400, `Send between 1 and ${IMPORT_MAX} rows per request`);
  const dryRun = body.dry_run === true;

  const results = await db.withIdentity(req.session.userId, async (client) => {
    const { rows: rooms } = await client.query(
      `select rm.id, lower(b.name) as building, lower(rm.floor) as floor, lower(rm.number) as number
         from rooms rm join buildings b on b.id = rm.building_id`);
    // Two indexes over the active register: by reference, which is exact, and
    // by name, which may be ambiguous and is allowed to say so.
    //
    // Date of birth is deliberately NOT part of either. It used to be, and it
    // could not tell two residents of the same name and birthday apart while
    // resting on dobFromSheet() — which reads every dd/mm/yyyy as day-first
    // whatever the sheet's origin, and parses successfully when it is wrong.
    // A date of birth is still imported and still decides whether someone is
    // an adult; it no longer decides who a row IS.
    const { rows: existing } = await client.query(
      `select id, ref, first_name, last_name from residents where status = 'active'`);

    // Both sides folded by the SAME function, here. The register's own
    // search_key folds with immutable_unaccent, which uses a lookup table;
    // NFD-stripping only approximates it, and where the two disagree a match
    // silently becomes a second copy of a person. So neither side is folded
    // in SQL: the sheet and the register go through this one line.
    const fold = (first, last) =>
      `${first} ${last}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ').trim().toLowerCase();

    const byRef = new Map(existing.map((e) => [e.ref, e]));
    const byName = new Map();
    for (const e of existing) {
      const k = fold(e.first_name, e.last_name);
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(e);
    }
    // A name imported twice in the SAME sheet is a duplicate too, so rows
    // added by this run join the index as they go.
    const addedThisRun = new Map();

    const out = [];
    for (const [i, raw] of rows.entries()) {
      const r = raw && typeof raw === 'object' ? raw : {};
      const line = Number.isInteger(r.line) ? r.line : i + 1;
      try {
        const first = nameParam(r.first_name, 'First name');
        const last = nameParam(r.last_name, 'Last name');
        const dob = dobFromSheet(r.date_of_birth);
        const idType = String(r.id_type || '').trim();
        const idNumber = String(r.id_number || '').trim();
        const id = (idType || idNumber) ? idParams({ id_type: idType || null, id_number: idNumber || null }) : { idType: null, idNumber: null };
        const evac = evacFromSheet(r.evac_need);

        let roomId = null;
        const bName = String(r.building || '').trim().toLowerCase();
        const rNum = String(r.room || '').trim().toLowerCase();
        const fl = String(r.floor || '').trim().toLowerCase();
        if (bName || rNum) {
          const hits = rooms.filter((x) => x.building === bName && x.number === rNum && (!fl || x.floor === fl));
          if (hits.length === 0) throw new HttpError(400, `No room "${r.room || ''}" in "${r.building || ''}". Add it under Buildings first, or leave the room blank`);
          if (hits.length > 1) throw new HttpError(400, `More than one room "${r.room}" in ${r.building}: give the floor`);
          roomId = hits[0].id;
        }

        // Who is this row about?
        const wantRef = parseRef(r.ref);
        const key = fold(first, last);

        if (wantRef !== null) {
          const hit = byRef.get(wantRef);
          // An unknown reference is an error, never an insert. A typo in a
          // reference must not quietly create a second copy of a person.
          if (!hit) throw new HttpError(400, `No resident with reference ${formatRef(wantRef)} on this register`);
          out.push({
            line, status: 'exists', ref: formatRef(hit.ref),
            matched: `${hit.first_name} ${hit.last_name}`,
            message: `Already on the register as ${formatRef(hit.ref)} ${hit.first_name} ${hit.last_name}`,
          });
          continue;
        }

        const hits = (byName.get(key) || []).concat(addedThisRun.get(key) || []);
        if (hits.length === 1) {
          out.push({
            line, status: 'exists', ref: formatRef(hits[0].ref),
            matched: `${hits[0].first_name} ${hits[0].last_name}`,
            message: `Already on the register as ${formatRef(hits[0].ref)}`,
          });
          continue;
        }
        if (hits.length > 1) {
          // Guessing here is how the wrong resident gets updated. Say so and
          // let the person put the reference in.
          out.push({
            line, status: 'ambiguous',
            message: `${hits.length} residents are called ${first} ${last}. Put their reference in the ref column to say which.`,
          });
          continue;
        }

        if (dryRun) {
          addedThisRun.set(key, [{ ref: null, first_name: first, last_name: last }]);
          out.push({ line, status: 'ready', message: roomId ? 'Ready' : 'Ready (no room)' });
          continue;
        }

        await client.query('savepoint row_import');
        try {
          const { rows: ins } = await client.query(
            `insert into residents (first_name, last_name, date_of_birth, id_type, id_number, room_id, evac_need, registered_by)
             values ($1, $2, $3, $4, $5, $6, $7, auth.uid())
             returning id, ref`,
            [first, last, dob, id.idType, id.idNumber, roomId, evac]);
          await client.query('release savepoint row_import');
          // The new row joins the name index, so the same name twice in one
          // sheet is caught rather than inserted twice.
          addedThisRun.set(key, [{ ref: ins[0].ref, first_name: first, last_name: last }]);
          // The reference comes back in the response: that is how a centre
          // gets its numbers without anybody typing one.
          out.push({ line, status: 'added', id: ins[0].id, ref: formatRef(ins[0].ref), message: `Added as ${formatRef(ins[0].ref)}` });
        } catch (err) {
          await client.query('rollback to savepoint row_import');
          if (err.code === '23505') throw new HttpError(400, 'That ID number is already on the register');
          throw err;
        }
      } catch (err) {
        if (err instanceof HttpError && err.status === 400) out.push({ line, status: 'error', message: err.message });
        else throw err;
      }
    }
    return out;
  }).catch((err) => { throw roomError(supervisorOnly(err)); });

  const count = (st) => results.filter((x) => x.status === st).length;
  res.json({ dry_run: dryRun, results, added: count('added'), ready: count('ready'), exists: count('exists'), ambiguous: count('ambiguous'), errors: count('error') });
}));

// GET /api/residents/:id/record — the row as a supervisor edits it. This is
// the ONE endpoint that returns a date of birth, and only to a role the row
// policy lets read the residents table; a guard gets 404, because for them
// the row does not exist.
router.get('/:id/record', wrap(async (req, res) => {
  const row = await db.withIdentity(req.session.userId, async (client) => {
    await client.query('select note_view($1, $2)', [uuidParam(req.params.id, 'resident id'), 'admin']);
    const { rows } = await client.query(
      `select id, ref, first_name, last_name, date_of_birth, id_type, id_number,
              status, departed_on, registered_at, room_id, evac_need, household_id
         from residents where id = $1`,
      [uuidParam(req.params.id, 'resident id')],
    );
    return rows[0];
  });
  if (!row) throw new HttpError(404, 'No such resident, or not authorised');
  res.json(row);
}));

// GET /api/residents/:id/household — who shares this resident's household.
router.get('/:id/household', wrap(async (req, res) => {
  const rows = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query(
      `select v.id, v.full_name, v.is_adult, v.presence, x.room_label
         from v_resident_room me
         join residents m on m.household_id = me.household_id and m.status = 'active'
         join v_resident_status v on v.id = m.id
         left join v_resident_room x on x.id = m.id
        where me.id = $1 and me.household_id is not null
        order by v.is_adult desc, v.last_name, v.first_name`,
      [uuidParam(req.params.id, 'resident id')],
    );
    return rows;
  });
  res.json(rows);
}));

// PATCH /api/residents/:id — change a resident's details.
//
// Any of: first_name, last_name, date_of_birth, id_type + id_number (both or
// neither), status with departed_on. Authorisation is the row policy, not
// this handler: `residents_supervisor` allows the write only for
// is_supervisor(), which covers supervisor and admin. A guard's update
// matches no rows, so they get a 403 without this file knowing anything
// about roles.
//
// Departure: status 'departed' needs a departed_on date (today if none is
// given), which is the last day the daily rule applies — see
// departed_on_matches_status in migrations/002. Setting it before the next
// nightly close-out is what stops a departed resident collecting breaches.
// Reactivating clears the date.
router.patch('/:id', wrap(async (req, res) => {
  const body = req.body || {};
  const sets = [];
  const args = [uuidParam(req.params.id, 'resident id')];
  const set = (col, val) => { args.push(val); sets.push(`${col} = $${args.length}`); };

  if (Object.prototype.hasOwnProperty.call(body, 'first_name')) set('first_name', nameParam(body.first_name, 'First name'));
  if (Object.prototype.hasOwnProperty.call(body, 'last_name')) set('last_name', nameParam(body.last_name, 'Last name'));
  if (Object.prototype.hasOwnProperty.call(body, 'date_of_birth')) set('date_of_birth', dobParam(body.date_of_birth));

  const id = idParams(body);
  if (id) { set('id_type', id.idType); set('id_number', id.idNumber); }

  if (Object.prototype.hasOwnProperty.call(body, 'room_id')) set('room_id', roomParam(body.room_id));
  if (Object.prototype.hasOwnProperty.call(body, 'evac_need')) set('evac_need', evacParam(body.evac_need) || 'none');
  // household: null leaves the family; household_with joins another
  // resident's (handled by join_household() below, after the other fields).
  if (Object.prototype.hasOwnProperty.call(body, 'household_id')) {
    if (body.household_id !== null && body.household_id !== '') throw new HttpError(400, 'household_id may only be cleared here; use household_with to join a family');
    set('household_id', null);
  }
  const householdWith = body.household_with ? uuidParam(body.household_with, 'household_with') : null;
  if (householdWith && !sets.length) sets.push('updated_at = now()');

  if (Object.prototype.hasOwnProperty.call(body, 'status')) {
    const status = String(body.status || '');
    if (status === 'departed') {
      const on = body.departed_on ? dateParam(body.departed_on, 'Departure date') : null;
      set('status', 'departed');
      if (on) set('departed_on', on);
      else sets.push('departed_on = site_today()');
    } else if (status === 'active') {
      set('status', 'active');
      set('departed_on', null);
    } else {
      throw new HttpError(400, "status must be 'active' or 'departed'");
    }
  }

  if (!sets.length) throw new HttpError(400, 'Nothing to change');

  const row = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query(
      `update residents set ${sets.join(', ')}
        where id = $1
        returning id, first_name, last_name, id_type, id_number, status, departed_on, room_id, evac_need, household_id`,
      args,
    );
    if (rows[0] && householdWith) {
      const { rows: h } = await client.query(`select join_household($1, $2) as household_id`, [rows[0].id, householdWith]);
      rows[0].household_id = h[0].household_id;
    }
    return rows[0];
  }).catch((err) => { throw roomError(supervisorOnly(err)); });

  if (!row) throw new HttpError(403, 'Only a supervisor or admin can change resident details');
  res.json({ ok: true, ...row });
}));

// GET /api/residents/:id/export?reason=… — everything held about one
// resident, as a downloadable JSON file (Art. 15 / Art. 20). Admin only,
// enforced by export_resident_record() itself; the reason is recorded in
// admin_audit by note_disclosure() in the same transaction, so a disclosure
// cannot happen without its record.
router.get('/:id/export', wrap(async (req, res) => {
  const id = uuidParam(req.params.id, 'resident id');
  const reason = String(req.query.reason || '').trim();
  if (!reason || reason.length > 200) throw new HttpError(400, 'Give the reason for the export (up to 200 characters)');

  const out = await db.withIdentity(req.session.userId, async (client) => {
    await client.query('select note_disclosure($1, $2)', [id, reason]);
    await client.query('select note_view($1, $2)', [id, 'export']);
    const { rows } = await client.query('select export_resident_record($1) as record', [id]);
    return rows[0].record;
  }).catch((err) => { throw err.code === '42501' ? new HttpError(403, 'Only an administrator can export a record') : err; });

  const name = `${out.resident.last_name || 'resident'}-${out.resident.first_name || ''}`.replace(/[^A-Za-z0-9-]+/g, '_');
  res.setHeader('Content-Disposition', `attachment; filename="record-${name}-${new Date().toISOString().slice(0, 10)}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(out, null, 2));
}));

// DELETE /api/residents/:id — erase a resident and their history (Art. 17).
// Admin only, enforced by erase_resident(). The caller types the resident's
// full name back, which the route checks against the record before the
// function runs: an erasure is the one thing here nobody can undo.
router.delete('/:id', wrap(async (req, res) => {
  const id = uuidParam(req.params.id, 'resident id');
  const body = req.body || {};
  const reason = String(body.reason || '').trim();
  const typed = String(body.confirm_name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!reason || reason.length > 200) throw new HttpError(400, 'Give the reason for the erasure (up to 200 characters)');

  const result = await db.withIdentity(req.session.userId, async (client) => {
    // Only an administrator may erase; say so before the name check, so a
    // guard (who cannot even read the table) hears a refusal, not "no such
    // resident" (the permission matrix holds every refusal to a 403).
    if (req.session.role !== 'admin') throw new HttpError(403, 'Only an administrator can erase a resident');
    const { rows } = await client.query('select first_name, last_name from residents where id = $1', [id]);
    if (!rows[0]) throw new HttpError(404, 'No such resident');
    const full = `${rows[0].first_name} ${rows[0].last_name}`.trim().toLowerCase().replace(/\s+/g, ' ');
    if (typed !== full) throw new HttpError(400, "The name typed does not match the resident's name");
    const { rows: out } = await client.query('select erase_resident($1, $2) as r', [id, reason]);
    return out[0].r;
  }).catch((err) => { throw err.code === '42501' ? new HttpError(403, 'Only an administrator can erase a resident') : err; });

  res.json(result);
}));

module.exports = router;
