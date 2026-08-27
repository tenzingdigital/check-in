// The check-in app's API: the statutory daily register.
const express = require('express');
const { wrap } = require('../lib/asyncRoute');
const db = require('../database');
const { uuidParam, intParam } = require('../lib/api');

const router = express.Router();

const MAX_ATTENTION = 200;

// GET /api/attention — the guard's worklist.
router.get('/attention', wrap(async (req, res) => {
  const limit = intParam(req.query.limit, MAX_ATTENTION, MAX_ATTENTION);
  const rows = await db.withIdentity(req.session.userId, async (client) => {
    const { rows: list } = await client.query('select * from public.attention_list($1)', [limit]);
    return list;
  });
  res.json(rows);
}));

// GET /api/checkin-summary — the check-in app's header, in one round trip.
//
// The counts are queried from v_resident_compliance rather than derived from
// the attention list, for the reason the old client documented at length:
// attention_list() only admits breach_open | never | due_today,
// so a resident who is required today but not yet past due_soon_after_hour
// would silently fall out of a count derived from it.
router.get('/checkin-summary', wrap(async (req, res) => {
  const out = await db.withIdentity(req.session.userId, async (client) => {
    const [attention, counts] = await Promise.all([
      client.query('select * from public.attention_list($1)', [MAX_ATTENTION]),
      client.query(
        `select count(*) filter (where seen_today)::integer as seen_today,
                count(*) filter (where required_today and not seen_today)::integer as not_seen
           from public.v_resident_compliance`,
      ),
    ]);
    return {
      attention: attention.rows,
      seen_today: counts.rows[0] ? counts.rows[0].seen_today : 0,
      not_seen: counts.rows[0] ? counts.rows[0].not_seen : 0,
    };
  });
  res.json(out);
}));

// POST /api/checkins — record that a resident presented at the hut today.
router.post('/checkins', wrap(async (req, res) => {
  const body = req.body || {};
  const row = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query(
      'select * from public.record_checkin($1)',
      [uuidParam(body.resident_id, 'resident_id')],
    );
    return rows[0];
  });
  res.json(row);
}));

module.exports = router;
