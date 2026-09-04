// Password reset: request a link, then spend it.
//
// Both endpoints are UNAUTHENTICATED by necessity, so they are mounted before
// auth.requireSession in server.js and they carry their own rules:
//
//   * The request endpoint answers identically whether or not the address
//     exists. Nothing in the status, the body or the timing distinguishes a
//     real staff email from a stranger's, so this is not an oracle for who
//     works here.
//   * Both run on the OWNER connection, not withIdentity(): there is no
//     session yet, so there is no identity to bind. That is why the two SQL
//     functions are revoked from the request roles and re-check everything
//     themselves.
//   * The token never touches the database. Only its SHA-256 does, the same
//     arrangement as session cookies.
const express = require('express');
const crypto = require('crypto');
const { wrap } = require('../lib/asyncRoute');
const db = require('../database');
const mail = require('../lib/mail');
const auth = require('../lib/auth');
const { HttpError } = require('../lib/api');

const router = express.Router();

const TTL_MINUTES = 60;

// Same generator as session tokens: 32 CSPRNG bytes, base64url so it survives
// a query string without escaping.
function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}
function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest();
}

// The link has to point back at this deployment. Prefer an explicit
// PUBLIC_URL; fall back to the proxy's forwarded host, which Render sets.
function baseUrl(req) {
  const configured = String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  return `${proto}://${req.get('host')}`;
}

// POST /api/password-reset  { email }
router.post('/', wrap(async (req, res) => {
  const email = String((req.body || {}).email || '').trim();

  // Per-IP, on the same eight-in-five-minutes counter as login. Each request
  // costs a database call and possibly an email; without this a single
  // address could fire thousands. The account-level gap in
  // auth.create_password_reset() still caps the emails per person.
  if (auth.lockedOut('password-reset', req.ip)) {
    return res.status(429).json({ error: 'Too many requests. Wait five minutes and try again.' });
  }
  auth.noteFailure('password-reset', req.ip);

  // Answer before doing anything expensive if the input is obviously not an
  // address. Still a 200: a 400 here would leak that the format check ran.
  if (email && email.length <= 320 && email.includes('@')) {
    const token = newToken();

    const fullName = await db.withOwner(async (client) => {
      const { rows } = await client.query(
        'select auth.create_password_reset($1, $2, $3) as full_name',
        [email, tokenHash(token), TTL_MINUTES],
      );
      return rows[0] && rows[0].full_name;
    });

    // null means: no such active account, or a link was issued seconds ago.
    // Either way the browser is told the same thing.
    if (fullName) {
      const link = `${baseUrl(req)}/?reset=${encodeURIComponent(token)}`;
      const { subject, text } = mail.resetEmail({ fullName, link, minutes: TTL_MINUTES });
      await mail.send({ to: email, subject, text });
    }
  }

  res.json({ ok: true });
}));

// POST /api/password-reset/confirm  { token, password }
router.post('/confirm', wrap(async (req, res) => {
  const body = req.body || {};
  const token = String(body.token || '');
  const password = String(body.password || '');

  if (!token) throw new HttpError(400, 'This reset link is not valid.');
  if (password.length < 12) {
    throw new HttpError(400, 'Choose a password of at least 12 characters.');
  }

  const ok = await db.withOwner(async (client) => {
    const { rows } = await client.query(
      'select auth.redeem_password_reset($1, $2) as ok',
      [tokenHash(token), password],
    );
    return rows[0] && rows[0].ok;
  });

  if (!ok) {
    throw new HttpError(400, 'This reset link has expired or has already been used. Request a new one.');
  }

  // No session is issued here on purpose. Redeeming ends every session for
  // the account, and logging the browser straight in would mean a stolen link
  // is a login rather than a password change somebody notices.
  res.json({ ok: true });
}));

module.exports = router;
