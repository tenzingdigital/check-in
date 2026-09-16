// lib/emailPrefs.js — who has opted out of which site email, and the link
// that lets them.
//
// The single owner of the rules in migration 049. Three callers: the nightly
// jobs and the send-now route build a link per recipient; the unsubscribe
// page looks a key up and toggles rows; the staff routes read the rows and
// clear them when an admin re-ticks. The staff routes are the one exception
// to "goes through here" — they read the rows directly for the Staff list
// and delete them directly when an admin reinstates someone; everything
// else against these tables goes through this file, so if the shape
// changes, it changes here.
//
// Links come from PUBLIC_URL only, the same rule as every other link this
// app puts in an email (see lib/mail.js publicUrl()). Unset means no link,
// and the callers then send the email without one.
const { publicUrl } = require('./mail');
const tenancy = require('./tenancy');

// The emails a person can stop, keyed as the migration's `kind`. `tick`
// names the profiles column the email's recipient query reads, so opting
// out and back in keeps the tick and the row agreeing.
//
// Three are sent today: the Sunday report, the 22:00 guardian alert and the
// nightly email (054). The last two share the safeguarding_alert tick — one
// tick, one audience, per the 054 design — so stopping either clears it and
// stops both, which is what "stop this email" honestly means for a tick
// that decides both.
//
// The two kinds below them are no longer sent: 054 folded the overnight
// safeguarding alert (041) and the House Rules reminder (032) into the
// nightly email. Their rows stay valid so a link in an email sent before
// 054 still lands on a page that works; the name says where the email
// went, and both sit on the safeguarding_alert tick — the House Rules
// reminder had none, it went to every supervisor and admin — so stopping
// either old kind clears the tick the nightly email now reads, and the old
// link still does what the person meant by it. Setting the tick back on
// for a House Rules opt-in is safe by the same reasoning as the others:
// only a supervisor or admin ever received it.
const KINDS = Object.freeze({
  weekly_report:      Object.freeze({ name: 'the Sunday report',                                            tick: 'weekly_report' }),
  guardian_alert:     Object.freeze({ name: 'the 22:00 guardian alert',                                     tick: 'safeguarding_alert' }),
  nightly:            Object.freeze({ name: 'the nightly email',                                            tick: 'safeguarding_alert' }),
  safeguarding_alert: Object.freeze({ name: 'the nightly safeguarding alert (now the nightly email)',       tick: 'safeguarding_alert' }),
  house_rules:        Object.freeze({ name: 'the nightly House Rules reminder (now the nightly email)',     tick: 'safeguarding_alert' }),
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

// The send-now route runs as the admin, who cannot read public.tenants;
// the slug is looked up as the owner first, from the user's own row.
async function slugForUser(client, userId) {
  const { rows } = await client.query(
    `select t.slug from auth.users u join public.tenants t on t.id = u.tenant_id where u.id = $1`, [userId]);
  if (!rows[0]) throw new Error('user belongs to no tenant');
  return rows[0].slug;
}

// Validates and dedupes. Deduping matters beyond tidiness: a repeated kind
// would otherwise reach the `update ... set` below twice, and Postgres
// rejects "multiple assignments to same column" outright.
function checkKinds(kinds) {
  if (!Array.isArray(kinds) || !kinds.length || !kinds.every(isKind)) {
    throw new Error(`bad email kinds: ${JSON.stringify(kinds)}`);
  }
  return [...new Set(kinds)];
}

// The profiles columns the given kinds read, once each: three kinds share
// safeguarding_alert (054), and "stop all" names all three, so the same
// "multiple assignments" rule applies to the ticks as to the kinds.
function ticksFor(kinds) {
  return [...new Set(kinds.map((k) => KINDS[k].tick).filter(Boolean))];
}

// The kinds that read a given tick — what an admin's re-tick must clear
// (routes/staff.js), since a row for any of them shows on the staff card.
function kindsForTick(tick) {
  return Object.keys(KINDS).filter((k) => KINDS[k].tick === tick);
}

// Insert the rows and clear the matching ticks. These are two separate
// statements, not one transaction — a failure between them leaves the row
// and the tick disagreeing. `client` MUST come from db.withIdentity or
// db.withOwnerIn (both run inside BEGIN/COMMIT), never from the bare
// db.withOwner used elsewhere in this codebase for non-transactional work.
// Re-opting-out is a no-op.
async function optOut(client, profileId, kinds) {
  kinds = checkKinds(kinds);
  await client.query(
    `insert into email_opt_outs (profile_id, kind)
       select $1, unnest($2::text[])
       on conflict (profile_id, kind) do nothing`, [profileId, kinds]);
  // Interpolated below, but only ever from KINDS[k].tick — the frozen table above, never caller input.
  const ticks = ticksFor(kinds);
  if (ticks.length) {
    await client.query(
      `update profiles set ${ticks.map((t) => `${t} = false`).join(', ')} where id = $1`, [profileId]);
  }
}

// Delete the rows and set the ticks back. Same caveat as optOut: two
// statements, so `client` MUST be a transactional one (db.withIdentity or
// db.withOwnerIn) or a failure between them leaves the row and the tick
// disagreeing. Setting a tick true on a guard is refused by the check
// constraints (037/041) — the callers only ever reach here for a supervisor
// or admin, because a guard never received the email.
async function optIn(client, profileId, kinds) {
  kinds = checkKinds(kinds);
  await client.query(
    `delete from email_opt_outs where profile_id = $1 and kind = any($2::text[])`, [profileId, kinds]);
  // Interpolated below, but only ever from KINDS[k].tick — the frozen table above, never caller input.
  const ticks = ticksFor(kinds);
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

module.exports = { KINDS, isKind, kindsForTick, urlFor, headersFor, slugForSchema, slugForUser, keyFor, linkFor, optOut, optIn, optOutsFor };
