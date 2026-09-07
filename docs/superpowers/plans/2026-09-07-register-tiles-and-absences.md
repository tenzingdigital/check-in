# Register Tiles, Check-in Times and the Absences Tab — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The daily register answers only "who has been seen today", every check-in shows the time it was recorded and by whom, and the manager's threshold list moves to a new Admin → Absences tab.

**Architecture:** No migration. Three route additions in `routes/residents.js` surface times the database already stores (`daily_compliance.first_seen_at`, `checkin_events.occurred_at` + `guard_id`). `public/checkin.html` drops its third tile and derives a today-only `viewState` for cards; `public/admin.html` gains a tab that renders the existing compliance list against the thresholds in settings. Docs record the change.

**Tech Stack:** Node 22, Express, `pg`, vanilla HTML/JS with no build step, Postgres 16 for the test cluster (`./test/api.sh`), Playwright for the optional browser test.

**Spec:** `docs/superpowers/specs/2026-09-07-register-tiles-and-absences-design.md`

## Global Constraints

- Branch: `claude/security-hardening-roadmap-k7vtwv`. Run `git fetch origin && git rebase origin/claude/security-hardening-roadmap-k7vtwv` before starting each task and before each push; other sessions push to this repo.
- No migration, no change to `v_resident_compliance`, `attention_list()`, `/api/attention`, `/api/checkin-summary`, `routes/reports.js`, or `test/compliance.sql`.
- SQL in routes uses **unqualified** table and function names (`daily_compliance`, `site_today()`), never `public.` — tenant schemas resolve through `search_path` (Stage 5).
- Times are shown in the site timezone (`settings.local_timezone`), formatted with `Intl.DateTimeFormat` and `timeZone`, 24-hour, hours and minutes. Never the terminal's zone.
- Copy: no free text is stored anywhere; the app states counts against thresholds and never says a threshold "was met" as a verdict.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01QMp1iENRi9GJLzm3baLCQy
  ```
- Verification for each task: the parse layer (`node` snippet in `check.sh`, or `node --check`) and, for route/test tasks, `./test/api.sh`. The full `./check.sh` at the end.

---

### Task 1: Check-in times on the API

**Files:**
- Modify: `routes/residents.js:91-146` (list route), `:147-166` (`/:id/compliance`), `:168-190` (`/:id/days`)
- Test: `test/api.test.js` (after the test named "a check-in satisfies the day", around line 357)

**Interfaces:**
- Consumes: `daily_compliance(resident_id, compliance_date, first_seen_at, checkin_count)`, `checkin_events(resident_id, guard_id, occurred_at, id)`, `profiles(id, full_name)`, `site_today()`, `app_settings.local_timezone` (single row, `where id`).
- Produces:
  - `GET /api/residents?compliance=1` rows gain `first_seen_at: string|null` (ISO timestamptz, today's row).
  - `GET /api/residents/:id/compliance` gains `first_seen_at: string|null` and `checkins_today_events: Array<{ occurred_at: string, recorded_by: string }>` newest first, site day only.
  - `GET /api/residents/:id/days` rows gain `first_seen_at: string|null`.

- [ ] **Step 1: Write the failing test**

Insert directly after the closing `});` of the test "a check-in satisfies the day" in `test/api.test.js`:

```js
  await test("the time of the check-in, and who recorded it, are on the detail row", async () => {
    const found = await api.fetch("/api/residents?q=brennan&compliance=1");
    const resident = found.json[0];
    assert.ok("first_seen_at" in resident, "the list row has no first_seen_at field");
    assert.ok(resident.first_seen_at, "the list row's first_seen_at is empty after a check-in");
    assert.ok(Math.abs(Date.now() - new Date(resident.first_seen_at)) < 60_000, `first_seen_at is ${resident.first_seen_at}, not within a minute of now`);

    const detail = await api.fetch(`/api/residents/${resident.id}/compliance`);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.first_seen_at, resident.first_seen_at, "detail and list disagree about first_seen_at");
    assert.ok(Array.isArray(detail.json.checkins_today_events), "checkins_today_events is not an array");
    assert.equal(detail.json.checkins_today_events.length, 1, "expected exactly one event after one check-in");
    assert.equal(detail.json.checkins_today_events[0].recorded_by, "Gina Guard", "recorded_by is not the acting guard's name");
    assert.ok(Math.abs(new Date(detail.json.checkins_today_events[0].occurred_at) - new Date(resident.first_seen_at)) < 1000);

    // A second tap inside the 60-second dedupe window is one presentation.
    const again = await api.fetch("/api/checkins", { method: "POST", body: { resident_id: resident.id } });
    assert.equal(again.status, 200);
    const detail2 = await api.fetch(`/api/residents/${resident.id}/compliance`);
    assert.equal(detail2.json.checkins_today_events.length, 1, "the double tap recorded a second event");

    const days = await api.fetch(`/api/residents/${resident.id}/days`);
    const today = days.json.find((d) => d.presented);
    assert.ok(today, "no presented day on the strip");
    assert.ok("first_seen_at" in today, "the strip row has no first_seen_at");
    assert.equal(today.first_seen_at, resident.first_seen_at);
  });
```

Before writing it, confirm the seeded guard's display name: `grep -n "Gina" test/api.test.js | head -3`. If the name differs (for example `"Gina"` alone), use that exact string in the `recorded_by` assertion.

- [ ] **Step 2: Run the HTTP suite to see it fail**

Run: `./test/api.sh 2>&1 | tail -15`
Expected: the new test fails with `the list row has no first_seen_at field`.

- [ ] **Step 3: Add `first_seen_at` to the list route**

In `routes/residents.js`, in the `router.get('/', …)` handler, replace the compliance query:

```js
    const { rows: comp } = await client.query(
      `select v.id, v.state, v.required_today, v.seen_today, v.checkins_today,
              v.open_breaches, v.consecutive_missed, v.absent_in_window,
              v.absence_window_days, v.absence_window_limit,
              v.warn_after_consecutive_nights, v.last_seen_on,
              dc.first_seen_at
         from v_resident_compliance v
         left join daily_compliance dc
           on dc.resident_id = v.id and dc.compliance_date = site_today()
        where v.id = any($1::uuid[])`,
      [found.map(r => r.id)],
    );
```

Add this comment above it:

```js
    // first_seen_at is today's row in daily_compliance, joined here rather
    // than added to the view: attention_list() returns setof the view and
    // depends on its physical column order.
```

- [ ] **Step 4: Add `first_seen_at` and today's events to the detail route**

Replace the query in `router.get('/:id/compliance', …)`:

```js
    const { rows } = await client.query(
      `select v.id, v.full_name, v.id_type, v.id_number, v.age_years, v.required_today,
              v.seen_today, v.checkins_today, v.open_breaches, v.consecutive_missed,
              v.absent_in_window, v.absence_window_days, v.absence_window_limit,
              v.warn_after_consecutive_nights, v.last_seen_on, v.state,
              dc.first_seen_at
         from v_resident_compliance v
         left join daily_compliance dc
           on dc.resident_id = v.id and dc.compliance_date = site_today()
        where v.id = $1`,
      [uuidParam(req.params.id, 'resident id')],
    );
    if (!rows[0]) return null;
    // Every check-in recorded today, newest first, with the guard who
    // recorded it. This is the troubleshooting view: it says which
    // terminal's guard tapped, and when, including a double tap the
    // 60-second dedupe folded into one presentation (which is why a day
    // can say 1× with one event here and two taps at the desk).
    const { rows: events } = await client.query(
      `select e.occurred_at, p.full_name as recorded_by
         from checkin_events e
         join profiles p on p.id = e.guard_id
        cross join (select local_timezone from app_settings where id) s
        where e.resident_id = $1
          and (e.occurred_at at time zone s.local_timezone)::date = site_today()
        order by e.occurred_at desc, e.id desc`,
      [uuidParam(req.params.id, 'resident id')],
    );
    rows[0].checkins_today_events = events;
    return rows[0];
```

(The handler already ends with `if (!row) throw new HttpError(404, 'No such resident'); res.json(row);` — keep that.)

- [ ] **Step 5: Add `first_seen_at` to the strip route**

In `router.get('/:id/days', …)` change the select list:

```js
      `select compliance_date, required, presented, first_seen_at
         from daily_compliance
        where resident_id = $1
          and compliance_date >= (site_today() - ($2::integer - 1))
        order by compliance_date`,
```

- [ ] **Step 6: Run the HTTP suite to see it pass**

Run: `./test/api.sh 2>&1 | tail -5`
Expected: the last line reports all tests passed, including the new one. If the events query is refused with `permission denied for table profiles` for a guard, the fix is to read the guard name through the same source `v_gate_log` uses (`migrations/002_schema.sql:444`), not to widen a grant.

- [ ] **Step 7: Commit**

```bash
git add routes/residents.js test/api.test.js
git commit -m "The time of each check-in, and who recorded it, on the API

first_seen_at on the list and detail rows and on the 30-day strip; today's
check-in events with the recording guard on the detail row. Read from
daily_compliance and checkin_events, joined in the route, not the view.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QMp1iENRi9GJLzm3baLCQy"
```

---

### Task 2: A site-time formatter shared by both pages

**Files:**
- Modify: `public/app-common.js` (after `function ago(iso)` around line 51)

**Interfaces:**
- Produces: `siteTime(iso, tz)` → `"23:31"` (24-hour, site zone) or `""` when `iso` is empty or invalid. Global, like `esc()` and `ago()`.

- [ ] **Step 1: Add the helper**

After the `ago()` function in `public/app-common.js`:

```js
// Hours and minutes in the SITE's zone, which is the clock the register
// closes on. Never the terminal's zone: a terminal set to the wrong zone is
// exactly the fault a manager is trying to see when they ask "what time
// did that check-in actually land". tz is app_settings.local_timezone.
function siteTime(iso, tz) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: tz || undefined, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  } catch (_) {
    return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  }
}
```

- [ ] **Step 2: Check it parses and behaves**

Run:
```bash
node -e "
const fs=require('fs'),vm=require('vm');
const ctx={window:{},document:{},navigator:{}};vm.createContext(ctx);
new vm.Script(fs.readFileSync('public/app-common.js','utf8')+';globalThis.__t=siteTime;',{filename:'app-common.js'}).runInContext(ctx);
console.log(ctx.__t('2026-09-07T22:31:00Z','Europe/Dublin'), '| empty:', JSON.stringify(ctx.__t('', 'Europe/Dublin')));
"
```
Expected: `23:31 | empty: ""`. If the script throws on a DOM reference at load time, run the check instead by pasting the function alone into `node -e` — the point is the two outputs.

- [ ] **Step 3: Commit**

```bash
git add public/app-common.js
git commit -m "siteTime(): hours and minutes in the site's zone, for both pages

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QMp1iENRi9GJLzm3baLCQy"
```

---

### Task 3: The register has two tiles and cards that speak only of today

**Files:**
- Modify: `public/checkin.html` — styles `:33-42`, tiles `:126-128`, `state.filter` comment `:171`, `STATE_LABEL` `:189-197`, `residentCard()` `:223-247`, `refreshSummary()` `:427-446`, `FILTERS`/`FILTER_LABEL` `:526-532`, `orderFor()` `:541-552`, `renderSearch()` `:554-597`, `applyCheckin()` `:599-607`
- Modify: `check.sh` (the parse step, inside the `node -e "…"` block)
- Modify: `test/offline.e2e.test.js:93-121` (no change needed unless an assertion references `breach`; verify)

**Interfaces:**
- Consumes: list rows from Task 1 (`seen_today`, `first_seen_at`, `last_seen_on`, `state`, `required_today`, `room_label`), `state.settings.local_timezone`, `state.settings.due_soon_after_hour`, `siteTime()` from Task 2.
- Produces: `viewState(r)` → one of `seen_today | never | due_today | expected | exempt | not_required`; used by Task 4 for the detail sheet's Status fact.

- [ ] **Step 1: Add a static guard so the tile cannot return**

In `check.sh`, inside the `node -e "…"` parse block, after the loop over the three HTML files and before the `for (const f of ['public/app-common.js', …` loop, add:

```js
{
  const h=fs.readFileSync('public/checkin.html','utf8');
  if (/data-filter=\"breach\"|statOpenBreach/.test(h)) throw new Error('public/checkin.html: the Missed days tile is back — the register answers today only; history lives on Admin → Absences (spec 2026-09-07)');
}
```

Mind the quoting: the block is inside a double-quoted bash string, so the inner `"` characters must be written `\"` exactly as above.

- [ ] **Step 2: Run the parse step to see it fail**

Run: `./check.sh 2>&1 | sed -n '1,12p'`
Expected: the "Front ends parse" step fails with `the Missed days tile is back`.

- [ ] **Step 3: Remove the tile and the breach styles**

In `public/checkin.html`:

Delete line 127 (the `data-filter="breach"` button) so the `.stats` row holds only the `not_seen` and `seen` buttons.

Replace the style lines 33-42 with:

```css
  .badge.seen_today    { color: var(--ok); }
  .badge.expected      { color: var(--muted); }
  .badge.due_today     { color: var(--warn); }
  .badge.exempt, .badge.not_required { color: var(--muted); }
  .badge.never         { color: var(--bad); }

  .card.never          { border-left: 4px solid var(--bad); }
  .card.due_today      { border-left: 4px solid var(--warn); }
```

(Keep any other selectors that were between 33 and 42 that are not `breach_open`; only `breach_open` rules go.)

Change the `state.filter` comment on line 171 to `// which tile is pressed: all | not_seen | seen`.

- [ ] **Step 4: Derive a today-only state for cards**

Replace `STATE_LABEL` and `stateLabel()` (lines 187-201) with:

```js
// Plain words on the cards, about TODAY. The server's `state` ranks an open
// past breach above seen_today — right for the manager's list, wrong for a
// guard with the person at the window. viewState() keeps the server's
// exempt/not_required, and otherwise answers only "seen today, never seen,
// due, or expected".
const STATE_LABEL = {
  seen_today:   "Seen today",
  expected:     "Expected",
  due_today:    "Due today",
  exempt:       "Under 18 — not required",
  never:        "Not yet seen",
  not_required: "Not required",
};

function stateLabel(s) {
  return STATE_LABEL[s] || s;
}

function pastDueHour() {
  const h = state.settings && Number.isFinite(state.settings.due_soon_after_hour) ? state.settings.due_soon_after_hour : null;
  if (h === null) return false;
  const tz = state.settings.local_timezone;
  try {
    const now = Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz || undefined, hour: "2-digit", hour12: false }).format(new Date()));
    return now >= h;
  } catch (_) { return new Date().getHours() >= h; }
}

function viewState(r) {
  if (r.state === "exempt" || r.state === "not_required") return r.state;
  if (r.seen_today) return "seen_today";
  if (!r.last_seen_on) return "never";
  return pastDueHour() ? "due_today" : "expected";
}
```

- [ ] **Step 5: Cards carry no history**

Replace `lastSeenText()` (lines 207-211) with:

```js
// last_seen_on only ever counts CLOSED days (see v_resident_compliance) — a
// resident who checked in an hour ago has seen_today=true but last_seen_on
// still null, because today hasn't closed yet. seen_today is the only safe
// source for "have they presented today"; first_seen_at is when.
function lastSeenText(r) {
  if (r.seen_today) {
    const t = siteTime(r.first_seen_at, state.settings && state.settings.local_timezone);
    return t ? `Today ${t}` : "Today";
  }
  if (r.last_seen_on) return formatDate(r.last_seen_on);
  return "Never";
}
```

Replace `residentCard()` (lines 223-247) with:

```js
function residentCard(r) {
  const vs = viewState(r);
  const cls = ["card", esc(vs)];

  const bits = [];
  if (r.room_label && state.settings?.feature_buildings) bits.push(esc(r.room_label));
  bits.push(`last seen ${esc(lastSeenText(r))}`);

  // The pill on the right already says seen / not yet. The badge appears
  // only when it adds something the pill does not.
  const badge = (vs === "exempt" || vs === "not_required" || vs === "due_today" || vs === "never")
    ? ` · <span class="badge ${esc(vs)}">${esc(stateLabel(vs))}</span>`
    : "";

  // The strip behind the card says what a right swipe does (see .swipe-bg).
  return `<div class="swipe">
    <span class="swipe-bg right" aria-hidden="true">Check in ✓</span>
    <span class="swipe-bg left" aria-hidden="true">Check in ✓</span>
    <button class="${cls.join(" ")}" data-id="${esc(r.id)}" type="button">
      <span class="who">
        <span class="name">${esc(r.full_name)}</span>
        <span class="meta">${bits.join(" · ")}${badge}</span>
      </span>
      ${r.queued
        ? `<span class="pill queued">Queued</span>`
        : `<span class="pill ${r.seen_today ? "in" : "out"}">${r.seen_today ? "Seen today" : "Not yet"}</span>`}
    </button></div>`;
}
```

- [ ] **Step 6: Two tiles, two filters**

Replace `refreshSummary()` (lines 427-446) with:

```js
function refreshSummary() {
  if (!state.loaded) return;
  const rows = state.searchQuery ? state.allRows : state.searchRows;   // counts describe the whole register, not a name filter
  const all = rows || [];
  const notSeen  = all.filter(FILTERS.not_seen).length;
  const seen     = all.filter(FILTERS.seen).length;
  $("statNotSeen").textContent  = notSeen;
  $("statCheckins").textContent = seen;

  // Colour follows the number, not the tile. "Not seen" is neutral while
  // the day is young, amber once the due-soon hour has passed and people
  // are still missing.
  tone($("statNotSeen").parentElement, notSeen === 0 ? "ok" : pastDueHour() ? "warn" : "neutral");
}
```

Replace `FILTERS`, `FILTER_LABEL`, `setFilter()` and `orderFor()` (lines 526-552) with:

```js
const FILTERS = {
  all:      () => true,
  not_seen: (r) => r.required_today && !r.seen_today,
  seen:     (r) => !!r.seen_today,
};
const FILTER_LABEL = { all: "everyone", not_seen: "not seen today", seen: "seen today" };

function setFilter(name) {
  state.filter = FILTERS[name] ? name : "not_seen";
  renderDetail(null);
  renderSearch();
}

// Every view is alphabetical: a guard at the window is looking for a name.
// The manager's worst-first list is Admin → Absences.
function orderFor(filter, rows) {
  return rows;
}
```

In `renderSearch()`:
- change the "Showing" line to
  ```js
  line.innerHTML = `Showing ${shown.length} ${FILTER_LABEL[active]} · <button class="linkish" type="button" id="showAll">Show everyone</button>`;
  ```
- delete the line `: state.filter === "breach"   ? "Nobody has missed days outstanding."` from the `empty` expression.

Replace `applyCheckin()` (lines 599-607) with:

```js
function applyCheckin(residentId, dc) {
  const r = state.rows.get(residentId);
  if (!r) return;
  r.seen_today = true;
  r.checkins_today = dc && dc.checkin_count ? dc.checkin_count : (r.checkins_today || 0) + 1;
  if (dc && dc.first_seen_at) r.first_seen_at = dc.first_seen_at;
  renderSearch();
  refreshSummary();
}
```

Search the file for any remaining `breach` references: `grep -n "breach" public/checkin.html`. The only ones left should be the close-out banner text ("Missed days are not being recorded until it does") and comments that describe the database. Remove any remaining code path that reads `FILTERS.breach`, `statOpenBreach`, or `r.state === "breach_open"` except inside `viewState()`'s pass-through (which does not mention it).

- [ ] **Step 7: Parse and the static guard**

Run: `./check.sh 2>&1 | sed -n '1,14p'`
Expected: "Deploy configs" and "Front ends parse" both pass (the guard is silent). Let the database and HTTP suites run too; they must still pass (`tail -3 /tmp/hut-check-api.log`).

- [ ] **Step 8: Browser test still holds (optional, if Playwright is installed)**

Run: `./test/e2e.sh 2>&1 | tail -8`
Expected: passes. Its tile steps click `seen` and `not_seen` only. If it fails on `[...document.querySelectorAll('.stats button[data-filter]')].every(… "false")`, that is a real regression in `setFilter` — fix the code, not the test.

- [ ] **Step 9: Commit**

```bash
git add public/checkin.html check.sh
git commit -m "Register: two tiles, and cards that speak only of today

The Missed days tile counted everyone who had ever missed a day and never
cleared; a card could say Seen today beside 10 missed days. The register
now opens on Not seen and offers Seen today; the badge appears only when
it adds to the pill; the card's colour follows today. History moves to
Admin → Absences. check.sh refuses the tile's return.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QMp1iENRi9GJLzm3baLCQy"
```

---

### Task 4: The detail sheet shows the time, the recorder, and the thresholds

**Files:**
- Modify: `public/checkin.html` — `policyNotes()` `:328-349`, `renderDetail()` facts block `:378-386`, `loadStrip()` `:706-711`, the detail-fetch `.then` inside `renderDetail()` (the branch's version around `:360-372`)
- Modify: `public/checkin.html` styles — add one rule for `.events`

**Interfaces:**
- Consumes: `GET /api/residents/:id/compliance` → `first_seen_at`, `checkins_today_events` (Task 1); `GET /:id/days` → `first_seen_at` (Task 1); `siteTime()` (Task 2); `viewState()` (Task 3).

- [ ] **Step 1: Keep the events when the detail row arrives**

In `renderDetail()`, inside the `.then((fresh) => { … })` that handles the detail fetch, extend the `Object.assign(row, { … })` call so it also copies the new fields:

```js
      Object.assign(row, {
        id_type: fresh.id_type, id_number: fresh.id_number, has_id: !!fresh.id_number,
        first_seen_at: fresh.first_seen_at, checkins_today_events: fresh.checkins_today_events || [],
      });
```

- [ ] **Step 2: The facts block**

Replace the `<div class="facts"> … </div>` block inside `renderDetail()` with:

```js
    <div class="facts">
      <div class="fact"><span>Status</span><b class="badge ${esc(viewState(r))}">${esc(stateLabel(viewState(r)))}</b></div>
      <div class="fact"><span>Today</span><b>${todayFact(r)}</b></div>
      <div class="fact"><span>Last seen</span><b>${esc(lastSeenText(r))}</b></div>
      <div class="fact"><span>Consecutive nights</span><b>${r.consecutive_missed || 0} <small>of ${r.warn_after_consecutive_nights || 3}</small></b></div>
      <div class="fact"><span>Absent in ${r.absence_window_days || 28} days</span><b>${r.absent_in_window || 0} <small>of ${r.absence_window_limit || 10}</small></b></div>
      <div class="fact"><span>Missed days on record</span><b>${r.open_breaches || 0}</b></div>
    </div>

    ${eventsToday(r)}
```

Add these two functions directly above `renderDetail()`:

```js
// "Seen 23:31 (1×)": the first presentation today, in the site's zone, and
// how many taps landed on the day. A queued check-in is not yet a time the
// server has; it says so.
function todayFact(r) {
  if (r.queued) return "Queued";
  if (!r.seen_today) return "Not yet";
  const t = siteTime(r.first_seen_at, state.settings && state.settings.local_timezone);
  return `Seen${t ? " " + esc(t) : ""} (${r.checkins_today || 1}×)`;
}

// Every check-in recorded today, newest first, with the guard who recorded
// it. Shown only when there is one: this is the line a manager reads when
// a resident says "I checked in" and the register says otherwise.
function eventsToday(r) {
  const evs = r.checkins_today_events || [];
  if (!evs.length) return "";
  const tz = state.settings && state.settings.local_timezone;
  return `<div class="events"><span class="stripTitle">Today's check-ins</span>${evs.map((e) =>
    `<div><b>${esc(siteTime(e.occurred_at, tz))}</b> · recorded by ${esc(e.recorded_by || "—")}</div>`).join("")}</div>`;
}
```

Add a style next to the `.facts` rules in the page's `<style>`:

```css
  .events { margin: 8px 0 0; font-size: 13px; color: var(--muted); }
  .events div { padding: 2px 0; }
  .events b { color: var(--text); font-variant-numeric: tabular-nums; }
  .fact b small { font-weight: 400; color: var(--muted); font-size: 12px; }
```

- [ ] **Step 3: `policyNotes()` reads as facts against figures**

Replace `policyNotes()` with:

```js
// Facts against the figures in Settings. The app never says a threshold
// "was met" as a verdict; it states the count and the figure side by side
// and the decision is the manager's (migrations/008).
function policyNotes(r) {
  const notes = [];
  const nights = r.consecutive_missed || 0;
  const inWindow = r.absent_in_window || 0;
  const nightLimit = r.warn_after_consecutive_nights || 3;
  const windowLimit = r.absence_window_limit || 10;
  const windowDays = r.absence_window_days || 28;

  if (nights >= nightLimit) {
    notes.push(`${nights} consecutive nights recorded; the figure in Settings is ${nightLimit}.`);
  }
  if (inWindow >= windowLimit) {
    notes.push(`${inWindow} days absent in the last ${windowDays}; the figure in Settings is ${windowLimit}.`);
  } else if (inWindow >= windowLimit - 2 && inWindow > 0) {
    notes.push(`${inWindow} of ${windowLimit} days in the last ${windowDays}.`);
  }
  if (!notes.length) return "";
  return `<div class="policy">${notes.map((n) => `<p>${esc(n.replace(/\s+/g, " "))}</p>`).join("")}</div>`;
}
```

- [ ] **Step 4: The strip carries the time**

Replace `loadStrip()` with:

```js
async function loadStrip(residentId) {
  const data = await guarded(() => apiGet(`/api/residents/${residentId}/days`), (err) => Offline.noteFailure(err));
  const tz = state.settings && state.settings.local_timezone;
  return (data || []).map(d => {
    const t = d.presented ? siteTime(d.first_seen_at, tz) : "";
    const title = t ? `${d.compliance_date} · ${t}` : d.compliance_date;
    return `<i class="cell ${!d.required ? "na" : d.presented ? "ok" : "miss"}" data-date="${esc(d.compliance_date)}" title="${esc(title)}"></i>`;
  }).join("");
}
```

- [ ] **Step 5: Parse and suites**

Run: `./check.sh 2>&1 | grep -E "^==>|PASS|FAIL|passed|parse" `
Expected: every step passes.

- [ ] **Step 6: Look at it (if Playwright is installed)**

Run `./test/e2e.sh 2>&1 | tail -5` — it opens a detail sheet and records a check-in, so a JavaScript error in `renderDetail()` surfaces here. Expected: passes.

- [ ] **Step 7: Commit**

```bash
git add public/checkin.html
git commit -m "Detail sheet: the time of the check-in, who recorded it, and the figures beside the counts

\"Seen 23:31 (1×)\", today's check-ins with the recording guard, \"5 of 7\"
and \"8 of 10\" against Settings, missed days on record, and the time on
each cell of the 30-day strip. For the manager troubleshooting a day.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QMp1iENRi9GJLzm3baLCQy"
```

---

### Task 5: Admin → Absences

**Files:**
- Modify: `public/admin.html` — tab row `:165-169`, a new `<section id="panelAbsences">` after `panelResidents` (before line 204's `panelBuildings`), `selectTab()` `:1205-1218`, tab click wiring `:1312-1316`, the `.tablewrap`/table CSS `:75-78`
- Test: `test/api.test.js` (one assertion on the list contract, added to the Task 1 test)

**Interfaces:**
- Consumes: `GET /api/residents?q=&limit=1000&compliance=1` rows (`full_name`, `status`, `room_label`, `consecutive_missed`, `absent_in_window`, `last_seen_on`, `first_seen_at`, `seen_today`); `state.settings.warn_after_consecutive_nights`, `absence_window_limit`, `absence_window_days`, `feature_buildings`; `guarded()`, `apiGet()`, `esc()`.

- [ ] **Step 1: Pin the list contract in the HTTP suite**

In the Task 1 test body in `test/api.test.js`, after the `first_seen_at` assertions on `resident`, add:

```js
    for (const k of ["consecutive_missed", "absent_in_window", "open_breaches", "last_seen_on", "seen_today"]) {
      assert.ok(k in resident, `the list row has no ${k}; Admin → Absences reads it from the list`);
    }
```

Run `./test/api.sh 2>&1 | tail -3` — expected: still passes (the fields exist already; this pins them).

- [ ] **Step 2: The tab and the panel**

In the tab row, insert after the Residents button:

```html
      <button role="tab" id="tabAbsences"  aria-selected="false" aria-controls="panelAbsences">Absences</button>
```

Insert after the closing `</section>` of `panelResidents`:

```html
    <!-- ---- absences (supervisors and admins): the list a manager reads
         before writing a letter. Numbers the register already computes,
         beside the figures in Settings. ---- -->
    <section id="panelAbsences" role="tabpanel" aria-labelledby="tabAbsences" hidden>
      <p class="hint flush" id="absIntro"></p>
      <div class="tablewrap mt14"><table id="absTable"></table></div>
    </section>
```

Extend the table CSS on lines 76-78 so `#absTable` gets the same rules as `#rpTable` and `#impTable`:

```css
  #rpTable, #impTable, #absTable { border-collapse: collapse; width: 100%; font-size: 13px; }
  #rpTable th, #rpTable td, #impTable th, #impTable td, #absTable th, #absTable td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  #rpTable th, #impTable th, #absTable th { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); position: sticky; top: 0; background: var(--surface); }
  #absTable td.at { color: var(--bad); font-weight: 600; }
  #absTable td.num { font-variant-numeric: tabular-nums; }
```

- [ ] **Step 3: Wire the tab**

In `selectTab()` change the list of tabs to include `"absences"` right after `"residents"`:

```js
  for (const t of ["residents", "absences", "buildings", "reports", "staff", "settings"]) {
```

and add `if (name === "absences") loadAbsences();` after the `loadResidents()` line.

Next to the other tab click listeners add:

```js
$("tabAbsences").addEventListener("click", () => selectTab("absences"));
```

- [ ] **Step 4: Load and render**

Add after `loadResidents()` (around line 429-460):

```js
/* ========================================================================
   Absences (supervisors and admins)
   ====================================================================== */

// Active residents with a run of missed nights or a missed day inside the
// rolling window, worst first. Everything here is already on the list row
// (v_resident_compliance via /api/residents?compliance=1); this tab only
// puts the counts beside the figures in Settings. Residents whose only
// misses are older than the window are not listed — their total is on the
// register's detail sheet.
async function loadAbsences() {
  $("absIntro").textContent = "Loading…";
  const rows = await guarded(
    () => apiGet("/api/residents?q=&limit=1000&compliance=1"),
    (err) => { Offline.noteFailure(err); showError("Could not load absences: " + err.message); },
  );
  if (!rows) return;
  showError("");
  renderAbsences(rows);
}

function renderAbsences(rows) {
  const s = state.settings || {};
  const nightLimit = s.warn_after_consecutive_nights || 3;
  const winLimit = s.absence_window_limit || 10;
  const winDays = s.absence_window_days || 28;
  const withRooms = !!s.feature_buildings;

  const listed = rows
    .filter((r) => r.status === "active" && ((r.consecutive_missed || 0) > 0 || (r.absent_in_window || 0) > 0))
    .sort((a, b) =>
      (b.consecutive_missed || 0) - (a.consecutive_missed || 0) ||
      (b.absent_in_window || 0) - (a.absent_in_window || 0) ||
      String(a.full_name).localeCompare(String(b.full_name)));

  $("absIntro").textContent =
    `Facts against the figures in Settings: ${nightLimit} consecutive nights, ${winLimit} days in ${winDays}. ` +
    `The app never decides that a threshold was met; the decision, and the letter, are the manager's.`;

  if (!listed.length) {
    $("absTable").innerHTML = `<tbody><tr><td class="hint">Nobody has a run of missed nights or a missed day in the last ${winDays} days.</td></tr></tbody>`;
    return;
  }

  const lastSeen = (r) => r.seen_today ? "Today" : (r.last_seen_on || "Never");
  const head = ["Name", ...(withRooms ? ["Room"] : []), "Consecutive nights", `Absent in ${winDays} days`, "Last seen"];
  $("absTable").innerHTML =
    `<thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>` +
    `<tbody>${listed.map((r) => {
      const n = r.consecutive_missed || 0, w = r.absent_in_window || 0;
      return `<tr>` +
        `<td>${esc(r.full_name)}</td>` +
        (withRooms ? `<td>${esc(r.room_label || "")}</td>` : "") +
        `<td class="num${n >= nightLimit ? " at" : ""}">${n} of ${nightLimit}</td>` +
        `<td class="num${w >= winLimit ? " at" : ""}">${w} of ${winLimit}</td>` +
        `<td>${esc(lastSeen(r))}</td>` +
      `</tr>`;
    }).join("")}</tbody>`;
}
```

If `Offline` is not defined in `admin.html`'s scope (check with `grep -c "Offline\." public/admin.html`; the residents loader at line 437 uses it, so it should be), keep the call as written.

- [ ] **Step 5: Permissions check**

The tab must be visible to supervisors and admins only, like Residents. Find where `$("tabStaff").hidden = !canStaff();` is set (around line 1253) and confirm the whole tab row is already gated by `canResidents()` for supervisors (the page shows "This area is for supervisors and administrators" otherwise). If the Residents tab is shown to a role that Absences should not see, add `$("tabAbsences").hidden = !canResidents();` beside the Staff line. Do not widen anything.

- [ ] **Step 6: Parse and the permission-matrix check**

Run: `./check.sh 2>&1 | grep -E "^==>|PASS|FAIL|passed|parse|current"`
Expected: all steps pass. The permission matrix check (`tools/gen-permissions-doc.js --check`) reads routes, not pages, so it is unaffected; if it fails, no route was meant to change — revert whatever touched `routes/`.

- [ ] **Step 7: Commit**

```bash
git add public/admin.html test/api.test.js
git commit -m "Admin → Absences: the counts beside the figures in Settings, worst first

Consecutive nights and days absent in the rolling window for every active
resident with either, \"5 of 7\" and \"8 of 10\", reached figures marked.
Read from the list the register already loads; no new endpoint, no new
data. The manager's list, moved off the guard's screen.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QMp1iENRi9GJLzm3baLCQy"
```

---

### Task 6: Docs

**Files:**
- Modify: `README.md:50-54` and `:188-194`
- Modify: `docs/PRODUCT-ROADMAP.md` (a new section before "## Stage 6 — Access control integration")
- Modify: `docs/UX-REVIEW.md` (one paragraph after the "Status, 4 September 2026" paragraph, around line 55)

- [ ] **Step 1: README**

Replace the sentence at lines 50-54:

```
**`checkin.html` — the check-in app.** The statutory daily register: did this
resident present at the hut today? One list, filtered by two tiles above it:
not seen today, seen today. Each card says when the person was seen today and
the detail sheet says who recorded it. History — runs of missed nights and
days absent in the rolling window — is the manager's list under Admin →
Absences, not the guard's screen. A gate sign-in/out is a different act from
a check-in and does not satisfy the daily requirement — see "Compliance is
per calendar day" below.
```

Replace the paragraph at lines 188-194 (beginning "The **Breaches** tile"):

```
**Admin → Absences** is the flow itself: every active resident with a run of
consecutive missed nights or a missed day inside the rolling window, worst
first, with each count beside the figure in Settings ("5 of 7", "8 of 10").
The **Not seen** tile on the register is the working list for the day. What
the hut does about an absence — call, escalate, welfare check, the letter —
is a procedure, not a feature; the app tells you who and for how long.
```

- [ ] **Step 2: Product roadmap**

Insert before `## Stage 6 — Access control integration`:

```
## Absences — the manager's list, off the guard's screen

**Status: built 7 September 2026, on the working branch. No switch, no
migration, no new data.**

- The register's third tile ("Missed days") counted everyone who had ever
  missed a required day and never cleared. It is gone; the register has
  Not seen and Seen today, and a card says only what is true today.
- Admin → Absences lists active residents with a run of consecutive missed
  nights or a missed day in the rolling window, worst first, each count
  beside the figure in Settings. Reached figures are marked; nothing is
  decided.
- Every check-in shows its time in the site's zone, and the detail sheet
  lists today's check-ins with the guard who recorded each — the
  troubleshooting view a manager asked for.
- Note on the figures: the IPAS House Rules 2025 (3.2.14) put unauthorised
  absence at 7 consecutive days, or 10 days in a rolling 4 weeks. The
  consecutive-nights default in Settings is still 3, from the earlier
  policy; each centre sets its own under Admin → Settings → House Rules
  thresholds.
```

- [ ] **Step 3: UX review**

After the "Status, 4 September 2026." paragraph in `docs/UX-REVIEW.md`, add:

```
**7 September 2026.** The "Missed days" tile is gone from the register — a
lifetime tally that never cleared, beside a green "Seen today" pill on the
same card, read as a contradiction. The register now answers today only;
the manager's worst-first list is Admin → Absences, with each count beside
the figure in Settings. Cards and the detail sheet show the time of the
check-in in the site's zone, and the sheet lists who recorded each one.
```

- [ ] **Step 4: Commit**

```bash
git add README.md docs/PRODUCT-ROADMAP.md docs/UX-REVIEW.md
git commit -m "docs: two register tiles, Admin → Absences, and the time on every check-in

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QMp1iENRi9GJLzm3baLCQy"
```

---

### Task 7: Full check and push

- [ ] **Step 1: Everything**

Run: `./check.sh 2>&1 | tail -25`
Expected: `All checks passed.`

- [ ] **Step 2: Rebase and push**

```bash
git fetch origin
git rebase origin/claude/security-hardening-roadmap-k7vtwv
./check.sh 2>&1 | tail -3
git push origin HEAD
```

If the rebase conflicts in `public/checkin.html` or `public/admin.html`, resolve by keeping both sides' intent (the other session's header or tip changes, and this plan's tile/tab changes), re-run `./check.sh`, then push.

---

### Task 8: The close-out banner waits for the job's own hour

Added 8 September 2026 from a screenshot taken at 00:09: every register
terminal showed "The nightly close-out has not run" in red. It had not —
`hut-nightly` runs at `30 0 * * *` UTC (`render.yaml`), which is 01:30 in
Dublin for half the year — but `v_system_health.close_out_behind` compares
the last closed day with *yesterday* from the first second of the new day.
A false alarm every night is how a real one gets ignored.

**Files:**
- Create: `migrations/025_close_out_grace.sql`
- Regenerate: `tenant/template.sql` (via `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./tools/gen-tenant-template.sh`; the HTTP suite fails if this is forgotten — `test/api.test.js:560-586`)
- Test: `test/compliance.sql` (append a block at the end, before any final summary lines)

**Interfaces:**
- Consumes: `public.site_today()`, `public.app_settings.local_timezone` (single row, `where id`), `public.daily_compliance`, `public.job_runs`, `public.is_staff()`.
- Produces: `public.close_out_due_through()` → `date`; `v_system_health.close_out_behind` now compares against it. No column of the view changes name or order; `public/checkin.html` needs no change.

- [ ] **Step 1: Write the failing test**

Append to `test/compliance.sql`:

```sql
\echo '--- close-out grace: yesterday is not due until 02:00 site time'
-- The function exists and answers one of the two dates the rule allows.
-- Which one depends on the clock, so the assertion is on the invariant,
-- not the hour: before 02:00 site time it is the day before yesterday,
-- from 02:00 it is yesterday, and it is never anything else.
select public.close_out_due_through() as due \gset
select date_part('hour', now() at time zone (select local_timezone from public.app_settings where id))::integer as site_hour \gset
select pg_temp.expect('close_out_due_through: yesterday, or the day before until 02:00 site time',
  (:'due')::date,
  case when :site_hour < 2 then public.site_today() - 2 else public.site_today() - 1 end);
-- And the view follows it: a register whose last closed day IS the due day
-- is not behind, one whose last closed day is the day before the due day is.
reset role;
insert into public.residents (id, first_name, last_name, date_of_birth, registered_at)
values ('66666666-6666-6666-6666-666666666666', 'Grace', 'Window', '1990-01-01', now() - interval '10 days')
on conflict (id) do nothing;
delete from public.daily_compliance where resident_id = '66666666-6666-6666-6666-666666666666';
insert into public.daily_compliance (resident_id, compliance_date, required, presented, first_seen_at, checkin_count, closed_at)
values ('66666666-6666-6666-6666-666666666666', public.close_out_due_through(), true, false, null, 0, now());
set role authenticated;
select close_out_behind as behind_when_due_day_closed from public.v_system_health \gset
reset role;
-- Only this fixture's row may be the latest closed day for the assertion to
-- mean anything: assert that first.
select pg_temp.expect('fixture: the grace row is the latest closed day',
  (select max(compliance_date) from public.daily_compliance where closed_at is not null), public.close_out_due_through());
select pg_temp.expect('v_system_health: not behind when the due day is closed', (:'behind_when_due_day_closed')::boolean, false);
```

Before writing, read the top of `test/compliance.sql` to match how it sets and resets roles (`set role authenticated;` / `reset role;`) and how `pg_temp.expect` is called (name, actual, expected), and check whether other closed rows in the fixture have a later `compliance_date` than the due day — if they do (for example a row closed for today), the fixture assertion fails; in that case delete those later closed rows in this block first, since it is the last block in the file.

- [ ] **Step 2: Run the database suite to see it fail**

Run: `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./test/sql.sh 2>&1 | tail -15`
Expected: fails at `close_out_due_through` — `function public.close_out_due_through() does not exist`.

- [ ] **Step 3: The migration**

Create `migrations/025_close_out_grace.sql`:

```sql
-- 025: the close-out banner waits for the job's own hour.
--
-- v_system_health.close_out_behind compared the last closed day with
-- yesterday from the first second of the new day, but hut-nightly runs at
-- 00:30 UTC (render.yaml), which is 01:30 in Dublin for half the year. So
-- every register terminal showed "The nightly close-out has not run" in red
-- from midnight until the job ran — a false alarm every night, which is how
-- a real one gets ignored (seen on a phone at 00:09 on 8 September 2026).
--
-- The rule now: until 02:00 site time, the day that must be closed is the
-- day before yesterday; from 02:00, yesterday. 02:00 leaves the job half an
-- hour of headroom in summer and an hour and a half in winter. Same
-- columns, same order; the register page needs no change.
set search_path = public, extensions;

create or replace function public.close_out_due_through()
returns date
language sql stable
set search_path = public
as $$
  select case
    when date_part('hour', now() at time zone (select local_timezone from public.app_settings where id)) < 2
      then public.site_today() - 2
    else public.site_today() - 1
  end;
$$;

comment on function public.close_out_due_through() is
  'The latest day the nightly close-out should have closed by now: yesterday, or the day before until 02:00 site time (hut-nightly runs at 00:30 UTC).';

revoke all on function public.close_out_due_through() from anon, public;
grant execute on function public.close_out_due_through() to authenticated;

create or replace view public.v_system_health as
select
  (select max(compliance_date) from public.daily_compliance where closed_at is not null) as last_closed_day,
  public.site_today() as site_today,
  (select max(ran_at) from public.job_runs where job = 'close-out-compliance-days' and ok) as last_close_out_run,
  (select max(ran_at) from public.job_runs where ok) as last_job_run,
  (select count(*)::integer from public.job_runs where not ok and ran_at > now() - interval '2 days') as recent_failures,
  coalesce(
    (select max(compliance_date) from public.daily_compliance where closed_at is not null) < public.close_out_due_through(),
    -- No closed day at all: behind only once there has been a full day to close.
    exists (select 1 from public.daily_compliance where compliance_date < public.close_out_due_through())
  ) as close_out_behind
where public.is_staff();
```

Compare the view body with the current definition in `migrations/012_audit_and_health.sql` (search `create or replace view public.v_system_health`) and with any later migration that redefined it (`grep -ln "v_system_health" migrations/*.sql`): every column other than `close_out_behind` must be copied exactly from the latest definition, in the same order, or `create or replace view` fails.

- [ ] **Step 4: Regenerate the tenant template**

Run: `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./tools/gen-tenant-template.sh 2>&1 | tail -3`
Expected: `tenant/template.sql` changes; `git diff --stat tenant/template.sql` shows the view and the new function with `__TENANT__.` prefixes and nothing unrelated. If the diff includes unrelated churn, stop and report DONE_WITH_CONCERNS rather than committing it.

- [ ] **Step 5: Run the database and HTTP suites**

Run: `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./test/sql.sh 2>&1 | tail -5` then `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./test/api.sh 2>&1 | tail -3`
Expected: both pass. (A pre-existing clock-dependent day-boundary assertion around `test/compliance.sql:284` can fail close to midnight; if it is the only failure, note it and re-run after 00:30 site time or report it as such.)

- [ ] **Step 6: Commit**

```bash
git add migrations/025_close_out_grace.sql tenant/template.sql test/compliance.sql
git commit -m "The close-out banner waits for the job's own hour

hut-nightly runs at 00:30 UTC, 01:30 Dublin in summer, but the health view
called the close-out late from midnight — a red banner on every terminal
every night until the job ran. Until 02:00 site time the day due is the
day before yesterday. Same view columns; the page is unchanged.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QMp1iENRi9GJLzm3baLCQy"
```

---

### Task 9: The help page and two doc passages catch up

Added 8 September 2026 from the Task 6 review: `public/help.html` still
documents the three-tile register, and two passages in the docs still say
"attention list" and "Breaches tile".

**Files:**
- Modify: `public/help.html` (the register section, and one troubleshooting entry)
- Modify: `README.md` (the annotation paragraph under the compliance-day table)
- Modify: `docs/UX-REVIEW.md` (the "Daily register — Breaches view" heading and its paragraph)

- [ ] **Step 1: help.html, the register section**

Replace the `<h3>The tiles</h3>` paragraph:

```html
  <h3>The tiles</h3>
  <p><span class="ui">Not seen</span> is today's work: residents required today who have not checked in. <span class="ui">Seen today</span> is who has already checked in, and each card says the time. Runs of missed nights and days absent in the rolling window are not on this screen; supervisors and admins read them under <span class="ui">Admin → Absences</span>.</p>
```

Replace the `<h3>Under 18s</h3>` paragraph's last clause so the sentence reads:

```html
  <p>Residents under the site's adult age are listed but not required. Their cards say so, and they are never counted as not seen.</p>
```

Replace the `<h3>The detail sheet</h3>` paragraph:

```html
  <p>Tap a name for the sheet: the identity document type and number, the time of today's check-in and every check-in recorded today with the name of whoever recorded it, consecutive missed nights and days absent in the rolling window each shown beside the figure in Settings ("2 of 3", "9 of 10"), the last 30 days as a strip (green seen, red missed, grey not required; long-press a green cell for the time), and a note when a count has reached a figure. The note states the count and the figure; it never gives a verdict. Supervisors and admins can add or change the ID number here.</p>
```

- [ ] **Step 2: help.html, the troubleshooting entry**

Replace the "The nightly job is late" entry:

```html
  <details><summary>The nightly job is late</summary><p>A banner appears on the register when the close-out has not run by two in the morning, site time. Until it runs, yesterday is not yet on the record as missed, and Admin → Absences may be a day behind. Tell your administrator; it is a hosting matter, not a data one.</p></details>
```

- [ ] **Step 3: help.html, the Admin section**

Find the Admin section (`<h2 id="admin"` or similar; `grep -n 'id="admin"' public/help.html`). If it lists the tabs (Residents, Buildings, Reports, Staff, Settings), add an Absences entry after Residents in the same markup as its neighbours, with this text:

```
Absences: every active resident with a run of consecutive missed nights or a missed day in the rolling window, worst first, each count beside the figure in Settings. A count that has reached its figure is marked. Nothing is decided here; the letter is the manager's.
```

If the Admin section does not enumerate tabs, add one sentence to its opening paragraph: "The Absences tab is the manager's list: who is near a House Rules figure, worst first."

- [ ] **Step 4: README annotation paragraph**

Replace the paragraph beginning "Staff may attach a reason to a missed day" so it reads:

```
Staff may attach a reason to a missed day with `annotate_compliance_day()`,
but the reason never flips the outcome — a `breach_noted` day still counts as a
breach and still counts under Admin → Absences. Annotation only demotes a row
in `attention_list()`'s ordering and greys it in the UI; it never removes it.
```

- [ ] **Step 5: UX review heading**

Replace the heading and paragraph "### Daily register — Breaches view (was the Attention tab)" … "the ordering note still applies to the tile's list." with:

```
### Daily register — Breaches view (was the Attention tab; removed 7 September)

*Updated the same afternoon:* the Attention tab and the chip row were
removed and the Breaches tile listed worst-first as the tab did. *7
September:* the tile went too; the worst-first list is Admin → Absences.
The paragraph below describes the tab as reviewed; the ordering note now
applies to that tab.
```

- [ ] **Step 6: Check and commit**

Run: `grep -n "three tiles\|Missed days\|attention list\|Breaches tile" public/help.html README.md docs/UX-REVIEW.md` — expected: no hits in help.html; README and UX-REVIEW hits only in historical, dated passages (the 4 September findings list, and the "as reviewed" section).
Run the parse snippet on help.html (`node -e "const fs=require('fs');const h=fs.readFileSync('public/help.html','utf8');console.log(h.length)"` is enough — the page has no script to parse; just confirm it is well-formed by opening the changed blocks).

```bash
git add public/help.html README.md docs/UX-REVIEW.md
git commit -m "help: the register has two tiles, the sheet shows the time, Absences is under Admin

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QMp1iENRi9GJLzm3baLCQy"
```

---

### Task 10: The test cluster runs in UTC on every host

Added 8 September 2026. `test/compliance.sql`'s day-boundary block (around
line 255-284) derives a synthetic timezone offset from
`clock_timestamp()::time`, which is rendered in the cluster's session
timezone. `test/cluster.sh` never sets one, so the throwaway cluster
inherits the host's zone: UTC in CI and containers, `Europe/Dublin` on a
Mac. On a Mac the offset is computed against Irish time and applied as if
UTC, and the assertion fails at every hour of the day — three implementers
in this plan lost time to it and called it a "midnight flake".

**Files:**
- Modify: `test/cluster.sh` (the `pg_ctl … start` line, around line 65)

- [ ] **Step 1: Reproduce**

Run: `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./test/sql.sh 2>&1 | grep -nE "day boundary|FAIL|expected" | head -5`
Expected: the "day boundary: seed timestamp lands on the day before the synthetic today" assertion fails.

- [ ] **Step 2: Pin the cluster's timezone**

In `test/cluster.sh`, the start line currently reads:

```bash
  if ! as_pg "'$PGBIN/pg_ctl' -D '$WORK/data' -o '-p $port -k $WORK' -l '$WORK/pg.log' -w start" >/dev/null; then
```

Change the `-o` options to add `-c timezone=UTC -c log_timezone=UTC`:

```bash
  if ! as_pg "'$PGBIN/pg_ctl' -D '$WORK/data' -o '-p $port -k $WORK -c timezone=UTC -c log_timezone=UTC' -l '$WORK/pg.log' -w start" >/dev/null; then
```

Add this comment directly above it:

```bash
  # UTC, whatever the host's zone. The compliance suite's day-boundary block
  # derives a synthetic offset from clock_timestamp()::time, which is rendered
  # in the session zone; on a Mac in Europe/Dublin that assertion failed at
  # every hour of the day while CI (UTC) stayed green. Production is UTC too.
```

- [ ] **Step 3: Run the database suite**

Run: `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./test/sql.sh 2>&1 | tail -4`
Expected: PASS, no failures. Then `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./test/api.sh 2>&1 | tail -2` — expected PASS (the HTTP suite uses the same cluster).

- [ ] **Step 4: Commit**

```bash
git add test/cluster.sh
git commit -m "test: the throwaway cluster runs in UTC on every host

The day-boundary block derives its synthetic offset from the session clock.
On a Mac in Europe/Dublin the cluster inherited the host zone and the
assertion failed at every hour; CI, in UTC, never saw it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QMp1iENRi9GJLzm3baLCQy"
```
