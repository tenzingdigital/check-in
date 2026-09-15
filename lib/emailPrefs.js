// lib/emailPrefs.js — who has opted out of which site email, and the link
// that lets them.
//
// The single owner of the rules in migration 049. Three callers: the nightly
// jobs and the send-now route build a link per recipient; the unsubscribe
// page looks a key up and toggles rows; the staff routes read the rows and
// clear them when an admin re-ticks. None of them writes SQL against these
// tables directly — if the shape changes, it changes here.
//
// Links come from PUBLIC_URL only, the same rule as every other link this
// app puts in an email (see lib/mail.js publicUrl()). Unset means no link,
// and the callers then send the email without one.
const { publicUrl } = require('./mail');
const tenancy = require('./tenancy');

// The three emails a person can stop, keyed as the migration's `kind`.
// `tick` names the profiles column the two chosen-per-person emails read,
// so opting out and back in keeps the tick and the row agreeing; the House
// Rules reminder has no tick — it goes to every supervisor and admin — so
// only the row decides.
const KINDS = Object.freeze({
  weekly_report:      { name: 'the Sunday report',                 tick: 'weekly_report' },
  safeguarding_alert: { name: 'the nightly safeguarding alert',    tick: 'safeguarding_alert' },
  house_rules:        { name: 'the nightly House Rules reminder',  tick: null },
});

function isKind(kind) {
  return Object.prototype.hasOwnProperty.call(KINDS, kind);
}

function urlFor({ slug, key, kind }) {
  if (!isKind(kind)) throw new Error(`unknown email kind: ${kind}`);
  const base = publicUrl();
  if (!base) return null;
  return `${base}/unsubscribe?${new URLSearchParams({ t: slug, k: key, e: kind })}`;
}

// RFC 8058: the mail client shows its own Unsubscribe button and POSTs the
// literal body "List-Unsubscribe=One-Click" to the URL. routes/unsubscribe.js
// treats that body as "stop the kind in the URL".
function headersFor(url) {
  if (!url) return {};
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

// The nightly job knows the schema it is running in, not the slug; the link
// must carry the slug because that is what public.tenants validates. The
// mapping is one-way in lib/tenancy.js (hyphen → underscore) but slugs may
// not contain underscores, so reversing it through the table is exact.
async function slugForSchema(client, schema) {
  if (schema === 'public') return tenancy.LEGACY_SLUG;
  const { rows } = await client.query(
    `select slug from public.tenants where 't_' || replace(slug, '-', '_') = $1`, [schema]);
  if (!rows[0]) throw new Error(`no tenant owns schema ${schema}`);
  return rows[0].slug;
}

// Mint-or-return, via the SECURITY DEFINER function so the caller may be
// the owner (jobs) or an admin (send-now) and nobody else.
async function keyFor(client, profileId) {
  const { rows } = await client.query('select email_link_key($1) as key', [profileId]);
  return rows[0].key;
}

async function linkFor(client, { slug, profileId, kind }) {
  if (!publicUrl()) return null;
  const key = await keyFor(client, profileId);
  return urlFor({ slug, key, kind });
}

function checkKinds(kinds) {
  if (!Array.isArray(kinds) || !kinds.length || !kinds.every(isKind)) {
    throw new Error(`bad email kinds: ${JSON.stringify(kinds)}`);
  }
}

// Insert the rows and clear the matching ticks, in one statement each so a
// half-applied "stop all" cannot happen. Re-opting-out is a no-op.
async function optOut(client, profileId, kinds) {
  checkKinds(kinds);
  await client.query(
    `insert into email_opt_outs (profile_id, kind)
       select $1, unnest($2::text[])
       on conflict (profile_id, kind) do nothing`, [profileId, kinds]);
  // Safe to interpolate: `ticks` is drawn only from KINDS[k].tick, the frozen
  // table above, never from caller input.
  const ticks = kinds.map((k) => KINDS[k].tick).filter(Boolean);
  if (ticks.length) {
    await client.query(
      `update profiles set ${ticks.map((t) => `${t} = false`).join(', ')} where id = $1`, [profileId]);
  }
}

// Delete the rows and set the ticks back. Setting a tick true on a guard is
// refused by the check constraints (037/041) — the callers only ever reach
// here for a supervisor or admin, because a guard never received the email.
async function optIn(client, profileId, kinds) {
  checkKinds(kinds);
  await client.query(
    `delete from email_opt_outs where profile_id = $1 and kind = any($2::text[])`, [profileId, kinds]);
  // Safe to interpolate: `ticks` is drawn only from KINDS[k].tick, the frozen
  // table above, never from caller input.
  const ticks = kinds.map((k) => KINDS[k].tick).filter(Boolean);
  if (ticks.length) {
    await client.query(
      `update profiles set ${ticks.map((t) => `${t} = true`).join(', ')} where id = $1`, [profileId]);
  }
}

async function optOutsFor(client, profileId) {
  const { rows } = await client.query(
    `select kind, unsubscribed_at from email_opt_outs where profile_id = $1 order by unsubscribed_at`, [profileId]);
  return rows;
}

module.exports = { KINDS, isKind, urlFor, headersFor, slugForSchema, keyFor, linkFor, optOut, optIn, optOutsFor };
