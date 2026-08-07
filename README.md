# Hut Check-In

A resident sign-in terminal for a security hut. A guard logs in, searches a
registered resident by name, verifies the person visually, and taps one button
to sign them in or out. Every event is timestamped and attributed to the guard
who recorded it.

Adults must present at the hut at least once every 24 hours. The app tracks
that clock per resident and shows who is overdue.

```
index.html            the whole front end — no build step, no framework
vercel.json           static hosting config and security headers
supabase/schema.sql   tables, views, RPCs, row-level security, GDPR functions
supabase/seed.sql     optional demo data (test projects only)
supabase/tests/       throwaway-Postgres acceptance suite for the RLS model
docs/GDPR.md          what personal data is held, why, and for how long
docs/TECH-STACK.md    stack options, costs, and why this one
```

---

## How it works

**No PINs, no cards, no biometrics.** Identity is established by the guard
looking at the person, which is the control that already exists at a hut. The
app's job is to record that the check happened, when, and who performed it.

**Append-only ledger.** `check_events` is the single source of truth. Presence
("is this person on site?") and compliance ("have they been seen in the last 24
hours?") are both derived from it. There is no nightly reset job and no status
column to drift out of sync — *today's log* is a timestamp range filter, and
yesterday's log is the same query with a different date.

**Corrections are new events, not edits.** No role has UPDATE or DELETE on the
ledger. If a guard signs in the wrong person, the fix is another event. Rows
leave the table only through the retention purge or a GDPR erasure request.

### The 24-hour rule

| State | Meaning |
|---|---|
| `ok` | Signed in within the window |
| `due_soon` | Inside the last 4 hours before the deadline |
| `overdue` | Past the deadline |
| `never` | On the register, no check-in ever recorded |
| `exempt` | Under 18 — the rule does not apply |

The window (24h), the warning lead time (4h) and the adult age (18) are rows in
`app_settings`, not constants in the code, so a supervisor can change them
without a redeploy.

Age is computed from date of birth on every read, so a resident becomes subject
to the rule automatically on their 18th birthday. Nobody has to remember to
flip a flag. This is the reason the register stores a full date of birth rather
than a boolean — see `docs/GDPR.md` for the necessity argument.

The **Overdue** tab is the flow itself: it lists everyone who owes a check-in,
worst first, and the count sits in the header so it is visible without changing
tabs. What the hut does about an overdue resident — call, escalate, welfare
check — is a procedure, not a feature; the app tells you who and for how long.

### Roles

| Role | Can do |
|---|---|
| `guard` | Search residents, sign in/out, read the log |
| `supervisor` | Also add, edit and retire residents |
| `admin` | Also manage staff, change settings, run GDPR export and erasure |

A guard never holds read access to the `residents` table, because that table
carries dates of birth. Guards read `v_resident_status`, which exposes age and
an adult flag but no date of birth. The acceptance suite asserts this.

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
Deleting is blocked by design: `check_events.guard_id` is `ON DELETE RESTRICT`,
so the database refuses to erase the identity behind a historical audit trail.

### 5. Schedule the retention purge

Database → Extensions → enable `pg_cron`, then:

```sql
select cron.schedule(
  'purge-expired-check-events',
  '15 3 * * *',
  $$ select public.purge_expired_check_events(); $$
);
```

Without this, sign-in history accumulates forever, which is a storage-limitation
problem under GDPR Art. 5(1)(e). Default retention is 90 days
(`app_settings.event_retention_days`).

### 6. Point the front end at the project

Edit the `CONFIG` block near the bottom of `index.html`:

```js
const CONFIG = {
  url: window.CHECKIN_SUPABASE_URL  || "https://YOUR-PROJECT.supabase.co",
  key: window.CHECKIN_SUPABASE_ANON_KEY || "YOUR-PUBLISHABLE-ANON-KEY",
};
```

Settings → API → Project URL and the **anon / publishable** key. Never the
service-role key: it bypasses every policy in `schema.sql`, and anything in
`index.html` is public.

The anon key itself is not a secret. It identifies the project; it grants
nothing. The acceptance suite confirms a logged-out caller holding that key
cannot read the register, search, or write an event.

Alternatively, keep the repo project-agnostic by serving a `config.js` (already
gitignored) that sets `window.CHECKIN_SUPABASE_URL` before `index.html` runs.

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
role grants), applies `schema.sql`, and runs an acceptance suite. It exits
non-zero if any operation that should be denied succeeds.

It exists because RLS fails *quietly*. A policy that blocks too much returns
zero rows instead of an error; a policy that blocks too little returns data
nobody notices. Neither is visible from the browser. The suite checks, among
other things, that a guard cannot read a date of birth, cannot edit or delete a
past event, cannot attribute an event to another guard, cannot promote
themselves, and that a suspended account and a logged-out caller can do nothing
at all.

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

**`record_check()` is `SECURITY DEFINER` and must stay that way.** Guards hold
no SELECT on `residents`, so an invoker-rights version cannot read the
resident's status to validate it and every sign-in fails with "Resident not
found". It is safe to elevate because it is a closed operation: it re-checks
`is_staff()` and takes the guard identity from `auth.uid()`, never from an
argument. Do not add a `guard_id` parameter to it.

**Two taps inside 60 seconds record one event.** Touchscreens double-fire.

**Timezones.** The log's date filter uses the browser's local day boundaries, so
"today" means what the guard on shift thinks it means, and DST is handled by the
platform. The header's *events today* counter uses
`app_settings.local_timezone` instead, because it is computed server-side — keep
that setting matched to the site.

### Not built, and why

- **Notifying residents that they are due.** Sending SMS or email would add a
  processor, a new category of contact data, and a delivery-failure mode that
  looks like non-compliance. The hut has the overdue list; the escalation
  procedure is an operational matter.
- **Photos on the register.** Would make visual verification stronger, and would
  also turn this into a system holding biometric-adjacent data. Worth doing
  deliberately, with a DPIA, not by default.
- **Offline queueing.** A hut with flaky wifi would benefit, but it means
  holding resident names in `localStorage` on a shared terminal. If you add it,
  encrypt the queue and clear it on logout.
