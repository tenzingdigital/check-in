# Hut Check-In

Two front ends, one Supabase backend, one resident register.

**`index.html` — the gate app.** Who is on site right now. A guard logs in,
searches a registered resident by name, verifies the person visually, and taps
one button to sign them in or out. Two tabs: Search and Log.

**`checkin.html` — the check-in app.** The statutory daily register: did this
resident present at the hut today? Two tabs: Check in and Attention. A gate
sign-in/out is a different act from a check-in and does not satisfy the daily
requirement — see "Compliance is per calendar day" below.

Every event, at either app, is timestamped and attributed to the guard who
recorded it. Both apps share `app-common.css` and `app-common.js`, loaded as
plain `<script>`/`<link>` tags — still no build step, no framework.

```
index.html             the gate app — Search and Log
checkin.html            the check-in app — Check in and Attention
app-common.css          styles shared by both front ends
app-common.js           Supabase client setup and helpers shared by both
vercel.json             static hosting config and security headers
supabase/schema.sql     tables, views, RPCs, row-level security, GDPR functions
supabase/seed.sql       optional demo data (test projects only)
supabase/tests/         throwaway-Postgres acceptance suite (authorisation + compliance)
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

### 1. Create the Supabase project

Pick an **EU region** — Frankfurt or Ireland. This matters for the transfer
analysis in `docs/GDPR.md` and cannot be changed after the project is created.

### 2. Apply the schema

Supabase dashboard → SQL Editor → paste `supabase/schema.sql` → Run.

It is written for a fresh project. Re-running it is safe, but note that
`residents.search_key` is a generated column: if you later change how names are
normalised you will need a migration rather than a re-run.

### 3. Turn off public sign-up

**Authentication → Sign In / Providers → Email → disable "Allow new users to
sign up".**

Do not skip this. Several policies grant access to any authenticated user on
the assumption that the only way to hold an account is for an admin to have
created one. With open sign-up, anyone who finds the URL could register and
read the resident register.

### 4. Create staff accounts

Authentication → Users → Add user. Set **User Metadata** to control the role:

```json
{ "full_name": "Gina Guard", "role": "guard" }
```

A `profiles` row is created automatically by trigger. Valid roles are `guard`,
`supervisor`, `admin`. Omitting `role` gives `guard`. Make at least one `admin`.

To revoke access, set `profiles.active = false` — do not delete the user.
Deleting is blocked by design: `gate_events.guard_id` and
`checkin_events.guard_id` are `ON DELETE RESTRICT`, so the database refuses to
erase the identity behind a historical audit trail.

### 5. Schedule the cron jobs

Database → Extensions → enable `pg_cron`, then run the four `cron.schedule`
calls in the commented block at the end of `supabase/schema.sql`:

```sql
select cron.schedule(
  'purge-expired-gate-events',
  '15 3 * * *',                        -- 03:15 UTC daily
  $$ select public.purge_expired_gate_events(); $$
);

select cron.schedule(
  'close-out-compliance-days',
  '30 0 * * *',                        -- 00:30 UTC daily, after midnight in Europe/Dublin
  $$ select public.close_out_compliance_days(); $$
);

select cron.schedule('purge-expired-checkin-events', '20 3 * * *',
  $$ select public.purge_expired_checkin_events(); $$);
select cron.schedule('purge-expired-compliance', '25 3 * * *',
  $$ select public.purge_expired_compliance(); $$);
```

Four jobs, not one:

- **`purge-expired-gate-events`** and **`purge-expired-checkin-events`** —
  delete movement rows older than `app_settings.event_retention_days` (default
  90). Without these, movement history accumulates forever, a
  storage-limitation problem under GDPR Art. 5(1)(e).
- **`purge-expired-compliance`** — deletes `daily_compliance` rows older than
  `app_settings.compliance_retention_days` (default 2555 days, a placeholder —
  see `docs/GDPR.md`).
- **`close-out-compliance-days`** — closes each day and writes the *negative*
  register rows for residents who were never seen. **This one is not
  optional.** If it is not scheduled, `daily_compliance` only ever gains rows
  from `record_checkin()` — the positive path — so nobody is ever recorded as
  having missed a day, and the register silently stops proving compliance at
  all. If the site timezone is far from UTC, move its schedule so it runs
  after local midnight; running it early only defers rows to the next run, it
  never writes a wrong day.

Confirm all four with `select * from cron.job;`.

### 6. Point the front ends at the project

Edit the `CONFIG` block near the bottom of **both** `index.html` and
`checkin.html` — they point at the same project and use the same keys:

```js
const CONFIG = {
  url: window.CHECKIN_SUPABASE_URL  || "https://YOUR-PROJECT.supabase.co",
  key: window.CHECKIN_SUPABASE_ANON_KEY || "YOUR-PUBLISHABLE-ANON-KEY",
};
```

Settings → API → Project URL and the **anon / publishable** key. Never the
service-role key: it bypasses every policy in `schema.sql`, and anything in
`index.html` or `checkin.html` is public.

The anon key itself is not a secret. It identifies the project; it grants
nothing. The acceptance suite confirms a logged-out caller holding that key
cannot read the register, search, or write an event.

Alternatively, keep the repo project-agnostic by serving a `config.js` (already
gitignored) that sets `window.CHECKIN_SUPABASE_URL` before either app runs.

### 7. Deploy

```bash
npx vercel --prod
```

No build step. `vercel.json` sets the framework to `null` and serves the
directory as static files.

Two things to check before this is genuinely live:

- **Vercel's Hobby plan is non-commercial.** A security contractor running this
  for a client needs a paid plan. `docs/TECH-STACK.md` compares hosts that allow
  commercial use for free.
- **Restrict who can reach it.** Add the deployment's domain to Supabase's
  allowed redirect URLs, and consider Vercel's deployment protection or an
  IP allowlist so the login page is not simply on the open internet.

---

## Verifying the security model

```bash
./supabase/tests/run.sh
```

This starts a throwaway PostgreSQL cluster, stubs the parts of Supabase the
schema depends on (`auth.users`, `auth.uid()`, and the `anon`/`authenticated`
role grants), applies `schema.sql`, and runs two suites: `01_acceptance.sql`
(the authorisation model) and `02_compliance.sql` (calendar-day semantics,
close-out, retention, GDPR). It exits non-zero if any assertion fails.

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

It reproduces Supabase's **default table grants** to `anon` and `authenticated`
deliberately. Testing without them would make RLS look effective when a missing
`GRANT` was really doing the work — and that grant exists on every real
Supabase project.

Requires the PostgreSQL server binaries (`postgresql-16` on Debian/Ubuntu). It
never touches a real project.

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

**Timezones.** The gate app's Log tab date filter uses the browser's local day
boundaries, so "today" means what the guard on shift thinks it means, and DST
is handled by the platform. Everything compliance-related — the day boundary
in `daily_compliance`, `due_today`/`expected`, close-out — uses
`app_settings.local_timezone` instead, because it is computed server-side and
has to be one definition of "today" regardless of which browser is open. Keep
that setting matched to the site; on a terminal set to the wrong zone the two
can disagree about what day it is.

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
