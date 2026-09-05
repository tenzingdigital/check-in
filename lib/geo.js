// lib/geo.js — which country a request comes from.
//
// Three sources, in order of trust:
//   1. A test header, only when HUT_GEO_OVERRIDE=1 (the suites; never set in
//      production).
//   2. Cloudflare's CF-IPCountry header, only when HUT_TRUST_CF_COUNTRY=1 —
//      set it the day the service sits behind Cloudflare on its own domain,
//      and not before, because anyone can send that header directly.
//   3. The bundled GeoLite2 country table (geoip-country, refreshed with the
//      package). Private and loopback addresses resolve to nothing.
//
// null means "unknown", and unknown is not treated as abroad: a lookup miss
// must not lock a guard out at 3 am. It is recorded as such on the login.

let geoip = null;
try { geoip = require('geoip-country'); } catch (_) { geoip = null; }

const CODE = /^[A-Z]{2}$/;

function countryFor(req) {
  if (process.env.HUT_GEO_OVERRIDE === '1') {
    const t = String(req.get('x-hut-test-country') || '').toUpperCase();
    if (CODE.test(t)) return t;
    if (t === 'NONE') return null;
  }
  if (process.env.HUT_TRUST_CF_COUNTRY === '1') {
    const cf = String(req.get('cf-ipcountry') || '').toUpperCase();
    if (CODE.test(cf)) return cf;
  }
  if (!geoip) return null;
  const hit = geoip.lookup(String(req.ip || ''));
  return hit && CODE.test(hit.country) ? hit.country : null;
}

const SECURITY_CONTACT = String(process.env.HUT_SECURITY_CONTACT || 'security@tenzing.ie');

module.exports = { countryFor, SECURITY_CONTACT };
