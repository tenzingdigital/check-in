"use strict";

/* ============================================================================
   index.js — the whole web tier.

   One Render web service serves both things: the static front ends out of
   public/, and the API out of /api. That is a deliberate choice over the more
   obvious "static site + separate API service" split:

     - Same origin, so no CORS, and the session cookie is a first-party cookie
       with SameSite=Lax rather than a cross-site one needing SameSite=None.
     - One service to pay for, deploy and watch, which was half the point of
       leaving a two-vendor setup.
     - The security headers are set in code, next to the CSP hashes they
       depend on, instead of being duplicated across two host config files
       that drift.

   No framework. `node:http`, one dependency (pg), no build step — the same
   property the front end has always had, now true of the back end too.
   ========================================================================= */

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { COOKIE_NAME, clearedCookie, lockedOut, parseCookies, sessionCookie, sessionFromToken, signIn, signOut } from "./auth.js";
import { HttpError, matchRoute, translateDbError } from "./routes.js";
import { closePool, pool } from "./db.js";
import { runMigrations } from "./migrate.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(HERE, "..", "public");
const PORT = Number(process.env.PORT || 3000);

// Only public/ is served, and this is now enforced by code rather than by a
// host's publish-directory setting: resolveStatic() refuses any path that
// escapes PUBLIC_DIR. docs/KNOWN-ISSUES.md — a map of every known weakness in
// this system — plus schema.sql and the RLS policies sit outside it and are
// unreachable over HTTP by construction.
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

const MAX_BODY_BYTES = 64 * 1024;

/* ------------------------------------------------------------------------
   Content-Security-Policy
   ---------------------------------------------------------------------- */

// Both front ends carry their JavaScript in inline <script> blocks, which
// normally forces `script-src 'unsafe-inline'` — and 'unsafe-inline' is most
// of what a CSP is for. Instead, hash every inline block at boot and list the
// hashes: the browser then executes exactly those blocks and nothing else, so
// an injected <script> is refused even though inline script is in use.
//
// This is a straight improvement on the Supabase deployment, which needed both
// 'unsafe-inline' AND a CDN origin in script-src to load supabase-js. Dropping
// the CDN removed the origin; hashing removed the rest.
//
// Consequence worth knowing: edit an inline block and the hash changes, so the
// CSP must be recomputed. It is computed at startup from the files on disk, so
// a deploy does that automatically — but a file edited while the server is
// running will be blocked until restart. check.sh asserts the two agree.
function inlineScriptHashes() {
  const hashes = new Set();
  for (const file of ["index.html", "checkin.html"]) {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, file), "utf8");
    for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
      hashes.add(`'sha256-${crypto.createHash("sha256").update(m[1], "utf8").digest("base64")}'`);
    }
  }
  return [...hashes];
}

function buildCsp() {
  return [
    "default-src 'none'",
    `script-src 'self' ${inlineScriptHashes().join(" ")}`,
    // Style attributes (style="...") on a few elements need this; there is no
    // equivalent hash mechanism for attributes, and the exposure from inline
    // CSS without inline script is slight.
    "style-src 'self' 'unsafe-inline'",
    // Same-origin only: the API is this service. Nothing here talks to a third
    // party any more, which is a statement the GDPR note relies on.
    "connect-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

// Everything vercel.json and render.yaml used to declare, in one place, applied
// to every response including API responses and errors.
export function securityHeaders(csp) {
  return {
    "Content-Security-Policy": csp,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), interest-cohort=(), browsing-topics=()",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Robots-Tag": "noindex, nofollow",
  };
}

/* ------------------------------------------------------------------------
   Helpers
   ---------------------------------------------------------------------- */

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...res.baseHeaders, ...headers });
  // A HEAD response carries the headers and nothing else. Node does not
  // enforce this, and a strict client reading Content-Length bytes that it was
  // never supposed to receive is a hang, not an error.
  res.end(res.isHead ? undefined : body);
}

function sendJson(res, status, value, headers = {}) {
  const body = JSON.stringify(value ?? null);
  send(res, status, body, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    // Resident data must never sit in a shared cache, or in the browser's back
    // button after a guard signs out.
    "Cache-Control": "no-store",
    ...headers,
  });
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HttpError(400, "Body must be a JSON object");
    }
    return parsed;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "Body must be valid JSON");
  }
}

// Second, independent CSRF control alongside SameSite=Lax. A cross-site form
// post carries an Origin the browser sets and script cannot forge; a request
// with no Origin at all (curl, an old browser) is allowed through because
// SameSite is already handling the browser case and blocking it would break
// scripted administration.
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

/* ------------------------------------------------------------------------
   Static files
   ---------------------------------------------------------------------- */

function resolveStatic(pathname) {
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const full = path.resolve(PUBLIC_DIR, rel);
  // Path traversal guard: the resolved path must still be inside public/.
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) return null;
  return full;
}

async function serveStatic(req, res, pathname) {
  const full = resolveStatic(pathname);
  if (!full) return send(res, 403, "Forbidden", { "Content-Type": "text/plain" });

  let stat;
  try {
    stat = await fsp.stat(full);
  } catch {
    return send(res, 404, "Not found", { "Content-Type": "text/plain; charset=utf-8" });
  }
  if (!stat.isFile()) return send(res, 404, "Not found", { "Content-Type": "text/plain; charset=utf-8" });

  const ext = path.extname(full).toLowerCase();
  // The two apps must never be served stale: a guard reloading after a deploy
  // needs the new code, not a cached page. The shared CSS and JS are
  // revalidated for the same reason — they change with the HTML that hashes
  // them into the CSP.
  const headers = {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Content-Length": stat.size,
    "Cache-Control": "public, max-age=0, must-revalidate",
    "Last-Modified": stat.mtime.toUTCString(),
  };

  if (req.headers["if-modified-since"]) {
    const since = Date.parse(req.headers["if-modified-since"]);
    if (Number.isFinite(since) && Math.floor(stat.mtimeMs / 1000) * 1000 <= since) {
      res.writeHead(304, { ...res.baseHeaders, "Cache-Control": headers["Cache-Control"] });
      return res.end();
    }
  }

  if (res.isHead) {
    res.writeHead(200, { ...res.baseHeaders, ...headers });
    return res.end();
  }

  res.writeHead(200, { ...res.baseHeaders, ...headers });
  fs.createReadStream(full).pipe(res);
}

/* ------------------------------------------------------------------------
   Request handling
   ---------------------------------------------------------------------- */

async function handleAuthRoutes(req, res, pathname, session, cookies) {
  if (pathname !== "/api/session") return false;

  if (req.method === "POST") {
    const body = await readJsonBody(req);
    const ip = clientIp(req);
    if (lockedOut(body.email, ip)) {
      return sendJson(res, 429, { error: "Too many attempts. Wait five minutes and try again." }), true;
    }
    const result = await signIn(body.email, body.password, { ip, userAgent: req.headers["user-agent"] });
    if (!result) {
      // One message for every failure mode — wrong password, unknown email,
      // deactivated profile. Distinguishing them tells an attacker which
      // addresses are real, and tells a suspended guard exactly what happened
      // when the intended channel for that is their supervisor.
      return sendJson(res, 401, { error: "Email or password not recognised." }), true;
    }
    sendJson(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(result.token, result.expiresAt) });
    return true;
  }

  if (req.method === "DELETE") {
    await signOut(cookies[COOKIE_NAME]);
    sendJson(res, 200, { ok: true }, { "Set-Cookie": clearedCookie() });
    return true;
  }

  return false;
}

async function handleApi(req, res, url, cookies) {
  const pathname = url.pathname;

  if (req.method !== "GET" && req.method !== "HEAD" && !originAllowed(req)) {
    return sendJson(res, 403, { error: "Cross-origin request refused" });
  }

  const session = await sessionFromToken(cookies[COOKIE_NAME]);

  if (await handleAuthRoutes(req, res, pathname, session, cookies)) return;

  if (!session) {
    return sendJson(res, 401, { error: "Not signed in" });
  }

  const matched = matchRoute(req.method === "HEAD" ? "GET" : req.method, pathname);
  if (!matched) return sendJson(res, 404, { error: "No such endpoint" });

  const body = req.method === "POST" ? await readJsonBody(req) : {};
  const value = await matched.route.handler({
    session,
    query: url.searchParams,
    params: matched.params,
    body,
  });
  sendJson(res, 200, value);
}

export function createApp() {
  const csp = buildCsp();
  const baseHeaders = securityHeaders(csp);

  return http.createServer(async (req, res) => {
    res.baseHeaders = baseHeaders;
    res.isHead = req.method === "HEAD";
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    try {
      if (url.pathname === "/healthz") {
        // Render polls this. It touches the database on purpose: a service
        // that answers 200 while Postgres is unreachable is a service that
        // stays in the load balancer while every guard sees errors.
        await pool.query("select 1");
        return sendJson(res, 200, { ok: true });
      }

      if (url.pathname.startsWith("/api/")) {
        return await handleApi(req, res, url, parseCookies(req.headers.cookie));
      }

      if (req.method !== "GET" && req.method !== "HEAD") {
        return send(res, 405, "Method not allowed", { "Content-Type": "text/plain; charset=utf-8" });
      }

      return await serveStatic(req, res, url.pathname);
    } catch (err) {
      const translated = err instanceof HttpError ? err : translateDbError(err);
      if (translated instanceof HttpError) {
        return sendJson(res, translated.status, { error: translated.message });
      }
      // Anything reaching here is ours, not the caller's. Log it in full,
      // return nothing: database errors carry column names, constraint text
      // and sometimes row values.
      console.error(`[api] ${req.method} ${url.pathname}:`, err);
      if (!res.headersSent) sendJson(res, 500, { error: "Something went wrong. Try again." });
    }
  });
}

// Only start listening when run directly, so the test suite can import
// createApp() and drive it on an ephemeral port.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. See README, 'Setup'.");
    process.exit(1);
  }
  // Migrate before listening, not after. An instance that answers requests
  // against a schema it has not applied is the failure this ordering exists to
  // prevent — and because the runner holds an advisory lock, two instances
  // coming up together during a deploy cannot race each other.
  //
  // A failure here is fatal on purpose: serving a hut's register against a
  // half-known schema is worse than being down and obviously down.
  try {
    await runMigrations();
  } catch (err) {
    console.error(`[migrate] ${err.message}`);
    process.exit(1);
  }

  const server = createApp();
  server.listen(PORT, () => console.log(`hut check-in listening on :${PORT}`));

  // Render sends SIGTERM on deploy. Finish in-flight requests, then let go of
  // the pool, so a deploy mid-sign-in does not leave a half-written event.
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      server.close(async () => {
        await closePool().catch(() => {});
        process.exit(0);
      });
    });
  }
}
