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
| 4 | `record_checkin()` does not clear `closed_at` when a late correction lands on an already-closed day | No reachable trigger found — close-out never closes today. Register *content* stays correct; only the timestamp would mislead |
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

### 17. `lib/` and `routes/` have no linter and no type checking

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
