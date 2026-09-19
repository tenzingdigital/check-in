// lib/push.js — the phones, and what is allowed to reach them.
/* ============================================================================

   Web Push, not a native SDK, and the reason is in the payload.

   A Web Push message is encrypted for the subscription's own key before it
   leaves this process (RFC 8291). The push service that relays it — Google's
   for Chrome, Mozilla's for Firefox, Apple's for Safari — carries ciphertext
   it cannot read. The same alert sent through a native FCM or APNs
   integration is readable by the provider. For a product whose GDPR position
   is that resident data does not go to third parties, that difference decides
   the architecture.

   It is belt and braces anyway, because of the second rule here:

   NO NAMES EVER LEAVE IN A PAYLOAD.

   The alert says which centre and that something needs attention. It does not
   say who, how many, or what kind. The app fetches the detail after it has a
   session, from a screen that is already behind a login and already on the
   access log. A phone left on a bus does not have a child's name on its lock
   screen, and the safeguarding alert is the message most likely to be read in
   public — at a door, on a bus, in front of the family it concerns.

   sendToUsers() is deliberately forgiving: one dead phone must never stop the
   other four being told. Subscriptions the push service has dropped (404, 410)
   are deleted; anything else is counted, and a device that has failed enough
   times stops being tried until it re-subscribes.
   ========================================================================= */

const webpush = require('web-push');
const db = require('../database');

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

// Whether alerts can be sent at all. False on a deployment with no keys set,
// which must be a visible, explained state rather than a silent no-op: the
// app tells an administrator that alerts are not configured instead of
// offering a button that does nothing.
function isConfigured() {
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

  const v = vapid();
  if (!v) {
    console.warn('[push] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY are not set — nothing sent');
    return out;
  }
  assertNoNames(payload);
  webpush.setVapidDetails(v.subject, v.publicKey, v.privateKey);

  const subs = await db.withOwner(async (client) => (await client.query(
    `select id, endpoint, key_p256dh, key_auth from public.push_subscriptions
      where user_id = any($1::uuid[]) and failures < $2`, [userIds, MAX_FAILURES])).rows);
  out.devices = subs.length;
  if (!subs.length) return out;

  const body = JSON.stringify(payload);
  // In parallel and never rejecting: one phone's failure is not the others'.
  const results = await Promise.all(subs.map(async (s) => {
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

/** Store or refresh one device's subscription. */
async function subscribe(userId, { endpoint, p256dh, auth, userAgent }) {
  if (!/^https:\/\//.test(String(endpoint || ''))) throw new Error('endpoint must be an https URL');
  if (!p256dh || !auth) throw new Error('a subscription needs both keys');
  return db.withOwner(async (client) => {
    const { rows } = await client.query(
      `insert into public.push_subscriptions (user_id, endpoint, key_p256dh, key_auth, user_agent)
       values ($1, $2, $3, $4, $5)
       on conflict (endpoint) do update
         set user_id = excluded.user_id, key_p256dh = excluded.key_p256dh,
             key_auth = excluded.key_auth, user_agent = excluded.user_agent,
             failures = 0
       returning id`,
      [userId, endpoint, p256dh, auth, String(userAgent || '').slice(0, 300) || null]);
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

module.exports = { isConfigured, publicKey, sendToUsers, subscribe, unsubscribe, assertNoNames, MAX_FAILURES };
