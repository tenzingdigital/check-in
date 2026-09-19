// lib/push.js — the phones, and what is allowed to reach them.
/* ============================================================================

   Two transports, one rule.

   Web Push (the browser, and the PWA on a home screen) encrypts each message
   for the subscription's own key before it leaves this process (RFC 8291), so
   the relaying service — Google's, Mozilla's, Apple's — carries ciphertext it
   cannot read.

   APNs (the native iOS app, migration 059) does not work that way. Apple
   encrypts the transport but can read the payload. That was the argument for
   staying on the web stack, and it is why a native app was a decision to make
   deliberately rather than drift into.

   What makes it acceptable is that it costs nothing, because of the rule
   below — which was written for the lock screen and turns out to be what makes
   a second transport safe as well. There is nothing in a CheckSteady payload
   for Apple to read.

   The rule, for both:

   NO NAMES EVER LEAVE IN A PAYLOAD.

   The alert says which centre and that something needs attention. It does not
   say who, how many, or what kind. The app fetches the detail after it has a
   session, from a screen that is already behind a login and already on the
   access log. A phone left on a bus does not have a child's name on its lock
   screen, and the safeguarding alert is the message most likely to be read in
   public — at a door, on a bus, in front of the family it concerns.

   sendToUsers() is deliberately forgiving: one dead phone must never stop the
   other four being told, and a person with an iPhone app and a laptop browser
   is two devices of two kinds that both get told. Subscriptions a push service
   has dropped (404, 410, BadDeviceToken, Unregistered) are deleted; anything
   else is counted, and a device that has failed enough times stops being tried
   until it re-subscribes.
   ========================================================================= */

const webpush = require('web-push');
const apns = require('./apns');
const db = require('../database');

// What each kind of device is told. The words live here rather than in the
// service worker alone, because a native iOS app does not run the service
// worker and would otherwise grow its own copy of this sentence to drift from.
const ALERT_TEXT = {
  'guardian-gap': {
    title: 'Children may be unsupervised',
    body: 'Open CheckSteady to see which family and act.',
  },
};

// A device that has failed this many times in a row is not tried again. It is
// left in the table rather than deleted: the row is how the app knows to offer
// the "turn alerts on" button again on that device.
const MAX_FAILURES = 8;

function vapid() {
  const publicKey = String(process.env.VAPID_PUBLIC_KEY || '').trim();
  const privateKey = String(process.env.VAPID_PRIVATE_KEY || '').trim();
  // mailto: or an https URL identifying the sender, per RFC 8292. Push
  // services use it to contact an operator whose sender is misbehaving.
  const subject = String(process.env.VAPID_SUBJECT || '').trim() || 'mailto:aimee@tenzing.ie';
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject };
}

// Whether alerts can be sent at all — a visible, explained state rather than a
// silent no-op: with neither transport set up the app tells an administrator
// so instead of offering a button that does nothing.
// Either transport being available is enough to offer alerts: a centre whose
// staff are all on iPhones needs APNs and no VAPID keys at all, and the
// reverse is the common case today.
function isConfigured() {
  return vapid() !== null || apns.isConfigured();
}

// Whether the browser half specifically is available. /api/push/key needs
// this: a web page cannot subscribe without a VAPID key however well APNs is
// set up.
function webPushConfigured() {
  return vapid() !== null;
}

function publicKey() {
  const v = vapid();
  return v ? v.publicKey : null;
}

/**
 * Send one alert to every device belonging to the given logins.
 *
 * @param userIds  auth.users ids — usually the staff at one centre who have
 *                 ticked safeguarding_alert
 * @param payload  a small object. It must not contain a name, a room, a
 *                 resident id or a count; see the rule at the top of this file
 *                 and the shape assertion below, which is enforced rather
 *                 than described.
 * @returns        { sent, failed, dropped, devices }
 */
async function sendToUsers(userIds, payload) {
  const out = { sent: 0, failed: 0, dropped: 0, devices: 0 };
  if (!userIds || !userIds.length) return out;

  assertNoNames(payload);
  const v = vapid();
  if (!v && !apns.isConfigured()) {
    console.warn('[push] neither VAPID keys nor APNs are configured — nothing sent');
    return out;
  }
  if (v) webpush.setVapidDetails(v.subject, v.publicKey, v.privateKey);

  const subs = await db.withOwner(async (client) => (await client.query(
    `select id, kind, endpoint, key_p256dh, key_auth from public.push_subscriptions
      where user_id = any($1::uuid[]) and failures < $2`, [userIds, MAX_FAILURES])).rows);
  out.devices = subs.length;
  if (!subs.length) return out;

  const body = JSON.stringify(payload);
  const text = ALERT_TEXT[payload.kind] || { title: 'CheckSteady', body: 'Something needs attention.' };
  // The centre's name leads the title: a warden covering two sites needs to
  // know which one before reading anything else. Same sentence as sw.js.
  const title = payload.site ? `${payload.site}: ${text.title}` : text.title;

  // In parallel and never rejecting: one phone's failure is not the others'.
  const results = await Promise.all(subs.map(async (s) => {
    // APNs: Apple's own transport encryption, no per-message keys, and the
    // words composed here rather than by a service worker the native app does
    // not run.
    if (s.kind === 'apns') {
      const r = await apns.send(s.endpoint, { title, body: text.body, tag: payload.tag, url: payload.url });
      return r.ok
        ? { id: s.id, ok: true }
        : { id: s.id, ok: false, gone: !!r.gone, status: r.status, message: r.reason };
    }
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.key_p256dh, auth: s.key_auth } },
        body,
        // Urgency high: a guardian gap is the one message that should wake a
        // device rather than wait for it to be picked up. TTL 6 hours — after
        // that the alert is stale enough that the app itself is the better
        // way to find out, and a phone switched on tomorrow should not buzz
        // about last night.
        { TTL: 6 * 60 * 60, urgency: 'high' },
      );
      return { id: s.id, ok: true };
    } catch (err) {
      const status = err && (err.statusCode || err.status);
      return { id: s.id, ok: false, gone: status === 404 || status === 410, status, message: err && err.message };
    }
  }));

  const ok = results.filter((r) => r.ok).map((r) => r.id);
  const gone = results.filter((r) => !r.ok && r.gone).map((r) => r.id);
  const bad = results.filter((r) => !r.ok && !r.gone);
  out.sent = ok.length;
  out.dropped = gone.length;
  out.failed = bad.length;

  await db.withOwner(async (client) => {
    if (ok.length) {
      await client.query(
        `update public.push_subscriptions set last_ok_at = now(), failures = 0 where id = any($1::uuid[])`, [ok]);
    }
    // The push service says this subscription no longer exists. Keeping it
    // would mean trying a dead endpoint forever.
    if (gone.length) {
      await client.query(`delete from public.push_subscriptions where id = any($1::uuid[])`, [gone]);
    }
    if (bad.length) {
      await client.query(
        `update public.push_subscriptions set failures = failures + 1 where id = any($1::uuid[])`,
        [bad.map((r) => r.id)]);
    }
  });

  for (const r of bad) console.warn(`[push] ${r.status || 'error'}: ${r.message}`);
  return out;
}

// The no-names rule, enforced rather than trusted. A payload is a fixed, tiny
// shape; anything else is a programming error and is refused here rather than
// discovered on somebody's lock screen.
const ALLOWED_KEYS = new Set(['kind', 'site', 'url', 'tag']);
function assertNoNames(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('push payload must be an object');
  for (const k of Object.keys(payload)) {
    if (!ALLOWED_KEYS.has(k)) {
      throw new Error(`push payload key ${JSON.stringify(k)} is not allowed — a payload carries no names, counts or ids (lib/push.js)`);
    }
  }
  // site is the centre's own name, which the person receiving the alert works
  // at and which names no resident. Everything else is a fixed string.
  if (payload.site != null && typeof payload.site !== 'string') throw new Error('push payload site must be a string');
  if (JSON.stringify(payload).length > 600) throw new Error('push payload is too large — it is carrying detail it should not');
}

/**
 * Store or refresh one device.
 *
 * Two shapes, one table (migration 059). A browser sends an https endpoint and
 * two keys; a native iOS app sends its APNs device token and no keys, because
 * Apple encrypts the transport itself and there is nothing per-message to
 * encrypt with.
 */
async function subscribe(userId, { kind = 'webpush', endpoint, p256dh, auth, userAgent }) {
  if (kind !== 'webpush' && kind !== 'apns') throw new Error("kind must be 'webpush' or 'apns'");
  const token = String(endpoint || '');
  if (kind === 'webpush') {
    if (!/^https:\/\//.test(token)) throw new Error('endpoint must be an https URL');
    if (!p256dh || !auth) throw new Error('a web push subscription needs both keys');
  } else {
    // Apple's tokens are hex and have been 64 characters for years, but that
    // length is not promised, so the alphabet and a sane range are checked
    // rather than an exact size. The same constraint is on the table.
    if (!/^[0-9a-fA-F]{32,200}$/.test(token)) throw new Error('an APNs device token must be hex');
  }
  return db.withOwner(async (client) => {
    const { rows } = await client.query(
      `insert into public.push_subscriptions (user_id, kind, endpoint, key_p256dh, key_auth, user_agent)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (endpoint) do update
         set user_id = excluded.user_id, kind = excluded.kind,
             key_p256dh = excluded.key_p256dh, key_auth = excluded.key_auth,
             user_agent = excluded.user_agent, failures = 0
       returning id`,
      [userId, kind, token,
       kind === 'webpush' ? p256dh : null,
       kind === 'webpush' ? auth : null,
       String(userAgent || '').slice(0, 300) || null]);
    return rows[0].id;
  });
}

/** Forget one device. Called when a person turns alerts off on that phone. */
async function unsubscribe(userId, endpoint) {
  return db.withOwner(async (client) => {
    const { rowCount } = await client.query(
      `delete from public.push_subscriptions where user_id = $1 and endpoint = $2`, [userId, endpoint]);
    return rowCount;
  });
}

module.exports = { isConfigured, webPushConfigured, publicKey, sendToUsers, subscribe, unsubscribe, assertNoNames, ALERT_TEXT, MAX_FAILURES };
