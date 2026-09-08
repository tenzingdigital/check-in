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
    const { rows } = await client.query('select * from hut_summary()');
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
      'select * from record_check($1, $2)',
      [uuidParam(body.resident_id, 'resident_id'), direction],
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
// GET /api/gate-events?date=YYYY-MM-DD            one day (the original form)
// GET /api/gate-events?from=…&to=…&q=…             up to 31 days, filtered by
//                                                  part of a name or a room
// The centre managers asked for both: a search over a period of days, by
// resident or by room. The room is the resident's room today, not the room
// they had at the time; rooms are not versioned.
router.get('/gate-events', wrap(async (req, res) => {
  const from = dateParam(req.query.from || req.query.date, 'from');
  const to = dateParam(req.query.to || req.query.from || req.query.date, 'to');
  if (to < from) throw new HttpError(400, 'to must not be before from');
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > 31) throw new HttpError(400, 'The log shows at most 31 days at a time; use a report for more');
  const q = String(req.query.q || '').trim().slice(0, 80);
  const limit = intParam(req.query.limit, MAX_LOG_ROWS, MAX_LOG_ROWS);

  const rows = await db.withIdentity(req.session.userId, async (client) => {
    const { rows: log } = await client.query(
      `with s as (select local_timezone as tz from app_settings limit 1)
       select l.id, l.resident_id, l.kind, l.occurred_at,
              l.resident_name, l.guard_id, l.guard_name,
              l.late_entry, l.recorded_at, rm.room_label
         from v_check_log l
         cross join s
         left join v_resident_room rm on rm.id = l.resident_id
        where l.occurred_at >= ($1::date)::timestamp at time zone s.tz
          and l.occurred_at <  (($2::date) + 1)::timestamp at time zone s.tz
          and ($3 = '' or l.resident_name ilike '%' || $3 || '%' or coalesce(rm.room_label, '') ilike '%' || $3 || '%')
        order by l.occurred_at desc
        limit $4`,
      [from, to, q, limit],
    );
    return log;
  });

  res.json(rows);
}));

module.exports = router;
