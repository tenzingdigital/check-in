// lib/apns.js — Apple's push service, with no dependency.
/* ============================================================================

   APNs is an HTTP/2 POST carrying a JSON payload, authorised by a JWT signed
   ES256 with a key downloaded from the Apple Developer portal. Node has http2
   and crypto in the standard library, so that is the whole of it — the same
   reasoning that left this repository hand-rolling its auth rather than
   running GoTrue. A package for this would be a supply-chain surface and a
   version to chase, for about eighty lines.

   WHAT APPLE CAN READ

   Unlike Web Push (RFC 8291), an APNs payload is not encrypted for the
   device: Apple can read it. That is acceptable here for exactly one reason —
   a CheckSteady alert says which centre and that something needs attention,
   and nothing else. lib/push.js asserts that shape before anything reaches
   either transport. If that rule is ever relaxed, this file becomes the place
   a child's name leaves the building, so it is asserted there rather than
   remembered here.

   THE TOKEN IS CACHED, AND MUST BE

   Apple rejects a provider that mints a fresh JWT per request (TooManyProviderTokenUpdates)
   and also rejects one older than an hour (ExpiredProviderToken). So the token
   is made once and reused for fifty minutes, which is the window both rules
   leave.

   Configuration, all from the Apple Developer portal:

     APNS_KEY_P8       the .p8 key's contents (or a path to it)
     APNS_KEY_ID       the key's 10-character id
     APNS_TEAM_ID      the team's 10-character id
     APNS_TOPIC        the app's bundle id, e.g. ie.checksteady.app
     APNS_PRODUCTION   "1" for the live gateway; sandbox otherwise, because a
                       development build's tokens are only valid there and the
                       two are a common and very confusing mismatch.
   ========================================================================= */

const http2 = require('http2');
const crypto = require('crypto');
const fs = require('fs');

const HOST_PRODUCTION = 'https://api.push.apple.com';
const HOST_SANDBOX = 'https://api.sandbox.push.apple.com';
const TOKEN_TTL_MS = 50 * 60 * 1000;      // under Apple's one-hour limit

let cachedToken = null;                    // { jwt, madeAt }

function config() {
  const keyRaw = String(process.env.APNS_KEY_P8 || '').trim();
  const keyId = String(process.env.APNS_KEY_ID || '').trim();
  const teamId = String(process.env.APNS_TEAM_ID || '').trim();
  const topic = String(process.env.APNS_TOPIC || '').trim();
  if (!keyRaw || !keyId || !teamId || !topic) return null;

  // The .p8 may be given inline (Render's environment, newlines and all) or as
  // a path. Inline is the usual case; a path is handy in development.
  let key = keyRaw;
  if (!keyRaw.includes('BEGIN PRIVATE KEY')) {
    try { key = fs.readFileSync(keyRaw, 'utf8'); }
    catch (err) { throw new Error(`APNS_KEY_P8 is neither a key nor a readable path: ${err.message}`); }
  }
  return {
    key,
    keyId,
    teamId,
    topic,
    host: process.env.APNS_PRODUCTION === '1' ? HOST_PRODUCTION : HOST_SANDBOX,
  };
}

const isConfigured = () => config() !== null;

// A provider token: ES256 over {alg,kid}.{iss,iat}, in the JOSE compact form.
// dsaEncoding ieee-p1363 is the raw r||s pair JWT wants; node's default is DER,
// which Apple rejects with a bare 403 and no explanation. That one line is the
// entire difficulty of this file.
function providerToken(cfg) {
  if (cachedToken && Date.now() - cachedToken.madeAt < TOKEN_TTL_MS) return cachedToken.jwt;
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: cfg.keyId })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ iss: cfg.teamId, iat: Math.floor(Date.now() / 1000) })).toString('base64url');
  const signature = crypto
    .sign('sha256', Buffer.from(`${header}.${claims}`), { key: cfg.key, dsaEncoding: 'ieee-p1363' })
    .toString('base64url');
  cachedToken = { jwt: `${header}.${claims}.${signature}`, madeAt: Date.now() };
  return cachedToken.jwt;
}

// Exposed for the tests and for a deploy that rotates the key without a
// restart: the next send mints a fresh one.
function forgetToken() { cachedToken = null; }

/**
 * Send one alert to one device.
 *
 * @returns { ok } on success, or { ok: false, status, reason, gone } where
 *          `gone` marks a token Apple says is dead — the caller deletes those
 *          and only counts the rest, exactly as it does a Web Push 410.
 */
function send(deviceToken, { title, body, tag, url }) {
  const cfg = config();
  if (!cfg) return Promise.resolve({ ok: false, status: 0, reason: 'NotConfigured' });

  const payload = JSON.stringify({
    aps: {
      alert: { title, body },
      sound: 'default',
      // A safeguarding alert is time-sensitive in Apple's sense: it should
      // break through Focus and a Scheduled Summary. The app must carry the
      // Time Sensitive Notifications entitlement or Apple downgrades this to
      // 'active' rather than refusing it.
      'interruption-level': 'time-sensitive',
      'thread-id': tag || 'checksteady',
      'relevance-score': 1,
    },
    // Where to land when it is tapped. Not a name, an id or a count — see the
    // rule in lib/push.js, which has already refused anything else.
    url: url || '/',
  });

  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };

    let client;
    try { client = http2.connect(cfg.host); }
    catch (err) { return done({ ok: false, status: 0, reason: err.message }); }

    client.on('error', (err) => { done({ ok: false, status: 0, reason: err.message }); client.close(); });

    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      authorization: `bearer ${providerToken(cfg)}`,
      'apns-topic': cfg.topic,
      'apns-push-type': 'alert',
      // 10 is "send immediately"; the low-power alternative would hold a
      // safeguarding alert back to save battery, which is the wrong trade.
      'apns-priority': '10',
      // Six hours, matching the Web Push TTL: after that the app itself is the
      // better way to find out, and a phone switched on tomorrow should not
      // buzz about last night.
      'apns-expiration': String(Math.floor(Date.now() / 1000) + 6 * 60 * 60),
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    });

    let status = 0;
    let text = '';
    req.setTimeout(10000, () => { done({ ok: false, status: 0, reason: 'Timeout' }); req.close(); });
    req.on('response', (headers) => { status = Number(headers[':status']) || 0; });
    req.on('data', (chunk) => { text += chunk; });
    req.on('error', (err) => done({ ok: false, status, reason: err.message }));
    req.on('end', () => {
      client.close();
      if (status === 200) return done({ ok: true, status });
      let reason = text;
      try { reason = JSON.parse(text).reason || text; } catch (_) { /* Apple sent no JSON */ }
      // BadDeviceToken / Unregistered mean this token will never work again;
      // 410 means the app was uninstalled. Everything else may be transient.
      const gone = status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered';
      // A rejected provider token is worth minting again next time rather than
      // failing every device behind one stale JWT.
      if (reason === 'ExpiredProviderToken' || reason === 'InvalidProviderToken') forgetToken();
      done({ ok: false, status, reason, gone });
    });

    req.end(payload);
  });
}

module.exports = { isConfigured, send, forgetToken, config };
