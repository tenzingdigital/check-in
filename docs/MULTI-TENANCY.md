# Multi-tenancy: schema per tenant

The design decision, why it was made, and the object-by-object split it
implies. Written before the code so the code can be checked against it.

## The decision

Each business gets its own PostgreSQL **schema**. Shared identity and billing
live in `public` and `auth`. `withIdentity()` sets `search_path` to the caller's
tenant schema for the life of the transaction, alongside the role and identity
it already binds.

Rejected: **row-level** (a `tenant_id` column with tenant-scoped policies).
Rejected on security, not on effort. Measured against this codebase, row-level
would require a hand-written tenant check in each of:

- **23 `SECURITY DEFINER` functions**, which bypass row-level security entirely
- **20 `withOwner()` call sites** across 6 files, which connect as the owner and
  never consult RLS at all
- **13 RLS policies**, all currently role-based, which would each need to
  compose tenant *and* role

That is roughly 56 places where one omission silently returns another centre's
residents — and it stays that way for the life of the product, because every new
function and job is a fresh chance to forget. Under schema-per-tenant none of
them need a tenant check, and a binding mistake raises `relation does not exist`
rather than returning data. Loud, not silent (Tao 17).

Rejected for now: **database per tenant**. Stronger still — separate
credentials, separate backups, no shared catalog — but roughly €7–20 per month
per customer on Render and too slow to provision for a self-serve trial. Kept as
an exit: a customer who demands it in procurement can be promoted with
`pg_dump -n` of their schema. Row-level offers no such exit.

## Why this is safer than it first looks

**Each tenant gets its own copy of every function, and each copy pins its own
`search_path` at creation time.** `is_staff()` inside `t_harbour` is created
with `set search_path = t_harbour, public, extensions`. It therefore reads
`t_harbour.profiles` and can read nothing else, regardless of what the caller's
session `search_path` says. Search-path manipulation stops being an attack
surface, because no tenant function resolves names dynamically.

**GDPR gets easier, not harder.** "Return or delete their data" in the DPA
becomes `pg_dump -n t_harbour` and `drop schema t_harbour cascade`. One
customer, cleanly, with no chance of catching a neighbour's rows in the net.

## The split

Verified against a freshly migrated database, not from memory.

### Shared — stays in `public` / `auth`

| Object | Why shared |
|---|---|
| `public.tenants` | The registry itself |
| `public.schema_migrations` | Platform migration ledger |
| `auth.users`, `auth.sessions`, `auth.password_resets` | One identity per person, carrying `tenant_id`. Login has to work before a tenant is known |
| `public.tenant_may_write()`, `public.expire_lapsed_trials()` | Operate on the registry |
| `public.immutable_unaccent()`, `public.touch_updated_at()` | Pure helpers with no tenant data. Tenant schemas resolve them because `public` stays on the tenant `search_path` |

### Per-tenant — one copy inside each tenant schema

**Tables:** `app_settings`, `profiles`, `residents`, `gate_events`,
`checkin_events`, `daily_compliance`, `erasure_log`

**Views:** `v_resident_status`, `v_resident_compliance`, `v_check_log`

**Functions:** `my_role`, `is_staff`, `is_supervisor`, `is_admin`,
`site_today`, `compliance_required`, `search_residents`, `record_check`,
`record_checkin`, `close_out_compliance_days`, `hut_summary`, `attention_list`,
`export_resident_record`, `erase_resident`, `purge_expired_gate_events`,
`purge_expired_checkin_events`, `purge_expired_compliance`,
`admin_create_staff`, `admin_set_staff_password`

**RLS policies:** all 13, unchanged — they stay role-based, because the schema
already answers "which tenant".

## Built, 4 September 2026 (migration 020)

- `withIdentity()` in `database.js` resolves the caller's tenant (one query
  on `auth.users` and `public.tenants`, never cached) and sets
  `search_path` to `<schema>, public, extensions` before it switches role.
  Every route now uses unqualified names, so each resolves inside the
  caller's schema; a suspended or closed tenant is refused with a 403
  before any query runs.
- `auth.profile_for(user)` finds a person's profile in their own centre by
  dynamic SQL from the validated slug; login, session validation, password
  reset and invitation links use it. `public.handle_new_user()` creates the
  profile in the new user's tenant. `auth.create_user()` and
  `auth.create_user_invited()` take an optional tenant and otherwise use the
  caller's own.
- `jobs.js` runs the per-tenant jobs once per open tenant inside its schema
  (each centre's `job_runs` and health banner are its own) and the platform
  jobs once.
- `tenant/template.sql` now carries the grants (pg_dump without `--no-acl`,
  minus default privileges and schema ACLs); `provisionSchema()` grants
  usage on the schema to the request roles.
- `routes/tenants.js`: platform administrators (`auth.users.platform_admin`,
  set in SQL by the operator) list centres with counts, provision one (row,
  schema, first admin, invitation link) and close one (slug typed back,
  schema dropped, logins ended). The screen is `/org.html`, the
  organisation page, a level above any one site: the site admin page
  manages one centre and never shows the list of centres.
- Not built: the trial's read-only state (`tenant_may_write()` exists and
  is not enforced), and an organisation role that spans several centres
  without being platform admin. One login belongs to one centre; a person
  who works at two has two logins.

## The two things that need care

**1. `handle_new_user()`.** Today it is a trigger on `auth.users` that inserts
into `public.profiles`. `auth.users` is shared but `profiles` is per-tenant, so
the trigger must resolve the new user's `tenant_id` to a schema and insert
there. It becomes the one function that legitimately uses dynamic SQL, so the
schema name must come from `public.tenants` and be quoted with `quote_ident` —
never from anything a user typed.

**2. Migration ordering.** Two ledgers, not one: platform migrations against
`public`/`auth`, and tenant migrations applied to every tenant schema. Boot must
refuse to serve if any tenant schema is behind — a half-migrated tenant is
exactly the "half-known schema" that Tao 17 says to be loudly down for. The
existing advisory lock keeps two instances from racing.

## Provisioning

`provision_tenant(name, slug)`:

1. Insert the `public.tenants` row (already built, migration 009).
2. `create schema t_<slug>` — slug validated against `^[a-z][a-z0-9-]{1,38}[a-z0-9]$`
   by a table constraint *before* it is ever interpolated, and quoted with
   `quote_ident` when it is.
3. Apply every tenant migration to that schema, in order.
4. Seed `app_settings` with one row and the tenant's own name and timezone.
5. Create the first administrator against `auth.users` with the new `tenant_id`.

Deprovisioning is `drop schema ... cascade` plus the tenant row, and is only
reached from the deletion timeline in the DPA.

## The existing deployment

`public` keeps its current objects and remains the `default` tenant, mapped by
`public.tenants.slug = 'default'`. It is not migrated into a `t_default` schema:
moving a live register to prove a point is risk with no benefit. The resolver
returns `public` for that tenant and a `t_` schema for everyone else, which is
one branch in one function.
