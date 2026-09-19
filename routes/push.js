// Alerts on a phone: the three calls a device makes about itself.
//
//   GET    /api/push/key          the VAPID public key, and whether alerts work
//   POST   /api/push/subscribe    this device would like to be told
//   DELETE /api/push/subscribe    this device would not
//
// All three are behind requireSession: a subscription belongs to a login, and
// the alert it will receive is a safeguarding one.
//
// What is deliberately NOT here: any way to ask what a notification was about.
// The payload carries no names (lib/push.js), so the app opens the register
// and reads the gap from the screens that already exist, behind the same
// session and the same access log as every other view of resident data. A
// "what was that alert" endpoint would be a second, thinner door to the same
// information.

const express = require('express');
const { wrap } = require('../lib/asyncRoute');
const { HttpError } = require('../lib/api');
const push = require('../lib/push');

const router = express.Router();

// The browser needs the server's VAPID public key before it can subscribe, and
// the app needs to know whether alerts are configured at all: a deployment
// with no keys set should say so plainly rather than offer a button that
// silently does nothing.
router.get('/key', wrap(async (req, res) => {
  res.json({ configured: push.isConfigured(), key: push.publicKey() });
}));

router.post('/subscribe', wrap(async (req, res) => {
  const body = req.body || {};
  const keys = body.keys || {};
  if (!push.isConfigured()) {
    throw new HttpError(503, 'Alerts are not configured on this service. Ask your administrator.');
  }
  let id;
  try {
    id = await push.subscribe(req.session.userId, {
      endpoint: String(body.endpoint || ''),
      p256dh: String(keys.p256dh || ''),
      auth: String(keys.auth || ''),
      userAgent: req.get('user-agent'),
    });
  } catch (err) {
    throw new HttpError(400, err.message);
  }
  res.status(201).json({ id });
}));

router.delete('/subscribe', wrap(async (req, res) => {
  const endpoint = String((req.body || {}).endpoint || '');
  if (!endpoint) throw new HttpError(400, 'endpoint is required');
  const gone = await push.unsubscribe(req.session.userId, endpoint);
  res.json({ removed: gone });
}));

module.exports = router;
