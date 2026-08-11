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

## Option 1 — Supabase + Vercel *(in use)*

| | |
|---|---|
| Cost | €0 to start; ~$25/mo Supabase Pro + ~$20/mo Vercel Pro realistically |
| EU-hosted | Yes — pick Frankfurt or Ireland at project creation |
| EU-owned | No (both US) |
| Ops burden | Near zero |

Postgres with row-level security is a genuinely good fit here. The access rules
("guards can append events but never edit them", "guards cannot see dates of
birth") are expressible as policies enforced by the database, so they hold no
matter what the front end does. That is worth more than it sounds for a system
whose entire client is a public HTML file.

**Two traps:**

- **Vercel's Hobby plan prohibits commercial use.** A security contractor
  running this for a client is commercial. Budget $20/user/mo, or use Option 2.
- **The Supabase free tier pauses a project after ~7 days of inactivity.** Fine
  while building, not fine for a hut that is quiet over Christmas. Pro (~$25/mo)
  removes this and adds daily backups — which you want anyway for an audit
  trail.

Realistic steady state: **~$45/mo**, or ~$25/mo with Option 2's hosting.

---

## Option 2 — Supabase + Render *(the escape hatch, config committed)*

| | |
|---|---|
| Cost | ~$25/mo (Supabase Pro only) |
| Commercial use on the free tier | **Yes** — unlike Vercel Hobby |
| EU-hosted | Yes — Frankfurt region available |
| Migration effort | `render.yaml` is committed and header-checked |

Render's free static sites permit commercial use, which is the trap that makes
Vercel's Hobby plan unusable for a security contractor running this for a
client. `render.yaml` carries the same security headers as `vercel.json`; keep
the two in sync.

Nothing about the app is Render-specific — it is four static files with no build
step, so this is a hosting choice you can reverse in an afternoon if Render
stops suiting you.

---

## Option 2b — Supabase + Cloudflare Pages

Identical to Option 2 with the static files served by Cloudflare Pages instead.

| | |
|---|---|
| Cost | ~$25/mo (Supabase Pro only) |
| Commercial use on the free tier | **Yes** — unlike Vercel Hobby |
| Migration effort | Minutes |

The front end is a couple of static files with no build step, so hosting is
nearly free to change. Cloudflare's free tier permits commercial use and has
no meaningful bandwidth ceiling for a hut.

`vercel.json`'s headers translate to a `_headers` file; keep the same CSP.

**This is the best value in the list** if you are staying on Supabase: it
removes a US processor and ~$20/mo, and costs almost nothing to switch to.

---

## Option 3 — Self-hosted Supabase on Hetzner

| | |
|---|---|
| Cost | ~€5–15/mo (CX22 upward) |
| EU-owned | **Yes** — Hetzner is German |
| Ops burden | Real: backups, upgrades, TLS, monitoring, incident response |

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

**Neon** (~$0–19/mo) is Postgres, so `schema.sql` mostly ports — but it has no
built-in auth, so you would add Clerk or Auth.js and rewrite the `auth.uid()`
integration. More moving parts for no compliance gain.

**Nhost** offers EU hosting on Hasura + Postgres; smaller company, smaller
ecosystem. **Appwrite** has a different permission model, so same rewrite
problem as PocketBase.

None of these beat Option 2 on either axis. Listed because they come up.

---

## Summary

| Option | ~Monthly | EU-hosted | EU-owned | Migration from here |
|---|---|---|---|---|
| **1. Supabase + Vercel** | **$45** | **Yes** | **No** | **— (in use)** |
| 2. Supabase + Render | $25 | Yes | No | config committed, header-checked |
| 2b. Supabase + Cloudflare | $25 | Yes | No | Minutes |
| 3. Self-hosted Supabase, Hetzner | €5–15 | Yes | Yes | Low — schema runs as-is |
| 4. PocketBase, EU VPS | €4 | Yes | Yes | High — full rewrite |
| 5. Neon / Nhost / Appwrite | $0–25 | Yes | No | Medium to high |

**In use: Option 1 (Supabase + Vercel).** The one thing to settle is the Vercel
plan — Hobby prohibits commercial use, so a client-facing deployment needs Pro
(~$20/user/mo). If that cost is unwelcome, Option 2 is the same architecture on
a free tier that permits commercial use, and `render.yaml` is already committed
and header-checked, so the switch is a dashboard change. Keep Option 3 as the
escape hatch if EU *ownership* ever becomes a requirement.

---

## Why the escape hatch is cheap

`schema.sql` depends on exactly three Supabase-specific things: the
`auth.users` table, the `auth.uid()` function, and the `anon` / `authenticated`
roles. `supabase/tests/00_supabase_stub.sql` recreates all three in about
thirty lines — that file was written to make the test suite run, but it doubles
as the portability layer.

Moving to any plain Postgres means applying that stub, wiring `auth.uid()` to
whatever issues tokens, and running `schema.sql` unchanged. Worth preserving
that property: keep Supabase-specific features out of the schema, and this
stays a Postgres app that happens to run on Supabase.

The front end has the same property for the opposite reason — no build step and
no framework means no lock-in to a host. A `<script>` tag and plain vanilla JS
will still run in ten years, which is a reasonable planning horizon for a
security hut and not one most JavaScript stacks can claim.

There are now **two** static front ends, `index.html` (gate app) and
`checkin.html` (check-in app), sharing `app-common.css` and `app-common.js`.
That strengthens this argument rather than weakening it: two HTML files and
two small JS/CSS includes are still nothing for a host to build or serve —
there is no bundler output to reproduce, no framework version to match, no
routing config beyond what `vercel.json` already has. Whichever option above
is chosen, hosting both apps costs exactly as little as hosting one.
