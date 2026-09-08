// Visitors — staff, visitors, contractors and suppliers on site (migration 024).
//
//   GET  /api/visits?date=YYYY-MM-DD   that day's visits (site time), on site first
//   GET  /api/visits?on_site=1          whoever is still on site, for the roll call
//   POST /api/visits                    { kind, name, company? }      sign in
//   POST /api/visits/:id/leave                                        sign out
//
// Any staff member: the guard at the door is the person who meets them.
// Behind the feature_visitors switch on the gate; the API itself does not
// hide, so a site that turns the tab off keeps its record readable.

const express = require('express');
const { wrap } = require('../lib/asyncRoute');
const db = require('../database');
const { HttpError, uuidParam, dateParam } = require('../lib/api');

const router = express.Router();

const KINDS = ['staff', 'visitor', 'contractor', 'supplier'];

const SELECT = `
  select v.id, v.kind, v.name, v.company, v.arrived_at, v.left_at, v.roster_id,
         a.full_name as arrived_by_name, l.full_name as left_by_name
    from visits v
    left join profiles a on a.id = v.arrived_by
    left join profiles l on l.id = v.left_by`;

router.get('/visits', wrap(async (req, res) => {
  const onSite = req.query.on_site === '1';
  const date = req.query.date ? dateParam(req.query.date, 'date') : null;
  const rows = await db.withIdentity(req.session.userId, async (client) => {
    if (onSite) {
      const { rows } = await client.query(`${SELECT} where v.left_at is null order by v.arrived_at`);
      return rows;
    }
    // The day in the site's own time zone, plus anyone still on site from
    // before it: a contractor who arrived last night is still a fact today.
    const { rows } = await client.query(
      `${SELECT}
        where (v.arrived_at at time zone (select local_timezone from app_settings where id))::date = coalesce($1::date, site_today())
           or v.left_at is null
        order by (v.left_at is null) desc, v.arrived_at desc`,
      [date]);
    return rows;
  });
  res.json(rows);
}));

router.post('/visits', wrap(async (req, res) => {
  const body = req.body || {};
  // A listed staff member (migration 030): the name and role come from the list.
  if (body.roster_id) {
    const rosterId = uuidParam(body.roster_id, 'roster_id');
    const row = await db.withIdentity(req.session.userId, async (client) => {
      const { rows } = await client.query('select * from record_staff_arrival($1)', [rosterId]);
      const { rows: full } = await client.query(`${SELECT} where v.id = $1`, [rows[0].id]);
      return full[0];
    }).catch((err) => {
      if (err && err.code === 'P0002') throw new HttpError(404, 'Not on the staff list');
      if (err && err.code === '23505') throw new HttpError(409, 'Already signed in');
      throw err;
    });
    return res.status(201).json(row);
  }
  const kind = String(body.kind || '').trim().toLowerCase();
  if (!KINDS.includes(kind)) throw new HttpError(400, `Who is this? Choose ${KINDS.join(', ')}`);
  const name = String(body.name || '').trim();
  if (!name || name.length > 80) throw new HttpError(400, 'A name is required (up to 80 characters)');
  const company = String(body.company || '').trim();
  if (company.length > 80) throw new HttpError(400, 'Company or reason: up to 80 characters');
  const row = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query('select * from record_visit_arrival($1, $2, $3)', [kind, name, company || null]);
    const { rows: full } = await client.query(`${SELECT} where v.id = $1`, [rows[0].id]);
    return full[0];
  });
  res.status(201).json(row);
}));

router.post('/visits/:id/leave', wrap(async (req, res) => {
  const id = uuidParam(req.params.id, 'visit id');
  const row = await db.withIdentity(req.session.userId, async (client) => {
    await client.query('select record_visit_departure($1)', [id]);
    const { rows } = await client.query(`${SELECT} where v.id = $1`, [id]);
    return rows[0];
  }).catch((err) => { throw err.code === 'P0002' ? new HttpError(404, 'No such visit') : err; });
  res.json(row);
}));

module.exports = router;
