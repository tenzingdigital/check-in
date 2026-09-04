# Known issues and follow-ups

Everything here was found during the build of the check-in app, reviewed, and
**deliberately** left as-is rather than overlooked. Each entry says why it was
carried and what would change if you fixed it.

Nothing in this list is a correctness defect in the statutory register. The bugs
that were, were fixed — see the design spec and the git history.

---

## Open decisions for the owner

### 1. There is no correction path

This is the most consequential item here.

The system has an **erasure** path (`erase_resident`) and an **annotation** path
(`annotate_compliance_day`), but nothing that can *correct* a recorded day.

That is right for `presented` — it is append-only evidence and must not be
rewritable. But `required` is a *derived fact about a resident's circumstances*,
and circumstances get corrected late. If a supervisor learns on Friday that a
resident moved out on Monday, the rows already written for Tuesday to Thursday
stay on the register as breaches. `close_out_compliance_days()` is idempotent and
never recomputes `required` on an existing row, so nothing repairs them.

Today the only remedy is a direct database correction by an admin.

**The decision:** whether to build a supervisor-facing correction RPC that may
rewrite `required` (never `presented`), recording each correction as an
annotation so the change is itself auditable. A regulator would plausibly expect
one to exist. It was out of scope for this plan.

Operational workaround until then: set `departed_on` **before** the next nightly
close-out. See the maintainer notes in `README.md`.

### 2. `compliance_retention_days` is still a placeholder

Default 2555 days (~7 years). It must be set to the real statutory period before
go-live. See the go-live checklist in `docs/GDPR.md`.

### 3. Attention-list ordering

`attention_list()` ranks a never-seen resident **above** an explained breach. The
reasoning is that an unknown outranks a human-triaged known, and reviewers agreed
it is defensible — but it is a judgement about what a guard should look at first,
and it is yours to overrule. Breach rows are exempt from the result cap either
way, so no explained breach can be pushed off the list.

---

## Carried technical items

| # | Item | Why carried |
|---|---|---|
| 1 | `app-common.css` keeps `.badge.due_soon/.overdue` and `.card.overdue/.due_soon` selectors, orphaned when the gate app's compliance UI was removed | Genuinely dead, zero behavioural risk. `checkin.html` redefines some same-named classes locally with identical values, so it is duplication, not conflict |
| 2 | The purge-cascades-annotations path is asserted from the FK definition, not exercised | The FK is `on delete cascade` and the identical mechanism is exercised for real by the erasure test |
| 3 | `tally` and `streak` in `v_resident_compliance` scan the whole register unbounded on every screen load | Fine at hut scale (~100 residents × 2555 days ≈ 255k rows), but the amplification is larger than it looks: a predicate cannot push into a grouped CTE, so even a single-resident refresh re-aggregates everything, and the header polls every 60s per terminal. **Bound both to a lookback window if the site grows** |
| 4 | A late check-in landing on an already-closed day flips `presented` but leaves `closed_at` as it was | **Now reachable**, through `record_checkin_late()` (migration 010): an event synced after the nightly close-out corrects the day's content and the day stays closed. That is the intended reading — `closed_at` says when close-out ran, not when the row last changed — and the event's own `late_entry` / `recorded_at` carry the provenance |
| 5 | `close_out_compliance_days()` resumes from the latest closed day **globally**, not per resident | A past day with zero rows is skipped forever. The realistic trigger is importing a resident with a backdated `registered_at` — see the "Data import" maintainer note in `README.md` |
| 6 | `seed.sql`'s comment above the `gate_events` insert still describes `due_soon`/`overdue` states | Demo-only file, one-line fix whenever convenient |
| 7 | `01_acceptance.sql` has a duplicate no-op `reset role;` and one test label using old "check event" prose | Cosmetic |
| 8 | `hut_summary()` is covered only by a non-negativity smoke assertion | Unchanged gate-app surface; the suite at least proves it executes under `authenticated` |
| 9 | `v_resident_status.is_adult` uses the **server** date while everything else uses `site_today()` | Divergent for up to a day in a far-offset timezone — but it has no consumer anywhere: no view, no function, neither front end. Dead output. Drop it, or route it through `site_today()` |
| 10 | ~~`index.html`'s Log tab filters by **browser** local day while compliance uses `local_timezone`~~ | **Fixed by the Render migration.** The range is now built server-side in `getGateLog()` from `app_settings.local_timezone`, so there is one definition of "today" |
| 11 | `02_compliance.sql` asserts one resident's attention rank is exactly `8` | Encodes the current seed roster; a change to `seed.sql` breaks a test whose real subject is "an explained breach ranks last but is still present". Prefer asserting against `count(*)` from the list |

---

## Introduced by the move from Supabase to Render

These did not exist while Supabase owned authentication and the HTTP API. They
are the price of that move, recorded honestly rather than buried in a commit
message.

### 12. Authentication is ours now

`lib/auth.js` is roughly two hundred lines standing where GoTrue used to be:
password verification, session issue and revocation, cookie flags, login
throttling. Every one of those is a well-understood problem with a
well-understood way to get it subtly wrong, and a subtle bug here is a breach
rather than a wrong number on a screen.

What holds the risk down, and what to preserve:

- **It is small, and it should stay small.** There is no sign-up, no password
  reset, no email confirmation, no OAuth, no MFA. Each of those is a flow with
  its own attack surface. Adding one is a decision, not a chore.
- **Sessions are opaque and server-side.** No JWT, so revocation is a `DELETE`
  rather than a denylist. Deactivating an account or changing a password ends
  every session in the same transaction.
- **`test/api.sh` asserts the properties, not the implementation** —
  revocation is immediate, tokens do not survive logout, unknown emails are
  indistinguishable from wrong passwords.

If this ever feels like more than it is worth, Option 3 in `docs/TECH-STACK.md`
(self-hosted Supabase) hands login back to GoTrue with `migrations/002_schema.sql`
unchanged.

### 13. The nightly schedule left the database

Under Supabase, `pg_cron` ran the maintenance functions from inside Postgres,
where the schedule was backed up with everything else and could not be deleted
by accident. It is now `hut-nightly`, a separate Render resource that somebody
can remove while tidying the dashboard.

The failure is silent and slow: `close_out_compliance_days()` stops writing
negative rows, so the register keeps recording who *did* attend and quietly
stops recording who did not. Nothing errors. The Attention tab simply empties.

Mitigations in place: the job runs all five functions and exits non-zero if any
fails, so a broken run shows red in Render. There is no alert on the job simply
*not existing*. **A monthly look at the job's run history is a real operational
requirement**, and it is on the go-live checklist in `docs/GDPR.md`.

### 14. Login throttling is per-instance and in memory

The eight-attempts-per-email-and-IP lockout in `lib/auth.js` lives in a `Map`.
It resets when the service restarts or redeploys, and it would not be shared if
the service were ever scaled to more than one instance.

Carried deliberately: the alternative is a write to Postgres on every failed
guess, which is exactly the amplification an online guessing attack wants.
bcrypt at cost 12 is what actually makes guessing expensive; the lockout is a
speed bump on top. If this service is ever scaled horizontally, move the
counter to the database or accept that the limit becomes per-instance.

### 15. A restart is needed after editing an inline `<script>`

The CSP lists a SHA-256 for each inline script block, computed at boot from the
files on disk — which is what lets it drop `'unsafe-inline'` entirely. Edit an
inline block without restarting and the browser refuses to run the app, with a
console error and a blank page.

This never bites in production (a deploy restarts the service) but it will bite
in local development. `check.sh` asserts the served CSP matches the served HTML,
so it cannot ship broken.

### 16. Nothing detects an edited migration

`database.js` records each applied migration by filename only — matching
`tenzingdigital/scheduler`, whose runner this one is deliberately shaped like.
Edit an applied file and the runner will not re-run it, so the change is not in
the database while the file looks as though it is.

An earlier version of this repo recorded a checksum per migration and warned at
boot on drift. It was removed to keep the two apps' tracking tables identical —
a divergence there is exactly the sort of thing that bites when you move
between the codebases. The property was worth having, so the fix is to add it
to **both** apps, not to re-diverge this one.

*Restored, 4 September 2026:* `schema_migrations.checksum` is back. Each
applied file's SHA-256 is recorded, and a file that later differs on disk is
warned about at every boot in capitals, with the instruction to write the
change as a new migration. The HTTP suite alters a recorded checksum and
asserts the warning fires.

### 17. The suites now run as a non-superuser — keep it that way

`test/cluster.sh` connects as `hutapp`, an ordinary role that owns the database,
because that is what Render gives you. It used to connect as `postgres`.

That difference is not cosmetic and it cost a broken production deploy. A
superuser may `SET ROLE` to any role and bypasses row-level security outright,
so the suites were passing against privileges production does not have —
`withIdentity()`'s `SET LOCAL ROLE authenticated` shipped failing with
"permission denied to set role" while every test here was green. The fix is
migrations/003_request_role_membership.sql; the reason it was reachable at all
is this line in the test harness.

**Do not change the suites back to a superuser connection**, and be suspicious
of any future fix that amounts to granting the app role more power rather than
making the test cluster look more like production. Verified the right way
round: removing 003 makes the HTTP suite fail with the exact production error.

### 18. The first password passes through an environment variable

`ADMIN_EMAIL` / `ADMIN_PASSWORD` create the first administrator on an empty
database, because `node staff.js add` needs a shell and Render's Shell tab is a
paid-plan feature — without this a free deploy comes up healthy and is
permanently unreachable.

The cost is that one password exists in the service's environment, visible to
anyone with access to the Render dashboard. Mitigated rather than solved: it is
never logged, it is only read when there are zero staff accounts, and the README
tells you to delete the variable after first login. Nothing enforces that
deletion, and nothing forces a password change on first use.

If this app ever holds more than one site, replace it with an invite flow.

### 19a. Offline queue: what it cannot survive

`public/offline.js` (see "Working offline" in `README.md`) keeps events
recorded during an outage as ciphertext whose key lives in `sessionStorage`.
Three consequences are accepted rather than solved:

- **A closed tab loses the key.** Anything queued becomes unreadable on that
  terminal and is shown as lost so it can be recorded from paper. The
  alternative — keeping the key next to the data — would make the encryption
  decorative.
- **A reload mid-outage trusts the last profile the tab saw.** A session
  revoked during the outage is not noticed until the link returns, at which
  point the queue is refused with a 401 and kept. The data on the device was
  already on the device; this does not widen it.
- **The terminal clock dates the event.** Bounded by
  `app_settings.late_entry_window_hours` and flagged, never silently trusted.

### 19c. The smallest database plan crashes under a burst of queries

On 4 September 2026 at 13:25 and again at 13:30 UTC the production Postgres
(`basic-256mb`) ran out of memory and crash-restarted, each time while a
phone was loading the register. Its memory sat at about 100 MB, then rose to
248 MB against a 256 MB limit as up to eight backends evaluated
`v_resident_compliance` at once; queries that take milliseconds on a laptop
took 12–18 seconds just to bind, then the instance died. Recovery is about
two minutes. This service then crashed as well (an unhandled `'error'` on a
checked-out client) and restarted, so guards saw 502s for the whole window.

Three things changed in code: the pool now defaults to four connections
rather than eight (`PGPOOL_MAX` to override), a checked-out client keeps an
error listener so a dropped connection fails one request instead of the
process, and the front end queues a tap that meets a 5xx the same way it
queues one with no link. Both suites cover the second; the third is in the
browser test.

Two things are for the dashboard, not the code: turn on failure
notifications for `hut-db` and `hut-check-in`, and budget for the next
database plan (1 GB) before a second centre is provisioned. A 256 MB
Postgres with half of it in shared buffers is a demo tier for this workload,
and carried item 3 above (the unbounded `tally` and `streak` scans in
`v_resident_compliance`) is the code-side change that would lower the
per-query cost if the plan cannot change.

### 19d. `v_resident_compliance` cost seconds on the live database — *found and fixed 4 September, evening*

Measured on 4 September 2026, healthy database, 200 residents: the list
query the register page makes on every load took **7.3 seconds** in the
database log, against 6 milliseconds on a laptop. The plan (`basic-256mb`:
a tenth of a CPU, 256 MB) was blamed first. It is a factor, but the cause was
found by reading `EXPLAIN (ANALYZE, BUFFERS)` to the bottom:

```
JIT:
  Timing: Generation 2.7 ms, Inlining 65 ms, Optimization 304 ms, Emission 226 ms, Total 598 ms
Execution Time: 691 ms
```

Postgres was **LLVM-compiling the query on every execution** — 600 ms of
the 691 on a laptop, and ten times that on a tenth of a CPU. It did so
because the planner costed a 200-row query at 85,000 rows: `app_settings`
has one row and had never been analysed (autovacuum's threshold is about 50
changed rows, which a one-row table never reaches), so the planner used its
default guess of ~300 rows for it, and every view cross-joins it. That
guess pushed the estimated cost over `jit_above_cost`.

Three fixes, all in the repo: `database.js` passes `-c jit=off` on every
connection (nothing here runs long enough for compiled code to pay for
itself, and the HTTP suite asserts the setting); migration 015 analyses the
small tables and `jobs.js` repeats it nightly; and the view itself was
rewritten in 015 from four passes over the whole register (one of them a
window function that needed a disk sort at Render's `work_mem`) into
per-resident index probes, with an index for the "last day presented"
lookup. On a year of history for 200 residents, at Render's `work_mem`, the
query fell from 691 ms to 84 ms locally with JIT off alone, and to 59 ms with
the rewritten view, with identical output row for row. The 1 GB plan is still the
right call for headroom (19c), but it is no longer what makes the register
slow.

The lesson for the next one: when a query is slow only in production, read
the whole plan, including the `JIT:` block at the end.

### 19e. What migration 012 changed about who is on the record

Administrators' changes to residents, profiles and settings are now in
`admin_audit`, with the row before and after; an export of a resident's
record is noted there with the reason given; every login attempt and its
outcome is in `auth.login_events` for 90 days (which makes the privacy notice
true); each nightly job leaves a `job_runs` row, and `v_system_health` turns
a late close-out into a red banner on every register terminal. A staff member
can no longer rename themselves. Erasure removes the audit rows that carried
the erased person's details.

Two things to know. The audit of a residents row includes the date of birth
before and after a change; it is admin-readable only, and dies with the
register retention. And `job_runs` is written by `jobs.js` on the owner
connection, so a cron job that never runs leaves no row — which is exactly
what `close_out_behind` detects from the register itself.

### 19b. New logins had no tenant until migration 011

009 backfilled every existing login into the default tenant and nothing
attached new ones, so every account created since — Staff tab, CLI,
first-admin bootstrap — had `tenant_id` null. Harmless today because nothing
resolves a tenant per request yet, and invisible to the suite because a
different test re-applied 009's backfill on every run. 011 adds a trigger that
fills a null `tenant_id` with the default tenant at insert. The signup path,
when it exists, must set `tenant_id` explicitly; the trigger fills only a
null.

### 19. `lib/` and `routes/` have no linter and no type checking

`check.sh` runs `node --check` on each file, which catches syntax errors and
nothing else. The suites cover behaviour, but a typo in a rarely-taken error
path — `err.staus` instead of `err.status` — would pass everything and fail at
3am. Worth adding `tsc --checkJs` with JSDoc types, or at least a linter,
across both apps together.

---

## A note on the test suite

Every expected value in `test/` is asserted via `pg_temp.expect()`
rather than printed. This is not ceremony — it caught six real defects during the
build, including two where a test *looked* like it was checking something and
could not fail:

- `pg_temp.try()` catches `when others`, so it reports a missing table
  identically to a row-level-security denial
- probes that ran against empty tables reported "no-op" whether or not a write
  policy existed
- a cap test whose fixture happened to fit inside the cap, so the guarantee it
  protected could be deleted with the suite staying green

If you add a test here, add an assertion, then **break it deliberately and watch
it fail** before trusting it.
