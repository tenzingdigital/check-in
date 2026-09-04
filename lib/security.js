// lib/security.js — the response headers, and the Content-Security-Policy the
// two front ends need.
//
// These live in code rather than in render.yaml because the CSP is computed
// from the HTML itself. Splitting the header set across a host config and the
// app was how this repo's old vercel.json / render.yaml pair drifted; there is
// one copy now, and test/api.test.js asserts the running server sends it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Both front ends carry their JavaScript in inline <script> blocks, which
// normally forces `script-src 'unsafe-inline'` — and 'unsafe-inline' is most of
// what a CSP is for. Instead, hash every inline block at boot and list the
// hashes: the browser then executes exactly those blocks and nothing else, so
// an injected <script> is refused even though inline script is in use.
//
// This is a straight improvement on the old Supabase deployment, which needed
// both 'unsafe-inline' AND a CDN origin in script-src to load supabase-js.
// Dropping the CDN removed the origin; hashing removed the rest.
//
// Consequence worth knowing: edit an inline block and the hash changes. It is
// computed at startup from the files on disk, so a deploy does that
// automatically — but a file edited while the server is running is blocked
// until restart. check.sh asserts the two agree.
function inlineScriptHashes() {
  const hashes = new Set();
  for (const file of ['index.html', 'checkin.html', 'admin.html']) {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
    for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
      hashes.add(`'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
    }
  }
  return [...hashes];
}

function buildCsp() {
  return [
    "default-src 'none'",
    `script-src 'self' ${inlineScriptHashes().join(' ')}`,
    // No style="" attributes anywhere (they are classes in app-common.css),
    // so inline styles can be refused outright. Scripts may still set
    // element.style through the CSSOM — that is not "inline" to a CSP.
    "style-src 'self'",
    // Same-origin only: the API is this service. Nothing here talks to a third
    // party any more, which is a statement docs/GDPR.md relies on.
    "connect-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

// Applied to every response, including API responses and errors.
function securityHeaders() {
  const csp = buildCsp();
  return function securityHeadersMiddleware(req, res, next) {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), interest-cohort=(), browsing-topics=()');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    next();
  };
}

module.exports = { securityHeaders, buildCsp };
