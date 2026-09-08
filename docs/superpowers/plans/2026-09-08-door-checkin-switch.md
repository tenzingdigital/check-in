# Door Sign-In Counts as Check-In (Per-Site Switch) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With a per-site switch on, a sign-in at the Door also records today's check-in, marked as recorded at the door; off, nothing changes.

**Architecture:** Migration 026 adds the switch, a `source` on check-in events, a fifth `p_source` parameter on `record_checkin_at()`, and a call to it from the two gate functions. Routes expose the switch and the source; the admin page gets a checkbox; the register sheet and the Door toast show the source. Tenant template regenerated.

**Tech Stack:** Postgres 16 migrations, Express routes, vanilla front end. `./check.sh` with `PGBIN=/opt/homebrew/opt/postgresql@16/bin`.

**Spec:** `docs/superpowers/specs/2026-09-08-door-checkin-switch-design.md`

## Global Constraints
- Branch `claude/security-hardening-roadmap-k7vtwv`; `git fetch origin && git rebase origin/claude/security-hardening-roadmap-k7vtwv` before starting each task; do not push.
- Route SQL uses unqualified names; migration SQL uses `public.` like its neighbours.
- No change to `daily_compliance`'s shape, `v_resident_compliance`, `attention_list()`, or reports.
- Copy: the switch is described as counting a sign IN, never a sign OUT; the register says "at the door", never "checked in" for a door event.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01QMp1iENRi9GJLzm3baLCQy
  ```

---

### Task 1: Migration 026, template, database tests

**Files:**
- Create: `migrations/026_door_checkin.sql`
- Regenerate: `tenant/template.sql` (`PGBIN=/opt/homebrew/opt/postgresql@16/bin ./tools/gen-tenant-template.sh`)
- Test: `test/compliance.sql` (append at the end, after the close-out grace block)

**Interfaces:**
- Consumes: `record_checkin_at(uuid, timestamptz, boolean, uuid)` in `migrations/010_offline_sync.sql` (read its full body there; the new definition below is that body with one added parameter and one changed insert), `record_check(uuid, text)` in `migrations/008_ipas_alignment.sql:244`, `record_check_late(uuid, text, timestamptz, uuid)` in `migrations/010_offline_sync.sql:262`.
- Produces: `app_settings.feature_door_checkin`, `checkin_events.source`, `record_checkin_at(uuid, timestamptz, boolean, uuid, text default 'desk')`.

- [ ] **Step 1: Write the failing tests**

Append to `test/compliance.sql`. Read the file's conventions first (`\echo`, `\gset`, `set role authenticated; set request.jwt.claim.sub = '1111…';`, `reset role;`, `pg_temp.expect(name, actual, expected)`), and match them.

```sql
\echo '--- door check-in switch: a sign-in is a presentation only when the site says so'
reset role;
insert into public.residents (id, first_name, last_name, date_of_birth, registered_at)
values ('77777777-7777-7777-7777-777777777777', 'Dara', 'Doorway', '1990-01-01', now() - interval '10 days')
on conflict (id) do nothing;
select feature_door_checkin as door_default from public.app_settings \gset
select pg_temp.expect('feature_door_checkin defaults off', (:'door_default')::boolean, false);

-- Off: a sign-in records a gate event and nothing on the register.
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select 1 as _ from public.record_check('77777777-7777-7777-7777-777777777777', 'in') limit 1;
reset role;
select count(*)::integer as off_events from public.checkin_events where resident_id = '77777777-7777-7777-7777-777777777777' \gset
select pg_temp.expect('switch off: a sign-in adds no check-in event', (:'off_events')::integer, 0);

-- On: a sign OUT still records nothing; a sign IN records a door check-in.
update public.app_settings set feature_door_checkin = true;
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select 1 as _ from public.record_check('77777777-7777-7777-7777-777777777777', 'out') limit 1;
reset role;
select count(*)::integer as out_events from public.checkin_events where resident_id = '77777777-7777-7777-7777-777777777777' \gset
select pg_temp.expect('switch on: a sign-out adds no check-in event', (:'out_events')::integer, 0);

-- The gate's own 60-second dedupe would swallow an identical 'in' now; wait
-- it out by backdating the earlier gate event.
update public.gate_events set occurred_at = occurred_at - interval '2 minutes'
 where resident_id = '77777777-7777-7777-7777-777777777777';
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select 1 as _ from public.record_check('77777777-7777-7777-7777-777777777777', 'in') limit 1;
reset role;
select count(*)::integer as in_events,
       coalesce(max(source), '') as in_source
  from public.checkin_events where resident_id = '77777777-7777-7777-7777-777777777777' \gset
select pg_temp.expect('switch on: a sign-in adds one check-in event', (:'in_events')::integer, 1);
select pg_temp.expect('…with source = door', (:'in_source')::text, 'door');
select presented as day_presented from public.daily_compliance
 where resident_id = '77777777-7777-7777-7777-777777777777' and compliance_date = public.site_today() \gset
select pg_temp.expect('switch on: the day is presented', (:'day_presented')::boolean, true);

-- A desk check-in seconds later is the same presentation (60-second rule).
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select 1 as _ from public.record_checkin('77777777-7777-7777-7777-777777777777') limit 1;
reset role;
select count(*)::integer as after_desk from public.checkin_events where resident_id = '77777777-7777-7777-7777-777777777777' \gset
select pg_temp.expect('a desk check-in inside 60 s adds no second event', (:'after_desk')::integer, 1);

-- The offline door: a late sign-in also records a late door check-in.
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select 1 as _ from public.record_check_late('77777777-7777-7777-7777-777777777777', 'in', now() - interval '3 hours', '77777777-7777-4777-8777-777777777701') limit 1;
reset role;
select count(*)::integer as late_events,
       bool_or(late_entry) as any_late
  from public.checkin_events
 where resident_id = '77777777-7777-7777-7777-777777777777' and source = 'door' and late_entry \gset
select pg_temp.expect('a late sign-in adds a late door check-in', (:'late_events')::integer, 1);
update public.app_settings set feature_door_checkin = false;
```

If `record_check_late` refuses a three-hour-old event because `late_entry_window_hours` in the fixture is smaller, use `interval '30 minutes'`. If the fixture's guard id differs from `1111…`, use the one the rest of the file uses.

- [ ] **Step 2: Run the database suite; expect failure**

`PGBIN=/opt/homebrew/opt/postgresql@16/bin ./test/sql.sh 2>&1 | tail -8` — expected: fails at `feature_door_checkin` (column does not exist).

- [ ] **Step 3: The migration**

Create `migrations/026_door_checkin.sql`:

```sql
-- 026: a Door sign-in counts as the day's check-in, when the site says so.
--
-- TAO 13: a sign-in is not a check-in, because the duty is to present, not
-- merely to be seen leaving. That stays the default. This switch lets a
-- centre say that at its door a sign IN *is* the presentation — the person
-- is seen and their card is checked there — while a sign OUT never counts.
-- The register keeps the difference: every check-in event carries a source,
-- 'desk' or 'door', so a manager can tell them apart and turning the switch
-- off later leaves the record honest.
set search_path = public, extensions;

alter table public.app_settings
  add column if not exists feature_door_checkin boolean not null default false;
comment on column public.app_settings.feature_door_checkin is
  'A sign IN at the Door also records today''s check-in, marked source=door. A sign OUT never does. Off: the two acts stay separate.';

alter table public.checkin_events
  add column if not exists source text not null default 'desk'
    check (source in ('desk', 'door'));
comment on column public.checkin_events.source is
  'Where the presentation was recorded: desk (the register) or door (a Door sign-in, feature_door_checkin).';

-- record_checkin_at() gains p_source. One function, not an overload: the old
-- signature goes first, and the two callers resolve to the default.
drop function if exists public.record_checkin_at(uuid, timestamptz, boolean, uuid);
```

Then paste the **entire** `create or replace function public.record_checkin_at(…)` from `migrations/010_offline_sync.sql`, changed in exactly two places: the parameter list becomes

```sql
create or replace function public.record_checkin_at(
  p_resident_id uuid,
  p_at          timestamptz,
  p_late        boolean,
  p_client_ref  uuid,
  p_source      text default 'desk'
)
```

and the insert into `checkin_events` becomes

```sql
    insert into public.checkin_events (resident_id, guard_id, occurred_at, recorded_at, late_entry, client_ref, source)
    values (p_resident_id, auth.uid(), p_at, now(), p_late, p_client_ref, p_source);
```

Everything else in that body, including its comments, stays byte-for-byte. Then re-apply its grants exactly as 010 does (`grep -n "record_checkin_at" migrations/010_offline_sync.sql` shows the revoke/grant lines; repeat them for the new signature).

Then redefine `record_check()`: paste the whole function from `migrations/008_ipas_alignment.sql:244-291` and change its insert block to:

```sql
  if v_last.id is null
     or v_last.kind <> p_direction
     or v_last.occurred_at < now() - interval '60 seconds'
  then
    insert into public.gate_events (resident_id, guard_id, kind)
    values (p_resident_id, v_guard, p_direction);

    -- The door as the presentation (feature_door_checkin). Only a sign IN,
    -- only when the event was really recorded, and through the same
    -- function the desk uses, so the 60-second rule and the day's row are
    -- the register's own. The source says it came from the door.
    if p_direction = 'in'
       and (select feature_door_checkin from public.app_settings where id) then
      perform public.record_checkin_at(p_resident_id, now(), false, null, 'door');
    end if;
  end if;
```

Then redefine `record_check_late()`: paste the whole function from `migrations/010_offline_sync.sql:262-318` and change its insert block to:

```sql
  if not v_dup then
    insert into public.gate_events (resident_id, guard_id, kind, occurred_at, recorded_at, late_entry, client_ref)
    values (p_resident_id, auth.uid(), p_direction, p_occurred_at, now(), true, p_client_ref);

    -- The offline door as the presentation, same rule as record_check().
    -- The gate event's client_ref is reused so a replay is idempotent on
    -- both tables.
    if p_direction = 'in'
       and (select feature_door_checkin from public.app_settings where id) then
      perform public.record_checkin_at(p_resident_id, p_occurred_at, true, p_client_ref, 'door');
    end if;
  end if;
```

Re-apply the grants for both gate functions as 008/010 do (they are `security definer`; `grep -n "record_check" migrations/002_schema.sql migrations/010_offline_sync.sql | grep -iE "grant|revoke"`).

- [ ] **Step 4: Regenerate the template**

`PGBIN=/opt/homebrew/opt/postgresql@16/bin ./tools/gen-tenant-template.sh 2>&1 | tail -3`; `git diff --stat tenant/template.sql` should show only the two columns, the three functions and their ACL blocks. Unrelated churn: stop and report DONE_WITH_CONCERNS.

- [ ] **Step 5: Suites**

`PGBIN=/opt/homebrew/opt/postgresql@16/bin ./test/sql.sh 2>&1 | tail -4` then `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./test/api.sh 2>&1 | tail -3` — both PASS.

- [ ] **Step 6: Commit**

```bash
git add migrations/026_door_checkin.sql tenant/template.sql test/compliance.sql
git commit -m "A Door sign-in counts as the day's check-in, when the site says so

feature_door_checkin, off by default. A sign IN at the door also records
today's check-in through record_checkin_at(), with source = door; a sign
OUT never does. The desk's 60-second rule and the day's row are shared.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QMp1iENRi9GJLzm3baLCQy"
```

---

### Task 2: Routes and the HTTP test

**Files:**
- Modify: `routes/settings.js:31` (the bool whitelist), `routes/session.js:85` (the settings select), `routes/residents.js` (the events query in `/:id/compliance`)
- Test: `test/api.test.js` (a new test after "the time of the check-in, and who recorded it, are on the detail row"; and the session settings assertion near line 1333)

**Interfaces:**
- Consumes: Task 1's column and functions.
- Produces: `feature_door_checkin` in `GET /api/session` settings and accepted by `PATCH /api/settings`; `source` on each `checkins_today_events` entry.

- [ ] **Step 1: Failing test**

After the Task-1-of-the-previous-plan test named "the time of the check-in, and who recorded it, are on the detail row", add:

```js
  await test("with the door switch on, a sign-in is the day's check-in, marked as from the door", async () => {
    const admin = client(base);
    assert.equal((await admin.fetch("/api/session", { method: "POST", body: { email: "head@hut.example", password: PASSWORD } })).status, 200);
    const before = await admin.fetch("/api/session");
    assert.equal(before.json.settings.feature_door_checkin, false, "the switch should default off");

    const found = await api.fetch("/api/residents?q=nowak&compliance=1");
    const resident = found.json[0];
    assert.equal(resident.seen_today, false, "fixture: Nowak must not be seen today yet");

    // Off: a sign-in changes nothing on the register.
    const offIn = await api.fetch("/api/gate-events", { method: "POST", body: { resident_id: resident.id, direction: "in" } });
    assert.equal(offIn.status, 200);
    assert.equal((await api.fetch(`/api/residents/${resident.id}/compliance`)).json.seen_today, false, "switch off but the sign-in counted");

    const on = await admin.fetch("/api/settings", { method: "PATCH", body: { feature_door_checkin: true } });
    assert.equal(on.status, 200, on.text);
    assert.equal((await admin.fetch("/api/session")).json.settings.feature_door_checkin, true);

    // The gate's 60-second dedupe would swallow an identical 'in'; sign out first.
    assert.equal((await api.fetch("/api/gate-events", { method: "POST", body: { resident_id: resident.id, direction: "out" } })).status, 200);
    assert.equal((await api.fetch(`/api/residents/${resident.id}/compliance`)).json.seen_today, false, "a sign-out counted as a presentation");
    const onIn = await api.fetch("/api/gate-events", { method: "POST", body: { resident_id: resident.id, direction: "in" } });
    assert.equal(onIn.status, 200);
    const detail = await api.fetch(`/api/residents/${resident.id}/compliance`);
    assert.equal(detail.json.seen_today, true, "switch on but the sign-in did not count");
    assert.equal(detail.json.checkins_today_events.length, 1);
    assert.equal(detail.json.checkins_today_events[0].source, "door");
    assert.equal(detail.json.checkins_today_events[0].recorded_by, "Gina Guard");

    const off = await admin.fetch("/api/settings", { method: "PATCH", body: { feature_door_checkin: false } });
    assert.equal(off.status, 200, off.text);
  });
```

Check the admin fixture email and password constants at the top of the file and the existing Nowak fixture (`grep -n "nowak" test/api.test.js | head -3`): if Nowak is already seen today by an earlier test, pick another seeded resident who is not (`grep -n "q=" test/api.test.js` shows which names earlier tests touch). The test must leave the switch off.

Also extend the session-settings assertion near line 1333 (`feature_visitors, false, "the switch defaults off"`) with the same line for `feature_door_checkin`.

- [ ] **Step 2: Run; expect failure**

`PGBIN=/opt/homebrew/opt/postgresql@16/bin ./test/api.sh 2>&1 | tail -8` — expected: fails at "the switch should default off" (undefined ≠ false) or the PATCH returning 400.

- [ ] **Step 3: Routes**

`routes/settings.js`: after `feature_visitors: { kind: 'bool' },` add `feature_door_checkin: { kind: 'bool' },`.

`routes/session.js:85`: add `feature_door_checkin` after `feature_visitors` in the select list.

`routes/residents.js`, the events query in `/:id/compliance`: select `e.source` alongside `e.occurred_at, p.full_name as recorded_by`.

- [ ] **Step 4: Run; expect pass**

`PGBIN=/opt/homebrew/opt/postgresql@16/bin ./test/api.sh 2>&1 | tail -3` — PASS. Also `node tools/gen-permissions-doc.js --check` (routes changed only in fields, so the matrix should still be current; if it is not, run `node tools/gen-permissions-doc.js` and include `docs/PERMISSIONS.md` in the commit).

- [ ] **Step 5: Commit**

```bash
git add routes/settings.js routes/session.js routes/residents.js test/api.test.js
git commit -m "The door switch on the API: setting, session, and the source on today's check-ins

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QMp1iENRi9GJLzm3baLCQy"
```

---

### Task 3: Admin switch, register sheet, Door toast, docs

**Files:**
- Modify: `public/admin.html` (features list ~line 357 and `FEATURE_FIELDS` ~line 1244), `public/checkin.html` (`todayFact()`, `eventsToday()`), `public/index.html` (the success toast in `record()`), `public/help.html:134,187`, `README.md:55-57` and the "Compliance is per calendar day" section, `docs/TAO.md:92-94`, `docs/PRODUCT-ROADMAP.md`

- [ ] **Step 1: Admin**

After the Visitors checkbox line in `public/admin.html`, add:

```html
        <label class="check"><input id="stFeatDoorCheckin" type="checkbox"> <span><b>Door sign-in counts as check-in.</b> A sign IN at the Door (never a sign OUT) also records today's check-in for that resident, marked as recorded at the door. Off, the two acts stay separate and a resident must present at the register.</span></label>
```

In `FEATURE_FIELDS` add `feature_door_checkin: "stFeatDoorCheckin"`.

- [ ] **Step 2: Register sheet**

In `public/checkin.html`, replace `todayFact()` and `eventsToday()`:

```js
// "Seen 23:31 (1×)": the first presentation today, in the site's zone, and
// how many taps landed on the day. "Seen at the door" when the earliest
// check-in came from a Door sign-in (feature_door_checkin). A queued
// check-in is not yet a time the server has; it says so.
function todayFact(r) {
  if (r.queued) return "Queued";
  if (!r.seen_today) return "Not yet";
  const t = siteTime(r.first_seen_at, state.settings && state.settings.local_timezone);
  const evs = r.checkins_today_events || [];
  const first = evs.length ? evs[evs.length - 1] : null;   // newest first, so the earliest is last
  const where = first && first.source === "door" ? " at the door" : "";
  return `Seen${where}${t ? " " + esc(t) : ""} (${r.checkins_today || 1}×)`;
}

// Every check-in recorded today, newest first, with where it was recorded
// and by whom. This is the line a manager reads when a resident says "I
// checked in" and the register says otherwise.
function eventsToday(r) {
  const evs = r.checkins_today_events || [];
  if (!evs.length) return "";
  const tz = state.settings && state.settings.local_timezone;
  return `<div class="events"><span class="stripTitle">Today's check-ins</span>${evs.map((e) =>
    `<div><b>${esc(siteTime(e.occurred_at, tz))}</b>${e.source === "door" ? " · at the door" : ""} · recorded by ${esc(e.recorded_by || "—")}</div>`).join("")}</div>`;
}
```

- [ ] **Step 3: Door toast**

In `public/index.html` `record()`, find the success toast after the server answers (the branch that runs when `apiPost("/api/gate-events", …)` returns a row and the page re-renders the card; it reads `toast(\`${…} signed ${direction.toUpperCase()}\`, "ok")` or similar — `grep -n 'signed \${direction' public/index.html`). Append the check-in note when it applies:

```js
  const doorNote = direction === "in" && state.settings && state.settings.feature_door_checkin ? " · today's check-in recorded" : "";
```

and add `${doorNote}` to the end of that toast's text. If the queued-offline toast is a separate string (it is: "… queued until the connection returns"), leave it alone; the check-in is recorded when the sync lands.

- [ ] **Step 4: Docs**

`public/help.html:134`: replace `Being signed in at the door does not count; the check-in is its own act.` with `Being signed in at the door does not count unless the site has turned on "Door sign-in counts as check-in" under Settings; then a sign IN (never a sign OUT) is recorded as the day's check-in, marked as from the door.`

`public/help.html:187`: extend the Features bullet: `buildings, evacuation, households, visitors and "Door sign-in counts as check-in" are off until turned on here.`

`README.md:55-57`: after "does not satisfy the daily requirement" add ` — unless the site turns on \`feature_door_checkin\`, in which case a sign **in** (never a sign out) is also recorded as the day's check-in with \`source = 'door'\``.

`docs/TAO.md:92-94`: after "because the duty is to present, not merely to be seen leaving" add: ` A site may declare its door the place of presentation (\`feature_door_checkin\`); then a sign in is recorded as a check-in *marked as such*, and a sign out still is not.`

`docs/PRODUCT-ROADMAP.md`: before "## Stage 6", add:

```
## The door as the presentation

**Status: built 8 September 2026, behind the `feature_door_checkin` switch.**

- Off by default. On, a sign IN at the Door also records today's check-in,
  through the register's own function, with `source = 'door'` on the event;
  a sign OUT never does. The detail sheet says "Seen at the door 08:12" and
  lists each door event as such. Turning it off later leaves the record
  honest.
- Data added: one two-value column on an event the system already keeps.
- Not done: a source column on the daily register report. Add it when an
  inspector asks how a day was satisfied.
```

- [ ] **Step 5: Check and commit**

Parse snippets for admin, checkin, index; `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./check.sh` — all pass.

```bash
git add public/admin.html public/checkin.html public/index.html public/help.html README.md docs/TAO.md docs/PRODUCT-ROADMAP.md
git commit -m "The door switch on the screens: Settings, the sheet says at the door, the Door says so

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QMp1iENRi9GJLzm3baLCQy"
```

---

### Task 4: Push and fast-forward main

- [ ] `git fetch origin && git rebase origin/claude/security-hardening-roadmap-k7vtwv && PGBIN=/opt/homebrew/opt/postgresql@16/bin ./check.sh && git push origin HEAD && git checkout main && git merge --ff-only claude/security-hardening-roadmap-k7vtwv && git push origin main && git checkout claude/security-hardening-roadmap-k7vtwv`
