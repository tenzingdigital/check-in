"use strict";

/* ============================================================================
   sw.js — the service worker. Keeps the two pages loadable with no connection.

   What it caches: the application shell and nothing else — the two HTML
   files, the stylesheet and the three scripts. No resident data ever passes
   through here: every request to /api or /healthz is left entirely alone, so
   the worker adds no privacy surface. Resident data that must survive an
   outage lives in offline.js's encrypted store, not in this cache.

   Strategy: NETWORK FIRST. The server sends the shell with Cache-Control:
   no-cache precisely so a guard reloading after a deploy gets the new code;
   this worker keeps that promise by always trying the network and only
   serving from cache when the network fails. An outage therefore shows the
   last version that loaded, never a stale one over a live link.

   Registered from offline.js. Same-origin, served by hash-admitting CSP as
   'self', so nothing about lib/security.js changes.
   ========================================================================= */

const VERSION = "hut-shell-v1";
const SHELL = [
  "/",
  "/index.html",
  "/checkin.html",
  "/admin.html",
  "/app-common.css",
  "/app-common.js",
  "/offline.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Never the API, never the health probe: those must fail honestly when the
  // link is down, which is how the page knows it is offline.
  if (url.pathname.startsWith("/api/") || url.pathname === "/healthz") return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && SHELL.includes(url.pathname)) {
          const copy = res.clone();
          caches.open(VERSION).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        // A navigation to a path we have never cached: hand back the gate app
        // rather than the browser's own error page.
        if (req.mode === "navigate") {
          const shell = await caches.match("/index.html");
          if (shell) return shell;
        }
        return new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
      }),
  );
});
