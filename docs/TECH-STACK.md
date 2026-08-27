# Stack options: GDPR posture vs. value

Brainstorm behind the stack this repo actually uses, and what the alternatives
would cost if the constraints change.

> **Pricing changes constantly.** Every figure below is an approximate monthly
> list price for a small single-site deployment and needs re-checking before
> anyone signs anything. The *shape* of the comparison is the durable part.

---

## The two axes that actually matter

Most "is it GDPR compliant?" comparisons collapse into one question, and it is
the wrong one. There are two:

**EU-hosted** — the data physically sits in the EU. Easy. Supabase, Neon,
Vercel, Cloudflare all offer it. Costs nothing extra. Handles the bulk of the
practical risk.

**EU-owned** — the company controlling the infrastructure is subject to EU law
and not to the US CLOUD Act. Much harder. Rules out every provider in the
default stack, because a US parent can be compelled regardless of where the
disks are.

For a security hut logging resident movements, EU-hosted with signed DPAs and
SCCs is the normal, defensible bar. EU-owned becomes worth the cost if the site
is public-sector, the residents are a vulnerable population, or a contract
specifies it. **Decide which bar applies before comparing prices**, because it
changes the answer completely.

A third axis quietly matters as much: **how much of this can one person operate
at 3am when it breaks?** Managed services cost money and save incidents.

---

## Option 1 — Render, all of it *(in use)*

Render Postgres, a Render Node web service serving both the front ends and the
API, and a Render cron job. One vendor, one region, one bill.

| | |
|---|---|
| Cost | ~$14/mo — `basic-256mb` Postgres (~$6) + `starter` web service (~$7) + cron |
| Schema | numbered SQL migrations in `db/migrations`, applied at boot |
| EU-hosted | Yes — Frankfurt |
| EU-owned | No (US company) |
| Ops burden | Low, with one new thing to own: authentication |

**What this costs that the Supabase version did not.** Supabase was not just a
database, it was PostgREST (the HTTP API the browser called directly) and
GoTrue (login, sessions, password hashing). Plain Postgres is only the first of
those three. Replacing the other two is `server/` — about four hundred lines,
one dependency, and the largest new risk in this system. `db/tests/api.sh`
exists specifically to hold that risk down.

**What it gains.** Cheaper, one vendor instead of two, no third-party origin in
the browser's request path at all — which let the CSP drop `'unsafe-inline'`
and every external host — and a schema that is now provably portable rather
than portable in principle.

**What did NOT change, and this is the important part.** The security model
stayed in the database. `db/migrations/002_schema.sql` was not modified by the migration:
every RLS policy, every `SECURITY DEFINER` RPC, every `auth.uid()` call works
as written, because `db/migrations/001_platform.sql` still provides `auth.users`,
`auth.uid()` and the `anon`/`authenticated` roles, and the API binds an
identity per transaction with `SET LOCAL ROLE` + `SET LOCAL
request.jwt.claim.sub`. The old acceptance suite passes unchanged.

**Two traps:**

- **A free Render Postgres is DELETED after 30 days.** Not paused — deleted.
  For a statutory audit trail that is not a tier, it is a countdown. This is
  strictly worse than the Supabase free tier's behaviour, which merely paused
  after ~7 days idle, and it is the single most important line in this
  document.
- **A free web service spins down after 15 minutes idle** and takes the best
  part of a minute to answer. A guard at 3am waiting a minute for a login
  screen concludes the system is broken.

Both are avoided by the paid plans in `render.yaml`. At ~$14/mo this is
cheaper than any Supabase option below, and the difference is roughly the price
of not maintaining login code.

---

## Option 2 — Supabase + Render *(what this repo used to be)*

| | |
|---|---|
| Cost | ~$25/mo (Supabase Pro) + $0 static hosting |
| EU-hosted | Yes — Frankfurt region available |
| Migration effort | Real, in both directions — see below |

Supabase's Postgres with row-level security was a genuinely good fit, and the
reason the schema is shaped the way it is. The access rules ("guards can append
events but never edit them", "guards cannot see dates of birth") are
expressible as policies enforced by the database, so they hold no matter what
the front end does — worth more than it sounds for a system whose entire client
used to be a public HTML file talking straight to the database.

What it also gave, and what Option 1 had to rebuild: login, sessions, password
storage, and an HTTP API generated from the schema.

Going back is not free but it is bounded: `db/migrations/002_schema.sql` is unchanged, so it
would be a data copy plus pointing the front ends at supabase-js again. The
Supabase free tier pauses a project after ~7 days of inactivity — fine while
building, not fine for a hut that is quiet over Christmas — so Pro (~$25/mo) is
the realistic figure, which also buys daily backups.

---

## Option 2b — Vercel

Worth a line only to record that it was ruled out. **Vercel's Hobby plan
prohibits commercial use**, and a security contractor running this for a client
is commercial — so it starts at ~$20/user/mo, on top of a database. It was the
original plan for this repo and `vercel.json` sat in the tree for a while as an
escape hatch. It is gone: the app is no longer a pile of static files, so
"switch hosts in an afternoon" is no longer the relevant property.

---

## Option 3 — Self-hosted Supabase on Hetzner

| | |
|---|---|
| Cost | ~€5–15/mo (CX22 upward) |
| EU-owned | **Yes** — Hetzner is German |
| Ops burden | Real: backups, upgrades, TLS, monitoring, incident response |

Now also the option that would let you delete `server/auth.js`: a self-hosted
Supabase brings GoTrue back, so login stops being ours to maintain.

The compliance story is the strongest available and the bill is the smallest.
The catch is that "€5/mo" ignores the cost of being the person who restores the
database at 3am. For a single hut, an unattended self-hosted Postgres holding an
audit trail is a liability unless someone genuinely owns it.

Worth it when EU ownership is a hard requirement. Otherwise the €20/mo saving
does not cover one incident.

`schema.sql` runs unchanged.

---

## Option 4 — PocketBase on a small EU VPS

A single Go binary: SQLite, auth, REST API, admin UI.

| | |
|---|---|
| Cost | ~€4/mo |
| EU-owned | Yes (with an EU host) |
| Migration effort | **High — `schema.sql` is thrown away** |

Genuinely appealing for something this small, and the whole system becomes one
binary plus one HTML file. But the entire security model here lives in Postgres
RLS, and PocketBase's rules are a different, weaker model. The append-only
ledger, the definer-rights RPC, the minimised view — all would need rebuilding
and re-proving.

Right choice at the start of this project. Wrong choice now that the Postgres
model exists and is tested.

---

## Option 5 — Neon / Nhost / Appwrite

Postgres-compatible or BaaS alternatives, all with EU regions.

**Neon** (~$0–19/mo) is Postgres, so `schema.sql` ports — and now that
`server/` exists and owns login, "it has no built-in auth" has stopped being a
disqualifier. Neon is a straight swap for Render Postgres: change
`DATABASE_URL`, keep everything else. Its EU regions and generous free tier
make it the obvious fallback if Render's database pricing ever moves.

**Nhost** offers EU hosting on Hasura + Postgres; smaller company, smaller
ecosystem. **Appwrite** has a different permission model, so same rewrite
problem as PocketBase.

**Nhost** and **Appwrite** are listed because they come up; neither beats
Option 1 on either axis, and Appwrite's permission model would mean rebuilding
the security model rather than porting it.

---

## Summary

| Option | ~Monthly | EU-hosted | EU-owned | Who owns login | Migration from here |
|---|---|---|---|---|---|
| **1. Render, all of it** | **$14** | **Yes** | **No** | **us (`server/auth.js`)** | **— (in use)** |
| 2. Supabase + Render | $25 | Yes | No | Supabase | Real — re-point the front ends |
| 2b. Vercel | $20+ | Yes | No | — | Ruled out: no commercial use on Hobby |
| 3. Self-hosted Supabase, Hetzner | €5–15 | Yes | Yes | GoTrue | Low — schema runs as-is |
| 4. PocketBase, EU VPS | €4 | Yes | Yes | PocketBase | High — full rewrite |
| 5. Neon | $0–19 | Yes | No | us | Trivial — change `DATABASE_URL` |

**In use: Option 1.** Cheapest of the managed options, one vendor, and the
resident data sits behind an API we control end to end. The price is the
"who owns login" column: authentication is ours now, and it is the one part of
this system where a subtle bug is a breach rather than a wrong number on a
screen. Keep `server/auth.js` small, keep `db/tests/api.sh` green, and reach
for Option 3 if EU *ownership* ever becomes a requirement — it is also the
option that hands login back to somebody else.

---

## The escape hatch was cheap — here is the receipt

Every earlier version of this document argued that `schema.sql` depended on
exactly three Supabase-specific things — the `auth.users` table, the
`auth.uid()` function, and the `anon` / `authenticated` roles — and that
`tests/00_supabase_stub.sql` recreated all three in about thirty lines, so the
schema was portable in principle.

The migration to Render tested that claim, and it held. Not one statement in
`db/migrations/002_schema.sql` changed. The only edits were two comment blocks: the header,
which named Supabase as the target, and the trailing scheduling block, which
used to give `cron.schedule` calls to paste into the Supabase dashboard and now
points at `server/jobs.js`. The stub was promoted to
`db/migrations/001_platform.sql`, given real password and session storage, and became
production. The 84-assertion acceptance suite passed against it without a
single test being changed.

What the claim did *not* cover, and what the migration actually cost, was
everything Supabase provided **above** the database: PostgREST turned the
schema into an HTTP API, and GoTrue handled login. Those had to be written —
`server/`, about four hundred lines and one dependency. That is the honest
price of leaving a BaaS, and it is worth writing down for whoever considers the
next move: **a portable schema makes the database portable, not the
application.**

Keep the property anyway. No Supabase-specific — and now no Render-specific —
features in the schema; nothing in `server/` that assumes a particular host
beyond reading `DATABASE_URL` and `PORT`. That is what makes Option 5 a
one-variable change.

The front end keeps its own version of the same property: no build step and no
framework means nothing for a host to compile. It has one fewer external
dependency than it used to — the supabase-js CDN tag is gone — so both apps are
now genuinely self-contained files that a `<script>` tag will still run in ten
years, which is a reasonable planning horizon for a security hut and not one
most JavaScript stacks can claim.
