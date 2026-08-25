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
   Supabase client
   ====================================================================== */

// Held here (not sb — a top-level `let`/`const` in one <script> tag shares
// the same global lexical scope as every other <script> tag in the document,
// so naming this the same as each page's own `const sb` would throw a
// SyntaxError as soon as the page's inline script parsed) so mountLogin()
// below can drive auth against the same client the page created, without
// every page having to pass it in.
let _client;

function createHutClient(config) {
  if (!window.supabase) {
    document.body.innerHTML =
      '<div class="login"><h1>Offline</h1><p>The Supabase client could not be loaded. ' +
      'Check the hut’s internet connection and reload.</p></div>';
    throw new Error("supabase-js failed to load");
  }

  _client = window.supabase.createClient(config.url, config.key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  return _client;
}

/* ========================================================================
   Login form
   ====================================================================== */

// Wires the shared #loginForm markup (see the login section duplicated at
// the top of both pages) against the client created by createHutClient().
// onReady() is called after a successful sign-in — each page passes its own
// "enter the app" function.
function mountLogin({ onReady } = {}) {
  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("loginBtn");
    btn.disabled = true;
    btn.textContent = "Logging in…";
    $("loginError").hidden = true;

    const { error } = await _client.auth.signInWithPassword({
      email: $("email").value.trim(),
      password: $("password").value,
    });

    btn.disabled = false;
    btn.textContent = "Log in";

    if (error) {
      $("loginError").textContent = error.message;
      $("loginError").hidden = false;
      return;
    }
    $("password").value = "";
    if (onReady) onReady();
  });
}
