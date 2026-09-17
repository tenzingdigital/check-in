// routes/registerFix.js — fixing the register over HTTP: take a wrong entry
// off, put a missed one on, at the time it happened.
//
// Every authorisation and validation rule for both lives in the two SQL
// functions from migration 056 — this router is thin transport, translating
// their refusals into HTTP statuses, the same posture as every other route
// in this directory.
//
//   DELETE /api/register-entries/:register/:id { reason? }
//     remove_register_entry() (056): the same site-day, your own entry,
//     within 15 minutes — any staff, no reason needed; the same site-day
//     otherwise, or an earlier day — a reason is required, and an earlier
//     day needs a supervisor or admin.
//
//   POST /api/register-entries { register, resident_id, direction?,
//                                 occurred_at, reason }
//     add_register_entry() (056): within the late-entry window (48h by
//     default) — any staff, with a reason; older, up to 28 nights — a
//     supervisor or admin, with a reason.
const express = require('express');
const { wrap } = require('../lib/asyncRoute');
const db = require('../database');
const { HttpError, uuidParam, translateDbError } = require('../lib/api');

const router = express.Router();

const ID_RE = /^\d{1,18}$/;

router.delete('/register-entries/:register/:id', wrap(async (req, res) => {
  const register = String(req.params.register || '');
  const id = String(req.params.id || '');
  if (!ID_RE.test(id)) throw new HttpError(400, 'id must be a positive integer');
  const reason = req.body && req.body.reason != null ? String(req.body.reason) : null;

  await db.withIdentity(req.session.userId, async (client) => {
    await client.query('select public.remove_register_entry($1, $2, $3)', [register, id, reason]);
  }).catch((err) => { throw translateDbError(err); });

  res.status(204).end();
}));

router.post('/register-entries', wrap(async (req, res) => {
  const body = req.body || {};
  const register = String(body.register || '');
  const resident_id = uuidParam(body.resident_id, 'resident_id');
  const direction = body.direction != null ? String(body.direction) : null;
  const occurred_at = String(body.occurred_at || '');
  if (!Number.isFinite(Date.parse(occurred_at))) throw new HttpError(400, 'occurred_at must be a date');
  const reason = body.reason != null ? String(body.reason) : null;

  const id = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query(
      'select public.add_register_entry($1, $2, $3, $4, $5) as id',
      [register, resident_id, direction, occurred_at, reason],
    );
    return rows[0].id;
  }).catch((err) => { throw translateDbError(err); });

  res.status(201).json({ id: Number(id) });
}));

module.exports = router;
