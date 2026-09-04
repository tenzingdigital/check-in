// Evacuation list and roll call — Stage 2 of docs/PRODUCT-ROADMAP.md.
//
//   GET  /api/evacuation                 everyone active: room, presence, evacuation need
//   GET  /api/roll-calls/active          the open roll call with its marks, or null
//   GET  /api/roll-calls                 the last 50, with counts (the drill record)
//   POST /api/roll-calls                 { id, kind: 'drill'|'incident', started_at? }
//   POST /api/roll-calls/:id/marks       { resident_id, ref?, at? }   idempotent
//   POST /api/roll-calls/:id/end         { at? }
//
// Any staff member may do all of this: a fire does not wait for a supervisor.
// The terminal chooses the roll call's id, so one started offline keeps its
// identity when the marks sync (routes/sync.js carries the same calls).

const express = require('express');
const { wrap } = require('../lib/asyncRoute');
const db = require('../database');
const { HttpError, uuidParam } = require('../lib/api');

const router = express.Router();

function when(value) {
  if (value === undefined || value === null || value === '') return null;
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) throw new HttpError(400, 'at must be a timestamp');
  return d.toISOString();
}

router.get('/evacuation', wrap(async (req, res) => {
  const rows = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query(`select * from public.v_evacuation_list`);
    return rows;
  });
  res.json(rows);
}));

async function rollCallWithMarks(client, id) {
  const { rows } = await client.query(
    `select rc.*, p.full_name as started_by_name,
            coalesce((select jsonb_agg(jsonb_build_object('resident_id', m.resident_id, 'marked_at', m.marked_at, 'marked_by', m.marked_by) order by m.marked_at)
                        from public.roll_call_marks m where m.roll_call_id = rc.id), '[]'::jsonb) as marks
       from public.roll_calls rc
       left join public.profiles p on p.id = rc.started_by
      where rc.id = $1`, [id]);
  return rows[0] || null;
}

router.get('/roll-calls/active', wrap(async (req, res) => {
  const row = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query(`select id from public.roll_calls where ended_at is null order by started_at desc limit 1`);
    return rows[0] ? rollCallWithMarks(client, rows[0].id) : null;
  });
  res.json(row);
}));

router.get('/roll-calls', wrap(async (req, res) => {
  const rows = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query(
      `select rc.id, rc.kind, rc.started_at, rc.ended_at, p.full_name as started_by_name,
              (select count(*)::int from public.roll_call_marks m where m.roll_call_id = rc.id) as accounted
         from public.roll_calls rc left join public.profiles p on p.id = rc.started_by
        order by rc.started_at desc limit 50`);
    return rows;
  });
  res.json(rows);
}));

router.post('/roll-calls', wrap(async (req, res) => {
  const body = req.body || {};
  const id = uuidParam(body.id, 'id');
  const kind = String(body.kind || '');
  if (kind !== 'drill' && kind !== 'incident') throw new HttpError(400, "kind must be 'drill' or 'incident'");
  const row = await db.withIdentity(req.session.userId, async (client) => {
    await client.query(`select public.start_roll_call($1, $2, $3)`, [id, kind, when(body.started_at)]);
    return rollCallWithMarks(client, id);
  });
  res.status(201).json(row);
}));

router.post('/roll-calls/:id/marks', wrap(async (req, res) => {
  const body = req.body || {};
  const id = uuidParam(req.params.id, 'roll call id');
  const residentId = uuidParam(body.resident_id, 'resident_id');
  const ref = body.ref ? uuidParam(body.ref, 'ref') : null;
  const row = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query(`select * from public.mark_roll_call($1, $2, $3, $4)`, [id, residentId, ref, when(body.at)]);
    return rows[0];
  });
  res.json(row);
}));

router.post('/roll-calls/:id/end', wrap(async (req, res) => {
  const body = req.body || {};
  const id = uuidParam(req.params.id, 'roll call id');
  const row = await db.withIdentity(req.session.userId, async (client) => {
    await client.query(`select public.end_roll_call($1, $2)`, [id, when(body.at)]);
    return rollCallWithMarks(client, id);
  });
  res.json(row);
}));

module.exports = router;
