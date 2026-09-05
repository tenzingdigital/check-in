// Express app entry point for Hut Check-In — the gate app and the daily
// register.
//
// Load a local .env (development convenience) before anything reads
// process.env. In production the host sets real env vars; dotenv is optional
// there, so this is wrapped — the app still boots if the package isn't
// installed.
try { require('dotenv').config(); } catch (_) { /* env comes from the host */ }

const path = require('path');
const express = require('express');

const db = require('./database');            // pool + migrate() + the RLS helpers
const auth = require('./lib/auth');
const { securityHeaders } = require('./lib/security');
const { translateDbError } = require('./lib/api');

// One Render web service serves both things: the static front ends out of
// public/, and the API out of /api. That is deliberate over the more obvious
// "static site + separate API service" split — same origin means the session
// cookie is a first-party cookie with SameSite=Lax rather than a cross-site one
// needing SameSite=None, and one service is one bill, one deploy, one log.
const app = express();

// Express advertises itself in every response header. Nothing depends on it and
// it names the stack to anyone probing.
app.disable('x-powered-by');

// Render terminates TLS and proxies every request through its own edge, so
// without this every request arrives from one internal hop and `req.ip`
// describes that connection, not the real visitor — which would collapse
// lib/auth.js's per-IP login lockout into one global counter. `1` trusts
// exactly one hop (Render's own edge); trusting more hops than actually exist
// would let a client spoof X-Forwarded-For itself.
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;
const pub = path.join(__dirname, 'public');

app.use(securityHeaders());

// Boot sequence — one ordered, awaited function, exported but never called at
// module load, so test/api.test.js can require this file and drive the app
// without migrating or listening.
//
// Order:
//   1. db.migrate()          — the schema must exist before anything queries it
//   2. seedAdminIfEmpty()    — so a fresh deploy has somebody who can log in
//
// db.migrate() runs before app.listen below, not after: an instance that
// answers requests against a schema it has not applied is the failure this
// ordering exists to prevent. The runner holds an advisory lock, so two
// instances coming up together during a deploy cannot race each other.
async function boot() {
  await db.migrate();

  // Demo databases only: SEED_TODAY_CHECKINS=1 gives every active resident a
  // check-in today at a random time (see seed-today.js — idempotent, so a
  // lingering flag re-runs as a no-op). Remove the env var once it has run.
  if (process.env.SEED_TODAY_CHECKINS === '1') {
    await require('./seed-today').run();
  }
  // Likewise SEED_ROOMS=1 puts every active resident in a room, inventing
  // Slaney Manor's buildings first if the centre has none (see seed-rooms.js).
  if (process.env.SEED_ROOMS === '1') {
    await require('./seed-rooms').run();
  }

  const admin = await auth.seedAdminIfEmpty();
  if (admin) {
    console.log(`\n*** First administrator created — ${admin.email}`);
    console.log('*** Log in, then remove ADMIN_PASSWORD from the environment.\n');
  }
}

/* --------------------------------------------------------------------------
   Health
   ------------------------------------------------------------------------ */

// Render polls this. It touches the database on purpose: a service that answers
// 200 while Postgres is unreachable is a service that stays in the load
// balancer while every guard sees errors.
app.get('/healthz', (req, res, next) => {
  db.query('select 1')
    .then(() => res.json({ ok: true }))
    .catch(next);
});

/* --------------------------------------------------------------------------
   API
   ------------------------------------------------------------------------ */

// 64 kB is far more than any request here sends; the point is that an
// unbounded body is a memory-exhaustion path on a service with no WAF.
app.use('/api', express.json({ limit: '64kb' }));

// Second, independent CSRF control alongside the cookie's SameSite=Lax. A
// cross-site form post carries an Origin the browser sets and script cannot
// forge; a request with no Origin at all (curl, an old browser) is allowed
// through because SameSite is already handling the browser case and blocking it
// would break scripted administration.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.get('origin');
  if (!origin) return next();
  let host;
  try { host = new URL(origin).host; } catch (_) { host = null; }
  if (host !== req.get('host')) {
    return res.status(403).json({ error: 'Cross-origin request refused' });
  }
  next();
});

// Resident data must never sit in a shared cache, or in the browser's back
// button after a guard signs out.
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use('/api', auth.attachSession);   // attach req.session (or null) from the cookie

// /api/session mounts ahead of requireSession because it is the router that
// creates a session; the GET inside it guards itself.
app.use('/api/session', require('./routes/session'));

// Password reset is unauthenticated by necessity: the whole point is that the
// caller cannot log in. Mounted here, before requireSession, and carrying its
// own no-enumeration and single-use rules.
app.use('/api/password-reset', require('./routes/password-reset'));

app.use('/api', auth.requireSession);
app.use('/api/residents', require('./routes/residents'));
app.use('/api', require('./routes/buildings'));
app.use('/api', require('./routes/rollcall'));
app.use('/api', require('./routes/reports'));
app.use('/api/staff', require('./routes/staff'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api', require('./routes/gate'));
app.use('/api', require('./routes/checkins'));
app.use('/api', require('./routes/sync'));

app.use('/api', (req, res) => res.status(404).json({ error: 'No such endpoint' }));

/* --------------------------------------------------------------------------
   Static
   ------------------------------------------------------------------------ */

// Only public/ is served, and this is enforced by serving that directory alone
// rather than by a host's publish-directory setting. docs/KNOWN-ISSUES.md — a
// map of every known weakness in this system — plus the migrations and the RLS
// policies sit outside it and are unreachable over HTTP.
//
// The two apps must never be served stale: there is no build step and no
// content hashing, so index.html and checkin.html keep the same URL forever and
// a browser that cached one would serve it after a deploy. `no-cache` does not
// mean "don't store" — the browser keeps the file and asks whether it changed,
// so an unchanged page still costs a 304 with no body.
app.use(express.static(pub, {
  setHeaders(res, filePath) {
    if (/\.(?:html|js|css|webmanifest)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

/* --------------------------------------------------------------------------
   Errors
   ------------------------------------------------------------------------ */

// eslint-disable-next-line no-unused-vars — Express identifies the error
// handler by its arity, so `next` must stay in the signature.
app.use((err, req, res, next) => {
  const translated = err && err.status ? err : translateDbError(err);

  if (translated && translated.status) {
    return res.status(translated.status).json({ error: translated.message });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large' });
  }
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'Body must be valid JSON' });
  }

  // Anything reaching here is ours, not the caller's. Log it in full, return
  // nothing: database errors carry column names, constraint text and sometimes
  // row values.
  console.error(`[${new Date().toISOString()}] [api] ${req.method} ${req.path}:`, err);
  res.status(500).json({ error: 'Something went wrong. Try again.' });
});

module.exports = app;
module.exports.boot = boot;

if (require.main === module) {
  boot()
    .then(() => {
      const server = app.listen(PORT, () => console.log(`hut check-in listening on :${PORT}`));

      // Render sends SIGTERM on deploy. Finish in-flight requests, then let go
      // of the pool, so a deploy mid-sign-in does not leave a half-written
      // event.
      for (const signal of ['SIGTERM', 'SIGINT']) {
        process.on(signal, () => {
          server.close(async () => {
            await db.closePool().catch(() => {});
            process.exit(0);
          });
        });
      }
    })
    .catch((err) => {
      // A migration failure is fatal on purpose: serving a hut's register
      // against a half-known schema is worse than being down and obviously so.
      console.error(`[migrate] ${err.message}`);
      process.exit(1);
    });
}
