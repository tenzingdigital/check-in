// lib/auth.js — passwords, sessions and cookies.
/* ============================================================================

   This is the part of the move that genuinely replaces something rather than
   re-hosting it: Supabase's GoTrue used to own login, and now this file does.
   It is written to be small enough to read in one sitting, because
   hand-rolled auth is the largest new risk this migration introduces and the
   only real mitigation is that there is very little of it.

   What it deliberately does NOT do: sign-up, email confirmation, password
   reset links, OAuth, magic links, MFA. Accounts are made by an administrator
   with `node server/staff.js add`. Every one of those flows is a mouth to
   feed and none of them is needed by a security hut where the administrator
   and the staff are in the same building.
   ========================================================================= */

const crypto = require('crypto');
const { withOwner } = require('../database');
const mail = require('./mail');
const geo = require('./geo');

const COOKIE_SECURE = process.env.HUT_ALLOW_INSECURE_COOKIE !== "1";

// The __Host- prefix is a browser-enforced guarantee: a cookie carrying it is
// rejected unless it is Secure, Path=/, and has no Domain attribute. That
// makes it impossible for a subdomain — including a hijacked one — to write a
// session cookie our origin will read. It costs nothing and closes a whole
// class of cookie-fixation bugs.
//
// HUT_ALLOW_INSECURE_COOKIE=1 drops the prefix for local development over
// plain http, where a Secure cookie is never stored. Never set it on Render:
// Render terminates TLS, so production is always https.
const COOKIE_NAME = COOKIE_SECURE ? "__Host-hut_session" : "hut_session";
// A trusted device (MFA skipped for thirty days). Same rules as the session
// cookie; a separate cookie so logging out does not forget the device.
const DEVICE_COOKIE_NAME = COOKIE_SECURE ? "__Host-hut_device" : "hut_device";
const DEVICE_TTL_DAYS = 30;
const MFA_CODE_MINUTES = 10;
const MFA_MAX_ATTEMPTS = 5;

const SESSION_TTL_HOURS = Number(process.env.HUT_SESSION_HOURS || 12);

// A shift, not a fortnight. A terminal in a hut is a shared physical device;
// a session that outlives the shift is a session the next person inherits.

/* ------------------------------------------------------------------------
   Tokens
   ---------------------------------------------------------------------- */

// 32 bytes from the CSPRNG. base64url so it is cookie-safe without escaping.
function newToken() {
  return crypto.randomBytes(32).toString("base64url");
}

// The database stores only this. A leaked backup therefore contains no
// credential that can be replayed — the same reason the password column holds
// a bcrypt hash rather than a password.
function tokenHash(token) {
  return crypto.createHash("sha256").update(token).digest();
}

/* ------------------------------------------------------------------------
   Login throttling
   ---------------------------------------------------------------------- */

// In-memory, per email+IP. Deliberately not in Postgres: a lockout table is a
// write on every failed guess, which is exactly the amplification an attacker
// wants. This resets when the service restarts, which is acceptable — it
// raises the cost of online guessing, and bcrypt at cost 12 is what actually
// makes guessing expensive.
const attempts = new Map();
const MAX_ATTEMPTS = 8;
const LOCKOUT_MS = 5 * 60_000;

function throttleKey(email, ip) {
  return `${String(email || "").toLowerCase()}|${ip}`;
}

function lockedOut(email, ip) {
  const rec = attempts.get(throttleKey(email, ip));
  if (!rec) return false;
  if (Date.now() > rec.until) {
    attempts.delete(throttleKey(email, ip));
    return false;
  }
  return rec.count >= MAX_ATTEMPTS;
}

function noteFailure(email, ip) {
  const key = throttleKey(email, ip);
  const rec = attempts.get(key) || { count: 0, until: 0 };
  rec.count += 1;
  rec.until = Date.now() + LOCKOUT_MS;
  attempts.set(key, rec);
}

function clearFailures(email, ip) {
  attempts.delete(throttleKey(email, ip));
}

// Bound the map so a flood of distinct emails cannot grow it without limit.
setInterval(() => {
  const now = Date.now();
  for (const [key, rec] of attempts) if (now > rec.until) attempts.delete(key);
}, 60_000).unref();

/* ------------------------------------------------------------------------
   Passwords
   ---------------------------------------------------------------------- */

// A real bcrypt hash of a value nobody holds, used to burn the same ~250ms on
// an unknown email as on a known one. Without it, "no such user" returns in
// microseconds and the login endpoint becomes an account enumerator: given
// this app's population, knowing which addresses are guards is itself useful
// to an attacker.
const DUMMY_HASH = "$2a$12$C6UzMDM.H6dfI/f/IKcEe.CkA1QQzRSDaXvSJHLtqCQLBJTdT4hyy";

/**
 * Verify an email/password pair and open a session.
 *
 * Runs on the owning connection, not under `authenticated`: at this point
 * there is no identity to bind, and auth.users is not reachable from the
 * request roles anyway. This is the one place that is allowed to touch
 * credentials.
 *
 * @returns {Promise<{token: string, expiresAt: Date, userId: string} | null>}
 */
// One row per attempt, whatever happened. Written on the owner connection;
// a failure to write must not turn into a failure to log in, so it is
// caught and logged rather than thrown.
async function noteLogin(client, { email, userId, outcome, ip, userAgent, country, risk }) {
  try {
    await client.query(
      `insert into auth.login_events (email, user_id, outcome, ip, user_agent, country, risk) values ($1, $2, $3, $4, $5, $6, $7)`,
      [String(email || "").slice(0, 320), userId || null, outcome, String(ip || "").slice(0, 64), String(userAgent || "").slice(0, 300),
       country || null, (risk && risk.length) ? risk.join(",") : null],
    );
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [auth] could not record login event:`, err && err.message ? err.message : err);
  }
}

async function signIn(email, password, { ip, userAgent, deviceToken, country } = {}) {
  const clean = String(email || "").trim();
  if (!clean || !password) return null;

  return withOwner(async (client) => {
    const { rows } = await client.query(
      `select id, encrypted_password from auth.users where lower(email) = lower($1)`,
      [clean],
    );

    const hash = rows[0]?.encrypted_password ?? DUMMY_HASH;
    const { rows: check } = await client.query(
      `select $1 = extensions.crypt($2, $1) as ok`,
      [hash, String(password)],
    );

    if (!rows[0] || !check[0]?.ok) {
      noteFailure(clean, ip);
      await noteLogin(client, { email: clean, userId: rows[0]?.id, outcome: rows[0] ? "bad_password" : "unknown_email", ip, userAgent });
      return null;
    }

    // A profile that is missing or deactivated is not a login. The old client
    // checked this after signing in, which meant a suspended guard still got a
    // valid Supabase session and was merely shown a message; here they never
    // get a session at all. `active = false` is the documented way to revoke
    // access, so it has to be the thing that actually revokes it.
    const { rows: profile } = await client.query(
      `select full_name, role, active from auth.profile_for($1)`,
      [rows[0].id],
    );
    if (!profile[0] || !profile[0].active) {
      noteFailure(clean, ip);
      await noteLogin(client, { email: clean, userId: rows[0].id, outcome: "disabled", ip, userAgent });
      return null;
    }

    clearFailures(clean, ip);
    const userId = rows[0].id;

    // Where and from what (migration 022). Home is the site's list (Ireland
    // by default); a device is "seen" once any login on it succeeded; three
    // wrong passwords in the last hour count against the next right one.
    const { rows: ctx } = await client.query(
      `select auth.home_countries_for($1) as home,
              (select count(*)::int from auth.login_events e
                where lower(e.email) = lower($2) and e.outcome = 'bad_password' and e.at > now() - interval '1 hour') as failures,
              auth.mfa_required_for($1) as mfa_switch`,
      [userId, clean],
    );
    const home = String(ctx[0].home || "IE").split(",");
    const abroad = !!country && !home.includes(country);
    const known = await deviceKnown(client, userId, deviceToken);
    const risk = [];
    if (abroad) risk.push("abroad");
    if (!known) risk.push("new_device");
    if (ctx[0].failures >= 3) risk.push("recent_failures");
    const senior = profile[0].role === "supervisor" || profile[0].role === "admin";

    if (abroad && senior) {
      await noteLogin(client, { email: clean, userId, outcome: "blocked_abroad", ip, userAgent, country, risk });
      return { blocked: true, message: `This account can only be used from ${homeNames(home)}. If you are working for the centre and see this, email ${geo.SECURITY_CONTACT}.` };
    }

    // The second step: the site's switch for senior roles (021), or a score
    // of two — abroad, or a new device with recent failures — for anyone.
    const score = (abroad ? 2 : 0) + (known ? 0 : 1) + (ctx[0].failures >= 3 ? 1 : 0);
    const needCode = (ctx[0].mfa_switch && senior) || score >= 2;
    if (needCode && !(await deviceTrusted(client, userId, deviceToken))) {
      if (!mail.isConfigured() && process.env.HUT_MAIL_SINK !== "1") {
        await noteLogin(client, { email: clean, userId, outcome: "blocked_no_code", ip, userAgent, country, risk });
        return { blocked: true, message: `This login looks unusual (${risk.join(", ").replace(/_/g, " ")}) and a code cannot be emailed from this service yet. Email ${geo.SECURITY_CONTACT}.` };
      }
      const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
      const { rows: ch } = await client.query(
        `insert into auth.mfa_challenges (user_id, code_sha256, expires_at, user_agent)
         values ($1, $2, now() + make_interval(mins => $3), $4) returning id`,
        [userId, tokenHash(code), MFA_CODE_MINUTES, String(userAgent || "").slice(0, 300)],
      );
      const { rows: who } = await client.query(`select email from auth.users where id = $1`, [userId]);
      const sent = await mail.send({ to: who[0].email, ...mail.codeEmail({ fullName: profile[0].full_name, code, minutes: MFA_CODE_MINUTES }) });
      await noteLogin(client, { email: clean, userId, outcome: "mfa_sent", ip, userAgent, country, risk });
      return { mfaRequired: true, challengeId: ch[0].id, emailHint: maskEmail(who[0].email), delivered: sent.delivered, risk };
    }

    await noteLogin(client, { email: clean, userId, outcome: "ok", ip, userAgent, country, risk });
    const session = await createSession(client, userId, userAgent);
    // Remember the device (not trusted) so the next login from it is not "new".
    const seen = known ? null : await rememberDevice(client, userId, userAgent, false);
    return { ...session, deviceToken: seen };
  });
}

function homeNames(codes) {
  const names = { IE: "Ireland", GB: "the United Kingdom" };
  return codes.map((c) => names[c] || c).join(" or ");
}

async function deviceKnown(client, userId, deviceToken) {
  if (!deviceToken) return false;
  const { rows } = await client.query(
    `select 1 from auth.mfa_devices where token_sha256 = $1 and user_id = $2 and expires_at > now()`,
    [tokenHash(deviceToken), userId],
  );
  return rows.length > 0;
}

async function rememberDevice(client, userId, userAgent, trusted) {
  const token = newToken();
  await client.query(
    `insert into auth.mfa_devices (token_sha256, user_id, expires_at, user_agent, trusted)
     values ($1, $2, now() + make_interval(days => $3), $4, $5)`,
    [tokenHash(token), userId, DEVICE_TTL_DAYS, String(userAgent || "").slice(0, 300), !!trusted],
  );
  return token;
}

async function createSession(client, userId, userAgent) {
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600_000);
  await client.query(
    `insert into auth.sessions (token_sha256, user_id, expires_at, user_agent)
     values ($1, $2, $3, $4)`,
    [tokenHash(token), userId, expiresAt, String(userAgent || "").slice(0, 300)],
  );
  await client.query(`update auth.users set last_sign_in_at = now() where id = $1`, [userId]);
  return { token, expiresAt, userId };
}

async function deviceTrusted(client, userId, deviceToken) {
  if (!deviceToken) return false;
  const { rows } = await client.query(
    `select 1 from auth.mfa_devices where token_sha256 = $1 and user_id = $2 and expires_at > now() and trusted`,
    [tokenHash(deviceToken), userId],
  );
  return rows.length > 0;
}

// "g•••@hut.example": enough to recognise the address, not enough to learn it.
function maskEmail(email) {
  const [local, domain] = String(email || "").split("@");
  if (!domain) return "";
  return `${local.slice(0, 1)}•••@${domain}`;
}

// Second step: the code from the email against the challenge the first step
// created. Five wrong codes end the challenge; the person starts again from
// the password. On success a session is created and, if asked, this device
// is trusted for thirty days.
async function completeMfa({ challengeId, code, trustDevice, ip, userAgent } = {}) {
  const clean = String(code || "").replace(/\s+/g, "");
  if (!challengeId || !/^\d{6}$/.test(clean)) return null;
  return withOwner(async (client) => {
    const { rows } = await client.query(
      `select c.id, c.user_id, c.code_sha256, c.attempts, u.email
         from auth.mfa_challenges c join auth.users u on u.id = c.user_id
        where c.id = $1 and c.used_at is null and c.expires_at > now() and c.attempts < $2
        for update of c`,
      [challengeId, MFA_MAX_ATTEMPTS],
    );
    const ch = rows[0];
    if (!ch) return null;
    const ok = crypto.timingSafeEqual(Buffer.from(ch.code_sha256), tokenHash(clean));
    if (!ok) {
      await client.query(`update auth.mfa_challenges set attempts = attempts + 1 where id = $1`, [ch.id]);
      await noteLogin(client, { email: ch.email, userId: ch.user_id, outcome: "mfa_failed", ip, userAgent });
      return null;
    }
    await client.query(`update auth.mfa_challenges set used_at = now() where id = $1`, [ch.id]);
    await noteLogin(client, { email: ch.email, userId: ch.user_id, outcome: "ok", ip, userAgent });
    const session = await createSession(client, ch.user_id, userAgent);
    // Always remembered as seen; trusted only if asked.
    const deviceToken = await rememberDevice(client, ch.user_id, userAgent, !!trustDevice);
    return { ...session, deviceToken };
  });
}

function deviceCookie(token) {
  const bits = [`${DEVICE_COOKIE_NAME}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${DEVICE_TTL_DAYS * 86400}`];
  if (COOKIE_SECURE) bits.push("Secure");
  return bits.join("; ");
}

/**
 * Resolve a cookie token to a live session.
 *
 * Returns null for an unknown, expired, deleted or deactivated account's
 * token. The `profiles.active` join is what makes deactivation immediate:
 * flipping the flag ends access on the next request, without having to find
 * and delete that guard's sessions.
 */
async function sessionFromToken(token) {
  if (!token) return null;
  return withOwner(async (client) => {
    const { rows } = await client.query(
      `update auth.sessions s
          set last_seen_at = now()
        where s.token_sha256 = $1
          and s.expires_at > now()
      returning s.user_id`,
      [tokenHash(token)],
    );
    if (!rows[0]) return null;
    // The profile lives in the user's own centre (auth.profile_for, 020).
    // Inactive, or a centre whose schema is gone: no session.
    const { rows: who } = await client.query(
      `select p.full_name, p.role, p.active, u.platform_admin
         from auth.profile_for($1) p, auth.users u
        where u.id = $1`,
      [rows[0].user_id],
    );
    if (!who[0] || !who[0].active) return null;
    return { userId: rows[0].user_id, fullName: who[0].full_name, role: who[0].role, platformAdmin: !!who[0].platform_admin };
  });
}

async function signOut(token) {
  if (!token) return;
  await withOwner((client) =>
    client.query(`delete from auth.sessions where token_sha256 = $1`, [tokenHash(token)]),
  );
}

/* ------------------------------------------------------------------------
   Cookies
   ---------------------------------------------------------------------- */

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

// SameSite=Lax is the CSRF control: a cross-site POST does not carry the
// cookie, and every mutating endpoint here is a POST. routes.js additionally
// rejects a mutating request whose Origin is not this host, so the two
// controls are independent.
function sessionCookie(token, expiresAt) {
  const bits = [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${expiresAt.toUTCString()}`,
  ];
  if (COOKIE_SECURE) bits.push("Secure");
  return bits.join("; ");
}

function clearedCookie() {
  const bits = [`${COOKIE_NAME}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (COOKIE_SECURE) bits.push("Secure");
  return bits.join("; ");
}

/* ------------------------------------------------------------------------
   First account
   ---------------------------------------------------------------------- */

// Create the first administrator on an empty database, from the environment.
//
// This exists because there is otherwise NO way to get into a fresh deploy.
// `node staff.js add` needs a shell, and Render's Shell tab is a paid-plan
// feature — so on a free instance the app would deploy successfully and be
// permanently unreachable, which is not a real deployment story.
//
// Modelled on the scheduler's auth.seedAuthIfEmpty(), with two deliberate
// differences:
//
//   * There is no fallback password, in any environment. A default credential
//     in source is exactly the failure the scheduler's own comments describe —
//     "forgetting to set a flag must not be the only thing between a customer
//     and a published credential". Here the variable is required or nothing is
//     created.
//   * The password is never logged. The scheduler prints the credentials it
//     generated, which it must, because it generated them. This reads a value
//     the operator already chose, so echoing it into a deploy log that persists
//     would add exposure and tell them nothing they do not know.
//
// Guarded on there being zero staff accounts, so it fires once on an empty
// install and never again — including after someone deletes ADMIN_PASSWORD,
// which they should do once they have logged in.
async function seedAdminIfEmpty() {
  return withOwner(async (client) => {
    const { rows } = await client.query('select count(*)::int as n from public.profiles');
    if (rows[0].n > 0) return null;

    const email = String(process.env.ADMIN_EMAIL || '').trim();
    const password = process.env.ADMIN_PASSWORD || '';
    const fullName = String(process.env.ADMIN_NAME || '').trim() || 'Administrator';

    if (!email || !password) {
      console.error(
        '*** No staff accounts exist and ADMIN_EMAIL / ADMIN_PASSWORD are not set.\n'
        + '*** Nobody can log in. Set both in the environment and redeploy, or run\n'
        + '***   node staff.js add <email> "<name>" admin\n'
        + '*** against the database. See README, "Create the first account".');
      return null;
    }
    if (password.length < 12) {
      console.error('*** REFUSING to create the first administrator: ADMIN_PASSWORD is shorter than 12 characters.');
      return null;
    }

    await client.query('select auth.create_user($1, $2, $3, $4)', [email, password, fullName, 'admin']);
    return { email };
  });
}

/* ------------------------------------------------------------------------
   Middleware
   ---------------------------------------------------------------------- */

// Attaches req.session (or null) from the cookie, the way the scheduler's
// auth.attachUser attaches req.user. Runs on every /api request so a handler
// never has to reach for the cookie itself.
function attachSession(req, res, next) {
  sessionFromToken(parseCookies(req.headers.cookie)[COOKIE_NAME])
    .then((session) => { req.session = session; next(); })
    .catch(next);
}

// Everything except the login endpoint sits behind this. A 401 is also what
// the front end watches for: app-common.js returns the terminal to the login
// screen on one, so an expired or revoked session shows the login form rather
// than a wall of errors.
function requireSession(req, res, next) {
  if (!req.session) return res.status(401).json({ error: 'Not signed in' });
  next();
}

// A lockout is an attempt too. Called by the session route, which is where
// the lockout is decided.
async function noteLocked(email, { ip, userAgent } = {}) {
  await withOwner((client) => noteLogin(client, { email, outcome: "locked", ip, userAgent }));
}

module.exports = {
  completeMfa,
  deviceCookie,
  DEVICE_COOKIE_NAME,
  noteLocked,
  seedAdminIfEmpty,
  attachSession,
  requireSession,
  COOKIE_NAME,
  COOKIE_SECURE,
  lockedOut,
  noteFailure,
  signIn,
  sessionFromToken,
  signOut,
  parseCookies,
  sessionCookie,
  clearedCookie,
};
