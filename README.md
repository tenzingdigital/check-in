# Hut Check-In

## Where this runs

Keep this block current. It is the answer to "what is this deployed on again?",
and it is deliberately the first thing in the file.

| | |
|---|---|
| **Everything** | **Render**, region **Frankfurt** — one blueprint, `render.yaml` |
| **Web service** | `hut-check-in` — Node 22, serves `public/` and `/api` |
| **Database** | `hut-db` — Render Postgres 16 |
| **Nightly cron** | `hut-nightly` — the maintenance `pg_cron` used to run |
| **Live URL** | _fill in_ |

One vendor, one region, one bill. There is no Supabase project and no separate
static host: the same Node service that serves the two HTML files also serves
the API they call, which is why the session cookie is a first-party cookie and
why there is no CORS configuration anywhere in this repo.

**Only `public/` is served.** This is now enforced in code — `resolveStatic()`
in `server/index.js` refuses any path that escapes that directory — rather than
by a host's publish-directory setting. `docs/KNOWN-ISSUES.md` (a list of every
known weakness in this system), the schema and the RLS policies all sit outside
it and are unreachable over HTTP. The HTTP suite asserts this.

If you are ever unsure which of your deployments this is: it serves
`/index.html` (gate app) and `/checkin.html` (daily register), and has **no
`/login` route** — login is a section inside the gate app, so the server 404s
on that path.

Run `./check.sh` before every deploy. It parses every front end and server
file, then runs both suites: the database's authorisation model and the HTTP
tier in front of it.

---

Two front ends, one API, one Postgres database, one resident register.

**`index.html` — the gate app.** Who is on site right now. A guard logs in,
searches a registered resident by name, verifies the person visually, and taps
one button to sign them in or out. Two tabs: Search and Log.

**`checkin.html` — the check-in app.** The statutory daily register: did this
resident present at the hut today? Two tabs: Check in and Attention. A gate
sign-in/out is a different act from a check-in and does not satisfy the daily
requirement — see "Compliance is per calendar day" below.

Every event, at either app, is timestamped and attributed to the guard who
recorded it. Both apps share `app-common.css` and `app-common.js`, loaded as
plain `<script>`/`<link>` tags — still no build step, no framework, and now no
CDN either.

```
public/                 the ONLY directory served publicly
  index.html            the gate app — Search and Log
  checkin.html          the check-in app — Check in and Attention
  app-common.css        styles shared by both front ends
  app-common.js         the API client and helpers shared by both
server/                 the web service (Node 22, one dependency: pg)
  index.js              http server: static files, /api routing, security headers
  db.js                 the pool, and the transaction that binds a request to RLS
  auth.js               passwords, sessions, cookies, login throttling
  routes.js             the endpoints — thin wrappers over the views and RPCs
  staff.js              account administration CLI (add / passwd / disable)
  migrate.js            applies db/platform.sql then db/schema.sql
  jobs.js               nightly maintenance, run by the Render cron job
  test.js               the HTTP suite
render.yaml             the blueprint: web service + Postgres + cron, all Frankfurt
check.sh                one command: parse everything, then both suites
db/platform.sql         auth.users, auth.sessions, auth.uid(), the request roles
db/schema.sql           tables, views, RPCs, row-level security, GDPR functions
db/seed.sql             optional demo data (test databases only)
db/tests/               throwaway-Postgres suites (authorisation, compliance, HTTP)
docs/GDPR.md            what personal data is held, why, and for how long
docs/TECH-STACK.md      stack options, costs, and why this one
```

---

## How it works

**No PINs, no cards, no biometrics.** Identity is established by the guard
looking at the person, which is the control that already exists at a hut. The
app's job is to record that the check happened, when, and who performed it.

**Two append-only event logs.** `gate_events` (kind `in`/`out`) is site entry
and exit, written by the gate app. `checkin_events` is a deliberate
presentation at the hut, written by the check-in app. They answer different
questions and are never merged: leaving the site is not the same act as being
seen and recorded for the day.

**Corrections are new events, not edits.** No role has UPDATE or DELETE on
either ledger. If a guard signs in the wrong person, the fix is another event.
Rows leave the tables only through the retention purge or a GDPR erasure
request.

### Compliance is per calendar day, not a rolling window

A resident satisfies the daily requirement with **at least one check-in
between midnight and midnight in `app_settings.local_timezone`**. There is no
rolling `last_in_at + 24h` deadline — that was the original design, and it was
removed because it produced false breaches: someone presenting at 09:00 Monday
and 10:00 Tuesday is fully compliant (they attended both days) but a rolling
24-hour clock marks them overdue.

The daily result is written to `daily_compliance`, one row per resident per
day, written twice: positively by `record_checkin()` in the same transaction
as the check-in event, and negatively by the nightly `close_out_compliance_days()`,
which closes the day and backfills any day it missed. That asymmetry is
deliberate — if the nightly job never runs, the register still proves who did
attend; it just temporarily lacks rows for who didn't. See "Setup" for why
scheduling that job is not optional.

**Today (the day is still open):**

| State | Meaning |
|---|---|
| `seen_today` | A check-in has been recorded today |
| `expected` | None yet, before `due_soon_after_hour` — normal |
| `due_today` | None yet, past `due_soon_after_hour` — nudge |
| `exempt` | Under 18, or not currently active |

**History (closed days):**

| State | Meaning |
|---|---|
| `breach_open` | Missed, unexplained |
| `breach_noted` | Missed, with a reason attached |
| `not_required` | The rule did not apply that day (under 18, or outside registered/departed dates) |
| `never` | On the register, never once seen |

Staff may attach a reason to a missed day with `annotate_compliance_day()`,
but the reason never flips the outcome — a `breach_noted` day still counts as a
breach and still appears in the attention list. Annotation only demotes a row
in the attention list's ordering and greys it in the UI; it never removes it.
**Consecutive missed days, not the total, is the headline number** — three
days running is a different kind of problem than three scattered Tuesdays over
six months.

`due_soon_after_hour` and the adult age (`adult_age_years`) are rows in
`app_settings`, not constants in the code, so a supervisor can change them
without a redeploy.

Age is computed from date of birth as of the day being evaluated (never as of
today), so a resident becomes subject to the rule automatically on their 18th
birthday, and backfilling history does not retroactively apply the duty to
days when they were legally a minor. This is the reason the register stores a
full date of birth rather than a boolean — see `docs/GDPR.md` for the
necessity argument.

The **Attention** tab in the check-in app is the flow itself: unexplained
breaches first (worst consecutive-run first), then noted breaches greyed out,
then residents not yet seen today past the cutoff. What the hut does about a
breach — call, escalate, welfare check — is a procedure, not a feature; the
app tells you who and for how long.

### Roles

| Role | Can do |
|---|---|
| `guard` | Search residents, sign in/out (gate app), record check-ins and annotate missed days (check-in app), read the logs and the register |
| `supervisor` | Also add, edit and retire residents, set `departed_on` |
| `admin` | Also manage staff, change settings, run GDPR export and erasure |

A guard never holds read access to the `residents` table, because that table
carries dates of birth. Guards read `v_resident_status` and
`v_resident_compliance`, which expose age and an adult flag but no date of
birth. The acceptance suite asserts this.

---

## Setup

Everything below is one Render blueprint plus two commands. There is no second
vendor to sign up for and no keys to copy between dashboards.

### 1. Create the services

Render dashboard → **New → Blueprint** → point at this repo. `render.yaml`
creates all three resources in Frankfurt:

| Resource | What it is |
|---|---|
| `hut-db` | Postgres 16. The register. |
| `hut-check-in` | The Node web service — serves `public/` and `/api`. |
| `hut-nightly` | The cron job that runs the maintenance functions. |

`DATABASE_URL` is wired from the database into both services by the blueprint;
you never paste a connection string anywhere.

**Pick the region before you create anything.** Frankfurt keeps the resident
data in the EU, which is the whole transfer analysis in `docs/GDPR.md`, and
Render cannot move a database between regions after the fact.

**Do not run this on the free tier.** A free Render Postgres is *deleted* after
30 days — not paused, deleted — and this database is a statutory audit trail.
A free web service also spins down after 15 minutes idle and takes the best
part of a minute to wake, which at 3am reads as "the system is broken". The
blueprint asks for `basic-256mb` and `starter`, about $14/month together. See
`docs/TECH-STACK.md`.

### 2. Apply the schema

The blueprint runs `node migrate.js` as a pre-deploy command, so the first
deploy applies both SQL files for you. To do it by hand — from a machine that
can reach the database, using the **external** connection string from the
Render dashboard:

```bash
cd server && npm install
DATABASE_URL="postgres://…render.com/hut?sslmode=require" node migrate.js
```

**`?sslmode=require` matters on the external URL** and must be absent on the
internal one. Render's external endpoint requires TLS; the internal one does
not offer it, and forcing TLS there fails to connect. The service reads the
mode from the connection string rather than guessing from the hostname, so
whichever URL you paste, say what it needs.

That applies `db/platform.sql` (the identity layer: `auth.users`,
`auth.sessions`, `auth.uid()`, the `anon`/`authenticated` roles) and then
`db/schema.sql` (the app: tables, views, RPCs, RLS). Order matters — the second
references the first. Both are re-runnable.

One caveat carried over from before: `residents.search_key` is a generated
column, so changing how names are normalised needs a migration rather than a
re-run.

### 3. Create staff accounts

There is no sign-up route, no invite email and no public registration form —
by construction, not by configuration. (Under Supabase this was step 3 of
setup, "remember to disable public sign-up"; the endpoint that had to be
disabled does not exist here.) Accounts are made by an administrator:

```bash
node server/staff.js add gina@hut.example "Gina Guard" admin
node server/staff.js list
```

Run it from Render → your service → **Shell**, where `DATABASE_URL` is already
set. It prompts for the password rather than taking it as an argument, so the
password never lands in shell history or Render's command log. Minimum twelve
characters; stored as bcrypt at cost 12.

Valid roles are `guard`, `supervisor`, `admin`; omitting it gives `guard`.
**Make at least one `admin`.** The `profiles` row is created automatically by
the same trigger that fired on Supabase.

To revoke access:

```bash
node server/staff.js disable gina@hut.example
```

That sets `profiles.active = false` **and** deletes their sessions, so access
ends immediately rather than at the next login. Deleting the account outright
is blocked by design: `gate_events.guard_id` and `checkin_events.guard_id` are
`ON DELETE RESTRICT`, so the database refuses to erase the identity behind a
historical audit trail. `node server/staff.js passwd <email>` changes a
password and, in the same transaction, ends every session that account has
open.

### 4. Check the nightly job is running

Four maintenance functions used to be scheduled with `pg_cron` inside Supabase.
Render's managed Postgres has no `pg_cron`, so the blueprint creates a cron
job — `hut-nightly` — that runs `node server/jobs.js` at 00:30 UTC:

- **`close-out-compliance-days`** — closes each day and writes the *negative*
  register rows for residents who were never seen. **This one is not
  optional.** If it never runs, `daily_compliance` only ever gains rows from
  `record_checkin()` — the positive path — so nobody is ever recorded as
  having missed a day, and the register silently stops proving compliance at
  all.
- **`purge-expired-gate-events`** and **`purge-expired-checkin-events`** —
  delete movement rows older than `app_settings.event_retention_days` (default
  90). Without these, movement history accumulates forever, a
  storage-limitation problem under GDPR Art. 5(1)(e).
- **`purge-expired-compliance`** — deletes `daily_compliance` rows older than
  `app_settings.compliance_retention_days` (default 2555 days, a placeholder —
  see `docs/GDPR.md`).
- **`purge-expired-sessions`** — new here, because sessions are ours now.

Confirm it by looking at the job's last run in the Render dashboard. The runner
exits non-zero if any function failed, which is the only way anyone finds out a
maintenance job has been failing quietly. If the site timezone is far from UTC,
move the schedule so it runs after local midnight; running early only defers
rows to the next run, and the function backfills any day it missed.

**Losing the scheduler is the single biggest operational risk this migration
introduced.** Inside Supabase the schedule lived in the database and survived
everything; here it is a separate Render resource that somebody can delete
while tidying up, and the register would degrade silently.

### 5. Point the front ends at the API

Nothing to do. The apps call `/api` on their own origin, served by the same
service. There is no URL to configure, no key to paste, and no `config.js` —
all three are gone.

### 6. Running it locally

```bash
# a local Postgres, or point at anything you do not mind rewriting
createdb hut
cd server && npm install
export DATABASE_URL="postgresql:///hut"
node migrate.js
node staff.js add you@example.com "Your Name" admin
HUT_ALLOW_INSECURE_COOKIE=1 node index.js      # http://localhost:3000
```

`HUT_ALLOW_INSECURE_COOKIE=1` is only for `http://localhost`. The session
cookie is normally `Secure` and carries the `__Host-` prefix, which browsers
refuse to store over plain http, so without it you can never log in locally.
**Never set it on Render** — Render terminates TLS, so production is always
https.

One local-only trap: the CSP hashes every inline `<script>` at boot, so if you
edit the JavaScript inside `index.html` or `checkin.html` while the server is
running, the browser refuses to run the page until you restart it. A blank page
with a CSP error in the console is almost always this.

### 7. Restrict who can reach it

The login page is on the public internet. Render supports IP allowlists on
paid instance types; use one if the hut has a fixed address. Failing that, the
controls that are already on are: bcrypt at cost 12, an eight-attempt lockout
per email and IP, and 12-hour sessions.


## Verifying the security model

```bash
./db/tests/run.sh     # the database: authorisation and compliance
./db/tests/api.sh     # the web tier in front of it
./check.sh            # both, plus a parse of everything
```

`run.sh` starts a throwaway PostgreSQL cluster, applies `db/platform.sql` and
`db/schema.sql`, and runs two suites: `01_acceptance.sql` (the authorisation
model) and `02_compliance.sql` (calendar-day semantics, close-out, retention,
GDPR). Both exit non-zero if any assertion fails.

Note what changed when the app left Supabase: the suite used to apply a
thirty-line *stub* of the Supabase objects the schema depends on. That stub is
now `db/platform.sql` — the real file, the one Render applies. The suite is no
longer testing an approximation of production, it is testing production.

`api.sh` builds the same cluster, boots the service against it, and drives it
over HTTP the way a browser does. That suite exists because replacing PostgREST
and GoTrue with four hundred lines of our own is the largest new risk in this
system, and the risk is not "does the database refuse things" — the SQL suite
already answers that — but "does the web tier in front of it offer a way
around". It asserts that `withIdentity()` really does reach `auth.uid()`, that
one guard's identity cannot leak into the next request through a pooled
connection, that no endpoint answers without a session, that deactivating an
account or changing a password ends existing sessions immediately, that nothing
outside `public/` is reachable, and that the security headers and the CSP
script hashes are actually sent.

It exists because RLS fails *quietly*, and compliance math fails *plausibly*.
A policy that blocks too much returns zero rows instead of an error; a policy
that blocks too little returns data nobody notices; a calendar-day bug still
prints a state, just the wrong one. Neither kind of failure is visible from
the browser. The suite checks, among other things, that a guard cannot read a
date of birth, cannot edit or delete a past event, cannot attribute an event
to another guard, cannot promote themselves, that a suspended account and a
logged-out caller can do nothing at all, and that a resident who checks in
every day never drifts into breach regardless of what time they arrive.

Every expected value is asserted with `pg_temp.expect()` rather than printed
for a human to eyeball — that discipline caught five real defects during the
build that a printed report would likely have let through unnoticed. Keep new
tests written that way; do not add a test that just prints a result.

`db/platform.sql` grants `anon` and `authenticated` **full table privileges on
the public schema**, which looks alarming and is deliberate: it is what a
Supabase project does, and keeping it means row-level security is carrying the
whole security model rather than a missing `GRANT` quietly doing the work. If
the grants were absent, the policies would look effective under test and would
fail open the first time someone granted a table for an unrelated reason.

Requires the PostgreSQL server binaries (`postgresql-16` on Debian/Ubuntu) and
Node 22+. Neither suite touches the deployed database.

---

## Notes for whoever maintains this

**Search is typo-tolerant, on purpose.** A guard types a half-heard name
through a window at 3am. `search_residents()` matches substrings first and
falls back to trigram word-similarity, so "novak" finds *Nowak* and
"suilleabhain" finds *Ó Súilleabháin* from an ASCII keyboard. Fuzzy results
appear only when nothing matches literally — otherwise typing an exact room
code like `B-11` also surfaced `B-06` and `B-02`, which is how a guard taps the
wrong name.

**`record_check()`, `record_checkin()` and `close_out_compliance_days()` are
all `SECURITY DEFINER` and must stay that way.** Guards hold no SELECT on
`residents`, so an invoker-rights version cannot read the resident's status to
validate it and every sign-in or check-in fails with "Resident not found". It
is safe to elevate each of them because it is a closed operation: they
re-check `is_staff()` and take the guard identity from `auth.uid()`, never
from an argument. Do not add a `guard_id` parameter to any of them.

**The dedupe in `record_checkin()` is scoped to the site-local day — do not
"simplify" it to a global `max(occurred_at)`.** A check-in at 23:59:30
followed by a genuine one at 00:10:10 is 40 seconds apart but two different
calendar days in `local_timezone`; the unscoped version would silently
discard the second one, which produces a false breach the next day.

**`compliance_required()` computes age as of the day being evaluated, never as
of today.** This matters for backfill: computing today's age against a
historical date would retroactively apply the duty to days when the resident
was still under 18.

**Two taps inside 60 seconds record one event.** Touchscreens double-fire.

**Timezones — now one definition, not two.** Everything is computed from
`app_settings.local_timezone`: the day boundary in `daily_compliance`,
`due_today`/`expected`, close-out, the 30-day strip, and — since the move —
the gate app's Log tab. That last one used to build its date range from the
browser's clock, which meant a terminal with a mis-set timezone could disagree
with the register about what day it was. It is computed server-side now, so
there is a single answer to "what is today" and it is the site's. Keep
`local_timezone` matched to the site.

**The web tier owns authentication; the database still owns authorisation.**
Every request runs through `withIdentity()` in `server/db.js`, which opens a
transaction, drops to the `authenticated` role, and sets
`request.jwt.claim.sub` — so `auth.uid()`, every policy and every `is_staff()`
check behave exactly as they did under Supabase. Resist the temptation to
"simplify" a handler by checking a role in JavaScript instead: the point of
this design is that `routes.js` could be wrong about who may do what and the
database would still refuse. Two rules keep that true — never use `withOwner()`
to serve resident data, and never use a bare `SET` where `SET LOCAL` is
written, because a session-level setting outlives the transaction and would
hand one guard's identity to the next request on that pooled connection.

**Editing an inline `<script>` changes the CSP.** `server/index.js` hashes
every inline block at boot and lists the hashes in `script-src`, which is what
lets the policy drop `'unsafe-inline'` entirely. The hashes are computed from
the files on disk at startup, so a deploy recomputes them — but a file edited
while the server is running is blocked until restart. `check.sh` asserts the
served CSP matches the served HTML.

### Not built, and why

- **Notifying residents that they are due.** Sending SMS or email would add a
  processor, a new category of contact data, and a delivery-failure mode that
  looks like non-compliance. The check-in app has the Attention tab; the
  escalation procedure is an operational matter.
- **Photos on the register.** Would make visual verification stronger, and would
  also turn this into a system holding biometric-adjacent data. Worth doing
  deliberately, with a DPIA, not by default.
- **Offline queueing.** A hut with flaky wifi would benefit, but it means
  holding resident names in `localStorage` on a shared terminal. If you add it,
  encrypt the queue and clear it on logout.

**Backdated departures.** `required` is written once per day by close-out and
nothing recomputes it. If a supervisor learns on Friday that a resident left
on Monday, the rows already written for Tue–Thu stay on the register as
breaches. Set `departed_on` before the next nightly close-out. Correcting
earlier days needs an admin database correction — the system deliberately has
no self-service path that can flip a recorded outcome.

**Data import.** `close_out_compliance_days()` resumes from the latest closed
day globally, not per resident, so importing a resident with a backdated
`registered_at` silently skips every day of theirs before that point. Import
residents before their history matters, or backfill deliberately.
