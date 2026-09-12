// lib/request-ip.js — the one place that decides a request's client address.
//
// Express already does this correctly: server.js sets `app.set('trust proxy',
// 1)`, which tells it to trust exactly the one hop Render's own edge adds and
// nothing beyond it (see server.js for the reasoning — the DNS for both
// checksteady.com and app.checksteady.com is grey-cloud/DNS-only at the
// owner's Cloudflare, so there is no extra proxy hop to account for; Render
// fronts its own domains with its own Cloudflare layer, which is what that
// one trusted hop has always meant). req.ip already reflects that.
//
// Everything that needs "the visitor's address" — a rate limit, an audit
// record, a geo lookup — should go through here rather than re-deriving it.
// routes/signup.js used to parse X-Forwarded-For by hand and take the
// left-most entry, which trusts whatever a caller puts in that header with no
// regard to how many real proxies exist, so anyone hitting the service
// directly could put any address they liked first in the list. req.ip does
// not have that problem: with trust proxy set to a hop count, Express reads
// from the RIGHT of X-Forwarded-For and only as many entries deep as there
// are trusted hops, so a spoofed entry prepended by the caller is ignored.
function clientIp(req) {
  return (req && req.ip) || null;
}

module.exports = { clientIp };
