// routes/kiosk.js — the resident self check-in kiosk: search one adult, and
// record one check-in. Nothing else.
//
// A shared, unattended tablet by the door, logged in once as the 'kiosk'
// role and left running (in Guided Access, on a real device). lib/auth.js's
// requireSession already refuses that role every route on this app but
// these two, plus reading and ending its own session — so this file is
// deliberately thin: validation, a rate limit, and a call to one of the two
// SECURITY DEFINER doors migration 051 built for it. Every real security
// decision — who may call them, what a result carries, what may be written —
// lives in kiosk_search()/kiosk_checkin() themselves, not here; see that
// migration's comments for what "match" means and why a child never appears.
const express = require('express');
const { wrap } = require('../lib/asyncRoute');
const db = require('../database');
const { HttpError, translateDbError, uuidParam } = require('../lib/api');

const router = express.Router();

// ---------------------------------------------------------------------------
// A search a minute, not a scrape. In-memory and per session, the same shape
// as lib/auth.js's own login-attempt map: a sliding one-minute window of
// timestamps, keyed on the session's user id (a kiosk holds exactly one
// session for its whole shift, so this is effectively per-tablet), swept on
// an unref'd interval so a quiet tablet's entry does not linger forever.
// ---------------------------------------------------------------------------
const SEARCH_LIMIT = 60;
const SEARCH_WINDOW_MS = 60_000;
const searches = new Map();

// Returns true (and does not count the attempt) if the caller has already
// searched SEARCH_LIMIT times in the last minute; otherwise records this
// attempt and returns false.
function overSearchLimit(key) {
  const now = Date.now();
  const hits = (searches.get(key) || []).filter((t) => now - t < SEARCH_WINDOW_MS);
  if (hits.length >= SEARCH_LIMIT) {
    searches.set(key, hits);
    return true;
  }
  hits.push(now);
  searches.set(key, hits);
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, hits] of searches) {
    const kept = hits.filter((t) => now - t < SEARCH_WINDOW_MS);
    if (kept.length) searches.set(key, kept);
    else searches.delete(key);
  }
}, 60_000).unref();

// POST /api/kiosk/search { q } — up to five adult residents matching a name
// (either word order), an exact room label, or an exact identity number.
// kiosk_search() (051) does the real work, including the "at least two
// letters, no LIKE wildcards" refusal (22023, translated to 400 below) and
// hiding the room unless two residents share a name. Callable by kiosk,
// supervisor and admin — anyone else gets 42501 from the function itself,
// translated to 403.
router.post('/search', wrap(async (req, res) => {
  if (overSearchLimit(req.session.userId)) {
    throw new HttpError(429, 'Too many searches — wait a moment.');
  }
  const q = typeof req.body?.q === 'string' ? req.body.q : '';
  const rows = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query('select * from kiosk_search($1)', [q]);
    return rows;
  }).catch((err) => { throw translateDbError(err); });

  res.json({
    results: rows.map((r) => ({
      id: r.resident_id,
      full_name: r.full_name,
      room_label: r.room_label,
      checked_in_today: r.checked_in_today,
    })),
  });
}));

// POST /api/kiosk/checkin { id, full_name? } — record that this resident
// presented today. kiosk_checkin() (051) is the only door: it is the one
// place a kiosk session can reach record_checkin_at, always with
// source='kiosk', and it refuses a child or a resident departed before today
// (P0002, translated below to 404 — from the tablet's point of view "not a
// resident who checks in here" is the record not existing, the same message
// migration 051 gives an unknown id).
//
// full_name is not looked up here: a kiosk session cannot read the residents
// table directly (RLS), and kiosk_checkin() returns only a daily_compliance
// row, which carries no name. The tablet already has it — it is the same
// name kiosk_search() just showed on the screen the resident was tapped
// from — so the route simply echoes back whatever the caller sends, for the
// confirmation screen; it is never trusted for anything and is not required.
router.post('/checkin', wrap(async (req, res) => {
  const id = uuidParam(req.body?.id, 'id');
  const fullName = typeof req.body?.full_name === 'string' && req.body.full_name.trim() ? req.body.full_name.trim() : null;

  const row = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query('select * from kiosk_checkin($1)', [id]);
    return rows[0];
  }).catch((err) => {
    const translated = translateDbError(err);
    if (translated.status === 400 && err.code === 'P0002') translated.status = 404;
    throw translated;
  });

  res.json({ ok: true, full_name: fullName, checked_in_at: row.first_seen_at });
}));

module.exports = router;
