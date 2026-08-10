# Resident Check-In App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a statutory daily-attendance register for residents, separate from the gate's in/out headcount, that records a permanent per-day compliance row surviving the 90-day movement-log purge.

**Architecture:** One Supabase project and one resident register serve two front ends. `gate_events` (renamed from `check_events`) answers "who is on site now". A new `checkin_events` table plus a materialised `daily_compliance` register answers "did this person present today", measured per calendar day in the site's timezone. Register rows are written twice — positively by `record_checkin()` in the same transaction as the event, negatively by a nightly `close_out_compliance_days()` that also backfills any missed days.

**Tech Stack:** PostgreSQL 15+ on Supabase (RLS, `pg_cron`, `pg_trgm`, `unaccent`), static HTML + supabase-js UMD from CDN, no build step. Tests run against a throwaway local Postgres via `supabase/tests/run.sh`.

**Spec:** `docs/superpowers/specs/2026-08-10-resident-checkin-app-design.md`

## Global Constraints

- Target PostgreSQL 15+; the local test harness runs PG16. Do not use PG17-only syntax.
- `supabase/schema.sql` is applied as a single file, top to bottom, inside one transaction. Objects must be defined before they are referenced.
- Every new function pins `set search_path = public, extensions` — extension functions (`digest`, `word_similarity`) may live in either schema.
- Every new table has RLS enabled with explicit policies. No table is reachable by `anon`.
- Guards never receive `SELECT` on `public.residents` (it holds `date_of_birth`). Guard-facing data comes from views or `SECURITY DEFINER` functions.
- `checkin_events`, `daily_compliance` and `compliance_annotations` are append-only for all roles: no `UPDATE` or `DELETE` policy for any role. Writes happen only through the designated functions.
- Guard identity always comes from `auth.uid()`, never from a function argument.
- The calendar day is defined by `app_settings.local_timezone`. Never use the server's or browser's local date for compliance.
- `supabase/tests/run.sh` must exit 0. It fails the build if any line matching `^   ALLOWED` appears in the authorisation summary.
- Commit after every task.

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/schema.sql` | Modified. All tables, views, functions, RLS. Applied as one unit. |
| `supabase/seed.sql` | Modified. Demo check-in history alongside gate history. |
| `supabase/tests/01_acceptance.sql` | Modified. Authorisation model — renames only. |
| `supabase/tests/02_compliance.sql` | **New.** Calendar-day semantics, close-out, retention. |
| `supabase/tests/run.sh` | Modified. Runs the second test file. |
| `checkin.html` | **New.** Check-in front end. |
| `README.md`, `docs/GDPR.md`, `docs/TECH-STACK.md` | Modified. Two apps, new retention categories. |

`supabase/schema.sql` stays a single file. It is a declarative schema applied in one transaction, and the README's "paste into the SQL editor" flow depends on that. Tests split by concern instead, since `01_acceptance.sql` is already 198 lines and the compliance behaviours are a distinct subject.

---

### Task 1: Rename to `gate_events`, add `departed_on`, restructure settings

Foundation for everything else. Purely mechanical, but the existing suite must stay green — that is the test.

**Files:**
- Modify: `supabase/schema.sql`
- Modify: `supabase/seed.sql`
- Modify: `supabase/tests/01_acceptance.sql`

**Interfaces:**
- Consumes: nothing
- Produces: table `public.gate_events(id bigint, resident_id uuid, guard_id uuid, kind text, occurred_at timestamptz, note text)`; `public.residents.departed_on date`; `app_settings.due_soon_after_hour integer`, `app_settings.compliance_retention_days integer`; function `public.record_check(p_resident_id uuid, p_direction text, p_note text) returns setof v_resident_status` unchanged in signature; function `public.purge_expired_gate_events() returns integer`

- [ ] **Step 1: Write the failing test**

Append to `supabase/tests/01_acceptance.sql`, just before the `DONE` echo:

```sql
\echo ''
\echo '=========== I. SCHEMA SHAPE ==========='
reset role;
select
  to_regclass('public.gate_events')  is not null as gate_events_exists,
  to_regclass('public.check_events') is     null as old_name_gone,
  exists (select 1 from information_schema.columns
          where table_name='residents' and column_name='departed_on') as residents_has_departed_on,
  exists (select 1 from information_schema.columns
          where table_name='app_settings' and column_name='due_soon_after_hour') as settings_has_cutoff,
  exists (select 1 from information_schema.columns
          where table_name='app_settings' and column_name='compliance_window_hours') = false as old_window_gone;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./supabase/tests/run.sh`
Expected: FAIL — schema application aborts, or the row returns `f` for `gate_events_exists`.

- [ ] **Step 3: Rename the table and column**

In `supabase/schema.sql`, replace the `check_events` table definition with:

```sql
create table if not exists public.gate_events (
  id          bigint generated always as identity primary key,
  resident_id uuid not null references public.residents (id) on delete cascade,
  guard_id    uuid not null references public.profiles (id) on delete restrict,
  kind        text not null check (kind in ('in', 'out')),
  occurred_at timestamptz not null default now(),
  note        text
);

create index if not exists gate_events_resident_time_idx
  on public.gate_events (resident_id, occurred_at desc, id desc);
create index if not exists gate_events_time_idx
  on public.gate_events (occurred_at desc);

comment on table public.gate_events is
  'Append-only record of site entry and exit. Answers "who is on site now". Does NOT satisfy the daily check-in requirement — see checkin_events.';
```

Delete the old `check_events_resident_in_time_idx` (partial index on `direction='in'`) — the compliance clock no longer reads this table.

Then across the whole file replace `check_events` with `gate_events` and, within that table's usages, `direction` with `kind`. Affected objects: `v_check_log`, `record_check`, `hut_summary`, `export_resident_record`, `erase_resident`, `purge_expired_check_events`, and the RLS policies `check_events_read` / `check_events_insert` (rename to `gate_events_read` / `gate_events_insert`).

Rename the purge function and its grant:

```sql
create or replace function public.purge_expired_gate_events()
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_days    integer;
  v_deleted integer;
begin
  select event_retention_days into v_days from public.app_settings where id;
  delete from public.gate_events where occurred_at < now() - make_interval(days => v_days);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;
```

- [ ] **Step 4: Add `departed_on` to residents**

In the `public.residents` table definition, after `status`:

```sql
  -- The day the resident stopped being subject to the daily rule. status alone
  -- cannot answer that for a PAST date, which would corrupt close-out backfill.
  departed_on   date,
```

Add the consistency constraint after the generated column, inside the table definition:

```sql
  constraint departed_on_requires_status
    check (departed_on is null or status = 'departed'),
```

- [ ] **Step 5: Restructure app_settings**

Replace `compliance_window_hours`, `warn_before_hours` and the `warn_within_window` constraint with:

```sql
  -- Hour of the site-local day after which "not seen yet" starts being flagged.
  due_soon_after_hour     integer not null default 18 check (due_soon_after_hour between 0 and 23),
  -- Statutory proof horizon for the daily register. PLACEHOLDER: set to the
  -- real retention period before go-live.
  compliance_retention_days integer not null default 2555 check (compliance_retention_days between 1 and 36500),
```

Keep `event_retention_days` — it now governs **both** `gate_events` and `checkin_events`.

- [ ] **Step 6: Repair everything that referenced the dropped settings**

`v_resident_status` currently computes `due_by` and `compliance` from `compliance_window_hours`. Delete both expressions and the `last_in` CTE from that view — compliance moves out of this view entirely in Task 6. The view keeps: `id, first_name, last_name, full_name, room_ref, status, note, search_key, age_years, is_adult, presence, last_event_at, last_event_guard_id`.

Delete `public.overdue_residents()` and its grant — replaced in Task 6.

In `hut_summary()`, drop the `overdue`, `due_soon` and `never_signed_in` counters; keep `on_site` and `events_today`. New signature:

```sql
create or replace function public.hut_summary()
returns table (on_site integer, events_today integer)
language sql stable security invoker set search_path = public, extensions
as $$
  select
    count(*) filter (where presence = 'in' and status = 'active')::integer,
    (select count(*)::integer from public.gate_events e
      where e.occurred_at >= date_trunc('day',
              now() at time zone (select local_timezone from public.app_settings where id)
            ) at time zone (select local_timezone from public.app_settings where id))
  from public.v_resident_status
  where public.is_staff();
$$;
```

Update `supabase/seed.sql`: rename the `check_events` insert to `gate_events` and the `direction` column to `kind`.

In `supabase/tests/01_acceptance.sql`, replace every `check_events` with `gate_events` and every `direction` with `kind`. Delete the `overdue_residents()` call and the `compliance`/`due_by` columns from every select.

Delete section C (the 24-hour rule tests) **in full**, including the four `Edge` residents it inserts and their events. Those residents existed only to probe the rolling-window and 18th-birthday boundaries; the rolling window is gone, and the birthday boundary is re-tested directly against `compliance_required()` in `02_compliance.sql` Task 2, which needs no fixture residents. Nothing else in either suite references them.

- [ ] **Step 7: Run tests to verify they pass**

Run: `./supabase/tests/run.sh`
Expected: PASS, and the new schema-shape row returns `t` for all five columns.

- [ ] **Step 8: Commit**

```bash
git add supabase/schema.sql supabase/seed.sql supabase/tests/01_acceptance.sql
git commit -m "refactor: rename check_events to gate_events, split settings for calendar-day compliance"
```

---

### Task 2: Calendar-day helpers

Two small pure functions everything downstream depends on. Isolated so their edge cases get their own test cycle.

**Files:**
- Modify: `supabase/schema.sql`
- Create: `supabase/tests/02_compliance.sql`
- Modify: `supabase/tests/run.sh`

**Interfaces:**
- Consumes: `app_settings.local_timezone`, `app_settings.adult_age_years`
- Produces: `public.site_today() returns date`; `public.compliance_required(p_dob date, p_registered_on date, p_departed_on date, p_day date, p_adult_age integer) returns boolean`

- [ ] **Step 1: Write the failing test**

Create `supabase/tests/02_compliance.sql`:

```sql
\set ON_ERROR_STOP on
\pset pager off

\echo '=========== CALENDAR-DAY HELPERS ==========='
\echo '--- site_today() follows app_settings.local_timezone, not the server clock'
update public.app_settings set local_timezone = 'Pacific/Kiritimati';  -- UTC+14
select public.site_today() as kiritimati_today;
update public.app_settings set local_timezone = 'Pacific/Midway';      -- UTC-11
select public.site_today() as midway_today;
update public.app_settings set local_timezone = 'Europe/Dublin';

\echo '--- compliance_required: the 18th-birthday boundary, computed per day'
select
  public.compliance_required(date '2008-08-10', date '2020-01-01', null, date '2026-08-09', 18) as day_before_18th,
  public.compliance_required(date '2008-08-10', date '2020-01-01', null, date '2026-08-10', 18) as on_18th_birthday,
  public.compliance_required(date '2008-08-10', date '2020-01-01', null, date '2026-08-11', 18) as day_after_18th;

\echo '--- compliance_required: registration and departure bound the duty'
select
  public.compliance_required(date '1990-01-01', date '2026-08-05', null,             date '2026-08-04', 18) as before_registration,
  public.compliance_required(date '1990-01-01', date '2026-08-05', null,             date '2026-08-05', 18) as on_registration_day,
  public.compliance_required(date '1990-01-01', date '2026-08-05', date '2026-08-20', date '2026-08-20', 18) as on_departure_day,
  public.compliance_required(date '1990-01-01', date '2026-08-05', date '2026-08-20', date '2026-08-21', 18) as after_departure;
```

Expected values: `day_before_18th=f, on_18th_birthday=t, day_after_18th=t`; `before_registration=f, on_registration_day=t, on_departure_day=t, after_departure=f`.

- [ ] **Step 2: Wire the new test file into the runner**

In `supabase/tests/run.sh`, after the existing acceptance-suite block, add:

```bash
echo "==> running compliance suite"
psql -q -v ON_ERROR_STOP=1 \
     -d hut -f "$HERE/02_compliance.sql" | tee -a "$WORK/out.txt"
```

- [ ] **Step 3: Run test to verify it fails**

Run: `./supabase/tests/run.sh`
Expected: FAIL with `function public.site_today() does not exist`.

- [ ] **Step 4: Write the helpers**

Add to `supabase/schema.sql` immediately after the role helpers (`is_admin`), before the `residents` table:

```sql
-- The current date at the site, not on the server. Every compliance decision
-- routes through this so there is exactly one definition of "a day".
create or replace function public.site_today()
returns date
language sql
stable
set search_path = public, extensions
as $$
  select (now() at time zone (select local_timezone from public.app_settings where id))::date;
$$;

-- Was the daily rule in force for this person on this specific day? Age is
-- computed as of p_day, never as of today — otherwise backfilling a resident's
-- history would retroactively apply the duty to days when they were 17.
create or replace function public.compliance_required(
  p_dob           date,
  p_registered_on date,
  p_departed_on   date,
  p_day           date,
  p_adult_age     integer
)
returns boolean
language sql
immutable
as $$
  select p_day >= p_registered_on
     and (p_departed_on is null or p_day <= p_departed_on)
     and p_dob <= (p_day - make_interval(years => p_adult_age))::date;
$$;
```

`site_today()` is `stable`, not `immutable` — it reads a table and the clock.
`compliance_required()` is `immutable` — pure arithmetic on its arguments.

Grant execute:

```sql
revoke all on function public.site_today() from anon, public;
revoke all on function public.compliance_required(date, date, date, date, integer) from anon, public;
grant execute on function public.site_today() to authenticated;
grant execute on function public.compliance_required(date, date, date, date, integer) to authenticated;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `./supabase/tests/run.sh`
Expected: PASS. `kiritimati_today` and `midway_today` differ by one day. The six boundary booleans match Step 1.

- [ ] **Step 6: Commit**

```bash
git add supabase/schema.sql supabase/tests/02_compliance.sql supabase/tests/run.sh
git commit -m "feat: add site_today and compliance_required calendar-day helpers"
```

---

### Task 3: `checkin_events` and `daily_compliance` tables

Tables and RLS only. The write path is Task 4.

**Files:**
- Modify: `supabase/schema.sql`
- Modify: `supabase/tests/02_compliance.sql`

**Interfaces:**
- Consumes: `public.residents`, `public.profiles`
- Produces: `public.checkin_events(id bigint, resident_id uuid, guard_id uuid, occurred_at timestamptz, note text)`; `public.daily_compliance(resident_id uuid, compliance_date date, required boolean, presented boolean, first_seen_at timestamptz, checkin_count integer, closed_at timestamptz)` with PK `(resident_id, compliance_date)`

- [ ] **Step 1: Write the failing test**

Append to `supabase/tests/02_compliance.sql`:

```sql
\echo ''
\echo '=========== LEDGER INTEGRITY ==========='
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select pg_temp.try('guard UPDATEs a checkin event',
                   'update public.checkin_events set note=''x'' where true');
select pg_temp.try('guard DELETEs a checkin event',
                   'delete from public.checkin_events where true');
select pg_temp.try('guard UPDATEs the register directly',
                   'update public.daily_compliance set presented=true where true');
select pg_temp.try('guard DELETEs a register row',
                   'delete from public.daily_compliance where true');
reset role;
```

`pg_temp.try` is defined in `01_acceptance.sql`, which runs first in the same session? **No** — each `psql -f` is a separate session, so `pg_temp` does not carry over. Copy the helper verbatim from `01_acceptance.sql` into the top of `02_compliance.sql`.

- [ ] **Step 2: Run test to verify it fails**

Run: `./supabase/tests/run.sh`
Expected: FAIL with `relation "public.checkin_events" does not exist`.

- [ ] **Step 3: Create the tables**

Add to `supabase/schema.sql` after the `gate_events` block:

```sql
-- Deliberate presentation at the hut. Separate from gate_events because a gate
-- sign-out does NOT satisfy the daily requirement: the duty is to present, not
-- merely to be seen leaving.
create table if not exists public.checkin_events (
  id          bigint generated always as identity primary key,
  resident_id uuid not null references public.residents (id) on delete cascade,
  guard_id    uuid not null references public.profiles (id) on delete restrict,
  occurred_at timestamptz not null default now(),
  note        text
);

create index if not exists checkin_events_resident_time_idx
  on public.checkin_events (resident_id, occurred_at desc, id desc);
create index if not exists checkin_events_time_idx
  on public.checkin_events (occurred_at desc);

-- The permanent register. Outlives checkin_events: the granular event log is
-- purged at 90 days for data minimisation, these rows are kept for the
-- statutory proof horizon.
create table if not exists public.daily_compliance (
  resident_id     uuid not null references public.residents (id) on delete cascade,
  compliance_date date not null,
  required        boolean not null,
  presented       boolean not null,
  first_seen_at   timestamptz,
  checkin_count   integer not null default 0,
  closed_at       timestamptz,
  primary key (resident_id, compliance_date),
  constraint presented_implies_seen check (presented = (first_seen_at is not null))
);

create index if not exists daily_compliance_date_idx
  on public.daily_compliance (compliance_date desc);
create index if not exists daily_compliance_breach_idx
  on public.daily_compliance (resident_id, compliance_date desc)
  where required and not presented;
```

- [ ] **Step 4: Enable RLS and add policies**

In the RLS section:

```sql
alter table public.checkin_events   enable row level security;
alter table public.daily_compliance enable row level security;

drop policy if exists checkin_events_read on public.checkin_events;
create policy checkin_events_read on public.checkin_events for select using (public.is_staff());

drop policy if exists daily_compliance_read on public.daily_compliance;
create policy daily_compliance_read on public.daily_compliance for select using (public.is_staff());
```

No insert, update or delete policy for any role. Both tables are written only by the `SECURITY DEFINER` functions in Tasks 4 and 6, which bypass RLS by design and enforce their own authorisation.

- [ ] **Step 5: Run tests to verify they pass**

Run: `./supabase/tests/run.sh`
Expected: PASS. All four `pg_temp.try` lines report `no-op` (0 rows) or `blocked`, never `ALLOWED`.

- [ ] **Step 6: Commit**

```bash
git add supabase/schema.sql supabase/tests/02_compliance.sql
git commit -m "feat: add checkin_events and daily_compliance tables with append-only RLS"
```

---

### Task 4: `record_checkin()` — the positive write path

Approach C, part one. The register row is written in the same transaction as the event.

**Files:**
- Modify: `supabase/schema.sql`
- Modify: `supabase/tests/02_compliance.sql`

**Interfaces:**
- Consumes: `site_today()`, `compliance_required()`, `checkin_events`, `daily_compliance`
- Produces: `public.record_checkin(p_resident_id uuid, p_note text default null) returns public.daily_compliance`

- [ ] **Step 1: Write the failing test**

Append to `supabase/tests/02_compliance.sql`:

```sql
\echo ''
\echo '=========== RECORD_CHECKIN ==========='
reset role;
select id as adult_id from public.residents where last_name='Brennan'  \gset
select id as minor_id from public.residents where last_name='Marchetti' \gset
delete from public.daily_compliance;
delete from public.checkin_events;

set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

\echo '--- first check-in creates the row'
select compliance_date = public.site_today() as dated_today, required, presented, checkin_count
from public.record_checkin(:'adult_id');

\echo '--- a second check-in 2 minutes later increments the count, keeps first_seen_at'
reset role;
update public.checkin_events set occurred_at = now() - interval '2 minutes';
update public.daily_compliance set first_seen_at = now() - interval '2 minutes';
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select checkin_count, first_seen_at < now() - interval '1 minute' as kept_earliest
from public.record_checkin(:'adult_id');

\echo '--- double tap within 60s does NOT inflate the count'
select checkin_count as after_double_tap from public.record_checkin(:'adult_id');

\echo '--- a minor gets a row with required=false'
select required as minor_required, presented as minor_presented
from public.record_checkin(:'minor_id');

\echo '--- attribution and authorisation'
select count(*) as events_attributed_to_guard from public.checkin_events
 where guard_id = '11111111-1111-1111-1111-111111111111';
set request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
select pg_temp.try('suspended account records a check-in',
                   'select public.record_checkin(' || quote_literal(:'adult_id') || ')');
reset role;
```

Expected: `dated_today=t, required=t, presented=t, checkin_count=1`; then `checkin_count=2, kept_earliest=t`; then `after_double_tap=2`; then `minor_required=f, minor_presented=t`; suspended account `blocked`.

- [ ] **Step 2: Run test to verify it fails**

Run: `./supabase/tests/run.sh`
Expected: FAIL with `function public.record_checkin(uuid) does not exist`.

- [ ] **Step 3: Write the function**

Add to `supabase/schema.sql` after `record_check`:

```sql
-- The only write path a guard has to the register.
--
-- SECURITY DEFINER for the same reason as record_check: guards hold no SELECT
-- on public.residents (it carries date_of_birth), so an invoker-rights version
-- could not read the resident's DOB to decide whether the rule applies. Safe to
-- elevate because it is closed — it re-checks is_staff() and takes the guard
-- identity from auth.uid(), never from an argument.
create or replace function public.record_checkin(
  p_resident_id uuid,
  p_note        text default null
)
returns public.daily_compliance
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_tz     text;
  v_adult  integer;
  v_now    timestamptz := now();
  v_day    date;
  v_res    public.residents;
  v_last   timestamptz;
  v_out    public.daily_compliance;
begin
  if not public.is_staff() then
    raise exception 'Not authorised to record check-ins' using errcode = '42501';
  end if;

  select local_timezone, adult_age_years into v_tz, v_adult
  from public.app_settings where id;

  select * into v_res from public.residents where id = p_resident_id;
  if not found then
    raise exception 'Resident not found' using errcode = 'P0002';
  end if;
  if v_res.status <> 'active' then
    raise exception 'Resident is not active and cannot check in' using errcode = '23514';
  end if;

  v_day := (v_now at time zone v_tz)::date;

  -- Touchscreens double-fire. A repeat inside 60 seconds is one presentation.
  select max(occurred_at) into v_last
  from public.checkin_events where resident_id = p_resident_id;

  if v_last is null or v_last < v_now - interval '60 seconds' then
    insert into public.checkin_events (resident_id, guard_id, occurred_at, note)
    values (p_resident_id, auth.uid(), v_now, nullif(btrim(p_note), ''));

    insert into public.daily_compliance as dc
      (resident_id, compliance_date, required, presented, first_seen_at, checkin_count)
    values (
      p_resident_id, v_day,
      public.compliance_required(
        v_res.date_of_birth,
        (v_res.registered_at at time zone v_tz)::date,
        v_res.departed_on, v_day, v_adult),
      true, v_now, 1)
    on conflict (resident_id, compliance_date) do update
      set presented     = true,
          first_seen_at = least(dc.first_seen_at, excluded.first_seen_at),
          checkin_count = dc.checkin_count + 1;
  end if;

  select * into v_out from public.daily_compliance
  where resident_id = p_resident_id and compliance_date = v_day;
  return v_out;
end;
$$;

revoke all on function public.record_checkin(uuid, text) from anon, public;
grant execute on function public.record_checkin(uuid, text) to authenticated;
```

`least()` ignores NULLs in PostgreSQL, so the `first_seen_at` merge is safe even if an earlier close-out wrote a NULL.

- [ ] **Step 4: Run tests to verify they pass**

Run: `./supabase/tests/run.sh`
Expected: PASS with the values from Step 1.

- [ ] **Step 5: Commit**

```bash
git add supabase/schema.sql supabase/tests/02_compliance.sql
git commit -m "feat: add record_checkin writing the register transactionally with the event"
```

---

### Task 5: `close_out_compliance_days()` — the negative write path

Approach C, part two. Writes only the rows for residents who never appeared, and backfills any gap.

**Files:**
- Modify: `supabase/schema.sql`
- Modify: `supabase/tests/02_compliance.sql`

**Interfaces:**
- Consumes: `site_today()`, `compliance_required()`, `daily_compliance`, `residents`
- Produces: `public.close_out_compliance_days(p_through date default null) returns integer` (count of rows written)

- [ ] **Step 1: Write the failing test**

Append to `supabase/tests/02_compliance.sql`:

```sql
\echo ''
\echo '=========== CLOSE-OUT AND BACKFILL ==========='
reset role;
delete from public.daily_compliance;
delete from public.checkin_events;
update public.residents set registered_at = now() - interval '10 days';

\echo '--- a 10-day outage: one run backfills every missing day'
select public.close_out_compliance_days() as rows_written;
select count(*) as distinct_days, count(*) filter (where presented) as any_presented
from (select distinct compliance_date, presented from public.daily_compliance) d;

\echo '--- idempotency: a second run writes nothing and overwrites nothing'
select public.close_out_compliance_days() as second_run_rows;

\echo '--- close-out never overwrites a recorded presence'
select id as adult_id from public.residents where last_name='Brennan' \gset
delete from public.daily_compliance where resident_id = :'adult_id' and compliance_date = public.site_today() - 1;
insert into public.daily_compliance (resident_id, compliance_date, required, presented, first_seen_at, checkin_count)
values (:'adult_id', public.site_today() - 1, true, true, now() - interval '1 day', 1);
select public.close_out_compliance_days() as third_run_rows;
select presented as still_presented from public.daily_compliance
 where resident_id = :'adult_id' and compliance_date = public.site_today() - 1;

\echo '--- today is left open; only completed days are closed'
select count(*) as open_rows_today from public.daily_compliance
 where compliance_date = public.site_today() and closed_at is null;
select count(*) as unclosed_past_rows from public.daily_compliance
 where compliance_date < public.site_today() and closed_at is null;

\echo '--- the minor is required=false on every backfilled day'
select bool_and(required = false) as minor_never_required
from public.daily_compliance dc
join public.residents r on r.id = dc.resident_id
where r.last_name = 'Marchetti';
```

Expected: `distinct_days=10, any_presented=0`; `second_run_rows=0`; `third_run_rows=0` and `still_presented=t`; `open_rows_today=0`; `unclosed_past_rows=0`; `minor_never_required=t`.

- [ ] **Step 2: Run test to verify it fails**

Run: `./supabase/tests/run.sh`
Expected: FAIL with `function public.close_out_compliance_days() does not exist`.

- [ ] **Step 3: Write the function**

Add to `supabase/schema.sql` after `record_checkin`:

```sql
-- Closes out completed days by writing the rows record_checkin never wrote:
-- residents who did not present. Idempotent and self-healing — it recomputes
-- the range from the register itself, so a cron outage of any length is
-- repaired by the next run.
--
-- Deliberately writes ONLY negative rows. Positive rows are written by
-- record_checkin in the same transaction as the event, so a failure of this
-- job can never destroy evidence that someone did attend.
create or replace function public.close_out_compliance_days(p_through date default null)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_tz      text;
  v_adult   integer;
  v_through date;
  v_from    date;
  v_day     date;
  v_written integer := 0;
  v_batch   integer;
begin
  select local_timezone, adult_age_years into v_tz, v_adult
  from public.app_settings where id;

  -- Never close the day in progress.
  v_through := least(
    coalesce(p_through, (now() at time zone v_tz)::date - 1),
    (now() at time zone v_tz)::date - 1
  );

  -- Resume from the day after the last closed one; on a fresh database, start
  -- at the earliest registration.
  select coalesce(
           (select max(compliance_date) + 1 from public.daily_compliance where closed_at is not null),
           (select min((registered_at at time zone v_tz)::date) from public.residents)
         )
    into v_from;

  if v_from is null or v_from > v_through then
    return 0;
  end if;

  for v_day in select d::date from generate_series(v_from, v_through, interval '1 day') d loop
    insert into public.daily_compliance
      (resident_id, compliance_date, required, presented, first_seen_at, checkin_count, closed_at)
    select
      r.id, v_day,
      public.compliance_required(
        r.date_of_birth, (r.registered_at at time zone v_tz)::date,
        r.departed_on, v_day, v_adult),
      false, null, 0, now()
    from public.residents r
    where (r.registered_at at time zone v_tz)::date <= v_day
      and (r.departed_on is null or r.departed_on >= v_day)
    on conflict (resident_id, compliance_date) do nothing;

    get diagnostics v_batch = row_count;
    v_written := v_written + v_batch;

    -- Rows written during the day by record_checkin are still open. Close them
    -- without touching presented, first_seen_at or checkin_count.
    update public.daily_compliance
       set closed_at = now()
     where compliance_date = v_day and closed_at is null;
  end loop;

  return v_written;
end;
$$;

revoke all on function public.close_out_compliance_days(date) from anon, public;
```

No `grant execute` — this runs as `pg_cron` (which executes as the database owner) or is invoked manually by an admin via the SQL editor. Guards never call it.

- [ ] **Step 4: Document the cron schedule**

In the scheduled-jobs comment block at the end of `supabase/schema.sql`, add alongside the existing purge:

```sql
--   select cron.schedule(
--     'close-out-compliance-days',
--     '30 0 * * *',                        -- 00:30 UTC daily, after midnight in Europe/Dublin
--     $$ select public.close_out_compliance_days(); $$
--   );
```

Note in the comment: if the site timezone is far from UTC, move this so it runs after local midnight; running early only defers rows to the next run, it never writes a wrong day, because `v_through` is clamped to yesterday in site time.

- [ ] **Step 5: Run tests to verify they pass**

Run: `./supabase/tests/run.sh`
Expected: PASS with the values from Step 1.

- [ ] **Step 6: Commit**

```bash
git add supabase/schema.sql supabase/tests/02_compliance.sql
git commit -m "feat: add idempotent close-out job with gap backfill"
```

---

### Task 6: Annotations, compliance view, and the Attention list

The read model the front end consumes, plus the "flag but never suppress" write path.

**Files:**
- Modify: `supabase/schema.sql`
- Modify: `supabase/tests/02_compliance.sql`

**Interfaces:**
- Consumes: `daily_compliance`, `residents`, `app_settings`
- Produces: `public.compliance_annotations(id bigint, resident_id uuid, compliance_date date, note text, author_id uuid, created_at timestamptz)`; view `public.v_resident_compliance` with columns `id, full_name, room_ref, status, age_years, required_today, seen_today, checkins_today, state, open_breaches, noted_breaches, consecutive_missed, last_seen_on`; `public.annotate_compliance_day(p_resident_id uuid, p_date date, p_note text) returns public.compliance_annotations`; `public.attention_list(max_results integer default 200) returns setof public.v_resident_compliance`

- [ ] **Step 1: Write the failing test**

Append to `supabase/tests/02_compliance.sql`:

```sql
\echo ''
\echo '=========== STATES AND ATTENTION LIST ==========='
reset role;
delete from public.compliance_annotations;
delete from public.daily_compliance;
delete from public.checkin_events;
select id as adult_id from public.residents where last_name='Brennan' \gset
select id as other_id from public.residents where last_name='Haddad'  \gset

-- Brennan: missed the last 3 completed days. Haddad: missed 1, explained.
insert into public.daily_compliance (resident_id, compliance_date, required, presented, checkin_count, closed_at)
select :'adult_id', public.site_today() - g, true, false, 0, now() from generate_series(1,3) g;
insert into public.daily_compliance (resident_id, compliance_date, required, presented, checkin_count, closed_at)
values (:'other_id', public.site_today() - 1, true, false, 0, now());

set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

\echo '--- an annotation records a reason without changing the outcome'
select compliance_date = public.site_today() - 1 as dated_yesterday
from public.annotate_compliance_day(:'other_id', public.site_today() - 1, 'In hospital, ward confirmed');
select presented as still_not_presented from public.daily_compliance
 where resident_id = :'other_id' and compliance_date = public.site_today() - 1;

\echo '--- states and consecutive-miss ordering'
select full_name, state, open_breaches, noted_breaches, consecutive_missed
from public.attention_list() order by consecutive_missed desc, full_name;

\echo '--- checking in flips today''s state'
select state as before_checkin from public.v_resident_compliance where id = :'adult_id';
select 1 as _ from public.record_checkin(:'adult_id') limit 1;
select state as after_checkin, seen_today from public.v_resident_compliance where id = :'adult_id';

\echo '--- annotations are append-only'
select pg_temp.try('guard edits an annotation',
                   'update public.compliance_annotations set note=''changed'' where true');
select pg_temp.try('guard deletes an annotation',
                   'delete from public.compliance_annotations where true');
reset role;
```

Expected: `dated_yesterday=t`; `still_not_presented=f`; Brennan `state=breach_open, open_breaches=3, consecutive_missed=3`, Haddad `state=breach_noted, open_breaches=0, noted_breaches=1`; `before_checkin=breach_open`, `after_checkin=breach_open` with `seen_today=t` (today satisfied, past breaches remain); both `pg_temp.try` lines `no-op` or `blocked`.

- [ ] **Step 2: Run test to verify it fails**

Run: `./supabase/tests/run.sh`
Expected: FAIL with `relation "public.compliance_annotations" does not exist`.

- [ ] **Step 3: Create the annotations table**

Add after `daily_compliance`:

```sql
-- Append-only. A separate table rather than columns on daily_compliance so that
-- adding context later never overwrites what someone wrote before, and so that
-- no annotation can alter the outcome it explains.
create table if not exists public.compliance_annotations (
  id              bigint generated always as identity primary key,
  resident_id     uuid not null,
  compliance_date date not null,
  note            text not null check (length(btrim(note)) > 0),
  author_id       uuid not null references public.profiles (id) on delete restrict,
  created_at      timestamptz not null default now(),
  foreign key (resident_id, compliance_date)
    references public.daily_compliance (resident_id, compliance_date) on delete cascade
);

create index if not exists compliance_annotations_day_idx
  on public.compliance_annotations (resident_id, compliance_date);
```

RLS, in the policies section:

```sql
alter table public.compliance_annotations enable row level security;
drop policy if exists compliance_annotations_read on public.compliance_annotations;
create policy compliance_annotations_read on public.compliance_annotations
  for select using (public.is_staff());
```

No insert policy — writes go through `annotate_compliance_day()`.

- [ ] **Step 4: Create the view**

Add after `v_check_log`:

```sql
create or replace view public.v_resident_compliance as
with s as (select * from public.app_settings where id),
today as (select public.site_today() as d),
tally as (
  select
    dc.resident_id,
    count(*) filter (where dc.required and not dc.presented
                       and not exists (select 1 from public.compliance_annotations a
                                        where a.resident_id = dc.resident_id
                                          and a.compliance_date = dc.compliance_date))::integer as open_breaches,
    count(*) filter (where dc.required and not dc.presented
                       and exists (select 1 from public.compliance_annotations a
                                    where a.resident_id = dc.resident_id
                                      and a.compliance_date = dc.compliance_date))::integer as noted_breaches,
    max(dc.compliance_date) filter (where dc.presented) as last_seen_on
  from public.daily_compliance dc
  where dc.closed_at is not null
  group by dc.resident_id
),
-- Consecutive required-and-missed days counting back from the last completed day.
streak as (
  select d.resident_id,
         count(*)::integer as consecutive_missed
  from (
    select dc.*,
           row_number() over (partition by dc.resident_id order by dc.compliance_date desc) as rn,
           sum(case when dc.presented or not dc.required then 1 else 0 end)
             over (partition by dc.resident_id order by dc.compliance_date desc
                   rows between unbounded preceding and current row) as breaks
    from public.daily_compliance dc
    where dc.closed_at is not null
  ) d
  where d.breaks = 0
  group by d.resident_id
),
todayrow as (
  select dc.resident_id, dc.presented, dc.checkin_count, dc.required
  from public.daily_compliance dc, today
  where dc.compliance_date = today.d
)
select
  r.id,
  btrim(r.first_name) || ' ' || btrim(r.last_name) as full_name,
  r.room_ref,
  r.status,
  (date_part('year', age(r.date_of_birth)))::integer as age_years,
  public.compliance_required(r.date_of_birth, (r.registered_at at time zone s.local_timezone)::date,
                             r.departed_on, today.d, s.adult_age_years) as required_today,
  coalesce(tr.presented, false) as seen_today,
  coalesce(tr.checkin_count, 0) as checkins_today,
  coalesce(t.open_breaches, 0)  as open_breaches,
  coalesce(t.noted_breaches, 0) as noted_breaches,
  coalesce(st.consecutive_missed, 0) as consecutive_missed,
  t.last_seen_on,
  case
    when r.status <> 'active' then 'not_required'
    when not public.compliance_required(r.date_of_birth, (r.registered_at at time zone s.local_timezone)::date,
                                        r.departed_on, today.d, s.adult_age_years) then 'exempt'
    when coalesce(t.open_breaches, 0) > 0 then 'breach_open'
    when coalesce(t.noted_breaches, 0) > 0 then 'breach_noted'
    when coalesce(tr.presented, false) then 'seen_today'
    when t.last_seen_on is null and coalesce(t.noted_breaches,0) = 0
         and not exists (select 1 from public.daily_compliance x
                          where x.resident_id = r.id and x.presented) then 'never'
    when date_part('hour', now() at time zone s.local_timezone) >= s.due_soon_after_hour then 'due_today'
    else 'expected'
  end as state
from public.residents r
cross join s
cross join today
left join tally    t  on t.resident_id  = r.id
left join streak   st on st.resident_id = r.id
left join todayrow tr on tr.resident_id = r.id
where public.is_staff();

revoke all on public.v_resident_compliance from anon, public;
grant select on public.v_resident_compliance to authenticated;
```

State precedence is deliberate: an open breach outranks "seen today", because clearing today does not clear a missed Tuesday. The front end shows both — `state` for the badge, `seen_today` for the tick.

- [ ] **Step 5: Add the write path and the list**

```sql
create or replace function public.annotate_compliance_day(
  p_resident_id uuid,
  p_date        date,
  p_note        text
)
returns public.compliance_annotations
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_out public.compliance_annotations;
begin
  if not public.is_staff() then
    raise exception 'Not authorised to annotate the register' using errcode = '42501';
  end if;
  if not exists (select 1 from public.daily_compliance
                  where resident_id = p_resident_id and compliance_date = p_date) then
    raise exception 'No register row for that resident and date' using errcode = 'P0002';
  end if;

  insert into public.compliance_annotations (resident_id, compliance_date, note, author_id)
  values (p_resident_id, p_date, btrim(p_note), auth.uid())
  returning * into v_out;
  return v_out;
end;
$$;

create or replace function public.attention_list(max_results integer default 200)
returns setof public.v_resident_compliance
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select *
  from public.v_resident_compliance
  where public.is_staff()
    and status = 'active'
    and (state in ('breach_open', 'breach_noted', 'never', 'due_today'))
  order by
    -- Unexplained first, then explained, then today's gap. Explained breaches
    -- are demoted but never removed: suppression happens in the guard's
    -- attention, never in the record.
    case state when 'breach_open' then 0 when 'never' then 1
               when 'breach_noted' then 2 else 3 end,
    consecutive_missed desc,
    open_breaches desc,
    full_name
  limit greatest(1, least(coalesce(max_results, 200), 500));
$$;

revoke all on function public.annotate_compliance_day(uuid, date, text) from anon, public;
revoke all on function public.attention_list(integer) from anon, public;
grant execute on function public.annotate_compliance_day(uuid, date, text) to authenticated;
grant execute on function public.attention_list(integer) to authenticated;
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `./supabase/tests/run.sh`
Expected: PASS with the values from Step 1.

- [ ] **Step 7: Commit**

```bash
git add supabase/schema.sql supabase/tests/02_compliance.sql
git commit -m "feat: add compliance annotations, state view and attention list"
```

---

### Task 7: Retention split and GDPR coverage

The defect that motivated the spec: the register must outlive the movement log, and both must be covered by export and erasure.

**Files:**
- Modify: `supabase/schema.sql`
- Modify: `supabase/tests/02_compliance.sql`

**Interfaces:**
- Consumes: `app_settings.event_retention_days`, `app_settings.compliance_retention_days`
- Produces: `public.purge_expired_checkin_events() returns integer`; `public.purge_expired_compliance() returns integer`; `export_resident_record()` and `erase_resident()` extended

- [ ] **Step 1: Write the failing test**

Append to `supabase/tests/02_compliance.sql`:

```sql
\echo ''
\echo '=========== RETENTION AND GDPR ==========='
reset role;
select id as adult_id from public.residents where last_name='Brennan' \gset

-- One old check-in event and one old register row, both beyond the event window.
insert into public.checkin_events (resident_id, guard_id, occurred_at)
values (:'adult_id', '11111111-1111-1111-1111-111111111111', now() - interval '200 days');
insert into public.daily_compliance (resident_id, compliance_date, required, presented, first_seen_at, checkin_count, closed_at)
values (:'adult_id', public.site_today() - 200, true, true, now() - interval '200 days', 1, now())
on conflict do nothing;

\echo '--- the movement log is purged at 90 days'
select public.purge_expired_checkin_events() as events_purged;
select count(*) as old_events_left from public.checkin_events
 where occurred_at < now() - interval '100 days';

\echo '--- but the register survives: this is the defect the spec fixes'
select count(*) as old_register_rows_kept from public.daily_compliance
 where compliance_date = public.site_today() - 200;

\echo '--- the register is purged at its own, longer horizon'
update public.app_settings set compliance_retention_days = 30;
select public.purge_expired_compliance() as register_rows_purged;
select count(*) as old_register_rows_left from public.daily_compliance
 where compliance_date < public.site_today() - 30;
update public.app_settings set compliance_retention_days = 2555;

\echo '--- export includes the register; erasure removes it'
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select public.export_resident_record(:'adult_id') ? 'daily_compliance' as export_has_register;
select public.erase_resident(:'adult_id', 'test') is not null as erased;
reset role;
select count(*) as register_rows_after_erasure from public.daily_compliance where resident_id = :'adult_id';
select count(*) as annotations_after_erasure  from public.compliance_annotations where resident_id = :'adult_id';
```

Expected: `old_events_left=0`; `old_register_rows_kept=1`; `old_register_rows_left=0`; `export_has_register=t`; `erased=t`; both post-erasure counts `0`.

- [ ] **Step 2: Run test to verify it fails**

Run: `./supabase/tests/run.sh`
Expected: FAIL with `function public.purge_expired_checkin_events() does not exist`.

- [ ] **Step 3: Add the purge functions**

```sql
create or replace function public.purge_expired_checkin_events()
returns integer
language plpgsql security definer set search_path = public, extensions
as $$
declare v_days integer; v_deleted integer;
begin
  select event_retention_days into v_days from public.app_settings where id;
  delete from public.checkin_events where occurred_at < now() - make_interval(days => v_days);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- The register outlives the events it was derived from. Deleting these rows
-- destroys the only proof of daily reporting, so this window is separate from
-- and much longer than event_retention_days.
create or replace function public.purge_expired_compliance()
returns integer
language plpgsql security definer set search_path = public, extensions
as $$
declare v_days integer; v_deleted integer;
begin
  select compliance_retention_days into v_days from public.app_settings where id;
  delete from public.daily_compliance
   where compliance_date < (public.site_today() - v_days);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.purge_expired_checkin_events() from anon, public;
revoke all on function public.purge_expired_compliance() from anon, public;
```

Annotations cascade via their foreign key — no separate purge.

- [ ] **Step 4: Extend export and erasure**

In `export_resident_record()`, add to the `jsonb_build_object`:

```sql
    'daily_compliance', coalesce((
      select jsonb_agg(jsonb_build_object(
               'date', dc.compliance_date,
               'required', dc.required,
               'presented', dc.presented,
               'checkins', dc.checkin_count,
               'annotations', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'note', a.note, 'at', a.created_at, 'by', p.full_name) order by a.created_at)
                 from public.compliance_annotations a
                 join public.profiles p on p.id = a.author_id
                 where a.resident_id = dc.resident_id and a.compliance_date = dc.compliance_date
               ), '[]'::jsonb)
             ) order by dc.compliance_date)
      from public.daily_compliance dc where dc.resident_id = r.id
    ), '[]'::jsonb),
```

Also rename the existing `check_events` key in that object to `gate_events` and add a `checkin_events` key with the same shape (direction omitted).

`erase_resident()` needs no change — `daily_compliance` and `compliance_annotations` both cascade from `residents`. Add the register row count to its return payload:

```sql
  select count(*)::integer into v_register from public.daily_compliance where resident_id = p_resident_id;
```
and include `'register_rows_removed', v_register` in the returned JSON. Declare `v_register integer;`.

- [ ] **Step 5: Document the cron schedules**

Extend the comment block:

```sql
--   select cron.schedule('purge-expired-checkin-events', '20 3 * * *',
--     $$ select public.purge_expired_checkin_events(); $$);
--   select cron.schedule('purge-expired-compliance', '25 3 * * *',
--     $$ select public.purge_expired_compliance(); $$);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `./supabase/tests/run.sh`
Expected: PASS with the values from Step 1.

- [ ] **Step 7: Commit**

```bash
git add supabase/schema.sql supabase/tests/02_compliance.sql
git commit -m "feat: split retention so the register outlives the movement log"
```

---

### Task 8: `checkin.html` front end

Second static file, same patterns as `index.html`: dark high-contrast UI, large touch targets, delegated click handling, `esc()` on every interpolated value.

**Files:**
- Create: `app-common.css`, `app-common.js`, `checkin.html`
- Modify: `index.html`, `vercel.json`

**Interfaces:**
- Consumes: `search_residents(q, include_departed, max_results)`, `record_checkin(p_resident_id, p_note)`, `attention_list(max_results)`, `annotate_compliance_day(p_resident_id, p_date, p_note)`, view `v_resident_compliance`, table `daily_compliance`
- Produces: `app-common.js` globals `esc(v)`, `toast(msg, kind)`, `ago(iso)`, `showError(msg, elId)`, `createHutClient(config)`, `mountLogin({onReady})`

- [ ] **Step 1: Extract the shared layer out of `index.html`**

Ruled by the human partner ahead of execution: the two apps share one stylesheet and one helper script rather than duplicating ~250 lines. Still no build step — two extra `<link>`/`<script>` tags pointing at static files.

Create `app-common.css` containing the entire `<style>` block currently inside `index.html`, unchanged.

Create `app-common.js` containing, moved verbatim from `index.html`'s inline script: `esc()`, `toast()`, `ago()`, `showError()`, the `$` shorthand, the supabase-client guard and `createClient` call (wrapped as `createHutClient(config)` returning the client), and the login form markup handler. Everything else — the tabs, search, and the gate-specific rendering — stays in `index.html`.

`showError()` currently hardcodes the element id `appError`; give it a second parameter defaulting to `"appError"` so `checkin.html` can reuse it.

Then in `index.html`, replace the removed blocks with:

```html
<link rel="stylesheet" href="/app-common.css">
...
<script src="/app-common.js"></script>
```

Keep the CDN `<script>` tag and its `integrity` hash in **both** HTML files, ahead of `app-common.js`. Do not re-derive the hash — it is `sha384-KX6Y/AMIv9qA8TLCDul2JatZWeyrJVgj3Xu/0r30Nr05xO8md1+wHAgtdsRV9LoE` for `@supabase/supabase-js@2.58.0`.

Verify `index.html` still renders and still logs in before touching `checkin.html`: re-run the mock-client render described in Step 5 against `index.html`. A regression here breaks the working gate app, which the plan otherwise leaves untouched.

- [ ] **Step 1b: Create `checkin.html`**

Start with the same head — `app-common.css`, the CDN tag, `app-common.js` — plus the login section markup. Set `<title>` to `Hut Check-In — Daily Register`. Everything below is check-in specific.

No CSP change is needed: `vercel.json` already allows `script-src 'self'` and `style-src 'self'`, which cover both new files.

- [ ] **Step 2: Build the two tabs**

Replace the three-tab nav with two: `Check in` and `Attention`. Header counters become `Not seen today`, `Open breaches`, `Check-ins today`, sourced from `attention_list()` and `v_resident_compliance`.

Check-in tab: reuse the search input and debounce from `index.html` verbatim, calling `search_residents`. Render result cards showing name, room, age, and the compliance badge from `state`. Selecting a resident opens a detail panel with one large primary button:

```html
<button class="btn primary-in wide" id="doCheckin" type="button">Record check-in</button>
```

```js
async function checkin(residentId) {
  if (state.busy) return;
  state.busy = true;
  const { data, error } = await sb.rpc("record_checkin", {
    p_resident_id: residentId, p_note: null,
  });
  state.busy = false;
  if (error) { toast("Not recorded: " + error.message, "err"); return; }
  const row = Array.isArray(data) ? data[0] : data;
  toast(`Check-in recorded — ${row.checkin_count > 1 ? "already seen today" : "day satisfied"}`, "ok");
  refreshSummary();
  if ($("q").value.trim().length >= 2) runSearch($("q").value);
}
```

- [ ] **Step 3: Build the Attention tab and the 30-day strip**

```js
async function loadAttention() {
  const { data, error } = await sb.rpc("attention_list", { max_results: 200 });
  if (error) { showError("Could not load the attention list: " + error.message); return; }
  showError("");
  renderList($("attentionList"), data, "Nobody is outstanding.");
}
```

Cards in `state === 'breach_noted'` get class `noted` — `opacity:.6` — so they are demoted but visibly present. Never filter them out.

The detail panel shows the last 30 days:

```js
async function loadStrip(residentId) {
  const from = new Date(Date.now() - 29 * 86400e3).toISOString().slice(0, 10);
  const { data } = await sb.from("daily_compliance")
    .select("compliance_date, required, presented")
    .eq("resident_id", residentId).gte("compliance_date", from)
    .order("compliance_date", { ascending: true });
  return (data || []).map(d =>
    `<i class="cell ${!d.required ? "na" : d.presented ? "ok" : "miss"}" title="${esc(d.compliance_date)}"></i>`
  ).join("");
}
```

CSS: `.cell{display:inline-block;width:10px;height:18px;margin:1px;border-radius:2px}` with `.ok{background:var(--ok)} .miss{background:var(--bad)} .na{background:var(--surface-2)}`.

Clicking a missed cell opens a prompt and calls:

```js
await sb.rpc("annotate_compliance_day", {
  p_resident_id: residentId, p_date: cellDate, p_note: noteText,
});
```

- [ ] **Step 4: Add the route to `vercel.json`**

Add a cache header entry mirroring the `/index.html` one:

```json
{
  "source": "/checkin.html",
  "headers": [
    { "key": "Cache-Control", "value": "public, max-age=0, must-revalidate" }
  ]
}
```

The existing CSP block already covers all paths via `"source": "/(.*)"` — no CSP change needed.

- [ ] **Step 5: Verify it parses and renders**

```bash
node -e "
const fs=require('fs'),vm=require('vm');
const h=fs.readFileSync('checkin.html','utf8');
[...h.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
  .forEach((m,i)=>new vm.Script(m[1],{filename:'b'+i}));
JSON.parse(fs.readFileSync('vercel.json','utf8'));
console.log('checkin.html parses, vercel.json valid');
"
```
Expected: `checkin.html parses, vercel.json valid`

Then render it against a mock client, exactly as `index.html` was verified: serve the directory, stub `window.supabase.createClient` with fixtures returning `v_resident_compliance` row shapes, drive it with Playwright (`executablePath: '/opt/pw-browsers/chromium'`), and screenshot the check-in tab, a resident detail with the strip, and the Attention tab. Confirm zero `pageerror` events and that a `breach_noted` card is visibly present but demoted.

- [ ] **Step 6: Commit**

```bash
git add checkin.html vercel.json
git commit -m "feat: add check-in front end for the daily register"
```

---

### Task 9: Documentation

**Files:**
- Modify: `README.md`, `docs/GDPR.md`, `docs/TECH-STACK.md`

- [ ] **Step 1: Update `README.md`**

Rewrite the intro to describe two apps and the shared backend. Replace the "The 24-hour rule" section's state table with the calendar-day states from Task 6. Add `checkin.html` to the file map. Add the two new cron schedules to the setup steps, and note that `close_out_compliance_days()` must be scheduled or the register will only ever contain positive rows. In "Notes for whoever maintains this", add: `record_checkin()` is `SECURITY DEFINER` for the same reason as `record_check()`; do not add a `guard_id` parameter.

- [ ] **Step 2: Update `docs/GDPR.md`**

In "What is held", add rows for `checkin_events` (deliberate presentation) and `daily_compliance` (daily attendance register, retained for the statutory period). Replace the single retention statement with the split table from the spec. Add to the go-live checklist: set `compliance_retention_days` to the real statutory period, and confirm `close-out-compliance-days` is scheduled. Add a paragraph noting the register is deliberately minimal — resident, date, two booleans, a count — which is what makes retaining it for years proportionate.

- [ ] **Step 3: Update `docs/TECH-STACK.md`**

Note in the closing section that there are now two static front ends sharing one backend, which strengthens the hosting-portability argument rather than weakening it.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/GDPR.md docs/TECH-STACK.md
git commit -m "docs: cover the two-app split and the retention horizons"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: decision 1 → Tasks 2 and 6; decision 2 → Task 6 (annotations, demotion ordering); decision 3 → Task 7; decision 4 → Tasks 4 and 5; decision 5 → no task, correctly, escalation is out of scope; decision 6 → Task 1 (`gate_events` keeps only `in`/`out`) and Task 3 (separate `checkin_events`). Shared-core changes → Task 1. Data model → Tasks 1, 3, 6. States → Task 6. Front end → Task 8. Failure modes → Tasks 4, 5, 7 tests. Testing → covered across all tasks. Follow-on gate-app trim → deliberately excluded.

**Placeholder scan.** No TBD/TODO. Every code step carries real code. The one word "PLACEHOLDER" appears inside a SQL comment on `compliance_retention_days` and is intentional — it marks a value the operator must set, per the spec, not missing plan content.

**Type consistency.** `record_checkin` returns `public.daily_compliance` in both its definition (Task 4) and its front-end consumer (Task 8, which reads `row.checkin_count`). `attention_list` returns `setof public.v_resident_compliance`, matching the view defined in the same task. `compliance_required` takes the same five arguments in its definition (Task 2), in `record_checkin` (Task 4), in `close_out_compliance_days` (Task 5) and in the view (Task 6). `site_today()` is used identically throughout. Column names `presented`, `required`, `checkin_count`, `first_seen_at`, `closed_at`, `consecutive_missed`, `open_breaches`, `noted_breaches`, `state` are consistent between Tasks 3, 5, 6 and 8.

**One risk flagged for the implementer.** The `streak` CTE in Task 6 uses a running-sum window to count consecutive missed days. If its expected value in the Task 6 test does not come out as 3, the likely cause is that `not required` days should break a streak rather than be skipped — decide against the spec's intent (consecutive *required* days missed) and fix the CTE, not the test.
