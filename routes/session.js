// Sign in, sign out, and "who am I".
//
// This is the only router mounted ahead of auth.requireSession, because it is
// the one that creates a session. Everything it does that touches credentials
// lives in lib/auth.js; this file is transport only.
const express = require('express');
const { wrap } = require('../lib/asyncRoute');
const db = require('../database');
const auth = require('../lib/auth');

const router = express.Router();

// POST /api/session — log in.
router.post('/', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  const ip = req.ip;

  if (auth.lockedOut(email, ip)) {
    await auth.noteLocked(email, { ip, userAgent: req.get('user-agent') });
    return res.status(429).json({ error: 'Too many attempts. Wait five minutes and try again.' });
  }

  const result = await auth.signIn(email, password, { ip, userAgent: req.get('user-agent') });
  if (!result) {
    // One message for every failure mode — wrong password, unknown email,
    // deactivated profile. Distinguishing them tells an attacker which
    // addresses are guards, and tells a suspended guard exactly what happened
    // when the intended channel for that is their supervisor.
    return res.status(401).json({ error: 'Email or password not recognised.' });
  }

  res.setHeader('Set-Cookie', auth.sessionCookie(result.token, result.expiresAt));
  res.json({ ok: true });
}));

// DELETE /api/session — log out.
router.delete('/', wrap(async (req, res) => {
  await auth.signOut(auth.parseCookies(req.headers.cookie)[auth.COOKIE_NAME]);
  res.setHeader('Set-Cookie', auth.clearedCookie());
  res.json({ ok: true });
}));

// GET /api/session — who am I, and what is this site called.
//
// Both front ends call this on boot. The browser holds no token of its own, so
// this is also how a page decides whether to show the login form or the app.
router.get('/', auth.requireSession, wrap(async (req, res) => {
  const settings = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query(
      `select site_name, local_timezone, adult_age_years, due_soon_after_hour,
              event_retention_days, compliance_retention_days, late_entry_window_hours,
              idle_lock_minutes, feature_buildings, feature_evacuation, feature_households
         from public.app_settings limit 1`,
    );
    return rows[0] || null;
  });

  // `id` is here for the offline queue: events recorded while the link was
  // down are stored on the terminal with the id of the guard who recorded
  // them, and only that guard's session replays them. The server still takes
  // identity from the session when it does (Tao 6) — the id lets the terminal
  // avoid handing one guard's events to another's login, not the reverse.
  res.json({
    profile: { id: req.session.userId, full_name: req.session.fullName, role: req.session.role },
    settings,
  });
}));

// GET /api/session/health — is the register being kept up? Every terminal
// polls this with its summary refresh and shows a banner when the nightly
// close-out is behind, because a register that has stopped recording who
// was missed looks exactly like a register where nobody was missed.
router.get('/health', auth.requireSession, wrap(async (req, res) => {
  const row = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query('select * from public.v_system_health');
    return rows[0] || null;
  });
  res.json(row || {});
}));

module.exports = router;
