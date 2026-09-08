// Buildings, floors and rooms — Stage 1 of docs/PRODUCT-ROADMAP.md.
//
//   GET    /api/buildings                 every building with its rooms and occupancy
//   POST   /api/buildings                 { name }                          supervisor+
//   PATCH  /api/buildings/:id             { name?, sort? }                  supervisor+
//   DELETE /api/buildings/:id             refused while any room is occupied
//   POST   /api/buildings/:id/rooms       { rooms: [{ floor?, number, capacity? }] }
//   PATCH  /api/rooms/:id                 { floor?, number?, capacity?, sort? }
//   DELETE /api/rooms/:id                 refused while occupied
//
// Reads are for every staff member (a guard needs the room on the card and
// the roll call needs the building). Writes are refused by the database to
// anyone below supervisor — the 42501 is turned into a 403 here.

const express = require('express');
const { wrap } = require('../lib/asyncRoute');
const db = require('../database');
const { HttpError, uuidParam } = require('../lib/api');

const router = express.Router();

function text(value, field, max) {
  const v = String(value ?? '').trim();
  if (!v || v.length > max) throw new HttpError(400, `${field} is required (up to ${max} characters)`);
  return v;
}
function optText(value, max, field) {
  const v = String(value ?? '').trim();
  if (v.length > max) throw new HttpError(400, `${field} is too long (up to ${max} characters)`);
  return v;
}
function int(value, field, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${field} must be a whole number between ${min} and ${max}`);
  return n;
}
function supervisorOnly(err) {
  if (err && err.code === '42501') return new HttpError(403, 'Only a supervisor or admin can change buildings and rooms');
  if (err && err.code === '23505') return new HttpError(409, 'That name or room already exists');
  // A room for a building that has since been removed: not an outage, a
  // stale screen. Found by the permission matrix test.
  if (err && err.code === '23503') return new HttpError(404, 'No such building');
  return err;
}

// Everything the Buildings tab shows, in one query: buildings in their
// order, each with its rooms in theirs, each room with its occupants.
async function listBuildings(client) {
  const { rows } = await client.query(
    `select b.id, b.name, b.sort,
            coalesce((
              select jsonb_agg(jsonb_build_object(
                       'id', o.room_id, 'floor', o.floor, 'number', o.room, 'capacity', o.capacity,
                       'contracted_capacity', o.contracted_capacity, 'bed_config', o.bed_config,
                       'sort', o.room_sort, 'occupants', o.occupants, 'on_site', o.on_site, 'residents', o.residents)
                     order by o.room_sort, o.floor, o.room)
                from v_room_occupancy o where o.building_id = b.id and not o.archived), '[]'::jsonb) as rooms,
            coalesce((
              select jsonb_agg(jsonb_build_object(
                       'id', o.room_id, 'floor', o.floor, 'number', o.room, 'capacity', o.capacity,
                       'contracted_capacity', o.contracted_capacity, 'bed_config', o.bed_config)
                     order by o.room_sort, o.floor, o.room)
                from v_room_occupancy o where o.building_id = b.id and o.archived), '[]'::jsonb) as archived_rooms
       from buildings b
      order by b.sort, b.name`,
  );
  return rows;
}

router.get('/buildings', wrap(async (req, res) => {
  const rows = await db.withIdentity(req.session.userId, listBuildings);
  res.json(rows);
}));

router.post('/buildings', wrap(async (req, res) => {
  const body = req.body || {};
  const name = text(body.name, 'Building name', 60);
  const sort = int(body.sort, 'Order', 0, 1000, null);
  const row = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query(
      `insert into buildings (name, sort)
       values ($1, coalesce($2, (select coalesce(max(sort), 0) + 10 from buildings)))
       returning id, name, sort`,
      [name, sort],
    );
    return rows[0];
  }).catch((err) => { throw supervisorOnly(err); });
  res.status(201).json(row);
}));

router.patch('/buildings/:id', wrap(async (req, res) => {
  const body = req.body || {};
  const id = uuidParam(req.params.id, 'building id');
  const sets = []; const args = [id];
  const set = (col, val) => { args.push(val); sets.push(`${col} = $${args.length}`); };
  if (Object.prototype.hasOwnProperty.call(body, 'name')) set('name', text(body.name, 'Building name', 60));
  if (Object.prototype.hasOwnProperty.call(body, 'sort')) set('sort', int(body.sort, 'Order', 0, 1000, 0));
  if (!sets.length) throw new HttpError(400, 'Nothing to change');
  const row = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query(
      `update buildings set ${sets.join(', ')} where id = $1 returning id, name, sort`, args);
    return rows[0];
  }).catch((err) => { throw supervisorOnly(err); });
  if (!row) throw new HttpError(403, 'Only a supervisor or admin can change buildings');
  res.json(row);
}));

router.delete('/buildings/:id', wrap(async (req, res) => {
  const id = uuidParam(req.params.id, 'building id');
  const out = await db.withIdentity(req.session.userId, async (client) => {
    const occupied = await client.query(
      `select count(*)::int as n from residents r join rooms rm on rm.id = r.room_id
        where rm.building_id = $1 and r.status = 'active'`, [id]);
    if (occupied.rows[0].n > 0) throw new HttpError(409, `${occupied.rows[0].n} resident(s) still live in this building. Move them first.`);
    const { rowCount } = await client.query(`delete from buildings where id = $1`, [id]);
    return rowCount;
  }).catch((err) => { throw supervisorOnly(err); });
  // The row policy lets a guard's delete match nothing. A refusal, not a
  // missing building: 403 like every other refusal (the permission matrix).
  if (!out) throw req.session.role === 'guard' ? new HttpError(403, 'Only a supervisor or admin can change buildings and rooms') : new HttpError(404, 'No such building');
  res.json({ ok: true });
}));

// Rooms are added in a batch so a supervisor can type "1-12" or a list on
// one screen and get twelve rooms; the browser expands the shorthand.
router.post('/buildings/:id/rooms', wrap(async (req, res) => {
  const buildingId = uuidParam(req.params.id, 'building id');
  const body = req.body || {};
  const list = Array.isArray(body.rooms) ? body.rooms : [body];
  if (!list.length || list.length > 200) throw new HttpError(400, 'Give between 1 and 200 rooms');
  const rooms = list.map((r, i) => ({
    floor: optText(r.floor, 20, `Floor of room ${i + 1}`),
    number: text(r.number, `Room number ${i + 1}`, 20),
    capacity: int(r.capacity, 'Capacity', 1, 30, 1),
  }));
  const out = await db.withIdentity(req.session.userId, async (client) => {
    const created = [];
    for (const r of rooms) {
      const { rows } = await client.query(
        `insert into rooms (building_id, floor, number, capacity, sort)
         values ($1, $2, $3, $4, (select coalesce(max(sort), 0) + 10 from rooms where building_id = $1))
         on conflict (building_id, floor, number) do update set capacity = excluded.capacity
         returning id, floor, number, capacity, sort`,
        [buildingId, r.floor, r.number, r.capacity],
      );
      if (rows[0]) created.push(rows[0]);
    }
    return created;
  }).catch((err) => { throw supervisorOnly(err); });
  if (!out.length) throw new HttpError(403, 'Only a supervisor or admin can add rooms');
  res.status(201).json(out);
}));

router.patch('/rooms/:id', wrap(async (req, res) => {
  const body = req.body || {};
  const id = uuidParam(req.params.id, 'room id');
  const sets = []; const args = [id];
  const set = (col, val) => { args.push(val); sets.push(`${col} = $${args.length}`); };
  if (Object.prototype.hasOwnProperty.call(body, 'floor')) set('floor', optText(body.floor, 20, 'Floor'));
  if (Object.prototype.hasOwnProperty.call(body, 'number')) set('number', text(body.number, 'Room number', 20));
  if (Object.prototype.hasOwnProperty.call(body, 'capacity')) set('capacity', int(body.capacity, 'Capacity', 1, 30, 1));
  if (Object.prototype.hasOwnProperty.call(body, 'sort')) set('sort', int(body.sort, 'Order', 0, 10000, 0));
  // Contracted beds (migration 031): a number, or null to mean "same as capacity".
  if (Object.prototype.hasOwnProperty.call(body, 'contracted_capacity')) {
    const v = body.contracted_capacity;
    set('contracted_capacity', v === null || v === '' ? null : int(v, 'Contracted beds', 0, 30, 0));
  }
  if (Object.prototype.hasOwnProperty.call(body, 'bed_config')) set('bed_config', optText(body.bed_config, 80, 'Bed configuration') || null);
  if (!sets.length) throw new HttpError(400, 'Nothing to change');
  const row = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query(
      `update rooms set ${sets.join(', ')} where id = $1 returning id, building_id, floor, number, capacity, contracted_capacity, bed_config, sort, archived_at`, args);
    return rows[0];
  }).catch((err) => { throw supervisorOnly(err); });
  if (!row) throw new HttpError(403, 'Only a supervisor or admin can change rooms');
  res.json(row);
}));

// DELETE /api/rooms/:id — take a room out of use. A room that has ever had
// a resident is archived (migration 031): it keeps its history and nobody
// can be assigned to it. A room that was never used is removed outright.
router.delete('/rooms/:id', wrap(async (req, res) => {
  const id = uuidParam(req.params.id, 'room id');
  const out = await db.withIdentity(req.session.userId, async (client) => {
    const occupied = await client.query(
      `select count(*)::int as n from residents where room_id = $1 and status = 'active'`, [id]);
    if (occupied.rows[0].n > 0) throw new HttpError(409, `${occupied.rows[0].n} resident(s) still live in this room. Move them first.`);
    const history = await client.query(
      `select exists (select 1 from room_assignments where room_id = $1) or exists (select 1 from residents where room_id = $1) as used`, [id]);
    if (history.rows[0].used) {
      const { rowCount } = await client.query(`update rooms set archived_at = coalesce(archived_at, now()) where id = $1`, [id]);
      return rowCount ? { ok: true, archived: true } : null;
    }
    const { rowCount } = await client.query(`delete from rooms where id = $1`, [id]);
    return rowCount ? { ok: true, archived: false } : null;
  }).catch((err) => { throw supervisorOnly(err); });
  if (!out) throw req.session.role === 'guard' ? new HttpError(403, 'Only a supervisor or admin can change buildings and rooms') : new HttpError(404, 'No such room');
  res.json(out);
}));

// POST /api/rooms/:id/restore — back into use.
router.post('/rooms/:id/restore', wrap(async (req, res) => {
  const id = uuidParam(req.params.id, 'room id');
  const row = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query(
      `update rooms set archived_at = null where id = $1 returning id, building_id, floor, number, capacity, contracted_capacity, bed_config, sort, archived_at`, [id]);
    return rows[0];
  }).catch((err) => { throw supervisorOnly(err); });
  if (!row) throw req.session.role === 'guard' ? new HttpError(403, 'Only a supervisor or admin can change buildings and rooms') : new HttpError(404, 'No such room');
  res.json(row);
}));

module.exports = router;
