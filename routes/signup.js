// Self-serve trials — the front door of the product.
//
//   POST /signup            { full_name, email, centre_name, seed }
//   GET  /signup/confirm    ?token=…
//
// Not under /api, and deliberately outside auth.requireSession: nobody has an
// account yet. It is the only unauthenticated write in the system, which is
// why most of this file is about not letting it be abused.
//
// The shape, and why:
//
//   POST writes a row to public.signup_requests and sends one email. It
//   provisions NOTHING. Provisioning runs `create schema` plus the whole of
//   tenant/template.sql — 150KB of DDL — and a public endpoint that does that
//   on an unverified POST is a way to fill the database from a script. The
//   click on the emailed link is the proof that somebody reads that inbox, and
//   only then is a centre created.
//
//   GET /signup/confirm provisions the schema, optionally seeds a sample
//   centre, creates the first administrator, and redirects into the app with a
//   password-setting token — so the whole journey is one email and one click,
//   not two.
//
// Both answer with HTML, not JSON: these are reached by a browser following a
// form post or a link in an email, and a person who lands on `{"ok":true}` has
// been failed. The pages use /app-common.css and carry no inline style or
// script, because lib/security.js hashes inline blocks per file and a route
// cannot be hashed.

const express = require('express');
const crypto = require('crypto');
const { wrap } = require('../lib/asyncRoute');
const db = require('../database');
const tenancy = require('../lib/tenancy');
const mail = require('../lib/mail');
const { seedDemoCentre } = require('../lib/demoSeed');

const router = express.Router();

const TRIAL_DAYS = 7;
const LINK_TTL_HOURS = 24;
const PASSWORD_TTL_MINUTES = 60 * 24;

// Addresses whose whole purpose is to be thrown away. Not a security control —
// anyone determined will use a real address — but it removes the casual case,
// and a trial is worth more to us when we can reply to the person who took it.
const THROWAWAY = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', '10minutemail.com',
  'yopmail.com', 'tempmail.com', 'temp-mail.org', 'trashmail.com', 'sharklasers.com',
  'getnada.com', 'dispostable.com', 'maildrop.cc', 'throwawaymail.com', 'fakeinbox.com',
  'mintemail.com', 'mytemp.email', 'spamgourmet.com', 'tempr.email', 'moakt.com',
]);

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------
// In memory and per instance, on the same reasoning as the login throttle in
// lib/auth.js: a table of counters is a table to lock, and losing the counts on
// a restart is a smaller problem than the write amplification. The durable half
// of the limit is the query against signup_requests below, which survives a
// restart and covers every instance.
const HOUR = 60 * 60 * 1000;
const PER_IP_PER_HOUR = 5;
const ipHits = new Map();

function tooManyFromIp(ip) {
  const now = Date.now();
  const rec = (ipHits.get(ip) || []).filter((t) => now - t < HOUR);
  if (rec.length >= PER_IP_PER_HOUR) { ipHits.set(ip, rec); return true; }
  rec.push(now);
  ipHits.set(ip, rec);
  if (ipHits.size > 5000) {
    for (const [k, v] of ipHits) if (!v.some((t) => now - t < HOUR)) ipHits.delete(k);
  }
  return false;
}

// ---------------------------------------------------------------------------
// A slug the customer can live with
// ---------------------------------------------------------------------------
// The slug is customer-visible and becomes the schema name, so it is derived
// from the centre's own name rather than generated. lib/tenancy.js validates
// the result again before it reaches any DDL — this only has to produce
// something plausible and unique.
function slugify(name) {
  const base = String(name || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')   // fadas and umlauts out
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 34)
    .replace(/-+$/, '');
  // The slug pattern demands it start with a letter, end with a letter or
  // digit, and be at least 3 characters. A name made entirely of punctuation
  // leaves nothing to work with, so it falls back to a plain word and
  // freeSlug() makes it unique.
  if (!base) return 'centre';
  const seeded = /^[a-z]/.test(base) ? base : `c-${base}`;
  return seeded.length >= 3 ? seeded : `${seeded}-centre`.slice(0, 38);
}

async function freeSlug(client, wanted) {
  for (let n = 0; n < 40; n++) {
    const candidate = n === 0 ? wanted : `${wanted.slice(0, 33)}-${n + 1}`;
    if (tenancy.RESERVED_SLUGS.has(candidate)) continue;
    try { tenancy.schemaForSlug(candidate); } catch (_) { continue; }
    const { rowCount } = await client.query('select 1 from public.tenants where slug = $1', [candidate]);
    if (!rowCount) return candidate;
  }
  // Nothing plausible was free: fall back to something that certainly is.
  return `centre-${crypto.randomBytes(4).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// The two pages this route serves
// ---------------------------------------------------------------------------
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function pageHtml({ title, heading, body, backHref = 'https://checksteady.ie/', backLabel = 'Back to checksteady.ie' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<meta name="robots" content="noindex">
<title>${esc(title)} — CheckSteady</title>
<link rel="stylesheet" href="/app-common.css">
</head>
<body class="app-signup">
<main class="wrap">
  <section class="login">
    <h1>CheckSteady</h1>
    <h2>${esc(heading)}</h2>
    ${body}
    <p class="hint"><a class="linkish" href="${esc(backHref)}">${esc(backLabel)}</a></p>
  </section>
</main>
</body>
</html>`;
}

const sent = (email) => pageHtml({
  title: 'Check your email',
  heading: 'Check your email',
  body: `<p>We have sent a link to <b>${esc(email)}</b>. Open it and your centre is created —
         it takes a few seconds — and you will be asked to choose a password.</p>
         <p class="hint">The link works once and lasts ${LINK_TTL_HOURS} hours. If it has not arrived in
         a few minutes, check the spam folder, or email
         <a class="linkish" href="mailto:aimee@tenzing.ie">aimee@tenzing.ie</a> and we will set it up by hand.</p>`,
});

const problem = (heading, message) => pageHtml({
  title: 'Sorry',
  heading,
  body: `<div class="alert">${esc(message)}</div>
         <p class="hint">If this keeps happening, email
         <a class="linkish" href="mailto:aimee@tenzing.ie">aimee@tenzing.ie</a> and we will sort it out.</p>`,
  backHref: 'https://checksteady.ie/trial/',
  backLabel: 'Back to the trial page',
});

// ---------------------------------------------------------------------------
// POST /signup — take the request, send the link, provision nothing
// ---------------------------------------------------------------------------
router.post('/signup', wrap(async (req, res) => {
  const body = req.body || {};
  const fullName = String(body.full_name || '').trim().slice(0, 120);
  const email = String(body.email || '').trim().toLowerCase().slice(0, 200);
  const centreName = String(body.centre_name || '').trim().slice(0, 120);
  const seed = body.seed === 'empty' ? 'empty' : 'sample';

  if (!fullName || !centreName || email.indexOf('@') < 1 || !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
    return res.status(400).send(problem('That form was not complete',
      'We need your name, a valid work email address and the name of your centre.'));
  }
  if (THROWAWAY.has(email.split('@')[1])) {
    return res.status(400).send(problem('That address will not reach you',
      'Please use your organisation\u2019s email address \u2014 the trial link is sent there, and it is the only way we can reach you about it.'));
  }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
  if (tooManyFromIp(ip)) {
    return res.status(429).send(problem('Too many requests',
      'Several trials have been started from this connection in the last hour. Try again later, or email us and we will set one up.'));
  }

  // The email this sends is a link, and PUBLIC_URL (lib/mail.js publicUrl())
  // is the only origin it may be built from — never the request's Host (see
  // mail.js for why). A trial confirmation with no link is close to useless
  // to the person waiting for it, so with no PUBLIC_URL the whole request is
  // refused here, before a pending row is written or a token minted, with a
  // page the prospective customer can read and a clear error in the log for
  // whoever operates this.
  const base = mail.publicUrl();
  if (!base) {
    console.error('[signup] refusing a trial request: PUBLIC_URL is not configured on this deployment');
    return res.status(500).send(problem('Sorry, something went wrong',
      'We could not start that trial just now. Try again shortly, or email us and we will set it up by hand.'));
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest();

  const outcome = await db.withOwner(async (client) => {
    // The durable half of the rate limit: unaffected by a restart, and shared
    // by every instance.
    const { rows: recent } = await client.query(
      `select count(*)::int as n from public.signup_requests
        where lower(email) = $1 and created_at > now() - interval '1 hour'`, [email]);
    if (recent[0].n >= 3) return { throttled: true };

    // Already a customer? Say so rather than making a second centre they
    // cannot get into, since auth.users.email is unique across the platform.
    const { rowCount: known } = await client.query(
      'select 1 from auth.users where lower(email) = $1', [email]);
    if (known) return { known: true };

    const slug = await freeSlug(client, slugify(centreName));
    await client.query(
      `insert into public.signup_requests
         (email, full_name, centre_name, slug, seed, token_sha256, requested_ip, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, now() + ($8 || ' hours')::interval)`,
      [email, fullName, centreName, slug, seed, tokenHash,
       /^[0-9a-f.:]+$/i.test(ip) ? ip : null, String(LINK_TTL_HOURS)]);
    return { ok: true };
  });

  if (outcome.throttled) {
    return res.status(429).send(problem('We have already sent that link',
      'A trial link went to this address in the last hour. Check your inbox and your spam folder before asking for another.'));
  }
  if (outcome.known) {
    return res.status(409).send(problem('That address already has an account',
      'This email address is already on CheckSteady. Sign in instead, or use the "forgotten password" link on the sign-in screen.'));
  }

  const link = `${base}/signup/confirm?token=${encodeURIComponent(token)}`;
  await mail.send({
    to: email,
    subject: 'Open your CheckSteady trial',
    text: `Hello ${fullName},

Open the link below and your CheckSteady trial centre — ${centreName} — is created.
You will be asked to choose a password, and then you are in.

${link}

The link works once and lasts ${LINK_TTL_HOURS} hours.

The trial runs for ${TRIAL_DAYS} days on one site, with no card. When it ends the
site becomes read-only rather than being deleted: you can still open it, read
it, export it and erase records. Nothing you record is lost.

If you did not ask for this, ignore this email. Nothing has been created.

— CheckSteady, from Tenzing Digital`,
  });

  res.status(202).send(sent(email));
}));

// ---------------------------------------------------------------------------
// GET /signup/confirm — the click that creates the centre
// ---------------------------------------------------------------------------
router.get('/signup/confirm', wrap(async (req, res) => {
  const token = String(req.query.token || '');
  if (!token) return res.status(400).send(problem('That link is incomplete', 'The link is missing its token. Open the one in the email exactly as it arrived.'));
  const tokenHash = crypto.createHash('sha256').update(token).digest();

  const out = await db.withOwner(async (client) => {
    const { rows } = await client.query(
      `select * from public.signup_requests
        where token_sha256 = $1 and confirmed_at is null and expires_at > now()`, [tokenHash]);
    const reqRow = rows[0];
    if (!reqRow) return { stale: true };

    // Claim it before doing any work, so a double click — or a mail client
    // that pre-fetches links — cannot provision twice.
    const { rowCount: claimed } = await client.query(
      `update public.signup_requests set confirmed_at = now()
        where id = $1 and confirmed_at is null`, [reqRow.id]);
    if (!claimed) return { stale: true };

    const slug = await freeSlug(client, reqRow.slug);
    const { rows: t } = await client.query(
      `insert into public.tenants
         (name, slug, status, trial_ends_at, terms_accepted_at, terms_version, terms_accepted_by_email)
       values ($1, $2, 'trial', now() + ($3 || ' days')::interval, now(), 'self-serve-trial', $4)
       returning id`,
      [reqRow.centre_name, slug, String(TRIAL_DAYS), reqRow.email]);
    const tenantId = t[0].id;

    try {
      const schema = await tenancy.provisionSchema(client, slug,
        { siteName: reqRow.centre_name, timezone: 'Europe/Dublin' });
      const { rows: u } = await client.query(
        `select auth.create_user_invited($1, $2, 'admin', $3) as id`,
        [reqRow.email, reqRow.full_name, tenantId]);
      const adminId = u[0].id;

      if (reqRow.seed === 'sample') {
        await client.query('begin');
        try {
          await seedDemoCentre(client, { schema, tenantId, adminId });
          await client.query('commit');
        } catch (err) { await client.query('rollback'); throw err; }
      }

      await client.query(
        'update public.signup_requests set tenant_id = $1 where id = $2', [tenantId, reqRow.id]);

      // Mint the password-setting token here rather than sending a second
      // email: the click that got them here already proved the address.
      const pwToken = crypto.randomBytes(32).toString('base64url');
      await client.query('select auth.create_password_reset($1, $2, $3) as full_name',
        [reqRow.email, crypto.createHash('sha256').update(pwToken).digest(), PASSWORD_TTL_MINUTES]);
      return { ok: true, pwToken, slug, seed: reqRow.seed };
    } catch (err) {
      // A half-built centre is worse than none: unwind everything this click
      // created, and let the person try again with a fresh link.
      await client.query(`delete from auth.users where lower(email) = $1 and tenant_id = $2`,
        [reqRow.email, tenantId]).catch(() => {});
      await tenancy.dropSchema(client, slug).catch(() => {});
      await client.query('delete from public.tenants where id = $1', [tenantId]).catch(() => {});
      await client.query(
        'update public.signup_requests set confirmed_at = null where id = $1', [reqRow.id]).catch(() => {});
      throw err;
    }
  });

  if (out.stale) {
    return res.status(410).send(problem('That link has been used, or has expired',
      `A trial link works once and lasts ${LINK_TTL_HOURS} hours. If your centre was already created, sign in instead. If not, ask for a new link.`));
  }
  // Straight into the app to choose a password. Same shape as the link
  // routes/staff.js sends, so there is one password-setting screen, not two.
  res.redirect(302, `/?reset=${encodeURIComponent(out.pwToken)}&welcome=trial`);
}));

module.exports = router;
module.exports.TRIAL_DAYS = TRIAL_DAYS;
module.exports.slugify = slugify;
