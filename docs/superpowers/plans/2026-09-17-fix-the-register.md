# Fix the Register Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff can take a wrong entry off the register (a check-in or an in/out movement) and add a missed one at a past time — every correction on the audit trail, the derived records (the day's register row, the overnight-absence record) recomputed so the Absences tab, the nightly email and the Sunday return read right.

**Architecture:** The register stays append-only in spirit: a removal is a `delete` of the event row inside a SECURITY DEFINER function that first copies the whole row to `admin_audit` (action `delete`, `old_row`, the reason as `note`), so the inspection view (register + audit) still shows what was recorded, by whom, and why it was corrected. Because the row is gone, every existing reader (`v_resident_status`, close-out, the snapshots, the conflicts view, reports, history) is right without change; the two stored derivations — `daily_compliance` for that day and `overnight_absences` for the affected nights — are recomputed by the same function. Adding a missed entry reuses `record_checkin_at()` (051) and the gate insert of `record_check_late()` (010), marked `by_hand`. Two routes in a new `routes/registerFix.js`; the shared History panel (`public/app-common.js mountHistory()`) grows a Remove action per row and an "Add a missed entry" form.

**Owner's ruling (17 Sep 2026):** "Staff need to be able to fix incorrect records and manually check someone in … fix incorrect check-in, or almost anything in it … flexibility is better because of human error, so the guards should be able to undo too."

**Tech Stack:** Node 22, Express, Postgres 16, `node:test`, `test/compliance.sql`, `./check.sh`.

## Global Constraints

- Work on `main`; commit per task; never push (the controller pushes).
- `./check.sh` needs `PGBIN=/opt/homebrew/opt/postgresql@16/bin`; one run at a time (scratch cluster port 54329). `test/sql.sh` runs the DB suite alone.
- Migrations hard-code `public.`; new COLUMNS on per-tenant tables get the `do $$ … like 't\_%' escape '\' …$$` loop (052 pattern); new FUNCTIONS do not (the template carries them; `tenant_schema_gaps()` reports a behind tenant). After any migration change: `./tools/gen-tenant-template.sh`, commit `tenant/template.sql`.
- **The rules, exactly:**
  - *Remove* an entry whose site-local day is today: any staff member (`is_staff()`). No reason needed when it is the caller's own entry (`guard_id = auth.uid()`) recorded less than 15 minutes ago (`coalesce(recorded_at, occurred_at) > now() - interval '15 minutes'`); otherwise a reason of 1–200 characters is required.
  - *Remove* an entry from an earlier day: `is_supervisor()` and a reason, always.
  - *Add* an entry at a past time: any staff member when `p_at >= now() - late_entry_window_hours` (app_settings, default 48); `is_supervisor()` when older, and never older than `site_today() - 28` days. Never in the future (`p_at > now() + interval '5 minutes'` refused, as `assert_late_entry_window`). A reason of 1–200 characters is always required.
  - A kiosk session (`my_role() = 'kiosk'`) can do neither: `is_staff()` is false for it.
- Every removal and addition writes one `admin_audit` row: removal `action = 'delete'`, `old_row = to_jsonb(the event)`, `note = reason` (or `'own entry, within 15 minutes'` when no reason was given); addition `action = 'insert'`, `new_row = to_jsonb(the new event)`, `note = reason`. `table_name` is `'checkin_events'` or `'gate_events'`, `row_id` the event id as text.
- Wording in the UI and docs: "Remove from the register" / "Recorded in error", "Add a missed entry", "entered by hand". Never "delete" or "edit" in user-facing copy.
- The daily register sheet, the kiosk and offline sync are not touched.
- Migrations up to 055 are deployed; 056 is new.

---

### Task 1: Migration 056 — the two functions and their recomputations

**Files:**
- Create: `migrations/056_fix_the_register.sql`
- Regenerate: `tenant/template.sql`
- Test: `test/compliance.sql` (append a `-- 056` block, using `pg_temp.expect` / `pg_temp.try` as the 053/054 blocks do; fixed uuids: guard `11111111-…`, supervisor `22222222-…`, admin `33333333-…` — read the top of the file for the exact ids and the `set role authenticated; set request.jwt.claim.sub` pattern)

**Interfaces:**
- Produces: `public.remove_register_entry(p_register text, p_id bigint, p_reason text) returns void` — `p_register in ('checkin', 'gate')`.
- Produces: `public.add_register_entry(p_register text, p_resident_id uuid, p_direction text, p_at timestamptz, p_reason text) returns bigint` (the new event id) — `p_direction` is `'in'`/`'out'` for `gate`, ignored (null) for `checkin`.
- Produces: `public.recompute_overnight_absences(p_resident_id uuid, p_from date, p_to date) returns integer` (owner-side helper; nights re-derived).
- Produces: columns `checkin_events.by_hand boolean not null default false`, `gate_events.by_hand boolean not null default false`.

- [ ] **Step 1: The migration**

```sql
-- 056_fix_the_register.sql — a wrong entry comes off the register; a
-- missed one goes on at the time it happened.
--
-- 17 September 2026, the owner: staff must be able to fix an incorrect
-- check-in or movement and record one that was missed, and guards too —
-- "flexibility is better because of human error". The register is the
-- inspection evidence, so nothing is edited in place: a removal copies the
-- whole row to admin_audit (action delete, the reason as the note) and then
-- deletes it, so every reader of the register is right without change and
-- the audit trail still says what was recorded, by whom, and why it went.
-- Two stored derivations have to follow the change by hand: the day's
-- daily_compliance row (a removed check-in can make a day missed again; a
-- check-in added to a closed day is what record_checkin_at() already does)
-- and overnight_absences for the nights a movement decides (027's snapshot,
-- re-derived for that resident over the nights between the changed event
-- and the next one). overnight_guardian_gaps (054) is NOT re-derived: it is
-- the record of what the register said at midnight, the nightly email has
-- already gone, and the correction is on the resident's history and the
-- audit trail. docs/KNOWN-ISSUES.md says so.
--
-- Who may:
--   remove, same site-day       any staff; no reason for your own entry
--                               within 15 minutes, a reason otherwise
--   remove, an earlier day      supervisor or admin, with a reason
--   add, within the late-entry  any staff, with a reason
--       window (48h default)
--   add, older, up to 28 nights supervisor or admin, with a reason
--
-- by_hand marks an entry added this way, as late_entry marks one synced
-- from an offline terminal; the history and the log say "entered by hand".

alter table public.checkin_events add column if not exists by_hand boolean not null default false;
alter table public.gate_events    add column if not exists by_hand boolean not null default false;
do $$
declare s text;
begin
  for s in select nspname from pg_namespace where nspname like 't\_%' escape '\' loop
    execute format('alter table %I.checkin_events add column if not exists by_hand boolean not null default false', s);
    execute format('alter table %I.gate_events    add column if not exists by_hand boolean not null default false', s);
  end loop;
end $$;

-- Re-derive one resident's overnight_absences rows for a run of nights, with
-- the predicate of snapshot_overnight_absences() (027): off site at the
-- midnight that ends the night if the latest movement before it is OUT or
-- there is none. Only nights already past (night < site_today()) are
-- touched; tonight is the snapshot's to write.
create or replace function public.recompute_overnight_absences(p_resident_id uuid, p_from date, p_to date)
returns integer language plpgsql security definer set search_path = public as $$
declare v_tz text; v_night date; v_end timestamptz; v_kind text; v_since timestamptz; v_res public.residents; n integer := 0;
begin
  select local_timezone into v_tz from public.app_settings where id;
  select * into v_res from public.residents where id = p_resident_id;
  if not found then return 0; end if;
  v_night := p_from;
  while v_night <= least(p_to, public.site_today() - 1) loop
    v_end := ((v_night + 1)::timestamp) at time zone v_tz;
    select e.kind, e.occurred_at into v_kind, v_since
      from public.gate_events e
     where e.resident_id = p_resident_id and e.occurred_at < v_end
     order by e.occurred_at desc, e.id desc limit 1;
    delete from public.overnight_absences where resident_id = p_resident_id and night = v_night;
    if v_res.registered_at < v_end
       and (v_res.status = 'active' or (v_res.status = 'departed' and v_res.departed_on is not null and v_res.departed_on > v_night))
       and (v_kind is null or v_kind = 'out') then
      insert into public.overnight_absences (night, resident_id, off_site_since) values (v_night, p_resident_id, v_since)
      on conflict do nothing;
    end if;
    n := n + 1;
    v_night := v_night + 1;
  end loop;
  return n;
end $$;
revoke all on function public.recompute_overnight_absences(uuid, date, date) from public, anon, authenticated;

-- Re-derive one day's daily_compliance row from the check-ins that remain.
-- The row stays (closed_at untouched): presented, first_seen_at and
-- checkin_count now describe what is on the register.
create or replace function public.recompute_daily_compliance(p_resident_id uuid, p_day date)
returns void language plpgsql security definer set search_path = public as $$
declare v_tz text;
begin
  select local_timezone into v_tz from public.app_settings where id;
  update public.daily_compliance dc
     set presented     = agg.n > 0,
         first_seen_at = agg.first_at,
         checkin_count = agg.n
    from (select count(*)::integer as n, min(e.occurred_at) as first_at
            from public.checkin_events e
           where e.resident_id = p_resident_id
             and (e.occurred_at at time zone v_tz)::date = p_day) agg
   where dc.resident_id = p_resident_id and dc.compliance_date = p_day;
end $$;
revoke all on function public.recompute_daily_compliance(uuid, date) from public, anon, authenticated;

create or replace function public.remove_register_entry(p_register text, p_id bigint, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_tz text; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_chk public.checkin_events; v_gate public.gate_events;
  v_resident uuid; v_guard uuid; v_at timestamptz; v_recorded timestamptz; v_day date; v_row jsonb;
  v_next timestamptz;
begin
  if not public.is_staff() then
    raise exception 'Not authorised to change the register' using errcode = '42501';
  end if;
  if p_register not in ('checkin', 'gate') then
    raise exception 'register must be ''checkin'' or ''gate''' using errcode = '22023';
  end if;
  if v_reason is not null and length(v_reason) > 200 then
    raise exception 'The reason is at most 200 characters' using errcode = '22023';
  end if;
  select local_timezone into v_tz from public.app_settings where id;

  if p_register = 'checkin' then
    select * into v_chk from public.checkin_events where id = p_id;
    if not found then raise exception 'No such check-in' using errcode = 'P0002'; end if;
    v_resident := v_chk.resident_id; v_guard := v_chk.guard_id; v_at := v_chk.occurred_at;
    v_recorded := coalesce(v_chk.recorded_at, v_chk.occurred_at); v_row := to_jsonb(v_chk);
  else
    select * into v_gate from public.gate_events where id = p_id;
    if not found then raise exception 'No such movement' using errcode = 'P0002'; end if;
    v_resident := v_gate.resident_id; v_guard := v_gate.guard_id; v_at := v_gate.occurred_at;
    v_recorded := coalesce(v_gate.recorded_at, v_gate.occurred_at); v_row := to_jsonb(v_gate);
  end if;
  v_day := (v_at at time zone v_tz)::date;

  if v_day < public.site_today() then
    if not public.is_supervisor() then
      raise exception 'Only a supervisor or admin can remove an entry from an earlier day' using errcode = '42501';
    end if;
    if v_reason is null then
      raise exception 'A reason is required to remove an entry from an earlier day' using errcode = '22023';
    end if;
  elsif v_reason is null and not (v_guard = auth.uid() and v_recorded > now() - interval '15 minutes') then
    raise exception 'A reason is required unless it is your own entry from the last 15 minutes' using errcode = '22023';
  end if;

  insert into public.admin_audit (actor_id, table_name, row_id, action, old_row, note)
  values (auth.uid(), case when p_register = 'checkin' then 'checkin_events' else 'gate_events' end, p_id::text, 'delete', v_row,
          coalesce(v_reason, 'own entry, within 15 minutes'));

  if p_register = 'checkin' then
    delete from public.checkin_events where id = p_id;
    perform public.recompute_daily_compliance(v_resident, v_day);
  else
    delete from public.gate_events where id = p_id;
    -- The nights this movement decided: from its own night up to the night
    -- before the next remaining movement (or last night).
    select min(e.occurred_at) into v_next from public.gate_events e where e.resident_id = v_resident and e.occurred_at > v_at;
    perform public.recompute_overnight_absences(v_resident, v_day,
      least(public.site_today() - 1, coalesce((v_next at time zone v_tz)::date, public.site_today() - 1)));
  end if;
end $$;
revoke all on function public.remove_register_entry(text, bigint, text) from public, anon;
grant execute on function public.remove_register_entry(text, bigint, text) to authenticated;

create or replace function public.add_register_entry(p_register text, p_resident_id uuid, p_direction text, p_at timestamptz, p_reason text)
returns bigint language plpgsql security definer set search_path = public, extensions as $$
declare
  v_tz text; v_hours integer; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_status text; v_id bigint; v_day date; v_next timestamptz; v_dup boolean;
begin
  if not public.is_staff() then
    raise exception 'Not authorised to change the register' using errcode = '42501';
  end if;
  if p_register not in ('checkin', 'gate') then
    raise exception 'register must be ''checkin'' or ''gate''' using errcode = '22023';
  end if;
  if p_register = 'gate' and p_direction not in ('in', 'out') then
    raise exception 'direction must be ''in'' or ''out''' using errcode = '22023';
  end if;
  if v_reason is null or length(v_reason) > 200 then
    raise exception 'A reason of 1 to 200 characters is required' using errcode = '22023';
  end if;
  if p_at is null then raise exception 'When it happened is required' using errcode = '22023'; end if;
  if p_at > now() + interval '5 minutes' then
    raise exception 'That time is in the future' using errcode = '22023';
  end if;
  select local_timezone, late_entry_window_hours into v_tz, v_hours from public.app_settings where id;
  if p_at < now() - make_interval(hours => v_hours) then
    if not public.is_supervisor() then
      raise exception 'Only a supervisor or admin can add an entry older than % hours', v_hours using errcode = '42501';
    end if;
    if (p_at at time zone v_tz)::date < public.site_today() - 28 then
      raise exception 'An entry can be added for the last 28 nights only' using errcode = '22023';
    end if;
  end if;
  select status into v_status from public.residents where id = p_resident_id;
  if v_status is null then raise exception 'Resident not found' using errcode = 'P0002'; end if;
  v_day := (p_at at time zone v_tz)::date;

  if p_register = 'checkin' then
    -- record_checkin_at() places the day, repairs a closed day, and applies
    -- the 60-second double-tap rule; by_hand is set on the row it made.
    perform public.record_checkin_at(p_resident_id, p_at, false, null, 'desk');
    select max(id) into v_id from public.checkin_events
     where resident_id = p_resident_id and occurred_at = p_at;
    if v_id is null then
      raise exception 'A check-in within a minute of that time is already on the register' using errcode = '23505';
    end if;
    update public.checkin_events set by_hand = true where id = v_id and by_hand = false and guard_id = auth.uid();
  else
    if v_status <> 'active' then
      raise exception 'Resident is not active and cannot be signed in or out' using errcode = '23514';
    end if;
    select exists (select 1 from public.gate_events
                    where resident_id = p_resident_id and kind = p_direction
                      and abs(extract(epoch from (occurred_at - p_at))) < 60) into v_dup;
    if v_dup then
      raise exception 'A movement within a minute of that time is already on the register' using errcode = '23505';
    end if;
    insert into public.gate_events (resident_id, guard_id, kind, occurred_at, recorded_at, late_entry, by_hand)
    values (p_resident_id, auth.uid(), p_direction, p_at, now(), false, true)
    returning id into v_id;
    select min(e.occurred_at) into v_next from public.gate_events e where e.resident_id = p_resident_id and e.occurred_at > p_at;
    perform public.recompute_overnight_absences(p_resident_id, v_day,
      least(public.site_today() - 1, coalesce((v_next at time zone v_tz)::date, public.site_today() - 1)));
  end if;

  insert into public.admin_audit (actor_id, table_name, row_id, action, new_row, note)
  select auth.uid(), case when p_register = 'checkin' then 'checkin_events' else 'gate_events' end, v_id::text, 'insert',
         case when p_register = 'checkin' then (select to_jsonb(c) from public.checkin_events c where c.id = v_id)
              else (select to_jsonb(g) from public.gate_events g where g.id = v_id) end,
         v_reason;
  return v_id;
end $$;
revoke all on function public.add_register_entry(text, uuid, text, timestamptz, text) from public, anon;
grant execute on function public.add_register_entry(text, uuid, text, timestamptz, text) to authenticated;

-- The log view and the history show "entered by hand" alongside "recorded
-- offline": columns appended, so create or replace is enough.
-- (v_check_log: read its current definition — the latest `create or replace
-- view public.v_check_log` in migrations/ — and re-create it with
-- `e.by_hand` added after `e.late_entry`. Do not drop the view.)
```

Note on the check-in `by_hand` update: `record_checkin_at()` inserts with `guard_id = auth.uid()` and `occurred_at = p_at`; if the 60-second rule swallowed the insert, `max(id) … where occurred_at = p_at` finds nothing (unless an identical timestamp existed, in which case the `by_hand = false and guard_id = auth.uid()` guard still only marks a row this caller made). Keep it exactly as written.

- [ ] **Step 2: The SQL tests**

Append a `-- 056` block to `test/compliance.sql`, in the file's idiom, covering (fixtures: create a resident `Fixer Fixture` born 1990-01-01 as the supervisor; today's site date via `public.site_today()`):

1. As the guard: record a gate `in` via `record_check(...)` (read its signature in 026) → the row exists; `remove_register_entry('gate', <id>, null)` succeeds (own, within 15 minutes) → row gone; `admin_audit` has a row `table_name='gate_events', row_id=<id>, action='delete', note='own entry, within 15 minutes'` with `old_row->>'kind' = 'in'`.
2. As the guard: record another `in`; as the SUPERVISOR (different uid) `remove_register_entry('gate', <id>, null)` → `pg_temp.try` reports the 22023 error (a reason is required); with reason 'wrong person' → succeeds.
3. Backdate: as the owner, insert a gate `out` for the resident at `(site_today() - 2)::timestamp + time '22:00'` site time (read how other tests build a site-local timestamp), then `select public.snapshot_overnight_absences(site_today() - 2)` and `(site_today() - 1)` → both nights have a row for the resident. As the guard: `remove_register_entry('gate', <that id>, 'tapped out instead of in')` → 42501 (earlier day, not a supervisor). As the supervisor: succeeds → both `overnight_absences` rows for the resident are gone (recompute found no movement… careful: with NO movement at all the predicate `le.kind is null` counts them absent — so first add an earlier `in` at `site_today() - 3` 09:00 as the fixture, so that after the removal the latest movement is IN and the nights are re-derived as present).
4. Check-in: as the guard, `record_checkin(<resident>)` → daily_compliance today `presented = true, checkin_count = 1`; `remove_register_entry('checkin', <id>, null)` → `presented = false, checkin_count = 0, first_seen_at is null`.
5. `add_register_entry('checkin', <resident>, null, now() - interval '2 hours', 'seen at the door, not entered')` as the guard → returns an id; the row has `by_hand = true`, `guard_id = guard`; audit row `action='insert'`, `note='seen at the door, not entered'`; daily_compliance today `presented = true`. As the guard, `add_register_entry('checkin', …, now() - interval '3 days', 'x')` → 42501; as the supervisor → succeeds and that day's daily_compliance row (create it closed and missed first, as the 054-era tests seed `daily_compliance`) reads `presented = true`. As the supervisor at `now() - interval '40 days'` → 22023 (28 nights). Empty reason → 22023. Future → 22023.
6. `add_register_entry('gate', <resident>, 'sideways', now(), 'x')` → 22023; `('gate', …, 'in', now() - interval '1 hour', 'forgot to sign him in')` → row with `by_hand = true, late_entry = false`; a second identical call → 23505.
7. As the kiosk uid (`55555555-…`): `remove_register_entry` and `add_register_entry` → 42501.
8. `select column_default … by_hand` is `false` on both tables (the 055 idiom), and `tenant_schema_gaps()` — if the suite already asserts it for 05x functions, add `remove_register_entry`, `add_register_entry`, `recompute_overnight_absences`, `recompute_daily_compliance` the same way.

- [ ] **Step 3: Run, regenerate, commit**

`PGBIN=/opt/homebrew/opt/postgresql@16/bin test/sql.sh` green; `./tools/gen-tenant-template.sh`; then the full `./check.sh` once (the HTTP suite must still pass — nothing else changed). Commit: `git add migrations/056_fix_the_register.sql tenant/template.sql test/compliance.sql && git commit -m "Migration 056: remove a wrong entry from the register, add a missed one — audited, derived rows recomputed"`.

---

### Task 2: The routes and the history's new columns

**Files:**
- Create: `routes/registerFix.js`
- Modify: `server.js` (mount: `app.use('/api', require('./routes/registerFix'));` next to `routes/gate`)
- Modify: `routes/residents.js` (history query ~line 340: add `x.id`, `x.register`, `x.by_hand`, `x.guard_id` to the select — `'gate'`/`'checkin'` as `register`; the CSV/xlsx mapping gains `entered_by_hand: e.by_hand ? 'yes' : ''` after `recorded_offline`)
- Modify: `routes/gate.js` GET `/gate-events` (add `l.by_hand` to the select from `v_check_log`)
- Modify: `test/permissions.js` (two rows, area 'Register': `"Remove an entry from the register"` `DELETE /api/register-entries/gate/:id` expect STAFF (guard ✓, supervisor ✓, admin ✓, kiosk ✗) — read how the matrix expresses "any staff" vs "supervisor" and how fixtures create a fresh event to delete (a `fresh:` hook like `weeklyReportStaff`); `"Add a missed entry to the register"` `POST /api/register-entries` body `{ register: 'gate', resident_id: fx.residentId, direction: 'in', occurred_at: <30 min ago ISO>, reason: 'matrix' }` expect STAFF)
- Regenerate: `docs/PERMISSIONS.md` (`node tools/gen-permissions-doc.js`)
- Test: `test/api.test.js`

**Interfaces:**
- Consumes: the two SQL functions from Task 1.
- Produces: `DELETE /api/register-entries/:register/:id` with JSON body `{ reason?: string }` → `204`; errors map: `42501 → 403`, `22023 → 400`, `P0002 → 404`, message = the SQL error's message (`translateDbError` — read `lib/api.js` to see what it already maps; add `P0002 → 404` there if missing).
- Produces: `POST /api/register-entries` body `{ register: 'checkin'|'gate', resident_id, direction?: 'in'|'out', occurred_at: ISO string, reason }` → `201 { id }`; same error mapping, `23505 → 409`.
- Produces: history rows now carry `id`, `register`, `by_hand`, `guard_id`.

- [ ] **Step 1: Failing tests** in `test/api.test.js`, near the existing history test (grep `history?` to find it): as `api` (a guard client — read which client is the guard) sign a resident in via `POST /api/gate-events`, fetch history, find the row (`register: 'gate'`, has `id`, `by_hand: false`, `guard_id` equals the guard's profile id from `/api/session`), `DELETE /api/register-entries/gate/${id}` with `{}` → 204, history no longer has it, `admin_audit` has the delete row; as `supC` delete a guard's fresh entry with no reason → 400 matching `/reason is required/`; with `{ reason: 'wrong person' }` → 204. `POST /api/register-entries` as the guard with a check-in 2 hours ago and a reason → 201, history row `register: 'checkin', by_hand: true`; the CSV export (`format=csv&reason=…` as `supC`) has an `entered_by_hand` column with `yes` on that row; a 3-day-old check-in as the guard → 403, as `supC` → 201; bad direction → 400; missing reason → 400; unknown id → 404; a kiosk session (read how the 051 tests obtain one) → 403 on both.
- [ ] **Step 2: Run to see them fail** (`./check.sh … | grep -A5 "register-entries"`).
- [ ] **Step 3: Implement** `routes/registerFix.js` in the style of `routes/gate.js` (wrap, `db.withIdentity(req.session.userId, …)`, `uuidParam`, `translateDbError`); the id param is a positive integer (`/^\d{1,18}$/`, else 400). `occurred_at` must parse as a date (`Number.isFinite(Date.parse(...))`, else 400). Header comment: what the two routes are, the who-may table from the migration in one sentence each, and that the rules live in the SQL (the route only translates errors).
- [ ] **Step 4: History and log columns**; permissions matrix rows; `node tools/gen-permissions-doc.js`.
- [ ] **Step 5: Full `./check.sh` green; commit**: `git add routes/registerFix.js server.js routes/residents.js routes/gate.js lib/api.js test/api.test.js test/permissions.js docs/PERMISSIONS.md && git commit -m "Register fixes over HTTP: remove an entry, add a missed one; history rows carry id, register, by_hand"`.

---

### Task 3: The History panel — Remove and Add a missed entry — and the copy

**Files:**
- Modify: `public/app-common.js` (`mountHistory()`; helpers next to it), `public/app-common.css` (small styles for the inline forms — follow `.hexportform`), `public/index.html` and `public/checkin.html` and `public/admin.html` (the three `mountHistory(...)` calls gain `onChange`: index/checkin pass a function that reloads their register data — read what each page calls after a check-in or gate event and reuse that; admin passes nothing), `public/help.html` (the register sections: how to remove a wrong entry and add a missed one, who may, that it is on the record), `docs/GDPR.md` (audit trail: corrections are removals copied to `admin_audit` with the reason; additions marked by hand), `README.md` (the features list, one bullet), `docs/KNOWN-ISSUES.md` (§ for 056: `overnight_guardian_gaps` is not re-derived after a correction — the snapshot is the record of what the register said at midnight; the history and audit trail carry the correction), `tools/build-site.py` (one sentence in the features list: "Wrong entry? Any staff member can take it off the register with a reason — it stays on the audit trail — and add a missed one at the time it happened." Then `python3 tools/build-site.py && python3 tools/check-site.py` and commit `site/`).
- CSP: `public/*.html` inline scripts are hashed at boot; `app-common.js` is an external file so no hash changes. Run `./check.sh` — it asserts the CSP header matches.

**Interfaces:**
- Consumes: `DELETE /api/register-entries/:register/:id`, `POST /api/register-entries`, history rows with `id`, `register`, `by_hand`, `guard_id`; `session.profile.id` and `session.profile.role` (both pages keep `session` from `GET /api/session` — check the variable each page exposes; `mountHistory` receives what it needs via options: `{ canExport, me: { id, role }, onChange }`).

- [ ] **Step 1: Rows.** Each history row gains, after the "by …" span: `${e.by_hand ? " · entered by hand" : ""}` in the same `.by` span; and a `<button type="button" class="linkish hremove" data-id data-register>Remove</button>` at the row's end. `renderLog` in `public/index.html` (Log tab) gains the same " · entered by hand" text (no Remove there — the resident's History is where fixes happen; say so in help).
- [ ] **Step 2: Remove.** Clicking Remove replaces the row's body with an inline form: a text field `reason` (maxlength 200, placeholder `Reason — optional for your own entry in the last 15 minutes`), buttons `Remove from the register` and `Cancel`. Submit → `apiDelete` with `{ reason }` (read `apiDelete`'s signature in app-common.js; if it takes no body, add an optional body parameter the same way `apiPost` sends one) → on success `toast("Removed from the register — it stays on the audit trail", "ok")`, reload the list, call `onChange()`. On error show the server's message in a toast (it says exactly what is missing: a reason, or a supervisor).
- [ ] **Step 3: Add a missed entry.** A `linkish` button `Add a missed entry` in the `.hkind` row (after the export button). It toggles an inline form: `<select name="register">` with options `Check-in` (`checkin`), `Signed IN` (`gate`/`in`), `Signed OUT` (`gate`/`out`); `<input type="datetime-local" name="at" required>` defaulted to now minus 5 minutes, `max` = now; `<input name="reason" maxlength="200" required placeholder="Reason — e.g. seen at 21:10, not entered">`; `Add` and `Cancel`. Submit → `apiPost('/api/register-entries', { register, resident_id, direction, occurred_at: new Date(at).toISOString(), reason })` → toast `Added to the register, marked entered by hand`, reload, `onChange()`.
- [ ] **Step 4: Copy** in help.html / GDPR.md / README.md / KNOWN-ISSUES.md / build-site.py as listed, in each file's voice. GDPR.md gets a dated "Updated 17 September 2026 against migration 056" paragraph after the 055 one.
- [ ] **Step 5: Check by eye** — start the app against the scratch cluster if a dev script exists (`ls *.sh tools/`), otherwise rely on the suite; `python3 tools/check-site.py`; full `./check.sh` green.
- [ ] **Step 6: Commit**: `git add public docs README.md tools site && git commit -m "History: Remove from the register and Add a missed entry; copy for 056"`.
