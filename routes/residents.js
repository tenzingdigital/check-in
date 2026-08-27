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
const { HttpError, uuidParam, intParam } = require('../lib/api');

const router = express.Router();

const STRIP_DAYS = 30;

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

  const rows = await db.withIdentity(req.session.userId, async (client) => {
    const { rows: found } = await client.query(
      'select * from public.search_residents($1, false, $2)',
      [q, limit],
    );
    if (!wantCompliance || found.length === 0) return found;

    const { rows: comp } = await client.query(
      `select id, state, required_today, seen_today, checkins_today,
              open_breaches, noted_breaches, consecutive_missed, last_seen_on
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
      `select id, full_name, room_ref, age_years, required_today, seen_today,
              checkins_today, open_breaches, noted_breaches, consecutive_missed,
              last_seen_on, state
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

module.exports = router;
