// The Unsubscribe link in every recurring site email lands here (049).
//
// No login: the person is on their phone, in their mail client, and the
// whole point is that they should not have to ask anyone. The key in the
// URL is the credential — one per person, minted by email_link_key() — and
// all it can do is toggle that person's own opt-outs. Mail scanners fetch
// links, so GET only shows the choice; POST acts. The tenant is named in
// the URL and checked against public.tenants, never taken from the Host
// header (the same weakness logged against the auth routes).
//
// A wrong key, an unknown centre and a kind we do not send are all the one
// 404 with the one body: nothing here says whether a person exists. Wrong
// keys cost the caller — eight in five minutes and the address is refused.
const express = require('express');
const { wrap } = require('../lib/asyncRoute');
const db = require('../database');
const auth = require('../lib/auth');
const tenancy = require('../lib/tenancy');
const prefs = require('../lib/emailPrefs');
const { cspAllowingForms } = require('../lib/security');
const { esc, pageHtml } = require('../lib/page');

const router = express.Router();

const KEY_RE = /^[A-Za-z0-9_-]{20,64}$/;

// Resolve the URL to a person, or null. One transaction, as the owner,
// inside the named tenant's schema: the tenant-status check reads
// public.tenants fully qualified (it is reachable from any search_path),
// and the key lookup reads the tenant's own tables. Two round trips would
// otherwise mean two connections, or nesting withOwnerIn inside withOwner
// on the same one — withOwnerIn opens its own transaction, so that nests
// BEGIN inside BEGIN. One withOwnerIn call avoids both.
async function resolve(query) {
  const slug = String(query.t || '');
  const key = String(query.k || '');
  const kind = String(query.e || '');
  if (!KEY_RE.test(key) || !prefs.isKind(kind)) return null;
  let schema;
  try { schema = tenancy.schemaForSlug(slug); } catch (_) { return null; }
  return db.withOwnerIn(schema, async (c) => {
    const { rows: [t] } = await c.query(
      `select status from public.tenants where slug = $1`, [slug]);
    if (!t || t.status === 'closed') return null;
    const { rows: [p] } = await c.query(
      `select p.id, p.full_name, u.email
         from email_link_keys k
         join profiles p on p.id = k.profile_id
         join auth.users u on u.id = p.id
        where k.key = $1`, [key]);
    if (!p) return null;
    const optOuts = await prefs.optOutsFor(c, p.id);
    return { schema, slug, key, kind, profile: p, optOuts };
  });
}

// Every write attributed to the person: audit_row() reads auth.uid(), which
// reads this setting, so the admin_audit row says they did it themselves.
function asPerson(schema, profileId, fn) {
  return db.withOwnerIn(schema, async (client) => {
    await client.query('SELECT set_config($1, $2, true)', ['request.jwt.claim.sub', String(profileId)]);
    return fn(client);
  });
}

const notValid = () => pageHtml({
  title: 'This link is not valid',
  heading: 'This link is not valid',
  body: `<p>It may have been copied incompletely, or the account it belonged to is gone. Open the link in the email exactly as it arrived, or ask an administrator at your centre to change what you receive under Admin → Staff.</p>`,
});

function choicePage(ctx, notice) {
  const { kind, profile, optOuts, slug, key } = ctx;
  const stopped = new Set(optOuts.map((o) => o.kind));
  const hidden = `<input type="hidden" name="t" value="${esc(slug)}"><input type="hidden" name="k" value="${esc(key)}"><input type="hidden" name="e" value="${esc(kind)}">`;
  const thisOne = prefs.KINDS[kind].name;
  const body = [];
  if (notice) body.push(`<p class="hint"><b>${esc(notice)}</b></p>`);
  body.push(`<p>This link came from <b>${esc(thisOne)}</b>, sent to <b>${esc(profile.email)}</b>.</p>`);
  // The kinds on the safeguarding_alert tick (054) are one setting, and the
  // page must not read as if stopping one leaves the other.
  if (prefs.kindsForTick('safeguarding_alert').includes(kind)) {
    body.push(`<p>The nightly email and the 22:00 alert are one setting: stopping either stops both, and resuming either resumes both.</p>`);
  }
  if (!stopped.has(kind)) {
    body.push(`<form method="post" action="/unsubscribe">${hidden}<input type="hidden" name="kind" value="${esc(kind)}"><input type="hidden" name="action" value="stop">
      <button class="btn" type="submit">Stop this email</button></form>`);
  }
  if (stopped.size < Object.keys(prefs.KINDS).length) {
    body.push(`<form method="post" action="/unsubscribe">${hidden}<input type="hidden" name="kind" value="all"><input type="hidden" name="action" value="stop">
      <button class="btn ghost" type="submit">Stop all site emails</button></form>`);
  }
  if (stopped.size) {
    body.push(`<h3>You are not receiving</h3><ul class="facts">${optOuts.map((o) => `<li>${esc(prefs.KINDS[o.kind].name)}
      <form method="post" action="/unsubscribe">${hidden}<input type="hidden" name="kind" value="${esc(o.kind)}"><input type="hidden" name="action" value="resume">
      <button class="linkish" type="submit">Get these again</button></form></li>`).join('')}</ul>`);
    if (stopped.size > 1) {
      body.push(`<form method="post" action="/unsubscribe">${hidden}<input type="hidden" name="kind" value="all"><input type="hidden" name="action" value="resume">
        <button class="btn ghost" type="submit">Get all site emails again</button></form>`);
    }
  }
  body.push(`<p class="hint">Login codes and password resets are not affected. An administrator can also change this for you under Admin → Staff.</p>`);
  return pageHtml({ title: 'Site emails', heading: 'Site emails', body: body.join('\n'), backHref: '/', backLabel: 'Open CheckSteady' });
}

function send(res, status, html) {
  res.setHeader('Content-Security-Policy', cspAllowingForms());
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.status(status).type('html').send(html);
}

async function guardedResolve(req) {
  if (auth.lockedOut('unsubscribe', req.ip)) return { locked: true };
  const ctx = await resolve(req.query);
  if (!ctx) auth.noteFailure('unsubscribe', req.ip);
  return { ctx };
}

router.get('/unsubscribe', wrap(async (req, res) => {
  const { locked, ctx } = await guardedResolve(req);
  if (locked) return send(res, 429, notValid());
  if (!ctx) return send(res, 404, notValid());
  send(res, 200, choicePage(ctx));
}));

router.post('/unsubscribe', wrap(async (req, res) => {
  // RFC 8058 one-click: the mail client posts this literal body to the URL
  // from the header, with no form fields of its own.
  const oneClick = req.body && req.body['List-Unsubscribe'] === 'One-Click';
  // The form carries the identity in its body; the one-click POST in the URL.
  const query = oneClick ? req.query : { t: req.body?.t, k: req.body?.k, e: req.body?.e };
  const { locked, ctx } = await guardedResolve({ ip: req.ip, query });
  if (locked) return send(res, 429, notValid());
  if (!ctx) return send(res, 404, notValid());

  const which = oneClick ? ctx.kind : String(req.body?.kind || '');
  const action = oneClick ? 'stop' : String(req.body?.action || '');
  const kinds = which === 'all' ? Object.keys(prefs.KINDS) : prefs.isKind(which) ? [which] : null;
  if (!kinds || !['stop', 'resume'].includes(action)) return send(res, 404, notValid());

  try {
    await asPerson(ctx.schema, ctx.profile.id, (client) =>
      action === 'stop' ? prefs.optOut(client, ctx.profile.id, kinds) : prefs.optIn(client, ctx.profile.id, kinds));
  } catch (err) {
    // optIn on a kind whose tick is guarded (037/041) fails this way when the
    // person was demoted to guard since the email went out — they can no
    // longer receive it, ticked or not, so resuming it is refused.
    if (err && err.code === '23514') {
      const fresh = await resolve(query);
      return send(res, 200, choicePage(fresh, 'That email is only sent to supervisors and administrators; ask an administrator at your centre.'));
    }
    throw err;
  }
  if (oneClick) return res.status(200).end();

  const fresh = await resolve(query);
  const names = which === 'all' ? 'The site emails' : prefs.KINDS[which].name.replace(/^the /, 'The ');
  const notice = action === 'stop'
    ? `${names} will not be sent to you any more.`
    : `${names} will be sent to you again.`;
  send(res, 200, choicePage(fresh, notice));
}));

module.exports = router;
