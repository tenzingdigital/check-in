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

// Successes fade; errors stay until tapped. A guard who looked up at the
// person and back down again must still be able to read why the tap did
// not record. Tapping the toast dismisses it either way.
function toast(msg, kind = "ok") {
  const el = $("toast");
  el.textContent = msg;
  el.className = "show " + kind;
  clearTimeout(toast._t);
  if (kind === "err") {
    el.setAttribute("role", "alert");
    return;
  }
  el.setAttribute("role", "status");
  toast._t = setTimeout(() => { el.className = ""; }, 3200);
}
document.addEventListener("click", (e) => {
  const el = e.target.closest("#toast");
  if (el) { el.className = ""; clearTimeout(toast._t); }
});

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
const apiPatch  = (path, body)  => api(path, { method: "PATCH", body });

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
// The forgot-password UI is built here rather than written into both HTML
// files, so the two front ends cannot drift apart and there is one copy of the
// wording. It is appended after the login form and starts hidden.
//
// Three states share this screen: the login form, "email me a link", and
// "choose a new password" (entered by opening the emailed ?reset=… link).
function mountResetUI() {
  const form = $("loginForm");
  if (!form || $("resetPanel")) return;

  const holder = document.createElement("div");
  holder.innerHTML = `
    <p class="hint centre">
      <a href="#" id="forgotLink">Forgot your password?</a>
    </p>

    <form id="resetPanel" class="mt14" hidden>
      <p class="hint lead">
        Enter the email address for your account and we will send a link to
        choose a new password.
      </p>
      <input id="resetEmail" class="field" type="email" placeholder="Email"
             autocomplete="username" required>
      <button id="resetBtn" class="btn" type="submit">Email me a link</button>
      <p class="hint centre">
        <a href="#" id="backToLogin">Back to log in</a>
      </p>
    </form>

    <form id="newPassPanel" class="mt14" hidden>
      <p class="hint lead">
        Choose a new password of at least 12 characters. This signs the account
        out everywhere else.
      </p>
      <input id="newPass" class="field" type="password" placeholder="New password"
             autocomplete="new-password" minlength="12" required>
      <input id="newPass2" class="field" type="password" placeholder="Repeat new password"
             autocomplete="new-password" minlength="12" required>
      <button id="newPassBtn" class="btn" type="submit">Set password</button>
    </form>`;
  form.parentNode.insertBefore(holder, form.nextSibling);

  const show = (which) => {
    form.hidden           = which !== "login";
    $("forgotLink").parentNode.hidden = which !== "login";
    $("resetPanel").hidden   = which !== "request";
    $("newPassPanel").hidden = which !== "choose";
  };

  const say = (msg, isError) => {
    const box = $("loginError");
    box.textContent = msg;
    box.hidden = !msg;
    box.style.borderColor = isError ? "" : "var(--ok)";
    box.style.color = isError ? "" : "var(--ok)";
  };

  $("forgotLink").addEventListener("click", (e) => {
    e.preventDefault();
    say("");
    $("resetEmail").value = $("email").value.trim();
    show("request");
    $("resetEmail").focus();
  });

  $("backToLogin").addEventListener("click", (e) => {
    e.preventDefault();
    say("");
    show("login");
  });

  // Always the same answer, whether or not the address has an account: the
  // server will not say, and neither will this.
  $("resetPanel").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("resetBtn");
    btn.disabled = true;
    btn.textContent = "Sending\u2026";
    try {
      await apiPost("/api/password-reset", { email: $("resetEmail").value.trim() });
      say("If that address has an account, a link is on its way. It expires in an hour.", false);
      show("login");
    } catch (err) {
      say(err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = "Email me a link";
    }
  });

  $("newPassPanel").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pw = $("newPass").value;
    if (pw !== $("newPass2").value) return say("Those two passwords do not match.", true);
    if (pw.length < 12) return say("Choose a password of at least 12 characters.", true);

    const btn = $("newPassBtn");
    btn.disabled = true;
    btn.textContent = "Setting\u2026";
    try {
      await apiPost("/api/password-reset/confirm", { token: resetTokenFromUrl(), password: pw });
      // Drop the spent token out of the address bar so a refresh, or the
      // browser history, cannot replay it.
      history.replaceState(null, "", location.pathname);
      say("Password changed. Log in with it now.", false);
      show("login");
      $("password").value = "";
      $("email").focus();
    } catch (err) {
      say(err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = "Set password";
    }
  });

  if (resetTokenFromUrl()) show("choose");
}

function resetTokenFromUrl() {
  try { return new URLSearchParams(location.search).get("reset") || ""; }
  catch (_) { return ""; }
}

// Publish the sticky header's height as a CSS variable so the search box can
// pin itself just below it on phones (see #q.pinned in app-common.css).
function trackHeaderHeight() {
  const header = document.querySelector("header");
  if (!header) return;
  const set = () => document.documentElement.style.setProperty("--header-h", header.offsetHeight + "px");
  set();
  if (window.ResizeObserver) new ResizeObserver(set).observe(header);
  else window.addEventListener("resize", set);
}

// Idle lock: a shared tablet at the door stays logged in for a whole shift,
// so after `minutes` with no touch, key or scroll we end the session and show
// the login screen. `isActive` lets a page veto the lock (e.g. while offline
// with queued events that a logout would strand); `onLock` does the logout.
function mountIdleLock({ minutes, isActive, onLock }) {
  // `minutes` may be a function: the setting arrives with the session, after
  // this is mounted, so it is read each time the lock starts.
  let ms = 20 * 60 * 1000;
  let last = Date.now();
  let timer = null;
  const touch = () => { last = Date.now(); };
  for (const ev of ["pointerdown", "keydown", "scroll", "touchstart"]) {
    document.addEventListener(ev, touch, { passive: true, capture: true });
  }
  const tick = () => {
    if (isActive && !isActive()) { last = Date.now(); return; }
    if (Date.now() - last >= ms) { stop(); onLock(); }
  };
  const start = () => {
    stop();
    const m = typeof minutes === "function" ? minutes() : minutes;
    ms = Math.max(1, Number(m) || 20) * 60 * 1000;
    last = Date.now();
    timer = setInterval(tick, 15 * 1000);
  };
  const stop  = () => { if (timer) clearInterval(timer); timer = null; };
  // A backgrounded tab's timers are throttled; re-check the moment it returns.
  document.addEventListener("visibilitychange", () => { if (!document.hidden && timer) tick(); });
  return { start, stop };
}

function mountLogin({ onReady } = {}) {
  mountResetUI();

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

// Swipe a resident card to act on it without opening the detail panel — one
// gesture per person on a tablet at the door. Shared because both apps use it:
// the register swipes right to record a check-in, the gate swipes right to
// sign in and left to sign out.
//
// Touch and pen only: a mouse drag on a button is not a gesture anyone means.
// The card slides under the finger and only commits past SWIPE_FIRE pixels,
// arming visibly first, so a hesitant swipe does nothing. A capture-phase
// click listener eats the click that follows any real horizontal movement, so
// a swipe never also opens the panel behind it.
//
//   onRight / onLeft — called with the card's data-id. Omit one to disable
//   that direction (the card then will not slide that way at all).
function mountCardSwipe({ onRight, onLeft } = {}) {
  const FIRE = 90, TAP_SLOP = 12, MAX = 140;
  let swipe = null, swallow = false;

  document.addEventListener("pointerdown", (e) => {
    swallow = false;
    if (e.pointerType === "mouse") return;
    const card = e.target.closest("button.card");
    if (!card) return;
    swipe = { card, id: card.dataset.id, x0: e.clientX, y0: e.clientY, dx: 0, horizontal: null };
  });

  document.addEventListener("pointermove", (e) => {
    if (!swipe) return;
    const dx = e.clientX - swipe.x0, dy = e.clientY - swipe.y0;
    // Decide once, on the first real movement, whether this is a horizontal
    // gesture or a vertical scroll — after that the two never fight.
    if (swipe.horizontal === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
      swipe.horizontal = Math.abs(dx) > Math.abs(dy);
    }
    if (!swipe.horizontal) return;

    // A direction with no handler does not move.
    if ((dx > 0 && !onRight) || (dx < 0 && !onLeft)) { swipe.dx = 0; return; }

    swipe.dx = dx;
    const shown = Math.max(-MAX, Math.min(MAX, dx));
    swipe.card.style.transform = `translateX(${shown}px)`;
    swipe.card.classList.toggle("swipe-arm",     dx >=  FIRE);
    swipe.card.classList.toggle("swipe-arm-out", dx <= -FIRE);
  });

  function end(fire) {
    const s = swipe;
    swipe = null;
    if (!s) return;
    s.card.style.transform = "";
    s.card.classList.remove("swipe-arm", "swipe-arm-out");
    if (Math.abs(s.dx) > TAP_SLOP) swallow = true;
    if (!fire) return;
    if (s.dx >=  FIRE && onRight) onRight(s.id);
    if (s.dx <= -FIRE && onLeft)  onLeft(s.id);
  }
  document.addEventListener("pointerup",     () => end(true));
  document.addEventListener("pointercancel", () => end(false));

  // Capture phase, so it runs before the page's own card-click handler on
  // document and can stop it reaching one.
  document.addEventListener("click", (e) => {
    if (!swallow) return;
    swallow = false;
    e.stopPropagation();
    e.preventDefault();
  }, true);
}

async function logout() {
  try { await apiDelete("/api/session"); } catch { /* the cookie is gone either way */ }
}
