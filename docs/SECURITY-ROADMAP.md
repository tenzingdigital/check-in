# Security, privacy and resilience roadmap

What it would take to bring CheckSteady from "carefully built and honestly
documented" to a system whose operator could stand behind ISO 27001, plus the
two operational problems raised alongside that question: the centre's internet
is unreliable, and managing staff from a phone is awkward.

Reviewed against `main` at the tenant-template commit: `server.js`, `lib/`,
`routes/`, `migrations/001`–`009`, both front ends, `render.yaml`, the three
legal documents and the two test suites. Both suites are green (79 SQL and 57
HTTP assertions). Every finding names the file it comes from. Nothing here is a
correctness defect in the register.

**Plain-language note on ISO 27001.** It does not certify software. It
certifies an organisation's *management system*: the documented process by
which it identifies risks, chooses controls, checks they work, and improves
them. Annex A of the 2022 edition lists 93 controls in four groups:
organisational (5.x), people (6.x), physical (7.x) and technological (8.x). A
good half of what an auditor wants is paperwork and evidence, not code. So this
roadmap has two halves: **things to build** (phases 0–5) and **things to write
down and do** (phase 6). ISO 27701 is the privacy extension, and the DPA and
privacy notice already in `docs/legal/` are most of the way to what it asks.

**Why this matters more now than it did for one hut.** CheckSteady is becoming
a product sold to IPAS accommodation centres, whose residents are international
protection applicants, and whose TRC/IRP numbers can reveal immigration status.
`docs/legal/DPA-2026-09-03.md` says so itself. The DPA promises customers audit
rights, 48-hour breach notification, and a named list of technical measures.
Those promises are the reason to do the management-system half: a state-funded
centre's procurement will ask for evidence, and the DPA has already told them
what to ask for.

---

## Where it stands today

Unusually strong for its size, and worth saying plainly:

- Authorisation is row-level security in Postgres, proven by two suites that
  run as the same non-superuser role production uses (`test/cluster.sh`).
- Authentication is small and well-shaped: bcrypt at cost 12, opaque sessions
  stored as SHA-256, a `__Host-` HttpOnly cookie, SameSite plus an Origin
  check, a lockout, a dummy hash against timing attacks, single-use reset links.
- The register is append-only for every role. Erasure leaves a proof.
- The browser loads nothing from anyone else, and the CSP admits inline script
  by hash rather than `'unsafe-inline'` (`lib/security.js`).
- The database accepts no public connections (`render.yaml`, `ipAllowList: []`).
- Retention matches the IPAS policy (180 days) and is enforced by a job.
- `docs/KNOWN-ISSUES.md` items 12–19 already list the honest costs of owning
  authentication. Several items below simply turn those into work.

What was missing fell into five themes: **the documents have drifted from the
code**, **administrators are not audited**, **stronger identity** (MFA, an idle
lock, a persisted login log), **operational safety nets** (CI, monitoring,
backups you have tested), and **the things the DPA promises that the app does
not yet do**.

**Status, 4 September 2026.** Everything in this file that is code is built,
tested and deployed, except two items deliberately deferred: MFA (3.1) and
the multi-tenancy binding (F11), both of which are decisions with a cost
rather than gaps. The documents are written (`docs/GDPR.md`,
`docs/procedures/`). What remains is the owner's: the database plan, Render
notifications and PITR confirmation, branch protection, scheduling the
off-provider backup, the provider DPAs and transfer impact assessment, and
the blanks in the procedures. `docs/procedures/RISK-REGISTER.md` lists them
by owner.

---

## Findings

In rough order of how much they matter. Each reappears in a phase below.

### F1. The GDPR notes contradict the schema — `docs/GDPR.md` *(rewritten 4 September against migrations 001–014 and the DPA annexes)*

This is the document that feeds the ROPA and the DPIA, and it describes a
system that no longer exists. It says no ID document numbers are held;
migration `008` added `id_type` and `id_number`. It lists `room_ref`, `note`
and `compliance_annotations`; migration `006` dropped all three. It says the
register is kept 2555 days; it is 180. It says there is exactly one processor;
the DPA and privacy notice correctly list two, Render and Resend. It describes
`pg_cron`; the schedule is a Render cron job. An auditor reading this next to
the schema would stop trusting every other document. The legal documents are
correct; this one needs rewriting from Annex I and Annex II of the DPA.

### F2. The privacy notice promises logging the code does not do *(fixed 4 September: `auth.login_events`)* — `docs/legal/PRIVACY-2026-09-03.md`, `migrations/001_platform.sql`

The notice says login records include "from which IP address" and are "kept
for 90 days". `auth.sessions` has no IP column, sessions are deleted at expiry
by the nightly purge, and failed attempts live only in an in-memory `Map` in
`lib/auth.js` that vanishes on restart. So there is no login history at all,
let alone 90 days of it. Either the code gains a login log or the notice loses
the claim; a notice that overstates what is held is its own finding.

### F3. The DPA promises "one-click export" and "one-click erasure" — neither has a route *(fixed 4 September)*

`export_resident_record()` and `erase_resident()` exist in the database, but
`routes/` has no endpoint for either and neither front end has a button. Today
a subject-access request means someone with the external `DATABASE_URL`
running psql as the database owner, which bypasses every RLS policy. The DPA
section 7 claim is contractually made to customers. Build the two routes and an
admin-only "Export" and "Erase" action on the resident detail panel, with a
typed confirmation for erasure.

### F4. Residents cannot be added, edited or departed from the app *(fixed 4 September)*

`routes/residents.js` has one write: `PATCH` for the ID number. There is no
create, no edit of name or date of birth, no way to set `departed_on`. The
README's roles table says supervisors "add, edit and retire residents"; that is
an RLS permission with no user interface behind it. For an IPAS centre with
arrivals and departures every week, the only path is psql as the owner, which
is the privileged access ISO 8.2 exists to eliminate. This is also why
`departed_on` will be set late, which is exactly the false-breach scenario in
`docs/KNOWN-ISSUES.md` item 1.

### F5. Administrators' actions leave no trail *(fixed 4 September, migration 012)*

Guards' every tap is attributed and immutable. The people with power are not
logged at all: creating a staff account, changing a role, disabling an account,
resetting someone's password (`routes/staff.js`), changing a resident's TRC/IRP
number (`routes/residents.js`), and any future edit of thresholds or retention
in `app_settings`. Changing an ID number on a register that is returned weekly
to IPAS, with no record of who changed it from what, is the kind of gap a
regulator notices. ISO 8.15 and GDPR Art. 5(2).

### F6. No multi-factor authentication — *codes by email built 4 September (migration 021), on the working branch*

*Built:* supervisors and administrators at a site with *Codes by email at
login* switched on (Admin → Settings → Security) type a six-digit code
emailed to them after their password. Ten minutes, one use, five wrong
guesses end it; a personal device may be trusted for thirty days; a new
password forgets every trusted device. Guards keep password-only login.
The switch refuses to turn on while email is unconfigured, because a code
nobody can receive is a lockout. Authenticator-app codes remain the
stronger option and can be added behind the same switch.

Password only, for every role, including the administrator who can reset every
other password. `docs/KNOWN-ISSUES.md` item 12 lists MFA as a deliberate
non-feature, which was right for one hut. For a product holding immigration
identifiers across centres it is no longer defensible for the admin role.
Authentication is now this codebase's own, so this is real work, but TOTP
(authenticator-app codes) needs no dependency: HMAC-SHA1 and base32 are in
Node's `crypto`. The forgot-password machinery already provides the shape for
recovery codes.

### F6b. Nothing looks at where a login comes from — *built 5 September (migration 022), on the working branch*

*Built:* the country of every sign-in is recorded; senior roles from outside
the site's home countries (Ireland by default) are refused with the security
contact in the message; a guard abroad, or a never-seen device after recent
failures, must type the emailed code. A hard country block was rejected on
purpose: Irish mobile networks sometimes route through the UK, and the
attacker who has a phished password can rent an Irish exit for a euro. The
code is the control; the country is a signal.

### F7. A 12-hour session on a shared terminal has no idle lock — *fixed 4 September*

*Fixed:* `mountIdleLock()` in `public/app-common.js` ends the session
(`DELETE /api/session`, so the terminal holds no live session) after
`app_settings.idle_lock_minutes` without a touch, key or scroll (default 20,
editable under Settings, migration 014). The gate and register never lock
while the connection is down, because a guard could not log back in until it
returned and would lose the offline copy of the register. The admin page
locks unconditionally.

`HUT_SESSION_HOURS=12` is a shift, per Tao 11, and correct as an upper bound.
But a guard who walks away leaves the register open for the rest of the shift.
An idle lock in the front end (blank the screen after N minutes without a
touch, require the password to resume) is the ISO 7.7 clear-screen control, and
it needs no server change if it simply calls `DELETE /api/session`.

### F8. Nothing runs the tests but a person *(fixed 4 September: `.github/workflows/check.yml`; branch protection is the owner's switch)*

`check.sh` is thorough and nothing invokes it. There is no `.github/`, no
branch protection, no dependency audit. `npm audit` today reports three
moderate findings in `qs` and `body-parser` via Express 4.22, all with a fix
available. Annex II of the DPA tells customers that changes "pass an automated
test suite before deployment"; that is a manual step today.

### F9. The README claims migration checksums that were removed *(checksums restored 4 September)*

`README.md` "Changing the schema" says each applied file is checksummed and
drift warns at boot. `docs/KNOWN-ISSUES.md` item 16 says that was removed for
parity with the scheduler repo, and `database.js` confirms it. Beyond the doc
drift, the control is worth having back in both repos: an edited migration is
exactly the "half-known schema" Tao 17 refuses to serve.

### F10. The nightly job has no existence monitor — `jobs.js`, `render.yaml` *(banner and job_runs added 4 September; Render notifications still yours)*

Item 13 in the known issues is right that this is the biggest operational risk
the move introduced. A red run shows in Render, but a *deleted* cron job shows
nothing, and the register degrades silently. Two cheap fixes: turn on Render's
failure notifications for `hut-nightly`, and add a health view the check-in app
polls so a stale close-out is a red banner on every terminal.

### F11. Multi-tenancy is half wired, and the half that is missing is the isolation

*Update:* migration 011 closes one piece of this. Every login created after
migration 009 had no `tenant_id` at all, which the tenancy resolver refuses;
a trigger now assigns the default tenant when none is given.

`public.tenants`, `tenant/template.sql` and `lib/tenancy.js` exist and are
tested. But `database.js` `withIdentity()` does not yet set `search_path`, no
request resolves a tenant, `handle_new_user()` still inserts into
`public.profiles`, the Staff list joins `auth.users` with no tenant filter, and
password reset joins `public.profiles`. None of this is wrong today because
there is one tenant. It becomes the most serious risk in the system the day a
second centre is provisioned before the binding is finished. The roadmap needs
a gate: no second tenant until a negative test proves a user in `t_a` cannot
read, write, list or reset anything in `t_b`.

### F12. ID numbers travel in every list response *(fixed 4 September)* — `routes/residents.js`, migration `008`

Annex II says identity numbers are "displayed only on an individual's detail
view, never in lists". That is true of the *screen*. The `GET /api/residents`
response carries `id_type` and `id_number` for every row because
`v_resident_status` includes them, so any staff session can pull every number
in one request. Strip both from the list endpoint and return them only from
`/:id/compliance`. Searching by number can stay, since `search_key` already
holds it.

### F12b. The database plan is a demo tier — `render.yaml`, `basic-256mb`

Found the hard way on 4 September 2026: two out-of-memory crash-restarts of
the production Postgres in six minutes, each triggered by nothing more than
a phone loading the register, each a two-minute outage. `docs/KNOWN-ISSUES.md`
item 19c has the timeline. The code-side mitigations are in (a smaller pool,
a service that survives a dropped connection, a front end that queues on a
5xx); the plan itself is the fix. Budget the 1 GB plan, turn on failure
notifications for the database and the service, and treat the memory graph
as part of the monthly check in Phase 1.5. (ISO 8.6 capacity management,
8.16)

### F13. Backups are claimed, not tested *(scripts and procedure written and rehearsed 4 September; the daily off-provider run and the PITR check are the owner's)*

Annex II promises "managed daily backups with point-in-time recovery". Confirm
on the Render dashboard that the `basic-256mb` plan actually has PITR enabled
(it is a paid-tier feature; verify rather than assume). There is no
off-provider copy and nobody has restored one. The DPA's 35-day backup deletion
promise in section 9 also needs a written procedure behind it.

### F14. Small things

- *Done 4 September:* `style-src` is `'self'`; every `style=""` attribute is a
  class in `app-common.css`.
- *Done 4 September:* the brochure site sends the same header set from
  `render.yaml`.
- `password-reset` has a per-account resend gap but no per-IP limit; a flood of
  unknown addresses costs a database call each. Bound it like login.
- No linter or type check (`docs/KNOWN-ISSUES.md` item 19).
- HSTS `preload` only matters once there is a custom domain; add it then.
- The reset link is written to the log when mail is unconfigured. Documented,
  but configure Resend before the first non-owner account exists.

---

## Phase 0 — Quick wins (two or three days, all in the repo)

| # | Item | Fixes | Where |
|---|---|---|---|
| 0.1 | *Done.* Rewrite `docs/GDPR.md` from DPA Annex I and II: current fields, 180 days, two processors, Render cron. | F1 | `docs/GDPR.md` |
| 0.2 | Fix the README migration paragraph, or restore checksums (0.7). | F9 | `README.md` |
| 0.3 | *Done (branch protection is yours).* GitHub Actions: `postgresql-16` plus Node 22, run `npm test` and `npm audit --omit=dev --audit-level=high` on every push and pull request. Branch protection on `main` requiring it. | F8 | `.github/workflows/check.yml` |
| 0.4 | *Done (an override for `qs`).* `npm audit fix` for the three moderate findings; commit the lockfile. | F8 | `package-lock.json` |
| 0.5 | *Done.* Strip `id_type` and `id_number` from the list endpoint. Add an HTTP assertion that `/api/residents` never carries `id_number`, the same shape as the existing date-of-birth test. | F12 | `routes/residents.js`, `test/api.test.js` |
| 0.6 | Turn on Render failure notifications for `hut-nightly`. Dashboard setting, five minutes. | F10 | Render |
| 0.7 | *Done.* Restore the per-migration checksum with a loud warning at boot, in this repo and the scheduler together. | F9 | `database.js` |
| 0.8 | *Done.* Per-IP throttle on `POST /api/password-reset`, reusing the login lockout map. | F14 | `routes/password-reset.js` |
| 0.9 | *Done.* Move inline `style=""` attributes to the stylesheet, drop `'unsafe-inline'` from `style-src`, add the header set to the static site. | F14 | both HTML files, `lib/security.js`, `render.yaml` |

---

## Phase 1 — Audit trail and logging (one week)

**1.1 `admin_audit` table.** *Done, 4 September (migration 012).* Append-only, written by triggers on `profiles`,
`residents` and `app_settings`: who (`auth.uid()`), when, table, row id, old
row and new row as JSON. Admin-read-only via RLS; no update or delete policy
for anyone; purged on the compliance retention schedule. Include it in
`export_resident_record()` so a subject-access export shows every edit to that
person's record. About forty lines of SQL and five assertions. (ISO 8.15, 5.33)

**1.2 Persisted login log.** *Done, 4 September (`auth.login_events`, 90 days).* `auth.login_events` with outcome, email as typed,
IP, user agent, timestamp. One insert per attempt is cheap next to the 250 ms
bcrypt already spent, so the amplification worry in known issue 14 does not
apply. Retain 90 days, which makes the privacy notice true, and gives the
lockout a durable counter if the service is ever scaled. (ISO 8.15; fixes F2)

**1.3 Log disclosures.** *Done for the function (`note_disclosure`); the export route in 2.2 calls it.* The export route from Phase 2 writes a row saying who
exported whom, when, and a stated reason. An export is the single most
sensitive read in the system. (GDPR Art. 30, ISO 5.34)

**1.4 Freeze attribution.** *Half done: the self-rename policy is gone. Name snapshots on events are still open.* `profiles_update_self` in `migrations/002` still
lets any user change their own `full_name`, and every log view joins to
`profiles` for the name. No route exposes it today, so this is defence in
depth: restrict the policy to admins, and add `guard_name` snapshots to the
event tables so a rename can never rewrite history. (ISO 8.15)

**1.5 Health view.** *Done, 4 September (`v_system_health`, `job_runs`, banner on the register).* `v_system_health` exposing the latest closed compliance
day and the last successful run of each job (write a `job_runs` row from
`jobs.js`). The check-in app's 60-second summary refresh reads it and shows a
red banner when close-out is more than a day behind. (ISO 8.16; fixes F10)

---

## Phase 2 — The missing administration (two weeks)

This phase is where "adding staff on mobile isn't great" gets fixed, and where
the DPA's promises become true.

**2.1 Resident management.** *Done, 4 September:* `POST /api/residents`,
`GET /api/residents/:id/record`, and `PATCH` extended to name, date of birth,
ID and departure, all under the existing `residents_supervisor` policy so the
database still decides. The Residents tab on `public/admin.html`: add, edit,
mark departed with a last day on site, reactivate. Date of birth is entered
once and shown only in the edit sheet. Covered by five HTTP assertions and
the browser test. (fixes F4)

**2.2 Export and erase.** *Done, 4 September.* `GET /api/residents/:id/export` returning the JSON,
and `DELETE /api/residents/:id` taking a reason and requiring the resident's
full name typed back. Admin only, enforced by the functions themselves. Two
buttons on the detail panel, visible to admins. (fixes F3)

**2.3 Staff management that works on a phone.** *Done, 4 September (migration 013): invite by email, no typed passwords, "Send login link" replaces "Reset password".* Previously: the Staff
tab has moved out of the gate app to `public/admin.html`, where the form is
labelled and stacks on a phone and the card actions get a row of their own.
Still to do is the part that removes typing passwords for other people:

- **Invite by email, no initial password.** `admin_create_staff()` already
  creates the account; drop the password parameter and let `auth.create_user()`
  leave the unguessable default hash. Then call the existing
  `auth.create_password_reset()` and send the existing reset email with the
  subject changed to "Set up your CheckSteady account". The admin types a name,
  an email and a role, and nothing else. The link is single-use and expires in
  an hour; the same "Send a new link" button replaces "Reset password".
- **Stack the layout under 480 px.** One media query in `app-common.css`: the
  staff form and card actions become full-width rows. Replace `prompt()` with
  the bottom-sheet pattern the check-in app already uses for the detail panel.
- **Force a password change** on first login for any account still on the
  default hash, once the invite path exists. This also closes known issue 18
  for the first administrator.

Effort: a day for the invite flow including two HTTP assertions, a day for
the layout. It removes the last reason for an administrator to type a password
on behalf of someone else.

**2.4 Settings screen.** *Done, 4 September.* Admin-only: site name, timezone, due-soon hour, the
three IPAS thresholds, retention. Each change logged by 1.1. Today these are
"a centre can match its own rules" only via psql.

---

## Phase 3 — Identity (two weeks)

**3.1 TOTP for supervisor and admin.** Enrolment shows a QR code; the secret is
stored encrypted with a key from the environment; verification allows a
30-second window either side; eight recovery codes stored as bcrypt. Enforce
it in the database, the same way everything else is enforced: `auth.sessions`
gains an `mfa_passed_at` column, `withIdentity()` sets a second GUC from it,
and `is_supervisor()` and `is_admin()` require it. Guards keep password-only
login for the 3 am shift. Add assertions: a supervisor session without MFA
sees zero rows of `residents`. (ISO 8.5, 8.2; fixes F6)

**3.2 Idle lock.** After N minutes without a pointer event, hide the register
and require the password to continue. N is a row in `app_settings` (default
10 for the gate, 30 for the register). Logging out server-side on lock keeps
the guarantee that a locked terminal holds no live session. (ISO 7.7, 8.1;
fixes F7)

**3.3 Passwords.** Twelve characters is enforced. Add a check against a
breached-password list at set time (the k-anonymity range API from Have I Been
Pwned sends five hash characters and receives no personal data, so it is not a
new processor in the GDPR sense, but record the reasoning). Write the policy
down; the auditor asks for the document, not the code. (ISO 5.17)

**3.4 Accounts that hold everything.** The Render, GitHub and Resend accounts
are the real crown jewels. MFA on all three, a named list of who holds access,
reviewed quarterly, and the external `DATABASE_URL` rotated when anyone leaves
that list. `docs/GDPR.md` already asks for the list; make it a document with
dates. (ISO 5.18, 8.2)

---

## Phase 4 — Resilience: the unstable internet (two to three weeks, staged)

**Status: stages A, B, C, D and E are built** (`public/sw.js`, `public/offline.js`,
`routes/sync.js`, `migrations/010_offline_sync.sql`; "Working offline" in
`README.md` states the limits; `docs/procedures/PAPER-FALLBACK.md` is stage
D, still to be rehearsed at the centre). Stage F, the router, is a purchase. The late-entry function
is open to any staff member for their own offline queue, bounded by the
window; a supervisor-only paper-entry path with a stated reason can reuse it.

Each stage is safe on its own. Do them in order.

**Stage A — make failure visible (two days).** The API client already says
"Cannot reach the server" (`public/app-common.js`). Add a header indicator
driven by `navigator.onLine` plus a lightweight `/healthz` ping every 30
seconds, and give every write button three states: recording, recorded, failed.
The 60-second dedupe in `record_check()` and the day-scoped dedupe in
`record_checkin()` already make a retry safe, so the failure toast should say
"tap again when the light is green".

**Stage B — cache the app shell (one day).** A service worker that caches the
two HTML pages, the CSS and the JS, and nothing else. No resident data touches
it, so no privacy surface. The CSP already allows `'self'` scripts. On a dead
link the app then opens and shows the red indicator instead of a browser error
page.

**Stage C — a supported late-entry path (one week, and a design decision).**
This is the piece everything else depends on, and it is also the answer to
`docs/KNOWN-ISSUES.md` item 1. `record_checkin()` deliberately takes no
timestamp, so a check-in from a paper sheet re-entered after midnight lands on
the wrong day and manufactures a breach. Add `record_checkin_late(resident,
occurred_at, reason)`:

- Supervisor only, MFA required once 3.1 exists.
- `occurred_at` in the past and inside a window from `app_settings` (48 hours).
- Writes the `checkin_events` row with the supplied time and a `late_entry`
  flag plus the reason, and lets the existing day logic place it correctly.
- Rewrites `daily_compliance.presented` for that one day only, never
  `required`, and logs the change through 1.1.

It never edits an existing event, so Tao 1 survives, and the flag means an
auditor can always separate "recorded live" from "recorded later from paper".
Assertions: the window, the flag, day placement, and that a guard cannot call it.

**Stage D — the paper fallback (one day, a document).** When the indicator is
red for more than a few minutes: the printed sheet, with name, TRC/IRP number,
time and staff initials. When the link returns, a supervisor enters the sheet
through Stage C before the nightly close-out, or next morning inside the
window. This is ISO 5.30, and the auditor wants it written and rehearsed.

**Stage E — an offline queue (optional, last).** Only after A–D. The browser
records check-ins locally and replays them through Stage C when the link
returns. The README's warning stands: encrypt the queue with a key derived from
the session, clear it on logout, cap it at a few hours, and note that the
12-hour session must still be live when it flushes. Honest assessment: for one
centre, Stage F removes most of the need for this.

**Stage F — fix the network (operational, do it first).** A dual-WAN router
with a 4G or 5G SIM as automatic failover, plus a small UPS for the router and
the terminal. A few hundred euro, no code, and it fixes everything at the
centre, not just this app. (ISO 8.14, 7.11)

---

## Phase 5 — Backup, recovery, continuity (a few days, then quarterly)

- **Confirm PITR** is actually enabled on `hut-db` in the Render dashboard, so
  Annex II stays true. (fixes F13)
- **Off-provider copy.** *Script done:* `tools/backup.sh`, an `age`-encrypted
  `pg_dump` kept 35 days. Scheduling it on a machine in the EU that you
  control is yours; `docs/procedures/BACKUP-AND-RESTORE.md` says how.
- **Restore rehearsal.** *Script done:* `tools/restore-rehearsal.sh` restores
  into a throwaway cluster, counts what came back and boots the service
  against it. Rehearsed 4 September against a seeded database; quarterly
  against a live backup from here, recorded in the procedure. (ISO 8.13)
- **Recovery targets.** *Written* in `BACKUP-AND-RESTORE.md`: up to a day of
  events (filled from the paper sheet), about an hour to restore.
- **Tenancy gate.** Before the second tenant: `withIdentity()` sets
  `search_path` per request, the Staff list and password reset are
  tenant-scoped, `handle_new_user()` routes to the tenant schema, and a
  negative test in `test/api.test.js` proves a `t_a` admin cannot read, list,
  write, export or erase anything in `t_b`. `docs/MULTI-TENANCY.md` already
  describes each of these. (ISO 8.3; fixes F11)

---

## Phase 6 — The management system (the certification half)

None of this is code. All of it is what an auditor reads. For an operation this
size most documents are one to three pages, and several already exist in
`docs/legal/`.

| Document or activity | ISO 27001:2022 | Notes |
|---|---|---|
| Information security policy, signed by the owner | 5.1 | One page: what is protected, who owns it, review cadence |
| Scope statement | Clause 4.3 | "CheckSteady, hosted on Render Frankfurt, for customer centres" |
| Asset and information inventory | 5.9 | DPA Annex I plus the accounts, the repo, the domains |
| Risk assessment and register | Clause 6.1 | *Done:* `docs/procedures/RISK-REGISTER.md`, twenty rows with owners |
| Statement of Applicability | Clause 6.1.3 | The 93 controls, each marked applicable or not with a reason. The mapping below is the draft |
| Access control policy and roles | 5.15, 5.16 | The roles table in `README.md`, plus who may hold admin and why |
| Joiner, mover, leaver procedure | 5.18, 6.5 | *Done:* `docs/procedures/ACCESS-JOINER-MOVER-LEAVER.md`, with the quarterly review table |
| Quarterly access review | 5.18 | The Staff tab list, signed by the centre manager; the Render/GitHub/Resend list, signed by you |
| Supplier register with signed DPAs | 5.19–5.22 | Render and Resend DPAs and SCCs on file, plus a transfer impact assessment. `docs/legal/README.md` already lists this as outstanding |
| DPIA template for customers | 5.34, ISO 27701 | The DPA promises one. Draft it once from Annex I and II; every centre reuses it |
| Incident response procedure | 5.24–5.28 | *Done:* `docs/procedures/INCIDENT-RESPONSE.md`; the contact names are blank until you fill them |
| Business continuity and the paper fallback | 5.29, 5.30 | *Done:* `docs/procedures/PAPER-FALLBACK.md`; rehearse it once at the centre |
| Operating procedures | 5.37 | Setup and the nightly-job check are in `README.md`; restore in `docs/procedures/BACKUP-AND-RESTORE.md`; tenant provisioning in `docs/MULTI-TENANCY.md` |
| Staff briefing for customers | 6.3 | A one-page handout: shared terminal rules, what to do offline, who to call |
| Physical: terminal siting, screen lock | 7.7, 7.8, 8.1 | Kiosk mode on the terminal, OS auto-lock, screen angled away from the door |
| Clock synchronisation | 8.17 | The server stamps every event; record that this is already satisfied |
| Secure development | 8.25–8.29 | Already largely true: state the review rule from `docs/TAO.md`, the test discipline from `docs/KNOWN-ISSUES.md`, and Phase 0's CI |
| Internal audit and management review | Clauses 9.2, 9.3 | Once a year, someone not involved in the build checks the above against reality |

**A decision to record, not a finding.** `docs/TECH-STACK.md` says EU-owned
hosting becomes worth its cost when "the residents are a vulnerable population"
or the site is public-sector. Both are now true. The current position, EU-hosted
on a US provider with SCCs and a transfer impact assessment, is the normal
defensible bar. But the DPIA needs to say why that bar was chosen over Option 3
(Hetzner), in one paragraph, so the decision is visibly made rather than
defaulted into.

**On certification itself.** For one hut it was overkill. For a product sold to
centres funded by the state, ISO 27001 becomes a sales asset, and the DPA's
audit clause means customers may ask for the evidence anyway. The realistic
path is "ISO-aligned first": everything in the table exists and is followed,
so any procurement questionnaire or regulator has answers on paper. Certify
when a customer contract requires it; the same documents are the submission.

---

## ISO 27001:2022 Annex A mapping

Controls not listed are either already met (8.3 access restriction, 8.10
deletion, 8.11 masking via the views, 8.24 hashing of every stored secret) or
not applicable at this size; the Statement of Applicability records which.

| Control | Title | Items |
|---|---|---|
| 5.1, 5.37 | Policies, operating procedures | Phase 6 |
| 5.9 | Inventory | Phase 6 |
| 5.15, 5.16, 5.18 | Access control, identity, access rights | 2.3, 3.4, Phase 6 reviews |
| 5.17 | Authentication information | 3.3 |
| 5.19–5.22 | Suppliers | Phase 6 supplier register |
| 5.24–5.28 | Incident management | 1.2, Phase 6 procedure |
| 5.29, 5.30 | Continuity | Phase 4 D and F, Phase 5 |
| 5.33 | Protection of records | 1.1, 1.4, Phase 5 |
| 5.34 | Privacy and PII | 0.1, 1.3, 2.2, 0.5 |
| 6.3, 6.5 | Awareness, termination | Phase 6 briefing, leaver procedure |
| 7.7, 7.8, 7.11 | Clear screen, siting, utilities | 3.2, Phase 6 physical, Phase 4 F |
| 8.1 | Endpoint devices | 3.2, kiosk mode |
| 8.2 | Privileged access | 2.1, 2.2, 2.4 (no more psql for routine work), 3.1 |
| 8.5 | Secure authentication | 3.1, 3.2, 3.3 |
| 8.8 | Vulnerability management | 0.3, 0.4 |
| 8.13, 8.14 | Backup, redundancy | Phase 5, Phase 4 F |
| 8.15, 8.16 | Logging, monitoring | 1.1, 1.2, 1.3, 1.5, 0.6 |
| 8.25, 8.28, 8.29 | Secure development, coding, testing | 0.3, the existing suites |
| 8.31, 8.32 | Environments, change management | 0.3 branch protection, a staging deploy |

---

## What not to do

- **Do not add photos, PINs or biometrics.** Tao 8 is right. The TRC/IRP
  number is the one identifier the weekly return requires, and it is enough.
- **Do not build the offline queue before the late-entry path and the paper
  procedure.** A queue that replays through `record_checkin()` puts events on
  the wrong day.
- **Do not provision a second tenant before the tenancy gate passes.** One
  missing `search_path` is another centre's residents on screen.
- **Do not weaken the `SECURITY DEFINER` functions** by adding a `guard_id` or
  `occurred_at` parameter to the existing RPCs. The late-entry function is
  separate, flagged and supervisor-only for that reason.
- **Do not keep documents that describe a previous version.** Every finding in
  F1, F2 and F9 is a document that was true once. Rewrite or delete.

---

## Suggested order

1. Phase 0 this week, one pull request, suite green, CI running on it.
2. Order the failover router (Phase 4 F). No code.
3. Phase 2, because it is what centre staff will notice, and it retires psql
   from daily use.
4. Phase 1 alongside it: the audit table is small and Phase 2's routes should
   write to it from day one.
5. Phase 3, then Phase 4 stages A–D, then Phase 5.
6. Phase 6 in parallel throughout, one document a week, starting with the risk
   register because every other document cites it.
7. The tenancy gate before any second customer, whatever else is unfinished.
