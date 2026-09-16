# Absences by date Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Admin → Absences tab shows who missed the daily register over a chosen range (Yesterday / 7 nights / 28 nights / any two dates), one row per resident with the count and the dates, and exports it to Excel through the audited reports route.

**Architecture:** One SQL over `daily_compliance` (missed = `required and not presented and closed_at is not null`, active residents only) is built by `missedSql()` in `routes/reports.js` and used twice: by a new report `missed` ("Missed register") that inherits the reason/audit/xlsx machinery, and by a new unaudited `GET /api/absences` that feeds the tab and also says how far the register is closed. The tab reuses the shared `mountRangePresets` chips (extended to take a preset list) and the History panel's inline reason-field export widget. No migration.

**Tech Stack:** Express on Node 22, Postgres 16 (`pg`), vanilla JS in `public/admin.html` + `public/app-common.js`, tests in `test/api.test.js` (plain `node:assert`, run by `./check.sh`), permission matrix in `test/permissions.js` → `docs/PERMISSIONS.md` via `tools/gen-permissions-doc.js`.

Spec: `docs/superpowers/specs/2026-09-16-absences-by-date-design.md`.

## Global Constraints

- No migration. Everything is a query over existing tables.
- A missed day is exactly `required and not presented and closed_at is not null`. Nothing else decides it. Today (open row) never counts.
- Denominator is the resident's own closed required days in the range ("3 of 4", not "3 of 7").
- Active residents only (`residents.status = 'active'`).
- `GET /api/absences` writes no audit row; the export goes through `/api/reports/missed` which does (`note_report()`).
- The Excel export covers the whole range, never the search-filtered rows.
- Range rules for both endpoints: `from`/`to` are `YYYY-MM-DD` via `dateParam`; `to` defaults to `from`; `to < from` → 400; more than 366 days → 400.
- Copy style: plain sentences, no jargon, the app never "decides" a threshold was met. Match the comment density and voice of the surrounding code.
- Tests on this Mac need `PGBIN=/opt/homebrew/opt/postgresql@16/bin` in the environment when running `./check.sh`.
- Before touching anything: `git fetch origin && git status -sb` — other sessions push to `main`. Work on `main` directly (project convention), commit per task, do **not** push until the whole plan is done and `./check.sh` is green.

---

### Task 1: `missedSql()`, the `missed` report, and `GET /api/absences`

**Files:**
- Modify: `routes/reports.js` (header comment lines 1–18; add helper after `const router = express.Router();` at line 43; add report after `REPORTS.weekly` block; add route before `router.get('/reports/:name', …)` at line 384)
- Modify: `test/api.test.js` (insert a new block immediately before `console.log("\n== audit trail ==");` at line ~1690, inside the scope where `supC`, `api`, `withOwner`, `siteToday` exist)
- Modify: `test/permissions.js` (add one row in the `// ---- reports` section, after line 115)
- Regenerate: `docs/PERMISSIONS.md` via `node tools/gen-permissions-doc.js`

**Interfaces:**
- Consumes: `dateParam(value, field)` and `HttpError` from `lib/api.js`; `db.withIdentity(userId, fn)`; `wrap` from `lib/asyncRoute`; existing `REPORTS` map and `xlsx(rows, {sheetName})`/`csv(rows)` in `routes/reports.js`.
- Produces:
  - `missedSql({ flat })` → SQL string with `$1 = from`, `$2 = to`. Columns: `id, ref, full_name, building, room, nights_missed, nights_required, missed_dates (text[]) | dates (text, when flat), consecutive_missed, absent_in_window, last_seen_on (text|null), seen_today (bool), last_breach_kind (text|null), last_breach_on (text|null)`.
  - `rangeParams(query)` → `{ from, to }` after validation (shared by both routes).
  - `REPORTS.missed` — title `'Missed register'`, `ranged: true`.
  - `GET /api/absences?from&to` → `{ from, to, closed_through: string|null, rows: [...] }` where each row is the non-flat columns with `last_breach_kind/last_breach_on` replaced by `last_breach: {kind, issued_on} | null`.

- [ ] **Step 1: Write the failing tests**

Insert into `test/api.test.js` immediately before the line `console.log("\n== audit trail ==");` (around line 1690). `supC` is the supervisor client, `api` the guard client.

```js
  console.log("\n== absences by date ==");

  // Dates as the site counts them. siteToday() is YYYY-MM-DD in
  // Europe/Dublin; shifting it by whole days at noon avoids DST edges.
  const siteDay = (offset) => {
    const d = new Date(`${siteToday()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  };
  const absIds = {};
  await test("the Absences range lists who missed the register, one row per resident, with the dates", async () => {
    for (const [key, first, last] of [["missy", "Missy", "Rangefixture"], ["twice", "Twice", "Rangefixture"], ["gone", "Gone", "Rangefixture"]]) {
      const res = await supC.fetch("/api/residents", { method: "POST", body: { first_name: first, last_name: last, date_of_birth: "1988-02-02" } });
      assert.equal(res.status, 201, res.text);
      absIds[key] = res.json.id;
    }
    await withOwner(async (c) => {
      const put = (id, offset, required, presented, closed) => c.query(
        `insert into public.daily_compliance (resident_id, compliance_date, required, presented, first_seen_at, checkin_count, closed_at)
         values ($1, public.site_today() + $2, $3, $4, case when $4 then now() end, case when $4 then 1 else 0 end, case when $5 then now() end)
         on conflict (resident_id, compliance_date) do update
           set required = excluded.required, presented = excluded.presented, first_seen_at = excluded.first_seen_at,
               checkin_count = excluded.checkin_count, closed_at = excluded.closed_at`,
        [id, offset, required, presented, closed]);
      // Missy: missed yesterday; presented the day before; authorised
      // (required = false) the day before that; today still open.
      await put(absIds.missy, -1, true, false, true);
      await put(absIds.missy, -2, true, true, true);
      await put(absIds.missy, -3, false, false, true);
      await put(absIds.missy, 0, true, false, false);
      // Twice: missed the last two nights, and one nine nights ago.
      await put(absIds.twice, -1, true, false, true);
      await put(absIds.twice, -2, true, false, true);
      await put(absIds.twice, -9, true, false, true);
      // Gone: missed yesterday, then left.
      await put(absIds.gone, -1, true, false, true);
      await c.query(`update public.residents set status = 'departed', departed_on = public.site_today() where id = $1`, [absIds.gone]);
    });

    const week = await supC.fetch(`/api/absences?from=${siteDay(-7)}&to=${siteDay(-1)}`);
    assert.equal(week.status, 200, week.text);
    assert.equal(week.json.from, siteDay(-7));
    assert.equal(week.json.to, siteDay(-1));
    const ours = week.json.rows.filter((r) => Object.values(absIds).includes(r.id));
    assert.deepEqual(ours.map((r) => r.id), [absIds.twice, absIds.missy], "most missed first; the departed resident must not be listed");
    const missy = ours[1];
    assert.equal(missy.full_name, "Missy Rangefixture");
    assert.equal(missy.nights_missed, 1);
    assert.equal(missy.nights_required, 2, "the authorised (required = false) day must not be in the denominator");
    assert.deepEqual(missy.missed_dates, [siteDay(-1)]);
    assert.equal(missy.last_breach, null);
    assert.equal(typeof missy.consecutive_missed, "number");
    const twice = ours[0];
    assert.equal(twice.nights_missed, 2, "the miss nine nights ago is outside a 7-night range");
    assert.deepEqual(twice.missed_dates, [siteDay(-2), siteDay(-1)]);

    const month = await supC.fetch(`/api/absences?from=${siteDay(-28)}&to=${siteDay(-1)}`);
    assert.equal(month.json.rows.find((r) => r.id === absIds.twice).nights_missed, 3);
  });

  await test("today's open row never counts, and the response says how far the register is closed", async () => {
    const res = await supC.fetch(`/api/absences?from=${siteDay(-7)}&to=${siteToday()}`);
    assert.equal(res.status, 200, res.text);
    const missy = res.json.rows.find((r) => r.id === absIds.missy);
    assert.equal(missy.nights_missed, 1, "the open row for today was counted as missed");
    assert.equal(missy.nights_required, 2, "the open row for today was counted as required");
    const { rows } = await withOwner((c) => c.query(`select max(compliance_date)::text as d from public.daily_compliance where closed_at is not null`));
    assert.equal(res.json.closed_through, rows[0].d);
  });

  await test("the Absences range is for supervisors and admins, and checks its dates", async () => {
    assert.equal((await api.fetch(`/api/absences?from=${siteDay(-1)}&to=${siteDay(-1)}`)).status, 403);
    assert.equal((await supC.fetch(`/api/absences?to=${siteDay(-1)}`)).status, 400, "from is required");
    assert.equal((await supC.fetch(`/api/absences?from=${siteDay(-1)}&to=${siteDay(-2)}`)).status, 400, "to before from");
    assert.equal((await supC.fetch(`/api/absences?from=2020-01-01&to=2021-06-01`)).status, 400, "more than a year");
    const one = await supC.fetch(`/api/absences?from=${siteDay(-1)}`);
    assert.equal(one.status, 200, "to should default to from");
    assert.equal(one.json.to, siteDay(-1));
  });

  await test("the Missed register report is the same rows with the dates flattened, and asks for a reason", async () => {
    const from = siteDay(-7), to = siteDay(-1);
    assert.equal((await supC.fetch(`/api/reports/missed?from=${from}&to=${to}`)).status, 400, "no reason");
    assert.equal((await api.fetch(`/api/reports/missed?from=${from}&to=${to}&reason=test`)).status, 403, "a guard");
    const rep = await supC.fetch(`/api/reports/missed?from=${from}&to=${to}&reason=House+Rules+letter&format=json`);
    assert.equal(rep.status, 200, rep.text);
    assert.equal(rep.json.title, "Missed register");
    const twice = rep.json.rows.find((r) => r.resident === "Twice Rangefixture");
    assert.ok(twice, "Twice is missing from the report");
    assert.equal(twice.nights_missed, 2);
    assert.equal(twice.dates, `${siteDay(-2)}, ${siteDay(-1)}`);
    assert.equal("missed_dates" in twice, false, "the array column must not reach a spreadsheet");
    assert.equal("id" in twice, false, "the report carries the ref, not the uuid");
    const xl = await supC.fetch(`/api/reports/missed?from=${from}&to=${to}&reason=House+Rules+letter&format=xlsx`);
    assert.equal(xl.status, 200);
    assert.match(xl.headers.get("content-type"), /spreadsheetml/);
    assert.ok(xl.text.startsWith("PK"), "not a zip/xlsx");
    const listed = await supC.fetch("/api/reports");
    assert.ok(listed.json.some((r) => r.name === "missed" && r.title === "Missed register" && r.ranged === true));
    const { rows } = await withOwner((c) => c.query(`select note from public.admin_audit where table_name = 'reports' and row_id = 'missed' order by at`));
    assert.equal(rows.length, 2, "both exports (json and xlsx) should be on the record");
    assert.match(rows[0].note, /^House Rules letter \[/);
  });
```

Add to `test/permissions.js`, after the line with `name: 'Export a report (register, …'` (line 115):

```js
  { area: 'Reports', name: 'Who missed the register over a range (the Absences tab); not logged', method: 'GET', path: (fx) => `/api/absences?from=${fx.today}&to=${fx.today}`, expect: SUPERVISOR },
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/check-in && PGBIN=/opt/homebrew/opt/postgresql@16/bin ./check.sh 2>&1 | tail -40`

Expected: the HTTP suite fails at "the Absences range lists who missed the register…" with status 404 (no such route), and the permission-matrix step fails because `docs/PERMISSIONS.md` is out of date.

- [ ] **Step 3: Implement the SQL builder, the report and the route**

In `routes/reports.js`, add to the header comment list (after the `weekly` line, keeping the column alignment):

```
//   missed      who missed the daily register over a range, one row per resident with the dates (the Absences tab's export)
```

and after the `//   GET /api/reports/inspection-pack…` paragraph:

```
//
//   GET /api/absences?from=&to=
//
// The Absences tab's range: the same query as the "missed" report, without
// the reason or the audit row — looking at the tab is not audited, as the
// resident list it read before was not. It also returns closed_through, the
// last register date the nightly job has closed, so the tab can say when a
// range reaches into a night that is not closed yet rather than show an
// empty table that reads as "nobody missed".
```

After `const router = express.Router();` add:

```js
// from/to for a ranged query: YYYY-MM-DD each, to defaults to from, at most
// a year. Shared by /reports/:name and /absences so the two never drift.
function rangeParams(query) {
  const from = dateParam(query.from, 'from');
  const to = dateParam(query.to || query.from, 'to');
  if (to < from) throw new HttpError(400, 'to must not be before from');
  const days = (Date.parse(to) - Date.parse(from)) / 86400000;
  if (days > 366) throw new HttpError(400, 'A report covers at most a year');
  return { from, to };
}

// Who missed the daily register between $1 and $2, one row per active
// resident with at least one miss. A miss is a closed day that was required
// and not presented — nothing else decides it: an authorised absence is
// written required = false by close_out_compliance_days(), a child is never
// required, and today's row is open until the nightly job closes it, so
// none of them can appear here. nights_required is the resident's own
// closed required days in the range, so someone who arrived on Thursday
// reads "2 of 3", not "2 of 7". `flat` swaps the text[] of dates for one
// comma-separated column, for csv/xlsx.
function missedSql({ flat = false } = {}) {
  return `
    with days as (
      select dc.resident_id,
             count(*) filter (where dc.required and not dc.presented)::int as nights_missed,
             count(*) filter (where dc.required)::int                     as nights_required,
             array_agg(dc.compliance_date::text order by dc.compliance_date)
               filter (where dc.required and not dc.presented)            as missed_dates
        from daily_compliance dc
       where dc.compliance_date between $1 and $2
         and dc.closed_at is not null
       group by dc.resident_id
    ),
    breach as (
      select distinct on (resident_id) resident_id, kind, issued_on
        from breach_reports order by resident_id, issued_on desc, id desc
    )
    select ${flat ? '' : 'r.id, '}r.ref, btrim(r.first_name) || ' ' || btrim(r.last_name) as ${flat ? 'resident' : 'full_name'},
           rm.building, rm.room,
           d.nights_missed, d.nights_required,
           ${flat ? "array_to_string(d.missed_dates, ', ') as dates" : 'd.missed_dates'},
           c.consecutive_missed, c.absent_in_window,
           c.last_seen_on::text as ${flat ? 'last_seen' : 'last_seen_on'},
           ${flat ? '' : 'c.seen_today, '}
           b.kind as last_breach_kind, b.issued_on::text as last_breach_on
      from days d
      join residents r on r.id = d.resident_id and r.status = 'active'
      left join v_resident_room rm on rm.id = r.id
      left join v_resident_compliance c on c.id = r.id
      left join breach b on b.resident_id = r.id
     where d.nights_missed > 0
     order by d.nights_missed desc, c.consecutive_missed desc nulls last, r.last_name, r.first_name`;
}
```

Replace the five range lines inside `router.get('/reports/:name', …)`:

```js
  let from = null, to = null;
  if (def.ranged) {
    from = dateParam(req.query.from, 'from');
    to = dateParam(req.query.to || req.query.from, 'to');
    if (to < from) throw new HttpError(400, 'to must not be before from');
    const days = (Date.parse(to) - Date.parse(from)) / 86400000;
    if (days > 366) throw new HttpError(400, 'A report covers at most a year');
  }
```

with

```js
  let from = null, to = null;
  if (def.ranged) ({ from, to } = rangeParams(req.query));
```

After the `REPORTS.weekly = { … };` block (find it with `grep -n "^REPORTS.weekly" routes/reports.js`), add:

```js
// The Absences tab's export: who missed the register over the range, with
// the dates (migration-free; see missedSql above).
REPORTS.missed = {
  title: 'Missed register',
  ranged: true,
  sql: missedSql({ flat: true }),
};
```

Before `router.get('/reports/:name', …)` add:

```js
router.get('/absences', wrap(async (req, res) => {
  if (req.session.role !== 'supervisor' && req.session.role !== 'admin') {
    throw new HttpError(403, 'Only a supervisor or admin can see who missed the register');
  }
  const { from, to } = rangeParams(req.query);
  const out = await db.withIdentity(req.session.userId, async (client) => {
    const { rows } = await client.query(missedSql(), [from, to]);
    const closed = await client.query(
      `select max(compliance_date)::text as d from daily_compliance where closed_at is not null`);
    return { closed_through: closed.rows[0].d, rows };
  });
  res.json({
    from, to, closed_through: out.closed_through,
    rows: out.rows.map(({ last_breach_kind, last_breach_on, ...r }) => ({
      ...r,
      last_breach: last_breach_kind ? { kind: last_breach_kind, issued_on: last_breach_on } : null,
    })),
  });
}));
```

Regenerate the permissions document:

Run: `cd ~/check-in && node tools/gen-permissions-doc.js && git diff --stat docs/PERMISSIONS.md`

Expected: one new row in `docs/PERMISSIONS.md`.

- [ ] **Step 4: Run the suite to verify it passes**

Run: `cd ~/check-in && PGBIN=/opt/homebrew/opt/postgresql@16/bin ./check.sh 2>&1 | tail -40`

Expected: every step green, including the four new tests and the permission matrix (`docs/PERMISSIONS.md` current). If `nights_required` for Missy comes back 3, the `required = false` day was counted — the filter on `nights_required` is wrong. If the departed resident appears, the `r.status = 'active'` join condition was dropped.

- [ ] **Step 5: Commit**

```bash
cd ~/check-in && git add routes/reports.js test/api.test.js test/permissions.js docs/PERMISSIONS.md
git commit -m "Absences by date: missedSql(), the Missed register report, GET /api/absences

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The Absences tab over a range

**Files:**
- Modify: `public/app-common.js:604-627` (`presetRange`, `mountRangePresets`)
- Modify: `public/admin.html:405-412` (panel markup), `:784-850` (`loadAbsences`/`renderAbsences`), `:2252-2254` (wiring)
- Modify: `public/app-common.css:146-147` (chip sizing selector)

**Interfaces:**
- Consumes: `GET /api/absences?from&to` → `{ from, to, closed_through, rows }` (Task 1). Existing helpers in `app-common.js`: `dayLabel(ymd)`, `isoDate(d)`, `esc`, `guarded`, `apiGet`, `showError`, `toast`, `Offline`.
- Produces: `presetRange(name)` accepts `"7nights"` and `"28nights"`; `mountRangePresets(container, fromEl, toEl, onPick, presets = DEFAULT_PRESETS)`; `state.absRows` holds the last loaded response; `loadAbsences()` fetches and renders, `renderAbsences()` re-renders from `state.absRows` (the search box calls the latter — no refetch to filter).

- [ ] **Step 1: Extend the shared presets**

In `public/app-common.js` replace lines 604–627 (from the `// Quick ranges for a date pair` comment through the end of `mountRangePresets`) with:

```js
// Quick ranges for a date pair: today, yesterday, this week (Monday to
// today), this month; and, for the registers that only exist once a night
// has closed, the last 7 or 28 nights ending yesterday. Returns [from, to]
// as YYYY-MM-DD in local time.
function presetRange(name) {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const f = new Date(t);
  if (name === "yesterday") { f.setDate(f.getDate() - 1); return [isoDate(f), isoDate(f)]; }
  if (name === "7nights" || name === "28nights") {
    const y = new Date(t); y.setDate(y.getDate() - 1);
    f.setDate(f.getDate() - (name === "7nights" ? 7 : 28));
    return [isoDate(f), isoDate(y)];
  }
  if (name === "week") { f.setDate(f.getDate() - ((f.getDay() + 6) % 7)); return [isoDate(f), isoDate(t)]; }
  if (name === "month") { f.setDate(1); return [isoDate(f), isoDate(t)]; }
  return [isoDate(t), isoDate(t)];
}
const DEFAULT_PRESETS = [["today", "Today"], ["yesterday", "Yesterday"], ["week", "This week"], ["month", "This month"]];
// Chips under a from/to pair. onPick runs after the inputs are set. The
// Log and History take the default four; a caller with a different set
// (the Absences tab: nights that have closed) passes its own [key, label]s.
function mountRangePresets(container, fromEl, toEl, onPick, presets = DEFAULT_PRESETS) {
  container.innerHTML = presets
    .map(([k, l]) => `<button type="button" data-preset="${k}">${l}</button>`).join("");
  container.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-preset]"); if (!b) return;
    const [f, t] = presetRange(b.dataset.preset);
    fromEl.value = f; toEl.value = t;
    container.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    onPick();
  });
  const clear = () => container.querySelectorAll("button").forEach((x) => x.removeAttribute("aria-pressed"));
  fromEl.addEventListener("input", clear); toEl.addEventListener("input", clear);
}
```

Note on the arithmetic: "7 nights ending yesterday" is `today - 7 … today - 1` (seven dates inclusive), so `f` steps back 7, not 6.

In `public/app-common.css` change lines 146–147 so the Absences chips get the same compact sizing:

```css
  .history .chips, #logPresets, #absPresets { margin: 8px 0 10px; gap: 6px; }
  .history .chips button, #logPresets button, #absPresets button { padding: 6px 10px; font-size: 13px; }
```

- [ ] **Step 2: Replace the panel markup**

In `public/admin.html` replace lines 405–412 (the `<!-- ---- absences` comment through `</section>`) with:

```html
    <!-- ---- absences (supervisors and admins): who missed the daily
         register over a range — yesterday in one tap, a week by default —
         one row per resident with the count and the dates, beside the
         figures in Settings. The export goes through the reports route so
         it asks for a reason and is on the record. ---- -->
    <section id="panelAbsences" role="tabpanel" aria-labelledby="tabAbsences" hidden>
      <form class="row" id="absRange" autocomplete="off">
        <input id="absFrom" class="field grow" type="date" aria-label="From">
        <input id="absTo" class="field grow" type="date" aria-label="To">
        <button class="btn ghost sm" type="submit">Show</button>
      </form>
      <div id="absPresets" class="chips" aria-label="Quick ranges"></div>
      <p class="hint flush" id="absIntro"></p>
      <p class="hint flush" id="absOpen" hidden>Last night's register is not closed yet — it closes at 01:30.</p>
      <div class="row mt8">
        <input id="absQ" class="field grow" type="search" placeholder="Name or room…" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Filter by name or room">
        <button type="button" class="btn sm" id="absExport" aria-expanded="false">Excel</button>
      </div>
      <form class="row mt8" id="absExportForm" hidden>
        <input class="field grow" name="reason" type="text" maxlength="200" required placeholder="Reason for the export" aria-label="Reason for the export">
        <button class="btn sm" type="submit">Download</button>
      </form>
      <div class="tablewrap mt14"><table id="absTable"></table></div>
    </section>
```

(The export form and button are wired in Task 3; leave them in the markup now so the layout is settled.)

- [ ] **Step 3: Rewrite `loadAbsences` / `renderAbsences`**

In `public/admin.html` replace lines 784–850 (from the `// Active residents with a run of missed nights` comment through the closing `}` of `renderAbsences`) with:

```js
// Who missed the daily register between the two dates: GET /api/absences,
// one row per active resident with at least one miss, most missed first.
// The range is the filter; the search box narrows the loaded rows without
// asking the server again. Today is never in the range by default — the
// row is open until the 00:30 job closes it — and when a chosen range does
// reach into an unclosed night the server's closed_through lets us say so.
async function loadAbsences() {
  const from = $("absFrom").value, to = $("absTo").value;
  if (!from || !to) { $("absIntro").textContent = "Pick two dates."; $("absTable").innerHTML = ""; return; }
  $("absIntro").textContent = "Loading…";
  const out = await guarded(
    () => apiGet(`/api/absences?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
    (err) => { Offline.noteFailure(err); showError("Could not load absences: " + err.message); },
  );
  if (!out) return;
  showError("");
  state.absRows = out;
  renderAbsences();
}

function renderAbsences() {
  const out = state.absRows;
  if (!out) return;
  const s = state.settings || {};
  const nightLimit = s.warn_after_consecutive_nights ?? 3;
  const winLimit = s.absence_window_limit ?? 10;
  const winDays = s.absence_window_days ?? 28;
  const withRooms = !!s.feature_buildings;
  const range = out.from === out.to ? `on ${dayLabel(out.from)}` : `between ${dayLabel(out.from)} and ${dayLabel(out.to)}`;

  $("absOpen").hidden = !(out.closed_through && out.to > out.closed_through);
  $("absIntro").textContent =
    `Missed the register ${range}. ` +
    `Facts against the figures in Settings: ${nightLimit} consecutive nights, ${winLimit} days in ${winDays}. ` +
    `The app never decides that a threshold was met; the decision, and the letter, are the manager's.`;

  const q = ($("absQ").value || "").trim().toLowerCase();
  const listed = out.rows.filter((r) => !q ||
    String(r.full_name).toLowerCase().includes(q) ||
    String(r.building || "").toLowerCase().includes(q) ||
    String(r.room || "").toLowerCase() === q);

  if (!listed.length) {
    $("absTable").innerHTML = `<tbody><tr><td class="hint">${out.rows.length
      ? "Nobody matching that name or room."
      : `Nobody missed the register ${esc(range)}.`}</td></tr></tbody>`;
    return;
  }

  const roomOf = (r) => [r.building, r.room].filter(Boolean).join(" · ");
  const lastSeen = (r) => r.seen_today ? "Today" : (r.last_seen_on ? dayLabel(r.last_seen_on) : "Never");
  const head = ["Name", ...(withRooms ? ["Room"] : []), "Missed", "Consecutive nights", `Absent in ${winDays} days`, "Last seen", "Today", "Breach report"];
  const KIND_SHORT = { house_rules: "house rules", misuse: "misuse" };
  $("absTable").innerHTML =
    `<thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>` +
    `<tbody>${listed.map((r) => {
      const n = r.consecutive_missed || 0, w = r.absent_in_window || 0;
      return `<tr>` +
        `<td>${esc(r.full_name)}</td>` +
        (withRooms ? `<td>${esc(roomOf(r))}</td>` : "") +
        `<td class="num"><b>${r.nights_missed} of ${r.nights_required}</b><br><small class="hint">${esc(r.missed_dates.map(dayLabel).join(", "))}</small></td>` +
        `<td class="num${n >= nightLimit ? " at" : ""}">${n} of ${nightLimit}</td>` +
        `<td class="num${w >= winLimit ? " at" : ""}">${w} of ${winLimit}</td>` +
        `<td>${esc(lastSeen(r))}</td>` +
        `<td>${r.seen_today ? "Checked in" : "Not yet checked in"}</td>` +
        `<td>${r.last_breach ? `${esc(KIND_SHORT[r.last_breach.kind] || r.last_breach.kind)} · ${esc(dayLabel(r.last_breach.issued_on))}` : "—"}</td>` +
      `</tr>`;
    }).join("")}</tbody>`;
}
```

Note: the old renderer read the threshold figures off the first resident row (`src.warn_after_consecutive_nights`) because `/api/residents?compliance=1` carried them; `/api/absences` does not, so they come from `state.settings`, which `admin.html` sets from the session at login (`state.settings = settings;`, line ~2142) before any tab can be opened. The "Away until" cell is gone from the Today column: a resident on an authorised absence has `required = false` and cannot be in these rows.

- [ ] **Step 4: Wire the range, the presets and the search box**

In `public/admin.html` replace lines 2252–2254:

```js
$("tabAbsences").addEventListener("click", () => selectTab("absences"));
let absQTimer = null;
$("absQ").addEventListener("input", () => { clearTimeout(absQTimer); absQTimer = setTimeout(loadAbsences, 200); });
```

with

```js
$("tabAbsences").addEventListener("click", () => selectTab("absences"));
let absQTimer = null;
$("absQ").addEventListener("input", () => { clearTimeout(absQTimer); absQTimer = setTimeout(renderAbsences, 120); });
$("absRange").addEventListener("submit", (e) => { e.preventDefault(); loadAbsences(); });
mountRangePresets($("absPresets"), $("absFrom"), $("absTo"), loadAbsences,
  [["yesterday", "Yesterday"], ["7nights", "7 nights"], ["28nights", "28 nights"]]);
// 7 nights, pressed, before the tab is first opened: selectTab() calls
// loadAbsences(), which needs the two dates filled in.
{ const [f, t] = presetRange("7nights"); $("absFrom").value = f; $("absTo").value = t; }
$("absPresets").querySelector('[data-preset="7nights"]').setAttribute("aria-pressed", "true");
```

- [ ] **Step 5: Parse check and a look in the browser**

Run: `cd ~/check-in && PGBIN=/opt/homebrew/opt/postgresql@16/bin ./check.sh 2>&1 | sed -n '/JavaScript parses/,/brochure/p'`

Expected: the parse step passes (it evaluates the inline scripts in `public/*.html` and `app-common.js`).

Then run the app locally per README.md §7 "Running it locally" (`HUT_ALLOW_INSECURE_COOKIE=1 npm start` against a local database with `.env` set, http://localhost:3000); log in as a supervisor, open Admin → Absences and confirm: the 7-nights chip is pressed and the table fills; Yesterday shows one day; typing in the search box narrows without a network call (check the Network tab); From/To with "Show" works; a range including today shows the "not closed yet" line. Take a screenshot for the review.

- [ ] **Step 6: Commit**

```bash
cd ~/check-in && git add public/app-common.js public/app-common.css public/admin.html
git commit -m "Absences tab over a range: Yesterday, 7 nights, 28 nights, or two dates

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Excel export from the tab, help text, roadmap

**Files:**
- Modify: `public/admin.html` (after the wiring added in Task 2 Step 4)
- Modify: `public/help.html:244` (the `facts` list under the register section) and the "More detail" paragraph at line 247
- Modify: `docs/PRODUCT-ROADMAP.md:143-162` (the Absences section)

**Interfaces:**
- Consumes: `GET /api/reports/missed?from&to&reason&format=xlsx` (Task 1); `#absExport`, `#absExportForm`, `#absFrom`, `#absTo` (Task 2); `dismissToastOnInput(el)`, `toast`, `Offline` from `app-common.js`.

- [ ] **Step 1: Wire the export**

In `public/admin.html`, directly after the `$("absPresets").querySelector('[data-preset="7nights"]')…` line from Task 2, add:

```js
// Excel: the whole range, never the search-filtered rows. The audit record
// note_report() writes says "missed [from to to]"; a sheet that quietly
// left people out because a name was typed in the filter box would make
// that record misleading. Same reason-field widget as the History export.
$("absExport").addEventListener("click", () => {
  const f = $("absExportForm");
  f.hidden = !f.hidden;
  $("absExport").setAttribute("aria-expanded", String(!f.hidden));
  if (!f.hidden) f.elements.reason.focus();
});
dismissToastOnInput($("absExportForm").elements.reason);
$("absExportForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const reason = $("absExportForm").elements.reason.value.trim();
  const from = $("absFrom").value, to = $("absTo").value;
  if (!reason) { toast("Give the reason for the export", "err"); $("absExportForm").elements.reason.focus(); return; }
  if (!from || !to) { toast("Pick two dates first", "err"); return; }
  if (!Offline.isOnline()) { toast("Exporting needs a connection", "err"); return; }
  // A file download: the browser saves it and stays on the page.
  window.location.href = `/api/reports/missed?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&reason=${encodeURIComponent(reason)}&format=xlsx`;
  toast("Export recorded and downloading", "ok");
  $("absExportForm").hidden = true; $("absExport").setAttribute("aria-expanded", "false");
});
```

`dismissToastOnInput(el)` is defined at `public/app-common.js:96` and is what the History export uses.

- [ ] **Step 2: Help text**

In `public/help.html` line 244, change

```html
    <li>Missed nights are under Admin → Absences</li>
```

to

```html
    <li>Missed nights are under Admin → Absences: yesterday, the last 7 or 28 nights, or any two dates</li>
```

and in the "More detail" paragraph at line 247 change the sentence

```
Runs of missed nights and days absent in the rolling window are not on this screen; supervisors and admins read them under <span class="ui">Admin → Absences</span>.
```

to

```
Runs of missed nights and days absent in the rolling window are not on this screen; supervisors and admins read them under <span class="ui">Admin → Absences</span>, which lists who missed the register over a range — <span class="ui">Yesterday</span> in one tap, the last 7 nights by default — with the dates, and exports it to Excel (a reason is asked for and kept on the record, like every export).
```

- [ ] **Step 3: Roadmap**

In `docs/PRODUCT-ROADMAP.md` replace lines 145–146:

```
**Status: built 7 September 2026, on the working branch. No switch, no
migration, no new data.**
```

with

```
**Status: built 7 September 2026; given a date range 16 September 2026
(Yesterday · 7 nights · 28 nights · two dates, one row per resident with
the dates, Excel through the audited "Missed register" report). No switch,
no migration, no new data.**
```

- [ ] **Step 4: Full check and a browser pass**

Run: `cd ~/check-in && PGBIN=/opt/homebrew/opt/postgresql@16/bin ./check.sh 2>&1 | tail -30`

Expected: every step green.

In the browser (same setup as Task 2 Step 5): tap Excel, the reason field appears and takes focus; Download with an empty reason toasts "Give the reason for the export"; with a reason, a file `missed-<from>-to-<to>-<date>.xlsx` downloads and the toast says "Export recorded and downloading". Open it: columns `ref, resident, building, room, nights_missed, nights_required, dates, consecutive_missed, absent_in_window, last_seen, last_breach_kind, last_breach_on`. Check Admin → Reports lists "Missed register" too.

- [ ] **Step 5: Commit**

```bash
cd ~/check-in && git add public/admin.html public/help.html docs/PRODUCT-ROADMAP.md
git commit -m "Absences tab: Excel export through the Missed register report; help and roadmap

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Done when

- `./check.sh` green (`PGBIN=/opt/homebrew/opt/postgresql@16/bin`).
- Three commits on `main`, nothing pushed until the owner says so (Render deploys `main`).
- Deploy note: no migration, no env change, no `t_*` tenant hazard — the new SQL touches only tables migration 002 created, which every tenant schema has.
