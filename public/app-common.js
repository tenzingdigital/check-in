"use strict";

/* ============================================================================
   app-common.js — shared layer between index.html (gate) and checkin.html
   (daily register). No build step: this is a plain script loaded with an
   ordinary <script src="/app-common.js"> tag, after the Supabase CDN tag and
   before each page's own inline script.
   ========================================================================= */

const $ = (id) => document.getElementById(id);

// Resident and guard names are entered by staff, so treat them as untrusted
// when building markup.
function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function toast(msg, kind = "ok") {
  const el = $("toast");
  el.textContent = msg;
  el.className = "show " + kind;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = ""; }, 3200);
}

// elId defaults to "appError" (the gate app's error banner) so checkin.html
// can pass its own element id and reuse the same function.
function showError(msg, elId = "appError") {
  const el = $(elId);
  el.textContent = msg;
  el.hidden = !msg;
}

// "3h 12m ago" — guards read this at a glance, absolute times go in the log.
// Hours are kept all the way to 72 rather than rolling over at 24: against a
// 24-hour rule, "30h ago" is the number that matters and "1 day ago" hides it.
function ago(iso) {
  if (!iso) return "never";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1)  return "just now";
  if (mins < 60) return mins + "m ago";
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h < 72) return m ? `${h}h ${m}m ago` : `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d} days ago`;
}

/* ========================================================================
   API client

   Everything below used to be supabase-js loaded from a CDN. The app now
   talks to its own service on the same origin, so the client is a fetch
   wrapper: there is no key to configure, no token to hold, and no third
   party in the request path.

   Authentication is a session cookie the browser attaches on its own. That
   is why nothing here reads or writes a token — the page genuinely cannot
   see it (HttpOnly), which is the point: an XSS bug can still act as the
   guard, but it cannot steal a credential and use it from elsewhere.
   ====================================================================== */

// Thrown for any non-2xx response so callers can `catch` in one place. The
// message is whatever the server chose to say — routes.js is careful to send
// only messages written for a guard to read, never raw database errors.
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      // Cookies are same-origin here, so "same-origin" (the default) would do.
      // Stated explicitly because it is the whole authentication mechanism.
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    // fetch only rejects on a transport failure: the hut's link is down, or
    // the service is restarting mid-deploy.
    throw new ApiError(0, "Cannot reach the server. Check the hut\u2019s internet connection.");
  }

  if (res.status === 204) return null;

  let payload = null;
  try { payload = await res.json(); } catch { /* fall through to status text */ }

  if (!res.ok) {
    throw new ApiError(res.status, payload?.error || `Request failed (${res.status})`);
  }
  return payload;
}

const apiGet  = (path)        => api(path);
const apiPost = (path, body)  => api(path, { method: "POST", body });
const apiDelete = (path)      => api(path, { method: "DELETE" });

// A 401 means the session expired or was revoked (a supervisor disabling the
// account ends it on the next request). Both pages hand this the function that
// returns them to the login screen, so an expired session shows the login form
// rather than a wall of errors.
let onUnauthenticated = () => {};
function setUnauthenticatedHandler(fn) { onUnauthenticated = fn; }

// Wraps a data call so that exactly one thing happens on 401, everywhere.
async function guarded(fn, onError) {
  try {
    return await fn();
  } catch (err) {
    if (err.status === 401) { onUnauthenticated(); return undefined; }
    if (onError) onError(err);
    else throw err;
    return undefined;
  }
}

/* ========================================================================
   Login form
   ====================================================================== */

// Wires the shared #loginForm markup (see the login section duplicated at
// the top of both pages) against the API. onReady() is called after a
// successful sign-in \u2014 each page passes its own "enter the app" function.
function mountLogin({ onReady } = {}) {
  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("loginBtn");
    btn.disabled = true;
    btn.textContent = "Logging in\u2026";
    $("loginError").hidden = true;

    try {
      await apiPost("/api/session", {
        email: $("email").value.trim(),
        password: $("password").value,
      });
      $("password").value = "";
      if (onReady) onReady();
    } catch (err) {
      $("loginError").textContent = err.message;
      $("loginError").hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = "Log in";
    }
  });
}

async function logout() {
  try { await apiDelete("/api/session"); } catch { /* the cookie is gone either way */ }
}
