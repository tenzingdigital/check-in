"use strict";

/* ============================================================================
   offline.js — surviving an outage of minutes to a few hours.

   Loaded by both pages after app-common.js. Plain script, no build step, no
   dependency: WebCrypto for the encryption, IndexedDB for the store, the
   service worker in sw.js for the pages themselves.

   WHAT IT DOES
     * Tells the page whether the server is reachable, and keeps checking.
     * Keeps an encrypted copy of the last register the page loaded, so a
       guard can still find a name while the link is down.
     * Queues gate events and check-ins recorded while offline, encrypted,
       each with the terminal's timestamp and a random ref, and replays them
       to POST /api/sync when the link returns. The server re-dates each one
       to when it happened and flags it as synced later — see
       migrations/010_offline_sync.sql.

   WHAT IT DELIBERATELY DOES NOT DO
     * Hold anything in plain text. Both the register copy and the queue are
       AES-GCM ciphertext in IndexedDB. The key lives in sessionStorage — kept
       across a reload, gone when the tab is closed — so a browser profile
       lifted off a stolen terminal contains ciphertext and no key. (A closed
       tab therefore also loses the ability to READ the cache until the page
       is next online; the queue's ciphertext is kept, and becomes readable
       again only by the same tab... which is gone. So: do not close the tab
       during an outage. The header says so.)
     * Replay one guard's events under another guard's login. Each queued
       item carries the id of the guard who recorded it, and only a session
       for that guard sends it. The server takes identity from the session
       regardless (Tao 6); this just stops the terminal from asking it to
       misattribute.
     * Throw anything away on its own. A queued event stays until the server
       says 'ok', or says 'rejected' with a reason a person then reads and
       dismisses.
   ========================================================================= */

const Offline = (() => {
  const DB_NAME = "hut-offline";
  const DB_VERSION = 1;
  const KEY_SLOT = "hut_offline_key";
  const PROBE_MS = 15000;
  const SYNC_BATCH = 100;

  /* ------------------------------------------------------------------
     Connectivity
     ---------------------------------------------------------------- */
  let online = navigator.onLine;
  let probing = false;
  const listeners = new Set();

  function notify() { for (const fn of listeners) { try { fn(online); } catch (_) { /* a listener must not break the others */ } } }
  function setOnline(v) {
    if (v === online) return;
    online = v;
    notify();
  }
  function isOnline() { return online; }
  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  // The health probe touches Postgres, so "online" here means "the whole
  // system can take a write", not merely "the wifi has a bar".
  async function probe() {
    if (probing) return online;
    probing = true;
    try {
      const res = await fetch("/healthz", { cache: "no-store", credentials: "same-origin" });
      setOnline(res.ok);
    } catch (_) {
      setOnline(false);
    } finally {
      probing = false;
    }
    return online;
  }

  window.addEventListener("online", () => { probe(); });
  window.addEventListener("offline", () => setOnline(false));
  setInterval(() => { if (!online) probe(); }, PROBE_MS);

  // "The server cannot take this right now" — whether the link is down
  // (status 0: fetch never got an answer) or the service answered that it is
  // broken (500 from the app when its database is unreachable, 502/503/504
  // from Render while the service restarts). Pages queue an event on any of
  // these rather than telling the guard it was not recorded: every one is a
  // state the health probe will see clear, and replaying through the late
  // functions is safe even if the original request did land, because the
  // same 60-second dedupe applies. A 4xx is a real refusal and is never
  // queued.
  function isOutage(err) {
    const s = err && err.status;
    return s === 0 || s === 500 || s === 502 || s === 503 || s === 504;
  }

  // Pages call this from their error handlers so one failed request flips
  // the indicator without waiting for the next probe. The probe hits
  // /healthz, which touches the database, so it stays red until the whole
  // system can take a write again.
  function noteFailure(err) {
    if (isOutage(err)) setOnline(false);
  }

  /* ------------------------------------------------------------------
     Key
     ---------------------------------------------------------------- */
  let keyPromise = null;

  function b64(bytes) { return btoa(String.fromCharCode(...bytes)); }
  function unb64(s) { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); }

  function getKey() {
    if (keyPromise) return keyPromise;
    keyPromise = (async () => {
      let raw;
      try { raw = sessionStorage.getItem(KEY_SLOT); } catch (_) { raw = null; }
      let bytes;
      if (raw) {
        bytes = unb64(raw);
      } else {
        bytes = crypto.getRandomValues(new Uint8Array(32));
        try { sessionStorage.setItem(KEY_SLOT, b64(bytes)); } catch (_) { /* private mode: key lives only in memory */ }
      }
      return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    })();
    return keyPromise;
  }

  async function seal(obj) {
    const key = await getKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(obj)),
    );
    return { iv, data };
  }

  async function open_(rec) {
    if (!rec) return null;
    try {
      const key = await getKey();
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: rec.iv }, key, rec.data);
      return JSON.parse(new TextDecoder().decode(plain));
    } catch (_) {
      // A different key than the one that wrote it — the tab was closed and
      // reopened. Unreadable, by design.
      return null;
    }
  }

  /* ------------------------------------------------------------------
     IndexedDB
     ---------------------------------------------------------------- */
  let dbPromise = null;
  function db() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains("blobs")) d.createObjectStore("blobs");
        if (!d.objectStoreNames.contains("queue")) d.createObjectStore("queue");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(store, mode, fn) {
    return db().then((d) => new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const s = t.objectStore(store);
      let out;
      try { out = fn(s); } catch (err) { reject(err); return; }
      t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  const idbGet = (store, key) => tx(store, "readonly", (s) => s.get(key));
  const idbPut = (store, key, val) => tx(store, "readwrite", (s) => s.put(val, key));
  const idbDel = (store, key) => tx(store, "readwrite", (s) => s.delete(key));
  const idbClear = (store) => tx(store, "readwrite", (s) => s.clear());
  const idbAll = (store) => tx(store, "readonly", (s) => s.getAll());
  const idbKeys = (store) => tx(store, "readonly", (s) => s.getAllKeys());

  /* ------------------------------------------------------------------
     Register cache — one slot per page ("gate", "checkin")
     ---------------------------------------------------------------- */
  async function saveRegister(slot, rows) {
    try {
      await idbPut("blobs", "register:" + slot, await seal({ saved_at: new Date().toISOString(), rows }));
    } catch (_) { /* storage unavailable: the app still works online */ }
  }

  async function loadRegister(slot) {
    try {
      const rec = await idbGet("blobs", "register:" + slot);
      const v = await open_(rec);
      return v && Array.isArray(v.rows) ? v : null;
    } catch (_) {
      return null;
    }
  }

  // Offline search is a substring match on the name, accent-blind, on the
  // same normalisation the server's search_key uses in spirit. The server's
  // typo tolerance is not available offline; the whole register is on
  // screen anyway, so scrolling is the fallback.
  function norm(s) {
    return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  }
  function filterRows(rows, q) {
    const nq = norm(q).trim();
    if (!nq) return rows;
    return rows.filter((r) =>
      norm(r.full_name).includes(nq) ||
      norm(`${r.last_name || ""} ${r.first_name || ""}`).includes(nq) ||
      (r.id_number && norm(r.id_number).includes(nq)));
  }

  /* ------------------------------------------------------------------
     Queue
     ---------------------------------------------------------------- */
  // item: { kind: "checkin" | "gate", resident_id, resident_name, direction?,
  //         guard_id, guard_name }
  async function enqueue(item) {
    const entry = {
      ref: crypto.randomUUID(),
      occurred_at: new Date().toISOString(),
      ...item,
    };
    try {
      await idbPut("queue", entry.ref, await seal(entry));
    } catch (_) {
      throw new Error("This browser cannot store events offline. Record it on the paper sheet.");
    }
    return entry;
  }

  // Every readable entry, oldest first. Entries written under a key this tab
  // no longer holds are counted but not returned — see unreadable().
  async function list() {
    let recs = [];
    try { recs = await idbAll("queue"); } catch (_) { return []; }
    const out = [];
    for (const rec of recs) {
      const v = await open_(rec);
      if (v) out.push(v);
    }
    out.sort((a, b) => a.occurred_at < b.occurred_at ? -1 : 1);
    return out;
  }

  async function unreadable() {
    try {
      const keys = await idbKeys("queue");
      const readable = (await list()).length;
      return Math.max(0, keys.length - readable);
    } catch (_) { return 0; }
  }

  async function remove(ref) {
    try { await idbDel("queue", ref); } catch (_) { /* nothing to do */ }
  }

  async function mark(entry, patch) {
    const next = { ...entry, ...patch };
    await idbPut("queue", next.ref, await seal(next));
    return next;
  }

  /* ------------------------------------------------------------------
     Flush
     ---------------------------------------------------------------- */
  let flushing = null;

  // Send this guard's pending items. Returns { sent, rejected, waiting } where
  // waiting counts items recorded by somebody else, which this session must
  // not replay. Safe to call often: it is a no-op with nothing to send, and
  // concurrent calls share one run.
  function flush(userId) {
    if (flushing) return flushing;
    flushing = (async () => {
      const summary = { sent: 0, rejected: 0, waiting: 0, offline: false };
      if (!userId) return summary;
      const all = await list();
      const mine = all.filter((e) => e.guard_id === userId && !e.rejected);
      summary.waiting = all.filter((e) => e.guard_id !== userId && !e.rejected).length;
      if (!mine.length) return summary;

      for (let i = 0; i < mine.length; i += SYNC_BATCH) {
        const page = mine.slice(i, i + SYNC_BATCH);
        let res;
        try {
          res = await apiPost("/api/sync", {
            events: page.map((e) => ({
              ref: e.ref, kind: e.kind, resident_id: e.resident_id,
              direction: e.direction, occurred_at: e.occurred_at,
            })),
          });
        } catch (err) {
          noteFailure(err);
          summary.offline = isOutage(err);
          // A 401 or 5xx: leave everything queued; the caller decides what to
          // tell the guard. Nothing has been lost.
          summary.error = err;
          return summary;
        }
        setOnline(true);
        const byRef = new Map((res.results || []).map((r) => [r.ref, r]));
        for (const e of page) {
          const verdict = byRef.get(e.ref);
          if (!verdict) continue;                       // unmatched: still pending
          if (verdict.status === "ok") { await remove(e.ref); summary.sent += 1; }
          else { await mark(e, { rejected: true, error: verdict.error || "Rejected" }); summary.rejected += 1; }
        }
      }
      return summary;
    })().finally(() => { flushing = null; });
    return flushing;
  }

  /* ------------------------------------------------------------------
     Lifecycle
     ---------------------------------------------------------------- */
  // On logout the register copy goes. The queue and its key go too — unless
  // something is still pending, in which case both are kept so the evidence
  // survives until somebody logs in and it can be sent (Tao 2).
  // A logout made while offline cannot reach the server, so the cookie's
  // session stays live there. Remember that, and end it the moment the link
  // returns — otherwise a reload after reconnecting would walk straight back
  // into the previous guard's app.
  const LOGOUT_SLOT = "hut_logout_pending";
  async function finishLogout() {
    let pending = false;
    try { pending = sessionStorage.getItem(LOGOUT_SLOT) === "1"; } catch (_) { pending = false; }
    if (!pending) return false;
    try {
      await apiDelete("/api/session");
    } catch (err) {
      if (err && err.status === 0) { noteFailure(err); return true; }   // still offline: keep it pending
    }
    try { sessionStorage.removeItem(LOGOUT_SLOT); } catch (_) { /* nothing to do */ }
    return false;
  }

  async function onLogout() {
    forgetSession();
    if (!isOnline()) {
      try { sessionStorage.setItem(LOGOUT_SLOT, "1"); } catch (_) { /* nothing to do */ }
    }
    try { await idbClear("blobs"); } catch (_) { /* nothing to do */ }
    let pending = 0;
    try { pending = (await idbKeys("queue")).length; } catch (_) { pending = 0; }
    if (pending === 0) {
      try { sessionStorage.removeItem(KEY_SLOT); } catch (_) { /* nothing to do */ }
      keyPromise = null;
    }
    return pending;
  }

  /* ------------------------------------------------------------------
     The last good session, for a reload during an outage
     ---------------------------------------------------------------- */
  // The page cannot verify its cookie while the server is unreachable. If it
  // is reloaded mid-outage it uses the profile it last saw, so the guard can
  // keep recording; the server re-checks everything the moment the queue is
  // sent. Kept in sessionStorage like the key: a closed tab forgets it.
  const SESSION_SLOT = "hut_session";
  function rememberSession(session) {
    try { sessionStorage.setItem(SESSION_SLOT, JSON.stringify(session)); } catch (_) { /* nothing to do */ }
  }
  function rememberedSession() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_SLOT) || "null"); } catch (_) { return null; }
  }
  function forgetSession() {
    try { sessionStorage.removeItem(SESSION_SLOT); } catch (_) { /* nothing to do */ }
  }

  /* ------------------------------------------------------------------
     Pending events, laid over the rows on screen
     ---------------------------------------------------------------- */
  // A guard who has just swiped somebody in needs the card to say so, even
  // though the server has not heard yet. The overlay is presentation only:
  // when the queue drains the next fetch replaces it with the server's view.
  async function overlay(slot, rows) {
    const pending = (await list()).filter((e) => !e.rejected && e.kind === (slot === "gate" ? "gate" : "checkin"));
    if (!pending.length) return rows;
    const latest = new Map();
    for (const e of pending) latest.set(e.resident_id, e);      // sorted oldest first, so the last write wins
    return rows.map((r) => {
      const e = latest.get(r.id);
      if (!e) return r;
      const c = { ...r, queued: true };
      if (slot === "gate") {
        c.presence = e.direction;
        c.last_event_at = e.occurred_at;
      } else {
        c.seen_today = true;
        c.checkins_today = (c.checkins_today || 0) + pending.filter((x) => x.resident_id === r.id).length;
        if (["expected", "due_today", "never"].includes(c.state)) c.state = "seen_today";
      }
      return c;
    });
  }

  /* ------------------------------------------------------------------
     Header indicator, rejected-events notice, periodic sync
     ---------------------------------------------------------------- */
  // Shared by both pages. Expects #netState and #syncNotice in the markup,
  // and uses $(), esc() and apiPost() from app-common.js.
  let ui = null;

  function mountUI(opts) {
    ui = opts;
    onChange(() => { renderNet(); if (isOnline()) { finishLogout().then(() => syncNow()); } });
    setInterval(() => { if (isOnline() && ui.getUserId()) syncNow(); }, 30000);
    renderNet();
  }

  async function renderNet() {
    const el = $("netState");
    if (!el) return;
    const items = await list();
    const pending = items.filter((e) => !e.rejected).length;
    const rejected = items.filter((e) => e.rejected);
    const lost = await unreadable();

    el.hidden = false;
    if (!isOnline()) {
      el.className = "net off";
      el.textContent = pending
        ? `Offline · ${pending} queued — keep this tab open`
        : "Offline — recording to this terminal";
    } else if (pending) {
      el.className = "net syncing";
      el.textContent = `Syncing ${pending}…`;
    } else {
      el.className = "net";
      el.textContent = "Online";
    }
    renderNotice(rejected, lost);
  }

  function when(iso) {
    try { return new Date(iso).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }); }
    catch (_) { return iso; }
  }

  // An event the server has refused for good, or one this tab can no longer
  // read, is not silently dropped: it is shown with its reason until a person
  // dismisses it, so it can go on the paper sheet instead.
  function renderNotice(rejected, lost) {
    const box = $("syncNotice");
    if (!box) return;
    if (!rejected.length && !lost) { box.hidden = true; box.innerHTML = ""; return; }
    const lines = rejected.map((e) => `
      <div class="row">
        <span>${esc(e.resident_name || e.resident_id)} · ${e.kind === "gate" ? "sign " + esc(String(e.direction || "").toUpperCase()) : "check-in"}
          · ${esc(when(e.occurred_at))}<br><span class="hint">Not recorded: ${esc(e.error || "rejected")}</span></span>
        <button class="btn ghost" type="button" data-dismiss="${esc(e.ref)}">Dismiss</button>
      </div>`);
    if (lost) {
      lines.push(`
      <div class="row">
        <span>${lost} event${lost === 1 ? "" : "s"} recorded offline in a tab that has since been closed cannot be read on this terminal and
          ${lost === 1 ? "was" : "were"} <b>not sent</b>. Record ${lost === 1 ? "it" : "them"} from the paper sheet.</span>
        <button class="btn ghost" type="button" data-dismiss-lost="1">Clear</button>
      </div>`);
    }
    box.innerHTML = `<b>Needs attention</b><div class="synclist">${lines.join("")}</div>`;
    box.hidden = false;
  }

  document.addEventListener("click", async (e) => {
    const d = e.target.closest("button[data-dismiss]");
    if (d) { await remove(d.dataset.dismiss); renderNet(); return; }
    const l = e.target.closest("button[data-dismiss-lost]");
    if (l) { await clearUnreadable(); renderNet(); }
  });

  async function clearUnreadable() {
    try {
      const keys = await idbKeys("queue");
      for (const k of keys) {
        const v = await open_(await idbGet("queue", k));
        if (!v) await idbDel("queue", k);
      }
    } catch (_) { /* nothing to do */ }
  }

  async function syncNow() {
    const uid = ui && ui.getUserId();
    if (!uid) return null;
    const s = await flush(uid);
    if (s.error && s.error.status === 401 && ui.onUnauthenticated) ui.onUnauthenticated(s);
    if (s.sent && ui.onSynced) ui.onSynced(s);
    await renderNet();
    return s;
  }

  function registerWorker() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => { /* http://localhost without the flag, or an old browser */ });
  }

  return {
    isOnline, onChange, probe, noteFailure, isOutage,
    saveRegister, loadRegister, filterRows, overlay,
    enqueue, list, unreadable, remove, flush,
    rememberSession, rememberedSession, forgetSession,
    mountUI, renderNet, syncNow,
    onLogout, finishLogout, registerWorker,
  };
})();
