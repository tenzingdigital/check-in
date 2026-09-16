# Resident self check-in kiosk — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `kiosk` login that can do exactly two things — find one adult resident by name, room or exact ID number, and record that person's daily check-in — on a dedicated tablet page, with every other route and table refused in the database.

**Architecture:** Migration 051 adds the role and two SECURITY DEFINER functions; `auth.requireSession` refuses a kiosk session everything but `/api/kiosk/*` and logout; `routes/kiosk.js` exposes search (rate-limited) and check-in; `public/kiosk.html` is the tablet page; the other pages redirect a kiosk session there; the register shows a "self" mark for `source = 'kiosk'`; the permission matrix gains a `kiosk` column that expects `deny` everywhere by default.

**Tech Stack:** Express + Postgres 16 (RLS, SECURITY DEFINER), numbered migrations + `tools/gen-tenant-template.sh`, vanilla JS under a strict CSP, plain-assert suites (`PGBIN=/opt/homebrew/opt/postgresql@16/bin ./check.sh`).

Spec: `docs/superpowers/specs/2026-09-16-self-checkin-kiosk-design.md`.

## Global Constraints

- The kiosk is the **daily 24-hour check-in only** — never In & out, never the roll call. Children (under the site's `adult_age_years`) never appear in a kiosk search.
- `is_staff()` must **not** include `kiosk`. Every existing policy and function keeps refusing it; only `kiosk_search`, `kiosk_checkin` (and `record_checkin_at` for `p_source = 'kiosk'`) admit the role.
- Search: ≥2 characters; name via `search_key` (prefix or trigram, as the existing residents search does — read `routes/residents.js` GET / for the operator used), room label exact case-insensitive, ID number **exact only**; at most 5 rows; fields `resident_id, full_name, room_label (null unless two matches share full_name), checked_in_today`. Never DOB, ID, history, counts.
- Rate limit `/api/kiosk/search`: 60 per minute per session (in-memory, like `lib/auth.js` lockouts).
- Every user-visible error is a sentence a resident can read on a tablet ("Type at least two letters of your name").
- Migrations only add; `tenant/template.sql` regenerated and committed; `docs/PERMISSIONS.md` regenerated (`node tools/gen-permissions-doc.js`); no `style=""`, no third-party scripts; new inline scripts are hashed at boot.
- Commit after every task with the footer:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01FofqrXrLKdxybZvZYupwRB
  ```

## File map

| File | Responsibility |
|---|---|
| `migrations/051_kiosk_role.sql` (create), `tenant/template.sql` (regen) | role, source, the two functions, guard-constraint widening |
| `lib/auth.js` (`requireSession`) | the one gate for kiosk sessions |
| `routes/kiosk.js` (create), `server.js` (mount) | search + check-in, rate limit |
| `test/permissions.js`, `test/api.test.js` | `kiosk` column; the kiosk block |
| `public/kiosk.html` (create), `public/app-common.js`, `public/index.html`, `public/checkin.html`, `public/admin.html` | the page; landing/redirects; role dropdown; the "self" mark |
| `public/help.html`, `README.md`, `docs/KNOWN-ISSUES.md`, `docs/PERMISSIONS.md` | docs |

---

### Task 1: Migration 051 — the role and its two doors

**Files:** create `migrations/051_kiosk_role.sql`; regenerate `tenant/template.sql`; test in `test/api.test.js` (new block "the self check-in kiosk (migration 051)" before the final `server.close()`).

**Interfaces produced:**
- `profiles.role` check: `('guard','supervisor','admin','kiosk')`; `checkin_events.source` check: `('desk','door','kiosk')`.
- `public.kiosk_search(p_q text) returns table (resident_id uuid, full_name text, room_label text, checked_in_today boolean)` — SECURITY DEFINER; raises `42501` unless `my_role() in ('kiosk','supervisor','admin')`; raises `22023` "Type at least two letters" when `length(btrim(p_q)) < 2`; adults only (`date_of_birth <= site_today() - make_interval(years => adult_age_years)` — copy the adult test used by `v_resident_compliance`); active only; match = `search_key like lower(unaccent(q)) || '%'` OR `search_key like '% ' || … || '%'` (word-prefix, as the residents search does — read it and match) OR `lower(room label) = lower(q)` OR `id_number = q`; `order by full_name limit 5`; `room_label` null unless `count(*) over (partition by full_name) > 1`; `checked_in_today` from `daily_compliance` for `site_today()` with `presented`.
- `public.kiosk_checkin(p_resident_id uuid) returns public.daily_compliance` — SECURITY DEFINER; `my_role() in ('kiosk','supervisor','admin')`; refuses a child (`P0002`-style "Not a resident who checks in here") and an inactive resident; then `return record_checkin_at(p_resident_id, now(), false, null, 'kiosk')`.
- `record_checkin_at`: its guard becomes `if not (public.is_staff() or (public.my_role() = 'kiosk' and p_source = 'kiosk')) then raise …` — the only write a kiosk can make is a kiosk-sourced check-in. Re-declare the whole function (copy from 039, change that one line; keep the comment and add why).
- `profiles_weekly_report_not_guard` / `profiles_safeguarding_alert_not_guard` constraints and their triggers: `role = 'guard'` → `role in ('guard','kiosk')` (re-create both constraints and both trigger functions — copy from 037/041).
- Grants: `revoke all on function kiosk_search(text), kiosk_checkin(uuid) from public, anon; grant execute … to authenticated;`.

- [ ] **Step 1: Failing tests.** Create a kiosk user: `select auth.create_user('kiosk@hut.example', PASSWORD, 'Gate tablet', 'kiosk')` — this fails today on the role check (that is RED #1). Then, with `withIdentity(kioskId, …)`: `select is_staff()` → false; `select count(*) from residents` → 0 (RLS, no error) or `permission denied` — assert whichever the policy yields and say which; `select * from kiosk_search('an')` returns rows for the seeded adult residents whose name starts with "an" (seed.sql has residents — pick a real prefix by reading it), each with `room_label null` unless a collision, no other columns; `kiosk_search('a')` raises `/two letters/`; `kiosk_search('<exact id_number of a seeded resident>')` returns exactly that resident and `kiosk_search('<that id minus its last char>')` returns nothing; a child (create one via `supC` with a DOB 10 years ago) never appears; `kiosk_checkin(adultId)` returns a row with `presented = true` and `select source from checkin_events where resident_id = $1 order by id desc limit 1` = `'kiosk'`; `kiosk_checkin(childId)` rejects; `record_checkin_at(adultId, now(), false, null, 'desk')` as kiosk → `42501`; setting `weekly_report = true` on the kiosk profile → check-constraint error.
- [ ] **Step 2: Write the migration** with the repo's comment density (a header paragraph on why a kiosk is not staff, and a sentence on each decision above). Regenerate the template: `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./tools/gen-tenant-template.sh`.
- [ ] **Step 3:** `PGBIN=… ./test/api.sh` green (the "provisioned too" test covers the template). Commit: `Migration 051: the kiosk role — search one adult, record one check-in, nothing else`.

---

### Task 2: The server gate and `routes/kiosk.js`

**Files:** `lib/auth.js` (`requireSession`), create `routes/kiosk.js`, `server.js` (mount at `/api/kiosk` after `requireSession`), `test/permissions.js`, `test/api.test.js`.

**Interfaces produced:**
- `requireSession`: after the 401 check, `if (req.session.role === 'kiosk' && !req.path.startsWith('/kiosk') && !(req.method === 'DELETE' && req.path === '/session') && !(req.method === 'GET' && req.path === '/session')) return res.status(403).json({ error: 'This login can only check residents in.' })`. (`req.path` inside the `/api` mount is `/kiosk/search`, `/session`.) GET /api/session stays allowed so the page can learn its role and site name.
- `POST /api/kiosk/search { q }` → `{ results: [{ id, full_name, room_label, checked_in_today }] }`; 400 with the DB's sentence for <2 chars; 429 `{ error: 'Too many searches — wait a moment.' }` after 60 in a minute per session token (key on `req.session.userId`; reuse the `attempts`-map idea from `lib/auth.js` in a tiny module-local limiter).
- `POST /api/kiosk/checkin { id }` → `{ ok: true, full_name, checked_in_at }` (site-time ISO); 404 sentence for an unknown id; 400 for a child/inactive.
- `test/permissions.js`: `ROLES` gains `'kiosk'` after `'guard'`; `expectFor` returns `'deny'` for kiosk when a row does not name it; the two new rows: `{ area: 'Self check-in tablet', name: 'Search for one adult resident by name, room or exact ID', method: 'POST', path: () => '/api/kiosk/search', body: () => ({ q: 'an' }), expect: KIOSK }` and `{ …, name: 'Record my own daily check-in', method: 'POST', path: (fx) => '/api/kiosk/checkin', body: (fx) => ({ id: fx.residentId }), expect: KIOSK }` where `const KIOSK = { anon: 'unauth', kiosk: 'allow', guard: 'deny', supervisor: 'allow', admin: 'allow' }` (supervisors/admins may test it). The matrix driver in `test/api.test.js` (~3178–3311) needs a kiosk client: create `kiosk@hut.example` there (or reuse Task 1's) and add it to `clients`/`EMAILS`.

- [ ] **Step 1: Failing tests.** Kiosk client: `GET /api/residents` → 403 with the sentence; `GET /api/residents/:id/compliance` → 403; `GET /api/checkins` → 403; `GET /api/settings` → 403; `GET /api/session` → 200; `POST /api/kiosk/search {q:'a'}` → 400; `{q:'an'}` → 200 with ≤5 results and no `date_of_birth`/`id_number` keys; the 61st search in a loop → 429; `POST /api/kiosk/checkin {id}` → 200 and the register (`GET /api/checkins` as the guard) shows that resident presented today; guard `POST /api/kiosk/search` → 403; `DELETE /api/session` as kiosk → 200. Run: the permission matrix section fails until the driver knows the role.
- [ ] **Step 2: Implement** the gate, the router (thin: validation, rate limit, `withIdentity(userId, …)` calling the two functions, `translateDbError`), the mount, the matrix changes; `node tools/gen-permissions-doc.js`.
- [ ] **Step 3:** `PGBIN=… ./test/api.sh` green; `node tools/gen-permissions-doc.js --check`. Commit: `Kiosk: one gate, two routes, and a fifth column in the permission matrix`.

---

### Task 3: The tablet page and the landing

**Files:** create `public/kiosk.html`; modify `public/app-common.js` (landing after login), `public/index.html`, `public/checkin.html`, `public/admin.html` (redirect a kiosk session; the Staff role dropdown; the "self" mark), `public/checkin.html:417,429` (source marks).

- [ ] **Step 1: `public/kiosk.html`.** Same head shape as `checkin.html` (manifest, theme colour, `app-common.css`, `app-common.js`, one inline script). Body: the site name small at the top, one `<input id="q" type="search" autocomplete="off" autofocus placeholder="Your name, room or ID number">` large (font-size 24px on a tablet), a results area of big buttons (`<button class="kioskHit">Ana Silva<span>Room 12</span></button>` — the span only when `room_label` is set), and a confirmation panel: name at 40px, "Checked in — goodnight." plus a `That's not me` button for 10 s (a countdown ring or "(8)" text), after which the check-in POSTs; on success "Thank you", then the search clears after 3 s. If the resident is already `checked_in_today`, the button reads "Already checked in today" and does nothing. Debounce search 250 ms; never fetch below 2 chars; clear the results and the input after 30 s idle. Errors: toast the server sentence. No header nav, no counts, no links except a tiny "Staff" link to `/index.html` that just logs out (`DELETE /api/session`) and goes to the login. `#toast` element present (toast dismiss from batch A applies).
- [ ] **Step 2: Landing and redirects.** Where `app-common.js` sends a user after login / on load (the chooser at ~500): if `session.role === 'kiosk'` → `location.replace('/kiosk.html')`. In `index.html`, `checkin.html`, `admin.html` on session load: same redirect. `kiosk.html` on load: if not signed in → login page; if role ≠ kiosk → `/index.html` (a staff member who opens it by mistake).
- [ ] **Step 3: Admin.** Staff role `<select>` options gain `<option value="kiosk">Self check-in tablet</option>`; the card shows the role as "Self check-in tablet"; the weekly/safeguarding ticks are not offered for it (extend the `s.role === "guard"` conditions to `["guard","kiosk"].includes(s.role)`). The routes/staff.js pre-checks that say "A guard cannot receive…" should say "A guard or a self check-in tablet cannot receive…" (one-word change; the constraint from Task 1 is the guarantee).
- [ ] **Step 4: The mark.** `checkin.html:417/429`: `source === "door" ? " at In & out" : source === "kiosk" ? " at the tablet (self)" : ""`. Also wherever the register list shows a "door" indicator (grep `door` in checkin.html and admin.html), show a `self` variant.
- [ ] **Step 5:** `./check.sh` layer 1 (parse); if a browser is available, log in as the kiosk user against the test cluster and walk the flow; otherwise say so. Commit: `Kiosk page: search, confirm, check in — and every other page sends a kiosk login there`.

---

### Task 4: Docs

**Files:** `public/help.html` (a short section "Self check-in tablet" under Staff: what the role can and cannot do, how to set it up, Guided Access), `README.md` (roles list), `docs/KNOWN-ISSUES.md` §4 (a `t_*` tenant provisioned before 051 lacks the role value — creating a kiosk account there fails on the check constraint with a plain sentence, and `tenant_schema_gaps()` reports `kiosk_search`), `docs/GDPR.md` (one sentence: kiosk check-ins are recorded with source `kiosk` and the tablet account as the actor; the search returns names only).

- [ ] **Step 1:** Write them in the repo's voice. `./check.sh` full run green. Commit: `docs: the self check-in tablet`.

---

## Self-review

Spec → tasks: role/functions/constraints (T1); gate, routes, rate limit, matrix (T2); page, landing, redirects, role dropdown, mark (T3); docs and the tenant note (T4). Interfaces named consistently: `kiosk_search(text)`, `kiosk_checkin(uuid)`, `/api/kiosk/search`, `/api/kiosk/checkin`, role string `kiosk`, source `kiosk`. The adult test and the name-match operator are to be copied from existing code, not invented — both tasks say where.
