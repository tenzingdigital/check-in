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
    if (!wantCompliance || found.length === 0) return found;

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

  const row = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query(
      `insert into public.residents (first_name, last_name, date_of_birth, id_type, id_number, registered_by)
       values ($1, $2, $3, $4, $5, auth.uid())
       returning id`,
      [first, last, dob, id.idType, id.idNumber],
    );
    return rows[0];
  }).catch((err) => { throw supervisorOnly(err); });

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
              status, departed_on, registered_at
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
        returning id, first_name, last_name, id_type, id_number, status, departed_on`,
      args,
    );
    return rows[0];
  }).catch((err) => { throw supervisorOnly(err); });

  if (!row) throw new HttpError(403, 'Only a supervisor or admin can change resident details');
  res.json({ ok: true, ...row });
}));

module.exports = router;
