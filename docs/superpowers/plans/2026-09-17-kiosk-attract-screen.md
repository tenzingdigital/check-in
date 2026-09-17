# Kiosk Attract Screen and Sign-in View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The resident self check-in tablet opens on a full-screen photograph of the centre with the site's name, the time and a "Tap to check in" invitation; a tap opens a refreshed sign-in view over the same photograph, in the resident's own language, where a room code alone finds the room.

**Architecture:** An administrator uploads one photograph under Settings (stored in a new per-tenant table `site_photos`, read through two SECURITY DEFINER doors the kiosk role may call, served at `GET /api/kiosk/photo`; `GET /api/kiosk/branding` gives the kiosk the site name and whether a photo exists — the kiosk role otherwise sees `settings: null`). `kiosk_search()` (051) gains an exact match on the room number alone. `public/kiosk.html` gains an attract view (the photo, site name, clock, pulsing invitation; idle returns to it) and its search/confirm/thanks views are restyled as a glass card over the blurred photo, with a six-language string table (English, Українська, Русский, ქართული, العربية with RTL, Français) chosen from a row of buttons and remembered in localStorage.

**Owner's brief (17 Sep 2026, with three photos of the incumbent tablet at Slaney):** "the tablet needs to look nice … it's got an image of Slaney, they tap to open the sign-in register. I want to beautify and enhance the view — there's no sign-out view, ignore that — but don't copy it exactly." The incumbent: aerial photo + "Tap the screen to start"; a Sign in / Sign out split (not ours); room-code search ("C09 Larysa Konotop") with a presence dot; a flag for language.

**Tech Stack:** Node 22, Express, Postgres 16, vanilla HTML/CSS/JS, `node:test`, `test/compliance.sql`, `./check.sh`.

## Global Constraints

- Work on `main`; commit per task; never push.
- `./check.sh` needs `PGBIN=/opt/homebrew/opt/postgresql@16/bin`; one run at a time. `test/sql.sh` = DB suite alone.
- Migrations hard-code `public.`; new TABLES and FUNCTIONS need no tenant loop (the template carries them); regenerate `tenant/template.sql` (`./tools/gen-tenant-template.sh`) and commit it.
- **CSP** (`lib/security.js`): `style-src 'self' <hashes of each page's <style> blocks>`, `img-src 'self' data:`, `font-src 'self'`, inline `<script>` blocks hashed at boot. So: no `style="…"` attributes in markup (use classes; CSSOM property sets from JS are fine, e.g. `img.src = …`), no external fonts, no external images. The photo is an `<img src="/api/kiosk/photo">`.
- The kiosk role reaches only `/api/kiosk/*` and its own session (`lib/auth.js requireSession`); the two new kiosk routes live under `/api/kiosk/` so nothing in the gate changes. It must gain no other reach: `kiosk_branding()` returns `site_name` and `has_photo` and nothing else.
- `kiosk_search` stays a search, not a list: the new room-number clause is EXACT equality (`lower(rm.number) = v_nq`), never prefix or substring; the five-row limit and the two-character minimum stand.
- Photo: JPEG/PNG/WebP only (sniff the first bytes; do not trust the header), ≤ 4 MB, one per site (`kind = 'kiosk'`); the upload route is admin-only and audited (`admin_audit` via a trigger or an explicit row — `note_report` is not the right tool; write the row in the SECURITY DEFINER setter with `table_name 'site_photos'`, `action 'insert'`/`'delete'`, no bytes in `new_row`).
- Wording: "Self check-in tablet" (Settings), "Tap to check in", "Your name or room", "Checking you in — stay for ten seconds", "That's not me", "Thank you", "Not checked in — please ask a member of staff". Translations must be of these exact strings. Never "Sign out" on the kiosk.
- The kiosk stays a single file (`public/kiosk.html`) with `app-common.css/js`; the design is CheckSteady's own — not the incumbent's layout.

---

### Task 1: The photograph and the branding — migration 057, routes, Settings upload

**Files:**
- Create: `migrations/057_kiosk_photo_and_room_search.sql`
- Regenerate: `tenant/template.sql`
- Modify: `routes/kiosk.js` (two GET routes), `routes/settings.js` (PUT/DELETE `/kiosk-photo`, GET `/kiosk-photo` for the admin preview), `server.js` (a raw body parser for the PUT only: `express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '4mb' })` mounted on that one path before the JSON parser refuses it — read how `/api` parsers are ordered), `public/admin.html` (Settings → a "Self check-in tablet" heading with the upload: file input, preview `<img>`, Remove button, hint), `test/permissions.js` (rows: "Upload the self check-in tablet's photograph" PUT admin-only; "Remove the self check-in tablet's photograph" DELETE admin-only; "Read the self check-in tablet's branding" GET `/api/kiosk/branding` — expect kiosk ✓ and staff ✓; "Read the self check-in tablet's photograph" GET `/api/kiosk/photo` same), regenerate `docs/PERMISSIONS.md`.
- Test: `test/compliance.sql` (057 block), `test/api.test.js`.

**Interfaces:**
- Produces: table `public.site_photos (kind text primary key check (kind in ('kiosk')), content_type text not null, bytes bytea not null, uploaded_by uuid references profiles(id), uploaded_at timestamptz not null default now())`, RLS enabled, no policies (owner-side functions only), `revoke all from anon, public, authenticated`.
- Produces: `public.set_site_photo(p_kind text, p_content_type text, p_bytes bytea) returns void` (admin only; upsert; audit row with `new_row = jsonb_build_object('kind', p_kind, 'content_type', p_content_type, 'bytes', length(p_bytes))`), `public.clear_site_photo(p_kind text) returns void` (admin; audit `delete`), `public.site_photo(p_kind text) returns table (content_type text, bytes bytea, uploaded_at timestamptz)` (kiosk, staff), `public.kiosk_branding() returns table (site_name text, has_photo boolean)` (kiosk, staff). All SECURITY DEFINER, `set search_path = public`, granted to `authenticated` after `revoke all from public, anon`, role checks inside as `kiosk_search` does (`my_role()`).
- Produces: `kiosk_search()` re-created with the extra clause `or (rm.id is not null and lower(rm.number) = v_nq)` right after the existing exact-label clause, with a comment: the room code is what the door knows.
- Produces: `GET /api/kiosk/branding` → `{ site_name, has_photo }`; `GET /api/kiosk/photo` → the bytes with `Content-Type`, `Cache-Control: private, max-age=300`, `ETag` = uploaded_at epoch (304 on `If-None-Match`), 404 when none; `PUT /api/settings/kiosk-photo` (raw body; admin) → `{ ok: true, content_type, bytes }`; `DELETE /api/settings/kiosk-photo` → 204; `GET /api/settings/kiosk-photo` (staff) → the same bytes as the kiosk route (for the Settings preview).

- [ ] **Step 1: Migration** as specified. Sniffing lives in the route (Node), the type check in SQL is `p_content_type in ('image/jpeg','image/png','image/webp')` and `length(p_bytes) between 1 and 4194304`.
- [ ] **Step 2: SQL tests** (057 block): admin sets a 3-byte photo → `site_photo('kiosk')` returns it; kiosk uid (`5555…`) can call `site_photo` and `kiosk_branding` (returns the site name and `true`) but not `set_site_photo`/`clear_site_photo` (42501); guard can read branding; supervisor cannot set (42501); bad type 22023; `clear_site_photo` → `has_photo = false`, audit rows one insert one delete with no bytes in `new_row`; `kiosk_search('c09')` as kiosk finds a resident in a room numbered `C09` in building `Slaney` (create both as the supervisor via the existing building/room functions the 016 tests use), and `kiosk_search('c0')` does not.
- [ ] **Step 3: Routes + sniffing.** Magic bytes: JPEG `FF D8 FF`, PNG `89 50 4E 47 0D 0A 1A 0A`, WebP `52 49 46 46 …… 57 45 42 50`; mismatch with the declared type → 400 "That file is not a JPEG, PNG or WebP image". Empty body → 400. Over 4 MB → the raw parser's 413 becomes a 400 with a sentence (read how `server.js` turns parser errors into JSON).
- [ ] **Step 4: Settings UI.** Under a new `<h2 class="mt6">Self check-in tablet</h2>` after the door check-in switch: a sentence ("The tablet opens on this photograph of the centre with the site's name and a Tap to check in. Landscape, at least 1600 pixels wide, JPEG or PNG, up to 4 MB."), `<input type="file" accept="image/jpeg,image/png,image/webp">`, a preview `<img id="stKioskPhoto" alt="">` shown when `has_photo`, and a `Remove` ghost button. Upload via `fetch(PUT)` with the File as body and its `type` as Content-Type (the shared `api()` helper sends JSON — write a small `apiPutRaw` in admin.html's script or app-common.js). Toast on success/failure.
- [ ] **Step 5: HTTP tests.** Admin PUT a tiny valid PNG (build the bytes in the test) → 200; GET `/api/kiosk/photo` as a kiosk session → 200 `image/png`, same bytes, ETag; second GET with `If-None-Match` → 304; `GET /api/kiosk/branding` as kiosk → `{ site_name, has_photo: true }`; guard GET photo → 200 (staff may see it); supervisor PUT → 403; PUT with a JPEG header declared as PNG → 400; DELETE → 204 then GET photo → 404 and `has_photo: false`. Kiosk search `C09` finds the room's adult (seed a building/room/resident as the 051 kiosk tests do).
- [ ] **Step 6:** `node tools/gen-permissions-doc.js`; full `./check.sh`; commit: `Migration 057: the self check-in tablet's photograph and branding; a room code alone finds the room`.

---

### Task 2: The kiosk — attract view, glass sign-in, six languages

**Files:**
- Modify: `public/kiosk.html` (markup, `<style>`, inline script), `public/help.html` (the Self check-in tablet section: the photo, the languages, "tap anywhere"), `tools/build-site.py` (one sentence in the feature grid or the daily-register page: the tablet opens on a photograph of your own centre and speaks the residents' languages) + regenerated `site/`.
- Test: `./check.sh` (CSP hash assertions cover the edited `<style>`/`<script>`); a Playwright/browser check with screenshots saved to the workspace (`.superpowers/sdd/<plan>/kiosk-attract.png`, `kiosk-search.png`, `kiosk-search-ar.png`) — the controller and the owner will look at them.

**Interfaces:** consumes `GET /api/kiosk/branding`, `GET /api/kiosk/photo`, the existing search/checkin routes and `state`/timers in kiosk.html.

**Design (build this, not the incumbent's):**

*Attract view* (`#attractView`, shown on boot and after 30 s idle from any view except an in-flight confirm):
- The photograph fills the screen (`<img class="attractPhoto" src="/api/kiosk/photo" alt="">`, `object-fit: cover`, `position: fixed; inset: 0`). Without a photo (`has_photo` false or the image fails to load): a deep two-stop gradient (`#0b1f3a → #1d4ed8` at 160°) with a very faint large CheckSteady tick in the corner.
- A gradient scrim from transparent at 45 % height to `rgba(6,12,24,.78)` at the bottom, so white text always reads.
- Bottom-left: the site name in 44–56 px, weight 700, letter-spacing −0.01em, white; beneath it, 18 px at 80 % white: today's date in words ("Thursday 17 September").
- Bottom-right: the clock, `HH:MM`, 72 px, `font-variant-numeric: tabular-nums`, updated each minute; the seconds are not shown.
- Centre-bottom, above the scrim's foot: a pill `Tap to check in` — white 92 % background, ink text, 22 px, 18 px × 34 px padding, `border-radius: 999px`, a soft shadow, and a slow 2.4 s scale pulse (1 → 1.04) that `prefers-reduced-motion` disables. The whole screen is the tap target (`pointer`).
- Top-right: the language row (below).
- Tapping anywhere → `#searchView` with a 220 ms fade; the photo stays underneath, blurred (`filter: blur(18px) brightness(.55)`, `transform: scale(1.06)` to hide the blur's edges).

*Sign-in view*:
- A centred glass card (`max-width: 720px; width: min(92vw, 720px)`, `background: rgba(255,255,255,.88)` light / `rgba(20,26,40,.86)` dark, `backdrop-filter: blur(20px) saturate(1.2)`, `border-radius: 28px`, 1 px `rgba(255,255,255,.35)` edge, deep soft shadow), padding 28 px, a `Check in` heading (30 px) with the site name under it in muted 15 px.
- The search field: 28 px text, 76 px tall, `border-radius: 18px`, a magnifier glyph inline (SVG in the markup; no icon font), placeholder `Your name or room`, `autofocus`.
- Results: cards as now but with a **room badge** first — the room number (`m_room_label`'s last segment after the final ` · `, e.g. `C09`) in a 15 px caps chip with a tinted background, then the name 24 px; `checked_in_today` shows a green tick chip `Checked in today` instead of the disabled state's warn text (keep `disabled`). No presence dot (we do not show presence to residents).
- The `Staff` link stays, bottom-centre, 13 px, 70 % white over the photo.
- Confirm / Thank you / Not checked in views: the same card, the name 48 px, the countdown button as now.

*Languages*: a row of six pills top-right of the attract view and inside the card's top-right on the sign-in view: `EN · UK · RU · KA · AR · FR`, showing the native name on the active one (`English`, `Українська`, `Русский`, `ქართული`, `العربية`, `Français`). The string table `STRINGS[lang]` covers: `tap` ("Tap to check in"), `heading` ("Check in"), `placeholder` ("Your name or room"), `checking` ("Checking you in — stay for ten seconds"), `notMe` ("That's not me"), `thanks` ("Thank you"), `failTitle` ("Not checked in"), `failSub` ("Please ask a member of staff"), `today` ("Checked in today"), `twoLetters` ("Type at least two letters"), `staff` ("Staff"). Write the five translations carefully and idiomatically (Ukrainian, Russian, Georgian, Arabic, French); `AR` sets `dir="rtl"` on the card and the attract text block; the choice persists in `localStorage['kioskLang']`; a resident's choice reverts to the site default (EN) when the idle timer returns to the attract view. Dates and the clock use `Intl.DateTimeFormat` with the chosen locale (`uk`, `ru`, `ka`, `ar`, `fr`, `en-IE`).

- [ ] **Step 1: Markup + styles** per the design; keep every id the script relies on (`q`, `results`, `confirmName`, `notMeBtn`, `notMeCount`, `failView`, `staffLink`, `reconnect`), add `attractView`, `attractPhoto`, `attractName`, `attractDate`, `attractClock`, `attractTap`, `langRow` (two instances share one render function).
- [ ] **Step 2: Script.** On boot after the session check: `GET /api/kiosk/branding` → site name into both places; `has_photo` decides the `<img>`; `img.onerror` → gradient fallback class. `showView('attract')` is the idle target; the existing 30 s idle timer's callback becomes "reset the search, revert the language, show attract". Clock: `setInterval` aligned to the next minute. Language: `applyLang(code)` rewrites every `data-s` element's text from `STRINGS`, sets `dir`, `lang` attributes, re-renders the pills.
- [ ] **Step 3: Room badge.** `roomShort(label)` = text after the last ` · ` (or the label itself); rendered in the hit card before the name.
- [ ] **Step 4: Browser check.** Start the app against the scratch cluster as Task 3 of the previous plan did (see `.superpowers` history or `check.sh` for the boot), upload a test photograph via the Settings route (any landscape JPEG you can generate — e.g. draw one with Python/PIL if available, else a solid-colour PNG), log a kiosk session in, and screenshot the attract view, the sign-in view with results for a room code, and the sign-in view in Arabic. Save to the workspace. Fix what the screenshots show (one pass).
- [ ] **Step 5: Copy** (help.html, build-site.py + site/), `python3 tools/check-site.py`.
- [ ] **Step 6:** full `./check.sh`; commit: `Kiosk: a photograph of the centre to tap, a glass sign-in card, six languages, room codes`.
