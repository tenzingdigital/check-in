// Resident search and one resident's compliance detail.
//
// Every handler is a thin wrapper: parse the request, call the same view or RPC
// the browser used to call directly through PostgREST before this app left
// Supabase, return the rows. There is deliberately no authorisation logic here
// — the `where public.is_staff()` in each view and the role checks inside each
// SECURITY DEFINER function are the things deciding what a caller may see, and
// they run inside withIdentity().
//
// The rule to hold onto when adding an endpoint: pass auth.uid() implicitly
// through withIdentity(), never accept a user or guard id as a parameter. The
// RPCs take the guard identity from auth.uid() precisely so that no argument
// can be used to act as somebody else.
const express = require('express');
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
         from public.search_residents($1, $2, $3) v`,
      [q, includeDeparted, limit],
    );
    for (const r of found) { delete r.id_number; delete r.id_type; }
    if (found.length === 0) return found;
    // The room, for every card (Stage 1 of docs/PRODUCT-ROADMAP.md).
    const { rows: rooms } = await client.query(
      `select id, room_id, building_id, building, floor, room, room_label, evac_need
         from public.v_resident_room where id = any($1::uuid[])`,
      [found.map(r => r.id)],
    );
    const roomById = new Map(rooms.map(r => [r.id, r]));
    for (const r of found) {
      const rm = roomById.get(r.id) || {};
      Object.assign(r, {
        room_id: rm.room_id || null, building_id: rm.building_id || null, building: rm.building || null,
        floor: rm.floor || null, room: rm.room || null, room_label: rm.room_label || null,
        evac_need: rm.evac_need || 'none',
      });
    }
    if (!wantCompliance) return found;

    const { rows: comp } = await client.query(
      `select id, state, required_today, seen_today, checkins_today,
              open_breaches, consecutive_missed, absent_in_window,
              absence_window_days, absence_window_limit,
              warn_after_consecutive_nights, last_seen_on
         from public.v_resident_compliance
        where id = any($1::uuid[])`,
      [found.map(r => r.id)],
    );
    const byId = new Map(comp.map(c => [c.id, c]));
    return found.map(r => ({ ...r, ...(byId.get(r.id) || {}) }));
  });

  res.json(rows);
}));

// GET /api/residents/:id/compliance — the detail panel's row.
router.get('/:id/compliance', wrap(async (req, res) => {
  const row = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query(
      `select id, full_name, id_type, id_number, age_years, required_today,
              seen_today, checkins_today, open_breaches, consecutive_missed,
              absent_in_window, absence_window_days, absence_window_limit,
              warn_after_consecutive_nights, last_seen_on, state
         from public.v_resident_compliance where id = $1`,
      [uuidParam(req.params.id, 'resident id')],
    );
    return rows[0];
  });

  if (!row) throw new HttpError(404, 'No such resident');
  res.json(row);
}));

// GET /api/residents/:id/days — the 30-day strip under the detail panel.
//
// The window is anchored to public.site_today() on the server rather than to
// the terminal's clock, so the strip lines up with the register.
router.get('/:id/days', wrap(async (req, res) => {
  const rows = await db.withIdentity(req.session.userId, async (client) => {
    const { rows: days } = await client.query(
      `select compliance_date, required, presented
         from public.daily_compliance
        where resident_id = $1
          and compliance_date >= (public.site_today() - ($2::integer - 1))
        order by compliance_date`,
      [uuidParam(req.params.id, 'resident id'), STRIP_DAYS],
    );
    return days;
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
      `insert into public.residents (first_name, last_name, date_of_birth, id_type, id_number, room_id, evac_need, registered_by)
       values ($1, $2, $3, $4, $5, $6, $7, auth.uid())
       returning id`,
      [first, last, dob, id.idType, id.idNumber, roomId, evac],
    );
    return rows[0];
  }).catch((err) => { throw roomError(supervisorOnly(err)); });

  res.status(201).json({ id: row.id });
}));

// GET /api/residents/:id/record — the row as a supervisor edits it. This is
// the ONE endpoint that returns a date of birth, and only to a role the row
// policy lets read the residents table; a guard gets 404, because for them
// the row does not exist.
router.get('/:id/record', wrap(async (req, res) => {
  const row = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query(
      `select id, first_name, last_name, date_of_birth, id_type, id_number,
              status, departed_on, registered_at, room_id, evac_need
         from public.residents where id = $1`,
      [uuidParam(req.params.id, 'resident id')],
    );
    return rows[0];
  });
  if (!row) throw new HttpError(404, 'No such resident, or not authorised');
  res.json(row);
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

  if (Object.prototype.hasOwnProperty.call(body, 'status')) {
    const status = String(body.status || '');
    if (status === 'departed') {
      const on = body.departed_on ? dateParam(body.departed_on, 'Departure date') : null;
      set('status', 'departed');
      if (on) set('departed_on', on);
      else sets.push('departed_on = public.site_today()');
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
      `update public.residents set ${sets.join(', ')}
        where id = $1
        returning id, first_name, last_name, id_type, id_number, status, departed_on, room_id, evac_need`,
      args,
    );
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
    await client.query('select public.note_disclosure($1, $2)', [id, reason]);
    const { rows } = await client.query('select public.export_resident_record($1) as record', [id]);
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
    const { rows } = await client.query('select first_name, last_name from public.residents where id = $1', [id]);
    if (!rows[0]) throw new HttpError(404, 'No such resident, or not authorised');
    const full = `${rows[0].first_name} ${rows[0].last_name}`.trim().toLowerCase().replace(/\s+/g, ' ');
    if (typed !== full) throw new HttpError(400, "The name typed does not match the resident's name");
    const { rows: out } = await client.query('select public.erase_resident($1, $2) as r', [id, reason]);
    return out[0].r;
  }).catch((err) => { throw err.code === '42501' ? new HttpError(403, 'Only an administrator can erase a resident') : err; });

  res.json(result);
}));

module.exports = router;
