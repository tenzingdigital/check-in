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

// Hours and minutes in the SITE's zone, which is the clock the register
// closes on. Never the terminal's zone: a terminal set to the wrong zone is
// exactly the fault a manager is trying to see when they ask "what time
// did that check-in actually land". tz is app_settings.local_timezone.
function siteTime(iso, tz) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: tz || undefined, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  } catch (_) {
    return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  }
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

// The two apps record two different acts — a door movement, and the once-a-
// day check-in — and a guard who has just logged in should choose which
// before seeing a list. Shown once per session (sessionStorage), cleared at
// logout so the next person on a shared terminal chooses again.
const VIEW_SLOT = "viewChosen";
function viewChosen() { try { return sessionStorage.getItem(VIEW_SLOT); } catch (_) { return "1"; } }
function rememberView(v) { try { sessionStorage.setItem(VIEW_SLOT, v); } catch (_) { /* private mode */ } }
function clearViewChoice() { try { sessionStorage.removeItem(VIEW_SLOT); } catch (_) { /* nothing */ } }

// A tablet that always does one job: open it with ?view=inout or
// ?view=register once and the choice is kept on that device (localStorage);
// or tick "Always open this on this tablet" on the chooser. "Forget this
// tablet's choice" on the chooser undoes it.
const DEFAULT_VIEW_SLOT = "defaultView";
const VIEW_PAGES = { gate: "/index.html", register: "/checkin.html" };
function defaultView() { try { return localStorage.getItem(DEFAULT_VIEW_SLOT) || ""; } catch (_) { return ""; } }
function setDefaultView(v) { try { if (v) localStorage.setItem(DEFAULT_VIEW_SLOT, v); else localStorage.removeItem(DEFAULT_VIEW_SLOT); } catch (_) { /* private mode */ } }

function mountViewChooser({ current, canAdmin = false, canOrg = false } = {}) {
  // ?view=… on the address bar fixes this device's job.
  try {
    const want = new URLSearchParams(location.search).get("view");
    const norm = want === "inout" || want === "gate" ? "gate" : want === "register" ? "register" : "";
    if (norm) { setDefaultView(norm); history.replaceState(null, "", location.pathname); }
    // ?view=choose forgets the device's fixed job and asks again.
    if (want === "choose") { setDefaultView(""); clearViewChoice(); history.replaceState(null, "", location.pathname); }
  } catch (_) { /* nothing */ }
  const fixed = defaultView();
  if (fixed && VIEW_PAGES[fixed]) {
    if (fixed !== current) { rememberView(fixed); location.replace(VIEW_PAGES[fixed]); return; }
    rememberView(fixed);
    document.dispatchEvent(new Event("viewchosen"));
    return;
  }
  if (viewChosen()) return;
  const el = document.createElement("div");
  el.id = "chooser"; el.className = "chooser"; el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true");
  el.innerHTML = `
    <h2>What are you recording?</h2>
    <p class="hint">Two different things are recorded here. Pick the one for this terminal; you can switch at the top of the screen later.</p>
    <a class="choice gate" href="/index.html" data-view="gate">
      <b>In &amp; out</b>
      <span>People passing in and out. Swipe right to sign IN, left to sign OUT. Keeps the movement log and who is on site now.</span>
    </a>
    <a class="choice register" href="/checkin.html" data-view="register">
      <b>Daily register — check-in</b>
      <span>The once-a-day presentation the policy requires. Swipe a card either way to record today's check-in. Nothing here signs anyone in or out.</span>
    </a>
    ${canAdmin ? `<a class="choice admin" href="/admin.html" data-view="admin"><b>Site admin</b><span>This centre's residents, buildings, staff and settings.</span></a>` : ""}
    ${canOrg ? `<a class="choice admin" href="/org.html" data-view="org"><b>Organisation</b><span>Every centre on the service. No resident data.</span></a>` : ""}
    <label class="check always"><input type="checkbox" id="chooserAlways"> <span>Always open this on this tablet. To undo, open the address with <b>?view=choose</b>.</span></label>`;
  el.addEventListener("click", (e) => {
    const a = e.target.closest("[data-view]");
    if (!a) return;
    if (el.querySelector("#chooserAlways")?.checked && VIEW_PAGES[a.dataset.view]) setDefaultView(a.dataset.view);
    rememberView(a.dataset.view);
    if (a.dataset.view === current) {
      e.preventDefault(); el.remove();
      // Anything that waited for the screen to be visible (the swipe demo)
      // can go ahead now.
      document.dispatchEvent(new Event("viewchosen"));
    }
  });
  document.body.appendChild(el);
  const first = el.querySelector(current === "register" ? ".choice.register" : ".choice.gate");
  if (first) first.focus();
}

// The swipe demo: on the first three loads of an app in this browser, the
// first card slides aside to reveal the strip behind it. Counted per app,
// because the gate and the register swipe for different things. It waits
// until the chooser is out of the way — a demonstration nobody can see is
// not a demonstration, and it must not use up one of the three plays.
// localStorage can be unavailable (private mode); then it simply never shows.
function nudgeFirstCard(container, app) {
  if (nudgeFirstCard.done) return;              // once per page load, whatever re-renders
  if (!container.querySelector("button.card")) return;
  if (document.getElementById("chooser")) {
    if (!nudgeFirstCard.waiting) {
      nudgeFirstCard.waiting = true;
      document.addEventListener("viewchosen", () => { nudgeFirstCard.waiting = false; nudgeFirstCard(container, app); }, { once: true });
    }
    return;
  }
  try {
    const key = "swipeNudge2:" + app;
    const seen = Number(localStorage.getItem(key) || 0);
    nudgeFirstCard.done = true;
    if (seen >= 3) return;
    const first = container.querySelector("button.card");
    first.classList.add("nudge");
    if (first.parentElement && first.parentElement.classList.contains("swipe")) first.parentElement.classList.add("nudge");
    localStorage.setItem(key, String(seen + 1));
  } catch (_) { /* storage blocked */ }
}

// The mark and the product name, drawn once here so every page shows the
// same thing: CheckSteady on the big line, the centre and the person on the
// small line. The header used to show only the centre's name, which left a
// person on a shared tablet unsure which product they were in.
const MARK_SVG = '<svg class="mark" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="16"/><path d="M18 33l10 10 18-20"/></svg>';
function mountBrand() {
  for (const el of document.querySelectorAll(".brand, .login h1")) {
    if (!el.querySelector(".mark")) el.insertAdjacentHTML("afterbegin", MARK_SVG);
  }
}
document.addEventListener("DOMContentLoaded", mountBrand);

// "since 14:20" today, "since Thu 4 Sep 14:20" otherwise. The centre
// managers asked for "off site since date and time" in place of "last
// movement 3h ago": a time is a fact a manager can act on, an age is not.
function sinceLabel(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  if (sameDay) return `since ${time}`;
  return `since ${d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} ${time}`;
}
function dayTime(iso) {
  const d = new Date(iso);
  return `${d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}`;
}
// "Thu 12 Sep" for a YYYY-MM-DD, in local words.
function dayLabel(ymd) {
  const d = new Date(`${ymd}T12:00:00`);
  return Number.isNaN(d.getTime()) ? ymd : d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}
function isoDate(d) { const p = (v) => String(v).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }

// Quick ranges for a date pair: today, yesterday, this week (Monday to
// today), this month. Returns [from, to] as YYYY-MM-DD in local time.
function presetRange(name) {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const f = new Date(t);
  if (name === "yesterday") { f.setDate(f.getDate() - 1); return [isoDate(f), isoDate(f)]; }
  if (name === "week") { f.setDate(f.getDate() - ((f.getDay() + 6) % 7)); return [isoDate(f), isoDate(t)]; }
  if (name === "month") { f.setDate(1); return [isoDate(f), isoDate(t)]; }
  return [isoDate(t), isoDate(t)];
}
// Chips under a from/to pair. onPick runs after the inputs are set.
function mountRangePresets(container, fromEl, toEl, onPick) {
  container.innerHTML = [["today", "Today"], ["yesterday", "Yesterday"], ["week", "This week"], ["month", "This month"]]
    .map(([k, l]) => `<button type="button" data-preset="${k}">${l}</button>`).join("");
  container.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-preset]"); if (!b) return;
    const [f, t] = presetRange(b.dataset.preset);
    fromEl.value = f; toEl.value = t;
    container.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    onPick();
  });
  const clear = () => container.querySelectorAll("button").forEach((x) => x.removeAttribute("aria-pressed"));
  fromEl.addEventListener("input", clear); toEl.addEventListener("input", clear);
}

// A resident's history: every movement and check-in with the date and time,
// over a range, newest first. Shared by the gate sheet, the register sheet
// and the admin edit sheet; each hands it a container to draw into.
// One person's history: the movements from In & out and the check-ins from
// the daily register together, newest first. The register filter shows one
// or the other; canExport (a supervisor or admin) adds a CSV download, which
// like every export asks for a reason and goes on the audit record — the
// server refuses it for anyone else, so the button is only drawn for them.
function mountHistory(container, residentId, { canExport = false } = {}) {
  const to = new Date(); const from = new Date(); from.setDate(from.getDate() - 29);
  container.innerHTML = `
    <div class="history">
      <div class="stripTitle">History</div>
      <form class="row hrange">
        <input class="field grow" type="date" name="from" value="${isoDate(from)}" aria-label="From">
        <input class="field grow" type="date" name="to" value="${isoDate(to)}" aria-label="To">
        <button class="btn ghost sm" type="submit">Show</button>
      </form>
      <div class="chips hpresets"></div>
      <div class="row hkind" role="group" aria-label="Which register">
        <button type="button" data-kind="all" aria-pressed="true">Both</button>
        <button type="button" data-kind="gate" aria-pressed="false">In &amp; out</button>
        <button type="button" data-kind="checkin" aria-pressed="false">Check-ins</button>
        ${canExport ? `<button type="button" class="hexport" aria-expanded="false">Export CSV</button>` : ""}
      </div>
      ${canExport ? `<form class="row hexportform" hidden>
        <input class="field grow" name="reason" type="text" maxlength="200" required placeholder="Reason for the export" aria-label="Reason for the export">
        <button class="btn sm" type="submit">Download</button>
      </form>` : ""}
      <div class="hlist"><span class="hint">Loading…</span></div>
    </div>`;
  const list = container.querySelector(".hlist");
  const form = container.querySelector(".hrange");
  let kind = "all";
  const query = () => `from=${encodeURIComponent(form.elements.from.value)}&to=${encodeURIComponent(form.elements.to.value)}&kind=${kind}`;
  const load = async () => {
    if (typeof Offline !== "undefined" && !Offline.isOnline()) { list.innerHTML = '<p class="hint">History needs a connection.</p>'; return; }
    const rows = await guarded(() => apiGet(`/api/residents/${residentId}/history?${query()}`), (err) => { list.innerHTML = `<p class="hint">${esc(err.message)}</p>`; });
    if (!rows) return;
    if (!rows.length) { list.innerHTML = `<p class="hint">${kind === "all" ? "Nothing recorded in this range." : kind === "gate" ? "No movements in this range." : "No check-ins in this range."}</p>`; return; }
    const label = { in: "IN", out: "OUT", checkin: "Check-in" };
    list.innerHTML = rows.map((e) => `
      <div class="logrow">
        <time datetime="${esc(e.occurred_at)}">${esc(dayTime(e.occurred_at))}</time>
        <span class="dir ${e.kind === "in" ? "in" : e.kind === "out" ? "out" : "chk"}">${label[e.kind] || esc(e.kind)}</span>
        <span class="body"><span class="by">by ${esc(e.guard_name)}${e.late_entry ? " · recorded offline, synced later" : ""}</span></span>
      </div>`).join("") + (rows.length >= 2000 ? '<p class="hint">Showing the first 2,000. Narrow the dates for the rest.</p>' : "");
  };
  form.addEventListener("submit", (e) => { e.preventDefault(); load(); });
  mountRangePresets(container.querySelector(".hpresets"), form.elements.from, form.elements.to, load);
  container.querySelectorAll(".hkind button[data-kind]").forEach((b) => b.addEventListener("click", () => {
    kind = b.dataset.kind;
    container.querySelectorAll(".hkind button[data-kind]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    load();
  }));
  const exportBtn = container.querySelector(".hexport"), exportForm = container.querySelector(".hexportform");
  if (exportBtn) {
    exportBtn.addEventListener("click", () => {
      exportForm.hidden = !exportForm.hidden;
      exportBtn.setAttribute("aria-expanded", String(!exportForm.hidden));
      if (!exportForm.hidden) exportForm.elements.reason.focus();
    });
    exportForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const reason = exportForm.elements.reason.value.trim();
      if (!reason) { toast("Give the reason for the export", "err"); exportForm.elements.reason.focus(); return; }
      if (typeof Offline !== "undefined" && !Offline.isOnline()) { toast("Exporting needs a connection", "err"); return; }
      // A file download: the browser saves it and stays on the page.
      window.location.href = `/api/residents/${residentId}/history?${query()}&format=csv&reason=${encodeURIComponent(reason)}`;
      toast("Export recorded and downloading", "ok");
      exportForm.hidden = true; exportBtn.setAttribute("aria-expanded", "false");
    });
  }
  load();
}

// Tips: one sentence that explains a control, on demand.
//
// Two ways in. A small "?" button (class tip, data-tip="…") next to a label
// opens a bubble on tap; anything else with a data-tip (a tile, a tab) shows
// it on a long press, and on hover where there is a mouse. Delegated on the
// document, so lists that re-render keep working. One bubble for the page.
function mountTips() {
  if (mountTips.done) return;
  mountTips.done = true;
  const pop = document.createElement("div");
  pop.id = "tipPop"; pop.setAttribute("role", "tooltip"); pop.hidden = true;
  document.body.appendChild(pop);
  const hover = window.matchMedia && window.matchMedia("(hover: hover)").matches;
  let shownFor = null;
  const hide = () => { pop.hidden = true; shownFor = null; };
  const show = (el) => {
    const text = el.dataset.tip; if (!text) return;
    pop.textContent = text; pop.hidden = false; shownFor = el;
    const r = el.getBoundingClientRect();
    const w = pop.offsetWidth;
    const vw = document.documentElement.clientWidth;
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(12, Math.min(left, vw - w - 12));
    // Through the CSSOM: a style="" attribute would be refused by the CSP.
    pop.style.left = `${left + window.scrollX}px`;
    pop.style.top = `${r.bottom + window.scrollY + 8}px`;
  };
  document.addEventListener("click", (e) => {
    const t = e.target.closest(".tip");
    if (t) { e.preventDefault(); e.stopPropagation(); if (shownFor === t) hide(); else show(t); return; }
    if (e.target.closest("#tipPop")) return;
    if (holdFired) { holdFired = false; e.preventDefault(); e.stopPropagation(); return; }
    hide();
  }, true);
  // Long press on a tile or a tab.
  let timer = null; let holdFired = false; let start = null;
  document.addEventListener("pointerdown", (e) => {
    const el = e.target.closest("[data-tip]:not(.tip)");
    if (!el) return;
    start = { x: e.clientX, y: e.clientY };
    clearTimeout(timer);
    timer = setTimeout(() => { holdFired = true; show(el); }, 500);
  }, { passive: true });
  const cancel = () => { clearTimeout(timer); timer = null; };
  document.addEventListener("pointerup", cancel, { passive: true });
  document.addEventListener("pointercancel", cancel, { passive: true });
  document.addEventListener("pointermove", (e) => { if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel(); }, { passive: true });
  if (hover) {
    document.addEventListener("mouseover", (e) => { const el = e.target.closest("[data-tip]:not(.tip)"); if (el && el !== shownFor) show(el); });
    document.addEventListener("mouseout", (e) => { const el = e.target.closest("[data-tip]:not(.tip)"); if (el && shownFor === el && !el.contains(e.relatedTarget)) hide(); });
  }
  document.addEventListener("focusin", (e) => { const el = e.target.closest("[data-tip]:not(.tip)"); if (el) show(el); });
  document.addEventListener("focusout", (e) => { if (shownFor && shownFor === e.target) hide(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });
  window.addEventListener("scroll", hide, { passive: true });
  window.addEventListener("resize", hide);
}

// The coach card: three sentences the first time someone opens an app on
// this device, above the list, with a way to the full guide. Dismissed once,
// gone for good — a person who has read it should never see it again.
function mountCoach({ app, title, points, before }) {
  const key = `coach:${app}`;
  try { if (localStorage.getItem(key)) return; } catch (_) { return; }
  const anchor = typeof before === "string" ? $(before) : before;
  if (!anchor || $("coach")) return;
  const el = document.createElement("section");
  el.id = "coach"; el.className = "coach"; el.setAttribute("aria-label", "How this screen works");
  el.innerHTML = `
    <b>${esc(title)}</b>
    <ul>${points.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>
    <div class="row">
      <button class="btn sm" type="button" id="coachOk">Got it</button>
      <a class="btn ghost sm" href="/help.html#${esc(app)}">Open the guide</a>
    </div>`;
  anchor.parentNode.insertBefore(el, anchor);
  $("coachOk").addEventListener("click", () => { try { localStorage.setItem(key, "1"); } catch (_) { /* private mode */ } el.remove(); });
}

// The second step for supervisors and admins at a site that requires it: a
// six-digit code from the email. Injected into the login section on demand.
function showMfa(challenge, onReady) {
  const form = $("loginForm");
  let panel = $("mfaPanel");
  if (!panel) {
    panel = document.createElement("form");
    panel.id = "mfaPanel";
    panel.className = "mt14";
    panel.autocomplete = "off";
    panel.innerHTML = `
      <p class="hint lead" id="mfaHint"></p>
      <input id="mfaCode" class="field" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" maxlength="7" placeholder="6-digit code" required>
      <label class="hint lead" id="mfaTrustWrap"><input id="mfaTrust" type="checkbox"> Trust this device for 30 days. Not on a shared terminal.</label>
      <button id="mfaBtn" class="btn" type="submit">Continue</button>
      <p class="hint centre"><a href="#" id="mfaBack">Start again</a></p>`;
    form.insertAdjacentElement("afterend", panel);
    panel.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = $("mfaBtn"); btn.disabled = true;
      $("loginError").hidden = true;
      try {
        await apiPost("/api/session/mfa", { challenge: panel.dataset.challenge, code: $("mfaCode").value.trim(), trust_device: $("mfaTrust").checked });
        $("mfaCode").value = "";
        panel.hidden = true; form.hidden = false;
        if (panel.dataset.onReady && onReady) onReady();
      } catch (err) {
        $("loginError").textContent = err.message;
        $("loginError").hidden = false;
      } finally { btn.disabled = false; }
    });
    $("mfaBack").addEventListener("click", (e) => { e.preventDefault(); panel.hidden = true; form.hidden = false; $("loginError").hidden = true; $("password").focus(); });
  }
  panel.dataset.challenge = challenge.challenge;
  panel.dataset.onReady = "1";
  $("mfaHint").textContent = challenge.delivered
    ? `A 6-digit code has been emailed to ${challenge.email_hint}. Enter it to finish logging in. It expires in 10 minutes.`
    : `Email is not configured on this service, so the code could not be sent. Ask your administrator.`;
  form.hidden = true;
  panel.hidden = false;
  $("mfaCode").focus();
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
      const out = await apiPost("/api/session", {
        email: $("email").value.trim(),
        password: $("password").value,
      });
      $("password").value = "";
      if (out && out.mfa_required) return showMfa(out, onReady);
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
// sign in and left to sign out, and the roll call swipes either way to mark
// safe.
//
// Touch and pen only: a mouse drag on a button is not a gesture anyone means.
// The card slides under the finger and only commits past SWIPE_FIRE pixels,
// arming visibly first, so a hesitant swipe does nothing. A capture-phase
// click listener eats the click that follows any real horizontal movement, so
// a swipe never also opens the panel behind it.
//
//   onRight / onLeft — called with the card's data-id and the element. Omit
//   one to disable that direction (the card then will not slide that way).
//   selector — which elements swipe; "button.card" unless a page says
//   otherwise (the gate's roll call swipes its own rows).
function mountCardSwipe({ selector = "button.card", onRight, onLeft } = {}) {
  const FIRE = 90, TAP_SLOP = 12, MAX = 140;
  let swipe = null, swallow = false;

  document.addEventListener("pointerdown", (e) => {
    swallow = false;
    if (e.pointerType === "mouse") return;
    // Selecting several: a tap chooses, a swipe would record. Not both.
    if (document.body.classList.contains("selecting")) return;
    const card = e.target.closest(selector);
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
    // The strip behind the card fades in with the drag and is fully shown
    // once the swipe is armed, so the guard reads what letting go will do.
    const wrap = swipe.card.parentElement;
    if (wrap && wrap.classList.contains("swipe")) {
      const reveal = Math.min(1, 0.35 + Math.abs(dx) / FIRE);
      wrap.style.setProperty("--reveal-right", dx > 0 ? reveal : 0);
      wrap.style.setProperty("--reveal-left",  dx < 0 ? reveal : 0);
    }
  });

  function end(fire) {
    const s = swipe;
    swipe = null;
    if (!s) return;
    s.card.style.transform = "";
    s.card.classList.remove("swipe-arm", "swipe-arm-out");
    const wrap = s.card.parentElement;
    if (wrap && wrap.classList.contains("swipe")) {
      wrap.style.removeProperty("--reveal-right");
      wrap.style.removeProperty("--reveal-left");
    }
    if (Math.abs(s.dx) > TAP_SLOP) swallow = true;
    if (!fire) return;
    if (s.dx >=  FIRE && onRight) onRight(s.id, s.card);
    if (s.dx <= -FIRE && onLeft)  onLeft(s.id, s.card);
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

// ---- the detail sheet: a bar that stays put, and three more ways off it ----
// The sheet's only exit used to be the Close button under the actions, which
// on a phone is below the fold once the sheet has scrolled. Every sheet now
// opens with this bar at the top: the grab handle and a ✕ that stay in view
// while the rest scrolls (position: sticky). Each page's renderDetail() puts
// it first in the markup.
function sheetBar() {
  return `<div class="sheetbar"><button class="x" type="button" aria-label="Close" title="Close">✕</button></div>`;
}

// Installed once per page. Closes the sheet on: a tap on the bar (the ✕ or
// the handle), Escape on a keyboard, and a tap on the dimmed page behind the
// sheet. The outside tap runs in the capture phase, so a tap on another
// resident's card closes this sheet first and then the card's own handler
// opens theirs — one tap, not two. A tap on the toast or a tooltip is
// neither inside nor outside, and leaves the sheet alone. Escape while
// typing in a field on the sheet is the field's (the admin edit form would
// otherwise lose its changes to a stray key); the ✕ is there for that.
function mountSheetDismiss(onClose, { id = "detail" } = {}) {
  const open = () => { const d = $(id); return d && !d.hidden ? d : null; };
  document.addEventListener("click", (e) => {
    const d = open();
    if (!d) return;
    if (e.target.closest(".sheetbar")) { onClose(); return; }
    if (d.contains(e.target)) return;
    if (e.target.closest("#toast, #tipPop")) return;
    onClose();
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    const d = open();
    if (!d) return;
    const a = document.activeElement;
    if (a && d.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
    e.preventDefault();
    onClose();
  });
}

async function logout() {
  try { await apiDelete("/api/session"); } catch { /* the cookie is gone either way */ }
}
