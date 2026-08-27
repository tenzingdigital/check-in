// The gate app's API: who is on site, sign in/out, and the day's movement log.
const express = require('express');
const { wrap } = require('../lib/asyncRoute');
const db = require('../database');
const { HttpError, uuidParam, intParam, dateParam } = require('../lib/api');

const router = express.Router();

const MAX_LOG_ROWS = 500;

// GET /api/summary — the header counts.
router.get('/summary', wrap(async (req, res) => {
  const row = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query('select * from public.hut_summary()');
    return rows[0];
  });
  res.json(row || { on_site: 0, events_today: 0 });
}));

// POST /api/gate-events — sign a resident in or out.
router.post('/gate-events', wrap(async (req, res) => {
  const body = req.body || {};
  const direction = String(body.direction || '');
  if (direction !== 'in' && direction !== 'out') {
    throw new HttpError(400, "direction must be 'in' or 'out'");
  }

  const row = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query(
      'select * from public.record_check($1, $2, $3)',
      [uuidParam(body.resident_id, 'resident_id'), direction, body.note ?? null],
    );
    return rows[0];
  });

  if (!row) throw new HttpError(404, 'Resident not found');
  res.json(row);
}));

// GET /api/gate-events?date=YYYY-MM-DD — the day's movement log.
//
// The window is computed from app_settings.local_timezone rather than from the
// browser's clock, which was a behaviour change when this app left Supabase:
// the old client built the range in the terminal's local time. The site's
// timezone is the one the rest of the compliance model already uses
// (site_today()), and a terminal with a mis-set timezone should not be able to
// shift what "today's log" means.
router.get('/gate-events', wrap(async (req, res) => {
  const date = dateParam(req.query.date, 'date');
  const limit = intParam(req.query.limit, MAX_LOG_ROWS, MAX_LOG_ROWS);

  const rows = await db.withIdentity(req.session.userId, async (client) => {
    const { rows: log } = await client.query(
      `with s as (select local_timezone as tz from public.app_settings limit 1)
       select l.id, l.resident_id, l.kind, l.occurred_at, l.note,
              l.resident_name, l.room_ref, l.guard_id, l.guard_name
         from public.v_check_log l, s
        where l.occurred_at >= ($1::date)::timestamp at time zone s.tz
          and l.occurred_at <  (($1::date) + 1)::timestamp at time zone s.tz
        order by l.occurred_at desc
        limit $2`,
      [date, limit],
    );
    return log;
  });

  res.json(rows);
}));

module.exports = router;
