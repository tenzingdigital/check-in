// The site's staff list (migration 030).
//
//   GET   /api/roster            active people, each with the id of their open visit if on site
//   GET   /api/roster?all=1      archived too
//   POST  /api/roster            { name, role? }                    supervisor
//   POST  /api/roster/import     { rows: [{ name, role? }] }        supervisor; skips names already listed
//   PATCH /api/roster/:id        { name?, role?, active? }          supervisor
//
// Writes are the staff_roster_supervisor row policy: a guard's insert or
// update is refused by the database (42501 → 403).

const express = require('express');
const { wrap } = require('../lib/asyncRoute');
const db = require('../database');
const { HttpError, uuidParam } = require('../lib/api');

const router = express.Router();

const SELECT = `select r.id, r.name, r.role, r.active, r.created_at,
                       v.id as visit_id, v.arrived_at
                  from staff_roster r
                  left join visits v on v.roster_id = r.id and v.left_at is null`;

function nameOf(value) {
  const s = String(value || '').trim();
  if (!s || s.length > 80) throw new HttpError(400, 'A name is required (up to 80 characters)');
  return s;
}
function roleOf(value) {
  const s = String(value || '').trim();
  if (s.length > 80) throw new HttpError(400, 'Role: up to 80 characters');
  return s || null;
}
function translate(err) {
  if (err && err.code === '42501') return new HttpError(403, 'Only a supervisor or admin can change the staff list');
  if (err && err.code === '23505') return new HttpError(409, 'That name is already on the list');
  return err;
}

router.get('/roster', wrap(async (req, res) => {
  const all = req.query.all === '1';
  const rows = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query(`${SELECT} ${all ? '' : 'where r.active'} order by r.active desc, lower(r.name)`);
    return rows;
  });
  res.json(rows);
}));

router.post('/roster', wrap(async (req, res) => {
  const body = req.body || {};
  const name = nameOf(body.name);
  const role = roleOf(body.role);
  const row = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query(
      'insert into staff_roster (name, role, created_by) values ($1, $2, auth.uid()) returning id', [name, role]);
    if (!rows[0]) throw new HttpError(403, 'Only a supervisor or admin can change the staff list');
    const { rows: full } = await client.query(`${SELECT} where r.id = $1`, [rows[0].id]);
    return full[0];
  }).catch((err) => { throw translate(err); });
  res.status(201).json(row);
}));

router.post('/roster/import', wrap(async (req, res) => {
  const body = req.body || {};
  const rows = Array.isArray(body.rows) ? body.rows.slice(0, 500) : [];
  if (!rows.length) throw new HttpError(400, 'rows: a list of { name, role? }');
  const clean = rows.map((r) => ({ name: nameOf(r && r.name), role: roleOf(r && r.role) }));
  const out = await db.withIdentity(req.session.userId, async (client) => {
    let added = 0, skipped = 0;
    for (const r of clean) {
      const { rows } = await client.query(
        `insert into staff_roster (name, role, created_by) values ($1, $2, auth.uid())
         on conflict (lower(btrim(name))) do nothing returning id`, [r.name, r.role]);
      if (rows[0]) added += 1; else skipped += 1;
    }
    if (!added && skipped === 0) throw new HttpError(403, 'Only a supervisor or admin can change the staff list');
    return { added, skipped };
  }).catch((err) => { throw translate(err); });
  res.status(201).json(out);
}));

router.patch('/roster/:id', wrap(async (req, res) => {
  const id = uuidParam(req.params.id, 'roster id');
  const body = req.body || {};
  const sets = []; const args = [id];
  const set = (col, val) => { args.push(val); sets.push(`${col} = $${args.length}`); };
  if (Object.prototype.hasOwnProperty.call(body, 'name')) set('name', nameOf(body.name));
  if (Object.prototype.hasOwnProperty.call(body, 'role')) set('role', roleOf(body.role));
  if (Object.prototype.hasOwnProperty.call(body, 'active')) set('active', body.active === true);
  if (!sets.length) throw new HttpError(400, 'Nothing to change');
  const row = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query(`update staff_roster set ${sets.join(', ')} where id = $1 returning id`, args);
    if (!rows[0]) {
      const { rows: exists } = await client.query('select 1 from staff_roster where id = $1', [id]);
      throw new HttpError(exists[0] ? 403 : 404, exists[0] ? 'Only a supervisor or admin can change the staff list' : 'Not on the staff list');
    }
    const { rows: full } = await client.query(`${SELECT} where r.id = $1`, [id]);
    return full[0];
  }).catch((err) => { throw translate(err); });
  res.json(row);
}));

module.exports = router;
