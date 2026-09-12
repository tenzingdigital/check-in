# Weekly Register Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Sunday "Weekly register update": absence spans from the overnight snapshot with approval in words, weekend partition, removals, room status and notes, a report under Admin → Reports, a Sunday email with recipients in Settings and a send-now button, the IPAS permitted-absence periods as a warning on holidays, and the iPad home-screen (standalone) support.

**Architecture:** One SQL function (`weekly_register_rows_unchecked`) builds every row and its sentence from base tables; a checked wrapper (`weekly_register_rows`) serves the report route; the nightly job and the send-now route share `lib/weeklyReport.js` to compose the email text. Rooms gain `status` and `note`. Two new settings and one new table (`absence_windows`) ride on the existing settings route. Two migrations: 035 (rooms, spans, report, settings) and 036 (absence windows).

**Tech Stack:** Express 4 on Node 22, PostgreSQL 16 (plpgsql, RLS, `security definer` functions), plain HTML/JS front ends with a hash-based CSP, `node:test`-style suite in `test/api.test.js` run by `./check.sh`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-10-weekly-register-update-design.md`. Read it first.
- Work on branch `claude/security-hardening-roadmap-k7vtwv`. Run `git fetch` and `git merge origin/main` before starting if main has moved. Do NOT push to `main` until every task is done; Render deploys main.
- Tests: `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./check.sh` runs everything. During a task, `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./test/api.sh` runs the HTTP suite alone (about a minute). The suite runs the server in-process with `HUT_MAIL_SINK=1`, so email lands in `global.__mailSink`.
- Every migration that touches a per-tenant table, view or function must be followed by `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./tools/gen-tenant-template.sh`, and `tenant/template.sql` committed with it. The HTTP suite's "a provisioned tenant schema matches the reference schema exactly" test fails otherwise.
- New SQL functions: `security definer set search_path = public`; `revoke all … from public, anon` and `grant execute … to authenticated` for anything the API calls; `revoke all … from public, anon, authenticated` for owner-only functions the nightly job calls.
- The nightly job runs as the database owner with no `auth.uid()`, so anything it queries must read base tables, never the `v_*` views (they filter on `is_staff()`).
- Copy rules: sentences in the report are exactly as the spec writes them. UI text is British English, no exclamation marks, the app "records facts" and never "decides".
- Commit after each task with a message in the repo's style (a sentence, then a short paragraph), ending with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Vr5PKm4KnWKvtjheJzL74A
  ```
- Test clients already in `test/api.test.js`: `api` (Gina, a guard), `supC` (sup2@hut.example, supervisor), and an admin is `dooradmin@hut.example` with `PASSWORD` (log in a fresh `client(base)`). `withOwner((c) => c.query(...))` runs SQL as owner in `public`. `siteToday()` returns today's date as `YYYY-MM-DD`. `hAdmin` belongs to a DIFFERENT tenant — do not use it.

---

## File map

| File | Responsibility |
|---|---|
| `migrations/035_weekly_register.sql` | rooms `status`/`note`; `v_room_occupancy` columns; `weekly_absence_spans`, `weekly_register_rows_unchecked`, `weekly_register_rows`; `app_settings.weekly_report_email`, `weekly_report_recipients` |
| `migrations/036_absence_windows.sql` | `absence_windows` table, RLS, audit |
| `routes/reports.js` | `REPORTS.weekly`; `status`, `note` on the vacancies report |
| `routes/buildings.js` | `PATCH /api/rooms/:id` accepts `status`, `note` |
| `routes/settings.js` | `emails` kind; `POST /api/settings/weekly-report/send`; absence-window routes |
| `routes/residents.js` | `warning` on a holiday outside every window |
| `lib/weeklyReport.js` | `lastWeek()`, `compose()` — shared by route and job |
| `jobs.js` | `weeklyRegister()` step after the overnight snapshot |
| `public/admin.html` | room form fields; Settings: weekly section, send-now, absence windows |
| `public/manifest.webmanifest`, `public/icon.svg`, `public/apple-touch-icon.png`, `tools/make-icon.js` | installable web app |
| `public/index.html`, `checkin.html`, `admin.html`, `org.html` | manifest + Apple meta tags |
| `lib/security.js` | `manifest-src 'self'` |
| `public/help.html`, `README.md`, `docs/PRODUCT-ROADMAP.md` | guide and docs |
| `test/api.test.js` | new sections; report count 16 → 17 |
| `tenant/template.sql` | regenerated |

---

### Task 1: Rooms gain a status and a note

**Files:**
- Create: `migrations/035_weekly_register.sql` (part 1 of 3; Tasks 2 and 3 append to it)
- Modify: `routes/buildings.js` (`PATCH /api/rooms/:id`, around line 165)
- Modify: `routes/reports.js` (`vacancies`, lines 83-92)
- Modify: `public/admin.html` (room card and edit form, lines ~1486-1500 and ~1549)
- Modify: `test/api.test.js` (new section after the migration 031 section, before line 2017)
- Regenerate: `tenant/template.sql`

**Interfaces:**
- Produces: `rooms.status text` (`'open'` | `'maintenance'`), `rooms.note text` (≤120), both on `v_room_occupancy` and on every room in `GET /api/buildings`; `PATCH /api/rooms/:id { status, note }`.

- [ ] **Step 1: Write the failing tests**

Insert before `console.log("\n== the nightly House Rules reminder by email (migration 032) ==");` in `test/api.test.js`:

```js
  console.log("\n== rooms: status and note for the weekly return (migration 035) ==");

  await test("a room can be marked under maintenance with a note, and the vacancies report carries both", async () => {
    const bld = await supC.fetch("/api/buildings", { method: "POST", body: { name: "Weekly Block" } });
    assert.equal(bld.status, 201, bld.text);
    const made = await supC.fetch(`/api/buildings/${bld.json.id}/rooms`, { method: "POST", body: { rooms: [{ floor: "", number: "W1", capacity: 2 }, { floor: "", number: "W2", capacity: 3 }] } });
    assert.equal(made.status, 201, made.text);
    const w1 = made.json.find((r) => r.number === "W1"), w2 = made.json.find((r) => r.number === "W2");
    assert.equal(w1.status, "open", "a new room is open");
    const bad = await supC.fetch(`/api/rooms/${w1.id}`, { method: "PATCH", body: { status: "closed" } });
    assert.equal(bad.status, 400);
    const set = await supC.fetch(`/api/rooms/${w1.id}`, { method: "PATCH", body: { status: "maintenance", note: "Boiler out until Friday" } });
    assert.equal(set.status, 200, set.text);
    assert.equal(set.json.status, "maintenance"); assert.equal(set.json.note, "Boiler out until Friday");
    const cleared = await supC.fetch(`/api/rooms/${w2.id}`, { method: "PATCH", body: { note: "   " } });
    assert.equal(cleared.status, 200); assert.equal(cleared.json.note, null, "a blank note is stored as null");
    const tooLong = await supC.fetch(`/api/rooms/${w2.id}`, { method: "PATCH", body: { note: "x".repeat(121) } });
    assert.equal(tooLong.status, 400);
    const asGuard = await api.fetch(`/api/rooms/${w1.id}`, { method: "PATCH", body: { status: "open" } });
    assert.equal(asGuard.status, 403);
    const list = await api.fetch("/api/buildings");
    const block = list.json.find((b) => b.name === "Weekly Block");
    assert.ok(block, "the building is missing from the list");
    const room = block.rooms.find((r) => r.number === "W1");
    assert.equal(room.status, "maintenance"); assert.equal(room.note, "Boiler out until Friday");
    const rep = await supC.fetch("/api/reports/vacancies?reason=return&format=json");
    assert.equal(rep.status, 200, rep.text);
    const row = rep.json.rows.find((r) => r.room === "W1");
    assert.equal(row.status, "maintenance"); assert.equal(row.note, "Boiler out until Friday");
    assert.equal(Object.keys(row).slice(-2).join(","), "status,note", "status and note are the last two columns");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./test/api.sh 2>&1 | grep -A3 "status and note"`
Expected: FAIL — `w1.status` is undefined.

- [ ] **Step 3: Write the migration (part 1)**

Create `migrations/035_weekly_register.sql`:

```sql
-- 035_weekly_register.sql — the Sunday Weekly Register Update.
--
-- Brighton Accommodation's "Weekly Register - Explanation Document"
-- (10 September 2026, docs/superpowers/specs/2026-09-10-weekly-register-update-design.md):
-- every Sunday the assistant centre manager emails head office who was
-- absent this week and whether management approved it, who left, and
-- which rooms are free or out of use. Three parts:
--
--   1. Rooms carry a status (open / maintenance) and a one-line note, the
--      only free text here, and it is about a room, never a person.
--   2. Absence spans: consecutive nights in overnight_absences (027)
--      collapsed into "from Monday to Wednesday", approved by construction
--      when every night is inside an authorised absence (028).
--   3. The report rows with their sentences, and the two settings that
--      send them on a Sunday (jobs.js).

-- ---------------------------------------------------------------------------
-- 1. Rooms: status and note
-- ---------------------------------------------------------------------------
alter table public.rooms
  add column if not exists status text not null default 'open' check (status in ('open', 'maintenance')),
  add column if not exists note   text check (note is null or length(note) <= 120);
comment on column public.rooms.status is 'open, or maintenance (out of use for now; a note for the return, not a lock).';
comment on column public.rooms.note is 'One line for the weekly return, e.g. "1 bed free for a single woman". About the room, never a resident.';

-- The occupancy view carries them. New columns go last: a view's existing
-- columns cannot be reordered in place.
create or replace view public.v_room_occupancy as
select
  b.id      as building_id,
  b.name    as building,
  b.sort    as building_sort,
  rm.id     as room_id,
  rm.floor,
  rm.number as room,
  rm.capacity,
  rm.sort   as room_sort,
  count(v.id)::integer                                   as occupants,
  count(v.id) filter (where v.presence = 'in')::integer  as on_site,
  coalesce(jsonb_agg(jsonb_build_object(
      'id', v.id, 'full_name', v.full_name, 'presence', v.presence, 'is_adult', v.is_adult,
      'evac_need', r.evac_need, 'household_id', r.household_id)
    order by r.household_id nulls last, v.last_name, v.first_name) filter (where v.id is not null), '[]'::jsonb) as residents,
  rm.contracted_capacity,
  rm.bed_config,
  (rm.archived_at is not null) as archived,
  rm.status,
  rm.note
from public.buildings b
join public.rooms rm on rm.building_id = b.id
left join public.residents r on r.room_id = rm.id and r.status = 'active'
left join public.v_resident_status v on v.id = r.id
where public.is_staff()
group by b.id, b.name, b.sort, rm.id, rm.floor, rm.number, rm.capacity, rm.contracted_capacity, rm.bed_config, rm.archived_at, rm.status, rm.note, rm.sort;

revoke all on public.v_room_occupancy from anon, public;
grant select on public.v_room_occupancy to authenticated;
```

- [ ] **Step 4: Accept the two fields on PATCH and return them everywhere**

In `routes/buildings.js`, in `router.patch('/rooms/:id', …)` after the `bed_config` line add:

```js
  // Status and note (migration 035): for the weekly return.
  if (Object.prototype.hasOwnProperty.call(body, 'status')) {
    const v = String(body.status || '');
    if (!['open', 'maintenance'].includes(v)) throw new HttpError(400, 'status must be open or maintenance');
    set('status', v);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'note')) set('note', optText(body.note, 120, 'Note') || null);
```

Then in every `returning …` list in `routes/buildings.js` that names room columns (`patch /rooms/:id`, `post /rooms/:id/restore`, and the `post /buildings/:id/rooms` insert), add `, status, note` after `archived_at` (or after the last column). Open `GET /api/buildings` in the same file: if it selects named columns from `v_room_occupancy` rather than `*`, add `status, note` to that list and to the room object it builds, so each room in the response carries both.

- [ ] **Step 5: The vacancies report**

In `routes/reports.js`, replace the `vacancies` sql with:

```js
    sql: `select o.building, o.floor, o.room, o.bed_config as beds,
                 o.capacity as physical_beds, coalesce(o.contracted_capacity, o.capacity) as contracted_beds,
                 o.occupants, coalesce(o.contracted_capacity, o.capacity) - o.occupants as vacancies,
                 o.status, o.note
            from v_room_occupancy o
           where not o.archived
           order by o.building_sort, o.building, o.room_sort, o.floor, o.room`,
```

- [ ] **Step 6: The room form and pill in Admin → Buildings**

In `public/admin.html`, in the room card template (the `<div class="room …">` around line 1486):

1. After the `<span class="hint">…on site</span>` in `.roomhead`, add:
   ```html
   ${r.status === "maintenance" ? `<span class="pill departed" title="${esc(r.note || "Under maintenance")}">maintenance</span>` : ""}
   ```
2. In `<form class="roomEdit">`, after the `grid3` div, add:
   ```html
   <div class="grid2">
     <div><label class="lbl">Status</label><select class="field reStatus" aria-label="Room status"><option value="open" ${r.status !== "maintenance" ? "selected" : ""}>Open</option><option value="maintenance" ${r.status === "maintenance" ? "selected" : ""}>Under maintenance</option></select></div>
     <div><label class="lbl">Note for the weekly return</label><input class="field reNote" type="text" maxlength="120" value="${esc(r.note || "")}" placeholder="e.g. 1 bed free for a single woman" aria-label="Room note"></div>
   </div>
   ```
3. In the `form.roomEdit` submit handler (around line 1549), extend `body`:
   ```js
   const body = { capacity: Number(form.querySelector(".reCap").value || 1), contracted_capacity: contract === "" ? null : Number(contract), bed_config: form.querySelector(".reBeds").value.trim(),
                  status: form.querySelector(".reStatus").value, note: form.querySelector(".reNote").value.trim() };
   ```

- [ ] **Step 7: Regenerate the tenant template and run the suite**

Run: `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./tools/gen-tenant-template.sh && PGBIN=/opt/homebrew/opt/postgresql@16/bin ./test/api.sh 2>&1 | tail -15`
Expected: the new test passes; "a provisioned tenant schema matches" passes; no failures.

- [ ] **Step 8: Commit**

```bash
git add migrations/035_weekly_register.sql routes/buildings.js routes/reports.js public/admin.html test/api.test.js tenant/template.sql
git commit -m "Rooms carry a status and a note for the weekly return"
```

---

### Task 2: Absence spans and the Weekly register update report

**Files:**
- Modify: `migrations/035_weekly_register.sql` (append part 2)
- Modify: `routes/reports.js` (add `REPORTS.weekly` after `REPORTS.away`; update the header comment list)
- Modify: `test/api.test.js` (report count at line ~1549; new section after Task 1's section)
- Regenerate: `tenant/template.sql`

**Interfaces:**
- Produces: `weekly_register_rows_unchecked(p_from date, p_to date)` (owner only) and `weekly_register_rows(p_from date, p_to date)` (supervisors and admins), both returning `(section text, building text, room text, resident text, child text, from_date date, to_date date, nights integer, back_on date, status text, line text)`. Report name `weekly`, title `Weekly register update`.

- [ ] **Step 1: Write the failing tests**

Change line ~1549 `assert.equal(list.json.length, 16);` to `assert.equal(list.json.length, 17);`.

Insert after Task 1's section (still before the migration 032 section):

```js
  console.log("\n== the Weekly register update: spans, approval, weekend, removals, rooms (migration 035) ==");

  // Nights well in the past so the migration-027 snapshot of "today" cannot
  // interfere. The range is a Sunday night to the Saturday night after it.
  const wkTo = (() => { const d = new Date(siteToday() + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - 30); while (d.getUTCDay() !== 6) d.setUTCDate(d.getUTCDate() - 1); return d; })();
  const wkDay = (offset) => { const d = new Date(wkTo); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };
  const wkFrom = wkDay(-6);   // the Sunday night

  await test("consecutive nights collapse into one span with approval in words", async () => {
    const jane = await supC.fetch("/api/residents", { method: "POST", body: { first_name: "Jane", last_name: "Weekly", date_of_birth: "1988-02-02" } });
    assert.equal(jane.status, 201, jane.text);
    const block = (await api.fetch("/api/buildings")).json.find((b) => b.name === "Weekly Block");
    const w2 = block.rooms.find((r) => r.number === "W2");
    assert.equal((await supC.fetch(`/api/residents/${jane.json.id}`, { method: "PATCH", body: { room_id: w2.id } })).status, 200);
    await withOwner((c) => c.query(`update public.residents set registered_at = now() - interval '60 days' where id = $1`, [jane.json.id]));
    // Mon, Tue, Wed nights out; Fri night out on its own.
    await withOwner((c) => c.query(
      `insert into public.overnight_absences (night, resident_id) values ($2::date, $1), ($3::date, $1), ($4::date, $1), ($5::date, $1) on conflict do nothing`,
      [jane.json.id, wkDay(-5), wkDay(-4), wkDay(-3), wkDay(-1)]));
    // Approved for Monday and Tuesday only.
    await withOwner((c) => c.query(
      `insert into public.authorised_absences (resident_id, from_date, to_date, reason) values ($1, $2::date, $3::date, 'family')`,
      [jane.json.id, wkDay(-5), wkDay(-4)]));
    const rep = await supC.fetch(`/api/reports/weekly?from=${wkFrom}&to=${wkDay(0)}&reason=Sunday&format=json`);
    assert.equal(rep.status, 200, rep.text);
    assert.equal(rep.json.title, "Weekly register update");
    const mine = rep.json.rows.filter((r) => r.resident === "Jane Weekly");
    assert.equal(mine.length, 2, JSON.stringify(mine));
    const [span, fri] = mine;
    assert.equal(span.section, "Resident absences");
    assert.equal(span.from_date, wkDay(-5)); assert.equal(span.to_date, wkDay(-3)); assert.equal(span.nights, 3);
    assert.equal(span.back_on, wkDay(-2), "back the day after the last absent night");
    assert.equal(span.status, "partly approved");
    assert.match(span.line, /^Jane Weekly from Weekly Block W2 was absent from \w+day \d+ \w+ to \w+day \d+ \w+ \d{4} \(3 nights\), back on \w+day \d+ \w+\. Partly approved \(2 of 3 nights\)\.$/);
    assert.equal(fri.section, "Updates from the weekend", "a span starting Friday night is a weekend update");
    assert.equal(fri.nights, 1); assert.equal(fri.status, "not approved");
    assert.match(fri.line, /\(1 night\), back on .*\. Not approved\.$/);
  });

  await test("a span reaching the last night is still away; a fully authorised one is approved; a guard is refused", async () => {
    const tom = await supC.fetch("/api/residents", { method: "POST", body: { first_name: "Tom", last_name: "Weekly", date_of_birth: "2015-06-06" } });
    assert.equal(tom.status, 201, tom.text);
    await withOwner((c) => c.query(`update public.residents set registered_at = now() - interval '60 days' where id = $1`, [tom.json.id]));
    await withOwner((c) => c.query(
      `insert into public.overnight_absences (night, resident_id) values ($2::date, $1), ($3::date, $1) on conflict do nothing`, [tom.json.id, wkDay(-1), wkDay(0)]));
    await withOwner((c) => c.query(
      `insert into public.authorised_absences (resident_id, from_date, to_date, reason, guardian_agreed) values ($1, $2::date, $3::date, 'holiday', true)`,
      [tom.json.id, wkDay(-1), wkDay(0)]));
    const rep = await supC.fetch(`/api/reports/weekly?from=${wkFrom}&to=${wkDay(0)}&reason=Sunday&format=json`);
    const row = rep.json.rows.find((r) => r.resident === "Tom Weekly");
    assert.ok(row, "Tom is missing");
    assert.equal(row.child, "child"); assert.equal(row.back_on, null); assert.equal(row.status, "approved");
    assert.match(row.line, /^Tom Weekly \(child\) was absent from .*\(2 nights\), still away\. Approved by management\.$/);
    const asGuard = await api.fetch(`/api/reports/weekly?from=${wkFrom}&to=${wkDay(0)}&reason=Sunday&format=json`);
    assert.equal(asGuard.status, 403);
  });

  await test("removals and room updates are on the same report, in order, and the CSV header is fixed", async () => {
    const gone = await supC.fetch("/api/residents", { method: "POST", body: { first_name: "Gone", last_name: "Weekly", date_of_birth: "1970-01-01" } });
    assert.equal(gone.status, 201, gone.text);
    const dep = await supC.fetch(`/api/residents/${gone.json.id}`, { method: "PATCH", body: { status: "departed", departed_on: wkDay(-2) } });
    assert.equal(dep.status, 200, dep.text);
    const rep = await supC.fetch(`/api/reports/weekly?from=${wkFrom}&to=${wkDay(0)}&reason=Sunday&format=json`);
    const sections = rep.json.rows.map((r) => r.section);
    const order = ["Resident absences", "Updates from the weekend", "Resident removals", "Room updates"];
    assert.deepEqual([...new Set(sections)], order.filter((s) => sections.includes(s)), "sections out of order");
    const removal = rep.json.rows.find((r) => r.section === "Resident removals" && r.resident === "Gone Weekly");
    assert.ok(removal, "the departure is missing"); assert.equal(removal.status, "departed");
    assert.match(removal.line, /^Gone Weekly departed on \w+day \d+ \w+ \d{4}\.$/);
    const maint = rep.json.rows.find((r) => r.section === "Room updates" && r.room === "W1");
    assert.equal(maint.status, "maintenance");
    assert.equal(maint.line, "Weekly Block W1 is under maintenance: Boiler out until Friday.");
    const free = rep.json.rows.find((r) => r.section === "Room updates" && r.room === "W2");
    assert.equal(free.status, "2 free", "W2 has 3 beds and one occupant");
    assert.equal(free.line, "Weekly Block W2: 2 of 3 beds free.");
    const csv = await supC.fetch(`/api/reports/weekly?from=${wkFrom}&to=${wkDay(0)}&reason=Sunday`);
    assert.match(csv.text, /^﻿?section,building,room,resident,child,from_date,to_date,nights,back_on,status,line\r\n/);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./test/api.sh 2>&1 | grep -B1 -A3 "Weekly register update\|list.json.length"`
Expected: FAIL — 404 "No such report" and the count assertion.

- [ ] **Step 3: Append part 2 to the migration**

Append to `migrations/035_weekly_register.sql`:

```sql
-- ---------------------------------------------------------------------------
-- 2. Absence spans
-- ---------------------------------------------------------------------------
-- Consecutive nights in overnight_absences become one span per resident.
-- back_on is the day on whose midnight the resident was on site again, or
-- null while the span reaches p_to. Approval is by construction: a night
-- inside an authorised absence is approved. Base tables only: the nightly
-- job runs this as owner, and the v_* views filter on is_staff().
create or replace function public.weekly_absence_spans(p_from date, p_to date)
returns table (
  resident_id uuid, resident text, building text, room text, child boolean,
  first_night date, last_night date, nights integer, back_on date,
  authorised_nights integer, approval text, weekend boolean,
  last_name text, first_name text
)
language sql stable security definer set search_path = public
as $$
  with nights as (
    select o.resident_id, o.night,
           o.night - (row_number() over (partition by o.resident_id order by o.night))::integer as grp
      from public.overnight_absences o
     where o.night between p_from and p_to
  ),
  spans as (
    select n.resident_id, min(n.night) as first_night, max(n.night) as last_night, count(*)::integer as nights,
           count(*) filter (where public.absence_authorised(n.resident_id, n.night))::integer as authorised_nights
      from nights n
     group by n.resident_id, n.grp
  )
  select s.resident_id,
         btrim(r.first_name) || ' ' || btrim(r.last_name),
         b.name, rm.number,
         (r.date_of_birth > (s.first_night - make_interval(years => st.adult_age_years))::date),
         s.first_night, s.last_night, s.nights,
         case when s.last_night < p_to then s.last_night + 1 end,
         s.authorised_nights,
         case when s.authorised_nights = s.nights then 'approved'
              when s.authorised_nights = 0       then 'not approved'
              else 'partly approved' end,
         extract(isodow from s.first_night) in (5, 6),
         r.last_name, r.first_name
    from spans s
    join public.residents r on r.id = s.resident_id
    left join public.rooms rm on rm.id = r.room_id
    left join public.buildings b on b.id = rm.building_id
    cross join (select adult_age_years from public.app_settings where id) st;
$$;
revoke all on function public.weekly_absence_spans(date, date) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The report rows, sentences included
-- ---------------------------------------------------------------------------
-- Four sections in a fixed order. The sentence is built here so the CSV,
-- the printable page and the Sunday email can never disagree.
create or replace function public.weekly_register_rows_unchecked(p_from date, p_to date)
returns table (
  section text, building text, room text, resident text, child text,
  from_date date, to_date date, nights integer, back_on date, status text, line text
)
language sql stable security definer set search_path = public
as $$
  select q.section, q.building, q.room, q.resident, q.child, q.from_date, q.to_date, q.nights, q.back_on, q.status, q.line
    from (
      -- Absences, then the weekend
      select case when s.weekend then 2 else 1 end as seq,
             s.first_night::text as k1, s.last_name as k2, s.first_name as k3,
             case when s.weekend then 'Updates from the weekend' else 'Resident absences' end as section,
             s.building, s.room, s.resident, case when s.child then 'child' else '' end as child,
             s.first_night as from_date, s.last_night as to_date, s.nights, s.back_on,
             s.approval as status,
             s.resident || case when s.child then ' (child)' else '' end
               || case when s.room is not null then ' from ' || s.building || ' ' || s.room else '' end
               || ' was absent from ' || to_char(s.first_night, 'FMDay FMDD FMMonth')
               || ' to ' || to_char(s.last_night, 'FMDay FMDD FMMonth YYYY')
               || ' (' || s.nights || ' night' || case when s.nights = 1 then '' else 's' end || '), '
               || case when s.back_on is null then 'still away' else 'back on ' || to_char(s.back_on, 'FMDay FMDD FMMonth') end
               || '. '
               || case s.approval when 'approved' then 'Approved by management.'
                                  when 'not approved' then 'Not approved.'
                                  else 'Partly approved (' || s.authorised_nights || ' of ' || s.nights || ' nights).' end as line
        from public.weekly_absence_spans(p_from, p_to) s
      union all
      -- Removals
      select 3, r.departed_on::text, r.last_name, r.first_name,
             'Resident removals', b.name, rm.number,
             btrim(r.first_name) || ' ' || btrim(r.last_name),
             case when r.date_of_birth > (r.departed_on - make_interval(years => st.adult_age_years))::date then 'child' else '' end,
             r.departed_on, r.departed_on, null::integer, null::date, 'departed',
             btrim(r.first_name) || ' ' || btrim(r.last_name)
               || case when r.date_of_birth > (r.departed_on - make_interval(years => st.adult_age_years))::date then ' (child)' else '' end
               || case when rm.id is not null then ' from ' || b.name || ' ' || rm.number else '' end
               || ' departed on ' || to_char(r.departed_on, 'FMDay FMDD FMMonth YYYY') || '.'
        from public.residents r
        left join public.rooms rm on rm.id = r.room_id
        left join public.buildings b on b.id = rm.building_id
        cross join (select adult_age_years from public.app_settings where id) st
       where r.status = 'departed' and r.departed_on between p_from and p_to
      union all
      -- Rooms under maintenance or with free contracted beds
      select 4, lpad(b.sort::text, 6, '0') || b.name, lpad(rm.sort::text, 6, '0') || rm.floor, rm.number,
             'Room updates', b.name, rm.number, null, '',
             null, null, null, null,
             case when rm.status = 'maintenance' then 'maintenance' else x.free || ' free' end,
             case when rm.status = 'maintenance'
                  then b.name || ' ' || rm.number || ' is under maintenance' || coalesce(': ' || rm.note, '') || '.'
                  else b.name || ' ' || rm.number || ': ' || x.free || ' of ' || x.contracted || ' bed' || case when x.contracted = 1 then '' else 's' end || ' free'
                       || coalesce(' (' || rm.bed_config || ')', '') || coalesce(': ' || rm.note, '') || '.' end
        from public.rooms rm
        join public.buildings b on b.id = rm.building_id
        cross join lateral (
          select coalesce(rm.contracted_capacity, rm.capacity) as contracted,
                 coalesce(rm.contracted_capacity, rm.capacity)
                   - (select count(*)::integer from public.residents r where r.room_id = rm.id and r.status = 'active') as free
        ) x
       where rm.archived_at is null and (rm.status = 'maintenance' or x.free > 0)
    ) q
   order by q.seq, q.k1, q.k2, q.k3;
$$;
revoke all on function public.weekly_register_rows_unchecked(date, date) from public, anon, authenticated;

-- What the API calls: a supervisor's report, refused to a guard.
create or replace function public.weekly_register_rows(p_from date, p_to date)
returns table (
  section text, building text, room text, resident text, child text,
  from_date date, to_date date, nights integer, back_on date, status text, line text
)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_supervisor() then
    raise exception 'Only a supervisor or admin may run the weekly register' using errcode = '42501';
  end if;
  return query select * from public.weekly_register_rows_unchecked(p_from, p_to);
end;
$$;
revoke all on function public.weekly_register_rows(date, date) from public, anon;
grant execute on function public.weekly_register_rows(date, date) to authenticated;
```

Note on the room note: `coalesce(': ' || rm.note, '')` is null-safe because `': ' || null` is null.

- [ ] **Step 4: Register the report**

In `routes/reports.js`, after the `REPORTS.away = { … };` block add:

```js
// The Sunday Weekly Register Update (migration 035): absences as spans of
// nights with approval in words, the weekend's on their own, the week's
// departures, and rooms under maintenance or with free beds. The sentence
// in `line` is what head office reads; the other columns are the facts.
REPORTS.weekly = {
  title: 'Weekly register update',
  ranged: true,
  sql: `select * from weekly_register_rows($1, $2)`,
};
```

Add `//   weekly      the Sunday Weekly Register Update: absence spans, weekend, removals, rooms (migration 035)` to the header comment list.

- [ ] **Step 5: Regenerate the template and run the suite**

Run: `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./tools/gen-tenant-template.sh && PGBIN=/opt/homebrew/opt/postgresql@16/bin ./test/api.sh 2>&1 | tail -15`
Expected: all pass. If the `line` regex fails, print `span.line` and compare word by word against the spec's sentence before touching the SQL.

- [ ] **Step 6: Commit**

```bash
git add migrations/035_weekly_register.sql routes/reports.js test/api.test.js tenant/template.sql
git commit -m "The Weekly register update: absence spans with approval in words, weekend, removals, rooms"
```

---

### Task 3: The Sunday email — settings, composer, send-now, nightly job

**Files:**
- Modify: `migrations/035_weekly_register.sql` (append part 3)
- Create: `lib/weeklyReport.js`
- Modify: `routes/settings.js` (`COLUMNS`, the `emails` kind, new route)
- Modify: `jobs.js` (`weeklyRegister`, wiring, export)
- Modify: `public/admin.html` (Settings section, `SETTINGS_FIELDS`, `FEATURE_FIELDS`, send button)
- Modify: `test/api.test.js` (new section after Task 2's)
- Regenerate: `tenant/template.sql`

**Interfaces:**
- Consumes: `weekly_register_rows(from, to)` and `weekly_register_rows_unchecked(from, to)` from Task 2.
- Produces: `app_settings.weekly_report_email boolean`, `app_settings.weekly_report_recipients text`; `lib/weeklyReport.js` exporting `lastWeek(todayIso) → { from, to }` and `compose({ siteName, from, to, rows }) → { subject, text }`; `POST /api/settings/weekly-report/send` → `{ sent, recipients, from, to }`; `weeklyRegister(schema, label, { force })` exported from `jobs.js`.

- [ ] **Step 1: Write the failing tests**

Insert after Task 2's section:

```js
  console.log("\n== the Sunday email: recipients, send now, the nightly job (migration 035) ==");

  const wkAdmin = client(base);
  assert.equal((await wkAdmin.fetch("/api/session", { method: "POST", body: { email: "dooradmin@hut.example", password: PASSWORD } })).status, 200);

  await test("recipients are validated, lower-cased and cleared; the switch is a setting", async () => {
    const bad = await wkAdmin.fetch("/api/settings", { method: "PATCH", body: { weekly_report_recipients: "not-an-address" } });
    assert.equal(bad.status, 400);
    const many = await wkAdmin.fetch("/api/settings", { method: "PATCH", body: { weekly_report_recipients: Array.from({ length: 11 }, (_, i) => `m${i}@example.ie`).join(",") } });
    assert.equal(many.status, 400, "more than ten addresses");
    const ok = await wkAdmin.fetch("/api/settings", { method: "PATCH", body: { weekly_report_recipients: " Mick@Example.ie, niamh@example.ie ", weekly_report_email: true } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.weekly_report_recipients, "mick@example.ie,niamh@example.ie");
    assert.equal(ok.json.weekly_report_email, true);
    const asSup = await supC.fetch("/api/settings", { method: "PATCH", body: { weekly_report_email: false } });
    assert.equal(asSup.status, 403);
  });

  await test("lastWeek and compose are pure", async () => {
    const { lastWeek, compose } = require("../lib/weeklyReport");
    assert.deepEqual(lastWeek("2026-09-13"), { from: "2026-09-06", to: "2026-09-12" });
    const out = compose({ siteName: "Slaney", from: "2026-09-06", to: "2026-09-12", rows: [
      { section: "Resident absences", line: "A was absent." }, { section: "Room updates", line: "B1 is under maintenance." }] });
    assert.equal(out.subject, "Slaney: Weekly register update, 6 September to 12 September 2026");
    assert.match(out.text, /^Slaney: Weekly register update, 6 September to 12 September 2026\n\nResident absences\n- A was absent\.\n\nUpdates from the weekend\n\(none\)\n\nResident removals\n\(none\)\n\nRoom updates\n- B1 is under maintenance\.\n\nNights are counted at midnight/);
  });

  await test("send now emails every recipient last week's report and is on the audit record; refused without recipients or to a supervisor", async () => {
    const asSup = await supC.fetch("/api/settings/weekly-report/send", { method: "POST" });
    assert.equal(asSup.status, 403);
    const before = (global.__mailSink || []).length;
    const sent = await wkAdmin.fetch("/api/settings/weekly-report/send", { method: "POST" });
    assert.equal(sent.status, 200, sent.text);
    assert.equal(sent.json.recipients, 2);
    const { lastWeek } = require("../lib/weeklyReport");
    assert.deepEqual({ from: sent.json.from, to: sent.json.to }, lastWeek(siteToday()));
    const mails = (global.__mailSink || []).slice(before);
    assert.equal(mails.length, 2);
    assert.ok(mails.some((m) => m.to === "mick@example.ie") && mails.some((m) => m.to === "niamh@example.ie"));
    assert.ok(mails.every((m) => /Weekly register update/.test(m.subject) && /Resident absences/.test(m.text)), "subject and sections");
    const logged = await withOwner((c) => c.query(`select note from public.admin_audit where table_name = 'reports' and row_id = 'weekly' order by at desc limit 1`));
    assert.match(logged.rows[0].note, /sent by hand/);
    await wkAdmin.fetch("/api/settings", { method: "PATCH", body: { weekly_report_recipients: "" } });
    const none = await wkAdmin.fetch("/api/settings/weekly-report/send", { method: "POST" });
    assert.equal(none.status, 400);
    const cleared = await wkAdmin.fetch("/api/settings");
    assert.equal(cleared.json.weekly_report_recipients, null, "an empty string stores null");
  });

  await test("the nightly step sends on a Sunday when on, and records why it did not otherwise", async () => {
    const { weeklyRegister } = require("../jobs");
    await withOwner((c) => c.query(`update public.app_settings set weekly_report_email = false, weekly_report_recipients = 'mick@example.ie'`));
    const before = (global.__mailSink || []).length;
    assert.equal(await weeklyRegister("public", "", { force: true }), true);
    assert.equal((global.__mailSink || []).length, before, "nothing goes while the switch is off");
    let run = await withOwner((c) => c.query(`select ok, result from public.job_runs where job = 'weekly-register-email' order by id desc limit 1`));
    assert.equal(run.rows[0].result, "off");
    await withOwner((c) => c.query(`update public.app_settings set weekly_report_email = true`));
    assert.equal(await weeklyRegister("public", "", { force: true }), true);
    const mails = (global.__mailSink || []).slice(before);
    assert.equal(mails.length, 1); assert.equal(mails[0].to, "mick@example.ie");
    assert.match(mails[0].text, /Weekly register update/);
    run = await withOwner((c) => c.query(`select ok, result from public.job_runs where job = 'weekly-register-email' order by id desc limit 1`));
    assert.equal(run.rows[0].ok, true); assert.match(run.rows[0].result, /rows, \d\/1 emailed/, \"the sink answers not delivered, so 0/1 is right here\");
    const dow = (await withOwner((c) => c.query(`select extract(isodow from public.site_today())::int as d`))).rows[0].d;
    if (dow !== 7) {
      assert.equal(await weeklyRegister("public", ""), true);
      run = await withOwner((c) => c.query(`select result from public.job_runs where job = 'weekly-register-email' order by id desc limit 1`));
      assert.equal(run.rows[0].result, "not Sunday");
    }
    await withOwner((c) => c.query(`update public.app_settings set weekly_report_email = false, weekly_report_recipients = null`));
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./test/api.sh 2>&1 | grep -A3 "Sunday email\|recipients are validated"`
Expected: FAIL — the PATCH ignores the unknown columns (200 with no field) or 400.

- [ ] **Step 3: Append part 3 to the migration**

Append to `migrations/035_weekly_register.sql`:

```sql
-- ---------------------------------------------------------------------------
-- 4. Sent on a Sunday
-- ---------------------------------------------------------------------------
-- Off by default. On, the nightly job (jobs.js) emails the addresses below
-- the report for the previous Sunday night through Saturday night, early on
-- Sunday morning, after Saturday night's snapshot. Needs email configured.
alter table public.app_settings
  add column if not exists weekly_report_email boolean not null default false,
  add column if not exists weekly_report_recipients text check (weekly_report_recipients is null or length(weekly_report_recipients) <= 400);
comment on column public.app_settings.weekly_report_email is 'Email the Weekly register update every Sunday (jobs.js).';
comment on column public.app_settings.weekly_report_recipients is 'Comma-separated addresses that receive it. Null: nobody.';
```

- [ ] **Step 4: The composer**

Create `lib/weeklyReport.js`:

```js
// The Sunday Weekly Register Update as an email — shared by the nightly job
// (jobs.js) and the send-now route (routes/settings.js), so the two can
// never differ. The rows and their sentences come from
// weekly_register_rows() (migration 035); this file only lays them out.

const SECTIONS = ['Resident absences', 'Updates from the weekend', 'Resident removals', 'Room updates'];

// The week that ended last night: the previous Sunday night through
// Saturday night, as nights. todayIso is the site's date, 'YYYY-MM-DD'.
function lastWeek(todayIso) {
  const d = new Date(`${todayIso}T00:00:00Z`);
  const iso = (x) => x.toISOString().slice(0, 10);
  const to = new Date(d); to.setUTCDate(to.getUTCDate() - 1);
  const from = new Date(d); from.setUTCDate(from.getUTCDate() - 7);
  return { from: iso(from), to: iso(to) };
}

function dayMonth(iso, withYear) {
  const d = new Date(`${iso}T00:00:00Z`);
  const opts = { day: 'numeric', month: 'long', timeZone: 'UTC' };
  if (withYear) opts.year = 'numeric';
  return d.toLocaleDateString('en-IE', opts);
}

function compose({ siteName, from, to, rows }) {
  const name = siteName || 'CheckSteady';
  const title = `${name}: Weekly register update, ${dayMonth(from)} to ${dayMonth(to, true)}`;
  const parts = SECTIONS.map((section) => {
    const lines = rows.filter((r) => r.section === section).map((r) => `- ${r.line}`);
    return `${section}\n${lines.length ? lines.join('\n') : '(none)'}`;
  });
  const text = `${title}\n\n${parts.join('\n\n')}\n\n` +
    'Nights are counted at midnight, site time. An absence inside an authorised absence ' +
    'recorded in CheckSteady is approved; any other is not. The full report, printable and ' +
    'as CSV, is under Admin → Reports.';
  return { subject: title, text };
}

module.exports = { SECTIONS, lastWeek, compose };
```

- [ ] **Step 5: The settings columns and the `emails` kind**

In `routes/settings.js` `COLUMNS`, after `notify_thresholds_email`, add:

```js
  // The Sunday Weekly register update by email (035).
  weekly_report_email:           { kind: 'bool' },
  weekly_report_recipients:      { kind: 'emails' },
```

In the PATCH loop, before the `} else if (rule.kind === 'bool') {` branch, add:

```js
    } else if (rule.kind === 'emails') {
      // Comma-separated addresses; empty clears. Same shape as a staff invite.
      const parts = String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (parts.length > 10) throw new HttpError(400, 'At most ten addresses');
      for (const p of parts) {
        if (!/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(p) || p.length > 120) throw new HttpError(400, `${p} is not an email address`);
      }
      v = parts.length ? parts.join(',') : null;
```

- [ ] **Step 6: The send-now route**

At the end of `routes/settings.js`, before `module.exports`, add:

```js
// ---------------------------------------------------------------------------
// POST /api/settings/weekly-report/send — last week's Weekly register update
// to the saved recipients, now. Administrators; on the audit record like an
// export, so a manual send has a trail.
// ---------------------------------------------------------------------------
const mail = require('../lib/mail');
const weekly = require('../lib/weeklyReport');

router.post('/weekly-report/send', wrap(async (req, res) => {
  if (req.session.role !== 'admin') throw new HttpError(403, 'Only an administrator can send the weekly report');
  const out = await db.withIdentity(req.session.userId, async (client) => {
    const { rows: [s] } = await client.query(
      `select site_name, weekly_report_recipients as recipients, to_char(site_today(), 'YYYY-MM-DD') as today from app_settings where id`);
    if (!s || !s.recipients) throw new HttpError(400, 'Add at least one recipient under Settings first');
    const { from, to } = weekly.lastWeek(s.today);
    await client.query('select note_report($1, $2, $3, $4)', ['weekly', 'sent by hand', from, to]);
    const { rows } = await client.query('select * from weekly_register_rows($1, $2)', [from, to]);
    const { subject, text } = weekly.compose({ siteName: s.site_name, from, to, rows });
    const recipients = s.recipients.split(',');
    let sent = 0;
    for (const to_ of recipients) {
      const r = await mail.send({ to: to_, subject, text });
      if (r.delivered) sent += 1;
    }
    return { sent, recipients: recipients.length, from, to };
  });
  res.json(out);
}));
```

Check that `wrap`, `db` and `HttpError` are already imported at the top of `routes/settings.js` (they are, for the existing routes).

- [ ] **Step 7: The nightly step**

In `jobs.js`, after `notifyThresholds` and before `async function main()`, add:

```js
// The Sunday Weekly Register Update (migration 035): on a Sunday, after
// Saturday night's snapshot, the addresses in Settings receive the week's
// absences, weekend updates, removals and room updates as plain text. The
// rows come from weekly_register_rows_unchecked(), the owner's copy: the
// checked one asks is_supervisor(), which a job is not.
const weekly = require('./lib/weeklyReport');
async function weeklyRegister(schema, label, { force = false } = {}) {
  const name = 'weekly-register-email';
  const started = Date.now();
  try {
    const summary = await withOwnerIn(schema, async (client) => {
      const { rows: [s] } = await client.query(
        `select weekly_report_email as on, weekly_report_recipients as recipients, site_name,
                to_char(site_today(), 'YYYY-MM-DD') as today, extract(isodow from site_today())::int as dow
           from app_settings where id`);
      if (!s || !s.on) { await record(client, name, true, 'off'); return 'off'; }
      if (!s.recipients) { await record(client, name, true, 'no recipients'); return 'no recipients'; }
      if (s.dow !== 7 && !force) { await record(client, name, true, 'not Sunday'); return 'not Sunday'; }
      const { from, to } = weekly.lastWeek(s.today);
      const { rows } = await client.query('select * from weekly_register_rows_unchecked($1, $2)', [from, to]);
      const { subject, text } = weekly.compose({ siteName: s.site_name, from, to, rows });
      const recipients = s.recipients.split(',');
      let delivered = 0;
      for (const to_ of recipients) {
        const out = await mail.send({ to: to_, subject, text });
        if (out.delivered) delivered += 1;
      }
      const result = `${rows.length} rows, ${delivered}/${recipients.length} emailed`;
      await record(client, name, true, result);
      return result;
    });
    console.log(`[jobs] ${label}${name}: ok (${summary}) in ${Date.now() - started}ms`);
    return true;
  } catch (err) {
    console.error(`[jobs] ${label}${name}: FAILED — ${err.message}`);
    await withOwnerIn(schema, (client) => record(client, name, false, err.message)).catch(() => {});
    return false;
  }
}
```

In `main()`, in the `for (const [name, sql, liveOnly] of TENANT_JOBS)` loop, after the `notifyThresholds` line add:

```js
      if (name === 'snapshot-overnight-absences' && !(await weeklyRegister(schema, label))) failed += 1;
```

Change the export to `module.exports = { notifyThresholds, weeklyRegister };`.

Note: the mail sink answers `delivered: false`, so in the suite the recorded result reads `N rows, 0/1 emailed`; the test's regex allows any digit for that reason.

- [ ] **Step 8: The Settings screen**

In `public/admin.html`, in the Settings form after the `stMfa` checkbox label, add:

```html
        <h2 class="mt6">Weekly register update</h2>
        <label class="check"><input id="stWeekly" type="checkbox"> <span><b>Email the Weekly register update every Sunday.</b> Early Sunday morning, after Saturday night's snapshot, the addresses below receive the week's absences, weekend updates, removals and room updates as plain text. Needs email configured on the service.</span></label>
        <div><label class="lbl" for="stWeeklyTo">Recipients</label><input id="stWeeklyTo" class="field" type="text" maxlength="400" placeholder="mick@example.ie, niamh@example.ie">
          <p class="hint under">Comma-separated, up to ten. <button class="linkish" type="button" id="stWeeklySend">Send last week's now</button> to check what arrives. A manual send is on the audit record.</p></div>
```

In the script: add `weekly_report_recipients: "stWeeklyTo"` to `SETTINGS_FIELDS` and `weekly_report_email: "stWeekly"` to `FEATURE_FIELDS`. After `$("stReload").addEventListener("click", loadSettings);` add:

```js
$("stWeeklySend").addEventListener("click", async () => {
  $("stWeeklySend").disabled = true;
  const out = await guarded(() => apiPost("/api/settings/weekly-report/send", {}), (err) => toast("Not sent: " + err.message, "err"));
  $("stWeeklySend").disabled = false;
  if (!out) return;
  toast(`Sent for ${out.from} to ${out.to} to ${out.recipients} address${out.recipients === 1 ? "" : "es"}`, "ok");
});
```

`SETTINGS_FIELDS` values are sent as `.value.trim()`; an empty recipients box therefore sends `""`, which the `emails` kind stores as null. Nothing else to do.

- [ ] **Step 9: Regenerate the template and run the suite**

Run: `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./tools/gen-tenant-template.sh && PGBIN=/opt/homebrew/opt/postgresql@16/bin ./test/api.sh 2>&1 | tail -15`
Expected: all pass. Then `./check.sh` layer 1 (`node -e` parse) must pass for the HTML change: run `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./check.sh 2>&1 | tail -20`.

- [ ] **Step 10: Commit**

```bash
git add migrations/035_weekly_register.sql lib/weeklyReport.js routes/settings.js jobs.js public/admin.html test/api.test.js tenant/template.sql
git commit -m "The Weekly register update by email on a Sunday, and a send-now for checking"
```

---

### Task 4: Permitted absence periods

**Files:**
- Create: `migrations/036_absence_windows.sql`
- Modify: `routes/settings.js` (three routes)
- Modify: `routes/residents.js` (`POST /:id/absences`, lines 334-355)
- Modify: `public/admin.html` (Settings section; absence form toast)
- Modify: `test/api.test.js` (new section after Task 3's)
- Regenerate: `tenant/template.sql`

**Interfaces:**
- Produces: table `absence_windows (id bigserial, name, from_date, to_date, created_by, created_at)`; `GET /api/settings/absence-windows → [{ id, name, from_date, to_date }]`; `POST /api/settings/absence-windows { name, from_date, to_date } → 201 row`; `DELETE /api/settings/absence-windows/:id → { ok: true }`; `POST /api/residents/:id/absences` response gains `warning` (string) when a holiday lies outside every window and at least one window exists.

- [ ] **Step 1: Write the failing tests**

Insert after Task 3's section:

```js
  console.log("\n== permitted absence periods (migration 036) ==");

  await test("an administrator keeps the IPAS windows; a holiday outside them carries a warning, other reasons never do", async () => {
    const who = await supC.fetch("/api/residents", { method: "POST", body: { first_name: "Window", last_name: "Weekly", date_of_birth: "1985-03-03" } });
    assert.equal(who.status, 201, who.text);
    const y = new Date().getUTCFullYear() + 1;
    // No windows yet: no warning.
    const early = await supC.fetch(`/api/residents/${who.json.id}/absences`, { method: "POST", body: { from_date: `${y}-03-01`, to_date: `${y}-03-03`, reason: "holiday" } });
    assert.equal(early.status, 201, early.text); assert.equal(early.json.warning, undefined);
    const asSup = await supC.fetch("/api/settings/absence-windows", { method: "POST", body: { name: "Summer", from_date: `${y}-07-01`, to_date: `${y}-08-31` } });
    assert.equal(asSup.status, 403);
    const bad = await wkAdmin.fetch("/api/settings/absence-windows", { method: "POST", body: { name: "", from_date: `${y}-07-01`, to_date: `${y}-06-30` } });
    assert.equal(bad.status, 400);
    const made = await wkAdmin.fetch("/api/settings/absence-windows", { method: "POST", body: { name: "Summer school holiday", from_date: `${y}-07-01`, to_date: `${y}-08-31` } });
    assert.equal(made.status, 201, made.text);
    const list = await api.fetch("/api/settings/absence-windows");
    assert.equal(list.status, 200); assert.ok(list.json.some((w) => w.id === made.json.id && w.name === "Summer school holiday"));
    const inside = await supC.fetch(`/api/residents/${who.json.id}/absences`, { method: "POST", body: { from_date: `${y}-07-10`, to_date: `${y}-07-20`, reason: "holiday" } });
    assert.equal(inside.status, 201, inside.text); assert.equal(inside.json.warning, undefined);
    const outside = await supC.fetch(`/api/residents/${who.json.id}/absences`, { method: "POST", body: { from_date: `${y}-10-01`, to_date: `${y}-10-05`, reason: "holiday" } });
    assert.equal(outside.status, 201, outside.text);
    assert.equal(outside.json.warning, "Outside the permitted absence periods in Settings");
    const family = await supC.fetch(`/api/residents/${who.json.id}/absences`, { method: "POST", body: { from_date: `${y}-11-01`, to_date: `${y}-11-02`, reason: "family" } });
    assert.equal(family.status, 201); assert.equal(family.json.warning, undefined, "only holidays are checked");
    const delSup = await supC.fetch(`/api/settings/absence-windows/${made.json.id}`, { method: "DELETE" });
    assert.equal(delSup.status, 403);
    const del = await wkAdmin.fetch(`/api/settings/absence-windows/${made.json.id}`, { method: "DELETE" });
    assert.equal(del.status, 200);
    const gone = await wkAdmin.fetch(`/api/settings/absence-windows/${made.json.id}`, { method: "DELETE" });
    assert.equal(gone.status, 404);
    const audited = await withOwner((c) => c.query(`select count(*)::int as n from public.admin_audit where table_name = 'absence_windows'`));
    assert.ok(audited.rows[0].n >= 2, "adding and removing a window should be audited");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./test/api.sh 2>&1 | grep -A3 "permitted absence periods"`
Expected: FAIL — 404 on the windows route.

- [ ] **Step 3: The migration**

Create `migrations/036_absence_windows.sql`:

```sql
-- 036_absence_windows.sql — the permitted absence periods IPAS notifies.
--
-- Christmas, Ramadan, Easter, the summer school holiday: dates that change
-- every year, held here by an administrator so the app can say when a
-- holiday falls outside them. It says so; it does not refuse. The 14-day
-- cap (029) and the guardian rule are unchanged. Policy, not a person:
-- no retention clock, kept until removed.

create table if not exists public.absence_windows (
  id         bigserial primary key,
  name       text not null check (length(btrim(name)) between 1 and 60),
  from_date  date not null,
  to_date    date not null,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  check (to_date >= from_date)
);
comment on table public.absence_windows is 'Permitted absence periods notified by IPAS. A holiday authorised outside every window carries a warning; nothing is refused.';

alter table public.absence_windows enable row level security;
drop policy if exists absence_windows_read on public.absence_windows;
create policy absence_windows_read on public.absence_windows for select using (public.is_staff());
drop policy if exists absence_windows_admin on public.absence_windows;
create policy absence_windows_admin on public.absence_windows for all using (public.is_admin()) with check (public.is_admin());
revoke all on public.absence_windows from anon, public;
grant select, insert, delete on public.absence_windows to authenticated;
grant usage on sequence public.absence_windows_id_seq to authenticated;

drop trigger if exists absence_windows_audit on public.absence_windows;
create trigger absence_windows_audit
  after insert or update or delete on public.absence_windows
  for each row execute function public.audit_row();

-- Does the whole span lie inside one window? False when there are no
-- windows at all is not useful, so the caller asks separately whether any
-- exist (routes/residents.js).
create or replace function public.inside_absence_window(p_from date, p_to date)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.absence_windows w
                  where daterange(w.from_date, w.to_date, '[]') @> daterange(p_from, p_to, '[]'));
$$;
revoke all on function public.inside_absence_window(date, date) from public, anon;
grant execute on function public.inside_absence_window(date, date) to authenticated;
```

- [ ] **Step 4: The routes**

In `routes/settings.js`, before `module.exports`, add:

```js
// ---------------------------------------------------------------------------
// Permitted absence periods (migration 036)
// ---------------------------------------------------------------------------
//   GET    /api/settings/absence-windows       any staff member
//   POST   /api/settings/absence-windows       administrators
//   DELETE /api/settings/absence-windows/:id   administrators
const { dateParam } = require('../lib/api');

router.get('/absence-windows', wrap(async (req, res) => {
  const rows = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query(
      `select id, name, from_date::text as from_date, to_date::text as to_date from absence_windows order by from_date, id`);
    return rows;
  });
  res.json(rows);
}));

router.post('/absence-windows', wrap(async (req, res) => {
  if (req.session.role !== 'admin') throw new HttpError(403, 'Only an administrator can change the permitted absence periods');
  const body = req.body || {};
  const name = String(body.name || '').trim();
  if (!name || name.length > 60) throw new HttpError(400, 'Give the period a name (up to 60 characters)');
  const from = dateParam(body.from_date, 'from_date');
  const to = dateParam(body.to_date, 'to_date');
  if (to < from) throw new HttpError(400, 'The last day must not be before the first');
  const row = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query(
      `insert into absence_windows (name, from_date, to_date, created_by) values ($1, $2, $3, $4)
       returning id, name, from_date::text as from_date, to_date::text as to_date`, [name, from, to, req.session.userId]);
    return rows[0];
  }).catch((err) => { if (err && err.code === '42501') throw new HttpError(403, 'Only an administrator can change the permitted absence periods'); throw err; });
  res.status(201).json(row);
}));

router.delete('/absence-windows/:id', wrap(async (req, res) => {
  if (req.session.role !== 'admin') throw new HttpError(403, 'Only an administrator can change the permitted absence periods');
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id < 1) throw new HttpError(400, 'Bad id');
  const n = await db.withIdentity(req.session.userId, async (client) => {
    const { rowCount } = await client.query('delete from absence_windows where id = $1', [id]);
    return rowCount;
  });
  if (!n) throw new HttpError(404, 'No such period');
  res.json({ ok: true });
}));
```

If `dateParam` is already imported at the top of `routes/settings.js`, do not import it twice; add it to the existing destructuring instead.

- [ ] **Step 5: The warning on a holiday**

In `routes/residents.js`, `router.post('/:id/absences', …)`: inside the `withIdentity` callback, after the `named` query and before `return`, add:

```js
    // Permitted absence periods (migration 036): a holiday outside every
    // window is still recorded; the answer says so.
    let warning;
    if (reason === 'holiday') {
      const { rows: [w] } = await client.query(
        `select (select count(*)::int from absence_windows) as n, inside_absence_window($1, $2) as inside`, [from, to]);
      if (w.n > 0 && !w.inside) warning = 'Outside the permitted absence periods in Settings';
    }
    return { row: named[0] || rows[0], warning };
```

and change the tail to:

```js
  res.status(201).json(row.warning ? { ...absenceRow(row.row), warning: row.warning } : absenceRow(row.row));
```

(rename the outer `const row` accordingly so `row.row` reads clearly, e.g. `const out = …; res.status(201).json(out.warning ? { ...absenceRow(out.row), warning: out.warning } : absenceRow(out.row));`).

- [ ] **Step 6: The Settings screen and the toast**

In `public/admin.html`, after the Weekly register update block from Task 3, add:

```html
        <h2 class="mt6">Permitted absence periods <button class="tip" type="button" data-tip="The dates IPAS notifies: Christmas, Ramadan, Easter, the summer school holiday. A holiday authorised outside these periods still goes through; the screen says so." aria-label="About permitted absence periods">?</button></h2>
        <div id="awList" class="list"></div>
        <div class="grid3">
          <input id="awName" class="field" type="text" maxlength="60" placeholder="Name, e.g. Summer 2026" aria-label="Period name">
          <input id="awFrom" class="field" type="date" aria-label="First day">
          <input id="awTo" class="field" type="date" aria-label="Last day">
        </div>
        <div class="actions"><button class="btn sm" type="button" id="awAdd">Add period</button></div>
```

In the script, after the `stWeeklySend` handler:

```js
async function loadWindows() {
  const rows = await guarded(() => apiGet("/api/settings/absence-windows"), () => null);
  if (!rows) return;
  $("awList").innerHTML = rows.length ? rows.map((w) => `
    <div class="report"><div><b>${esc(w.name)}</b><span class="hint">${esc(w.from_date)} to ${esc(w.to_date)}</span></div>
      <button class="linkish" type="button" data-del-window="${w.id}" aria-label="Remove ${esc(w.name)}">remove</button></div>`).join("")
    : '<p class="hint flush">No periods recorded. Holidays are never warned about until one is.</p>';
}
$("awAdd").addEventListener("click", async () => {
  const body = { name: $("awName").value.trim(), from_date: $("awFrom").value, to_date: $("awTo").value };
  const out = await guarded(() => apiPost("/api/settings/absence-windows", body), (err) => toast("Not added: " + err.message, "err"));
  if (!out) return;
  $("awName").value = ""; $("awFrom").value = ""; $("awTo").value = "";
  toast("Period added", "ok"); loadWindows();
});
$("awList").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-del-window]"); if (!btn) return;
  const out = await guarded(() => api(`/api/settings/absence-windows/${btn.dataset.delWindow}`, { method: "DELETE" }), (err) => toast("Not removed: " + err.message, "err"));
  if (!out) return;
  toast("Period removed", "ok"); loadWindows();
});
```

Call `loadWindows();` at the end of `loadSettings()`.

In the absence form submit handler (around line 1121, `toast("Absence recorded", "ok");`), change to:

```js
      toast(out.warning ? `Absence recorded. ${out.warning}` : "Absence recorded", "ok");
```

- [ ] **Step 7: Regenerate the template and run the suite**

Run: `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./tools/gen-tenant-template.sh && PGBIN=/opt/homebrew/opt/postgresql@16/bin ./check.sh 2>&1 | tail -20`
Expected: all layers pass.

- [ ] **Step 8: Commit**

```bash
git add migrations/036_absence_windows.sql routes/settings.js routes/residents.js public/admin.html test/api.test.js tenant/template.sql
git commit -m "Permitted absence periods: the IPAS windows as a setting, a warning on a holiday outside them"
```

---

### Task 5: The iPad as a fixed sign-in terminal

**Files:**
- Create: `public/manifest.webmanifest`, `public/icon.svg`, `tools/make-icon.js`, `public/apple-touch-icon.png` (generated)
- Modify: `public/index.html`, `public/checkin.html`, `public/admin.html`, `public/org.html` (head)
- Modify: `lib/security.js` (`buildCsp`)
- Modify: `test/api.test.js` (the static tier section, line ~2594)

- [ ] **Step 1: Write the failing test**

In the "the static tier" section of `test/api.test.js`, add:

```js
  await test("the app is installable: a manifest in standalone mode, linked from every page, allowed by the CSP", async () => {
    const m = await api.fetch("/manifest.webmanifest");
    assert.equal(m.status, 200);
    assert.match(m.headers.get("content-type"), /application\/manifest\+json/);
    const manifest = JSON.parse(m.text);
    assert.equal(manifest.display, "standalone"); assert.equal(manifest.start_url, "/");
    assert.ok(manifest.icons.some((i) => i.sizes === "512x512"), "a 512 icon");
    for (const page of ["/index.html", "/checkin.html", "/admin.html", "/org.html"]) {
      const res = await api.fetch(page);
      assert.match(res.text, /<link rel="manifest" href="\/manifest.webmanifest">/, `${page} lacks the manifest link`);
      assert.match(res.text, /<meta name="apple-mobile-web-app-capable" content="yes">/, `${page} lacks the Apple meta`);
      assert.match(res.headers.get("content-security-policy"), /manifest-src 'self'/);
    }
    const icon = await api.fetch("/apple-touch-icon.png");
    assert.equal(icon.status, 200); assert.match(icon.headers.get("content-type"), /image\/png/);
  });
```

If `client.fetch` does not expose `.text` for non-JSON bodies, look at how the existing static-tier test reads `/index.html` and follow it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./test/api.sh 2>&1 | grep -A3 "installable"`
Expected: FAIL — 404 for the manifest.

- [ ] **Step 3: The icon and the manifest**

Create `public/icon.svg`:

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#1d4ed8"/><path d="M18 33l10 10 18-20" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>
```

Create `tools/make-icon.js` (no dependencies; draws the same tick as a 180-px PNG):

```js
#!/usr/bin/env node
// Writes public/apple-touch-icon.png: the favicon's tick on the app blue,
// 180 px, the size iOS asks for. iOS ignores SVG for the home screen.
// No image library: a PNG is zlib-compressed rows with a CRC, which Node has.
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const N = 180, BG = [0x1d, 0x4e, 0xd8], FG = [0xff, 0xff, 0xff];
const scale = N / 64;
const pts = [[18, 33], [28, 43], [46, 23]].map(([x, y]) => [x * scale, y * scale]);
const width = 3.5 * scale;   // stroke-width 7 → radius 3.5
const radius = 16 * scale;   // corner radius 16

function distToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function inRoundedSquare(x, y) {
  const cx = Math.min(Math.max(x, radius), N - radius), cy = Math.min(Math.max(y, radius), N - radius);
  return Math.hypot(x - cx, y - cy) <= radius;
}

const raw = Buffer.alloc((N * 4 + 1) * N);
for (let y = 0; y < N; y += 1) {
  raw[y * (N * 4 + 1)] = 0;   // filter: none
  for (let x = 0; x < N; x += 1) {
    const px = x + 0.5, py = y + 0.5;
    const o = y * (N * 4 + 1) + 1 + x * 4;
    if (!inRoundedSquare(px, py)) { raw[o + 3] = 0; continue; }
    const d = Math.min(distToSegment(px, py, pts[0], pts[1]), distToSegment(px, py, pts[1], pts[2]));
    const c = d <= width ? FG : BG;
    raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2]; raw[o + 3] = 255;
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(__dirname, '..', 'public', 'apple-touch-icon.png');
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
```

Run: `node tools/make-icon.js` and confirm `public/apple-touch-icon.png` exists and opens (e.g. `file public/apple-touch-icon.png` prints `PNG image data, 180 x 180`).

Create `public/manifest.webmanifest`:

```json
{
  "name": "CheckSteady",
  "short_name": "CheckSteady",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#1d4ed8",
  "theme_color": "#1d4ed8",
  "icons": [
    { "src": "/icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any" },
    { "src": "/apple-touch-icon.png", "sizes": "180x180", "type": "image/png" },
    { "src": "/icon.svg", "sizes": "192x192", "type": "image/svg+xml" },
    { "src": "/icon.svg", "sizes": "512x512", "type": "image/svg+xml" }
  ]
}
```

- [ ] **Step 4: The head tags and the CSP**

In each of `public/index.html`, `public/checkin.html`, `public/admin.html`, `public/org.html`, directly after the `<link rel="icon" …>` line add:

```html
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="CheckSteady">
<meta name="theme-color" content="#1d4ed8">
```

In `lib/security.js` `buildCsp()`, after `"img-src 'self' data:",` add `"manifest-src 'self'",`.

- [ ] **Step 5: Run the suite**

Run: `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./check.sh 2>&1 | tail -20`
Expected: all pass, including layer 1 (the inline-script hash check is unaffected by head tags).

- [ ] **Step 6: Commit**

```bash
git add public/manifest.webmanifest public/icon.svg public/apple-touch-icon.png tools/make-icon.js public/index.html public/checkin.html public/admin.html public/org.html lib/security.js test/api.test.js
git commit -m "Installable on a tablet: a manifest, the Apple meta tags, an icon, manifest-src in the CSP"
```

---

### Task 6: Guide and documents

**Files:**
- Modify: `public/help.html` (sections `#start`, `#absent`, `#reports`, and a new `#sunday` recipe under Admin)
- Modify: `README.md` (Reports bullet, ~line 481; Authorised absences bullet)
- Modify: `docs/PRODUCT-ROADMAP.md` (a Stage 2f block after Stage 2e; the "waiting on the template" sentence)

- [ ] **Step 1: The help guide**

In `public/help.html`:

1. `#start` ("Set up a tablet"): after the third `<li>` of the recipe add:
   ```html
   <li><span>Fix it to one job: <span class="ui">Share → Add to Home Screen</span>, then open it from the icon.<small>No address bar, no tabs. On an iPad, then turn on <span class="ui">Guided Access</span> (Settings → Accessibility → Guided Access, set a passcode), open the app, triple-click the side button and tap <span class="ui">Start</span>. The tablet stays in the app until the passcode is entered. Managed tablets call the same thing Single App Mode.</small></span></li>
   ```
2. `#absent`, the "For a report or an inspection" paragraph: after the sentence ending "so a child's overnight absence stands out." add:
   ```html
   The <span class="ui">Weekly register update</span> is the Sunday report to head office: each absence as one line, "was absent from Monday to Wednesday, back on Thursday. Approved by management", the weekend's on their own, the week's departures, and rooms under maintenance or with free beds.
   ```
3. `#reports` facts list: add `<li>Weekly register update</li>` after `<li>Absent overnight</li>`. In "What each one is", after the Absent overnight sentence add: `<b>Weekly register update</b>: the Sunday report, see <a href="#sunday">Send the Sunday report</a>.`
4. After the `#reports` block (before the next `<h3>` or the section's "Back to the top"), add:
   ```html
   <h3 id="sunday">Send the Sunday report</h3>
   <ol class="recipe">
     <li><span>Under <span class="ui">Admin → Settings → Weekly register update</span>, tick the switch and type the addresses.<small>Comma-separated, up to ten. Head office and the manager, usually.</small></span></li>
     <li><span>Tap <span class="ui">Send last week's now</span>.<small>The same email that will go on Sunday, so you can see it arrive. It is on the audit record.</small></span></li>
     <li><span>Keep rooms honest under <span class="ui">Admin → Buildings</span>.<small>Mark a room <span class="ui">Under maintenance</span> and write the note for the return, e.g. "1 bed free for a single woman". The report reads it.</small></span></li>
   </ol>
   <ul class="facts">
     <li>Sent early Sunday, after Saturday night's snapshot</li>
     <li>Nights counted at midnight, site time</li>
     <li>Inside an authorised absence: approved</li>
     <li>Permitted periods (IPAS) live under Settings; a holiday outside them is recorded with a warning, never refused</li>
   </ul>
   ```
5. In the "I want to…" grid at the top (the `<li><a href="#reports">` list around line 122), add `<li><a href="#sunday"><span class="ico"><svg viewBox="0 0 24 24"><path d="M4 6h16v12H4z"/><path d="M4 7l8 6 8-6"/></svg></span>Send the Sunday report</a></li>` after the reports entry.

- [ ] **Step 2: README**

In the Reports bullet, after "*Absent overnight* for a date range," add "the *Weekly register update* (the Sunday report to head office: absence spans with approval in words, the weekend's, departures, rooms under maintenance or with free beds),". Add a bullet after Authorised absences:

```markdown
- **The Sunday email** (migration 035): under Settings, a switch and up to
  ten addresses; early Sunday the nightly job emails the Weekly register
  update for the previous Sunday night through Saturday night, and *Send
  last week's now* checks it. **Permitted absence periods** (migration
  036): the IPAS windows as dates under Settings; a holiday authorised
  outside them is recorded with a warning, never refused.
```

- [ ] **Step 3: The roadmap**

In `docs/PRODUCT-ROADMAP.md`, in Stage 2e's last paragraph change "the weekly IPAS report from their template (nationality held for that report only) — waiting on the template" to "the weekly IPAS report — the Sunday email is Stage 2f; matching head office's two Excel files column for column waits on copies of them". After Stage 2e, before "## Stage 5b", add:

```markdown
## Stage 2f — The Sunday report (Brighton's Weekly Register document, 10 September 2026)

**Status: built 10 September 2026 (migrations 035 and 036), on the
working branch.** Spec: `docs/superpowers/specs/2026-09-10-weekly-register-update-design.md`.

- *Absences as "from Monday to Wednesday"*: consecutive nights in the
  overnight snapshot become one span, approved by construction when every
  night is inside an authorised absence, "partly approved (2 of 3
  nights)" otherwise. Spans that begin on a Friday or Saturday night are
  "Updates from the weekend". Departures in the week are "Resident
  removals". Rooms gain a status (open, maintenance) and a one-line note
  for the return; "Room updates" lists maintenance and free contracted
  beds. One SQL function builds the rows and the sentences, so the CSV,
  the printable page and the email agree.
- *Sent on a Sunday*: a switch and up to ten addresses in Settings; the
  nightly job, after Saturday night's snapshot, emails the previous
  Sunday night through Saturday night. "Send last week's now" for
  checking, on the audit record.
- *The IPAS permitted periods*: dates under Settings; a holiday outside
  every window is recorded with a warning, never refused.
- *The iPad as a fixed terminal*: a manifest and the Apple meta tags, so
  the app installs to the home screen without Safari's bar; Guided Access
  does the locking. In the guide.
- Not done: the "Weekly Register Change" section (nobody has said what
  goes in it); matching head office's two Excel files (we do not have
  them); an hours-based rule (nights at midnight is the centre's own
  midnight list).
```

- [ ] **Step 4: Check and commit**

Run: `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./check.sh 2>&1 | tail -8` (layer 1 parses help.html's inline script if any).
Expected: pass.

```bash
git add public/help.html README.md docs/PRODUCT-ROADMAP.md
git commit -m "Guide and documents for the Sunday report, the permitted periods and the fixed tablet"
```

---

### Task 7: Final check and hand-off

- [ ] **Step 1: Full suite**

Run: `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./check.sh 2>&1 | tail -25`
Expected: every layer passes.

- [ ] **Step 2: Push the working branch only**

```bash
git fetch origin && git status -sb | head -1
git push origin HEAD
```

Do not push to main. Report the commit list to the owner; main is fast-forwarded by them or in a later step after review.
