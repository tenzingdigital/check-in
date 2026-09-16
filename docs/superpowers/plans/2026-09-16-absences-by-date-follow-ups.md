# Absences by date — follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the review follow-ups from `2026-09-16-absences-by-date.md` before the feature is pushed: rename the tab endpoint so it no longer collides with the "Authorised absences" report, show the not-closed hint when the register has never been closed, collapse the three copies of the reason-field export logic into one helper, and add the two small tests/copy fixes the reviews asked for.

**Architecture:** All on the unpushed `main` (`e2d98b0`), so the endpoint rename costs nothing. Server: one route path + header comment. Client: one shared `exportWithReason()` in `public/app-common.js` used by `mountHistory`, the Absences tab and the resident-record export. Tests: URLs follow the rename; one new assertion proves the tab read writes no audit row.

**Tech Stack:** as the parent plan (Express, Postgres 16, vanilla JS, `test/api.test.js`, `./check.sh` with `PGBIN=/opt/homebrew/opt/postgresql@16/bin`).

## Global Constraints

- `main` is at `e2d98b0`, six commits ahead of `origin/main`, unpushed. `git fetch origin && git status -sb` first; if either has moved, stop.
- The report named `absences` (Authorised absences) keeps its name — it is in production audit records. Only the new tab endpoint is renamed.
- Copy style: plain sentences; match the comment voice of the surrounding code.
- Do NOT push.

---

### Task 1: Rename `/api/absences` → `/api/missed`; null `closed_through`; failed-load copy; no-audit-row test

**Files:**
- Modify: `routes/reports.js` (header comment block `GET /api/absences?from=&to=`; `router.get('/absences', …)`)
- Modify: `public/admin.html` (`loadAbsences()` fetch URL and error handler; `renderAbsences()` `#absOpen` condition)
- Modify: `test/api.test.js` (every `/api/absences?` in the "absences by date" block; one new test)
- Modify: `test/permissions.js` (the `/api/absences` row's `path`)
- Regenerate: `docs/PERMISSIONS.md` (`node tools/gen-permissions-doc.js`)
- Modify: `docs/superpowers/specs/2026-09-16-absences-by-date-design.md` (every `/api/absences` → `/api/missed`; the "Honest about an unclosed night" decision and the `#absOpen` bullet gain the never-closed case)
- Modify: `docs/superpowers/plans/2026-09-16-absences-by-date.md` (add one line under the header: `> Superseded detail: the tab endpoint was renamed to \`GET /api/missed\` before push — see 2026-09-16-absences-by-date-follow-ups.md.`; leave the rest as the historical record)

**Interfaces:**
- Produces: `GET /api/missed?from&to` — identical contract to the former `/api/absences`.

- [ ] **Step 1: Write the failing test and move the URLs**

In `test/api.test.js`, in the "absences by date" block, replace every `/api/absences?` with `/api/missed?`. Then add, after the test "today's open row never counts…", this new test:

```js
  await test("looking at the Absences tab is not audited; only the export is", async () => {
    const before = (await withOwner((c) => c.query(`select count(*)::int as n from public.admin_audit where table_name = 'reports'`))).rows[0].n;
    const res = await supC.fetch(`/api/missed?from=${siteDay(-7)}&to=${siteDay(-1)}`);
    assert.equal(res.status, 200, res.text);
    const after = (await withOwner((c) => c.query(`select count(*)::int as n from public.admin_audit where table_name = 'reports'`))).rows[0].n;
    assert.equal(after, before, "reading the tab wrote an audit row");
  });
```

In `test/permissions.js`, change the row's path to `` (fx) => `/api/missed?from=${fx.today}&to=${fx.today}` `` and its name to `'Who missed the register over a range (the Absences tab); not logged'` (unchanged if already so).

- [ ] **Step 2: Run to see it fail**

Run: `cd ~/check-in && PGBIN=/opt/homebrew/opt/postgresql@16/bin ./check.sh 2>&1 | tail -30`
Expected: HTTP suite fails at the first `/api/missed` call with 404; permission matrix step fails (doc out of date).

- [ ] **Step 3: Rename the route, update the header, handle null `closed_through`, fix the failed-load copy**

`routes/reports.js`:
- Header comment: `//   GET /api/absences?from=&to=` → `//   GET /api/missed?from=&to=`, and in the paragraph beneath, after "The Absences tab's range:", add the sentence: `Named for the report it shares its query with — "absences" is already the Authorised absences report, and the two mean opposite things.`
- `router.get('/absences', …)` → `router.get('/missed', …)`. Nothing else in the handler changes.

`public/admin.html`:
- In `loadAbsences()`: the fetch URL `/api/absences?from=…` → `/api/missed?from=…`; in the error callback, before `showError(...)`, add `$("absIntro").textContent = "Could not load.";`.
- In `renderAbsences()`: replace
  ```js
  $("absOpen").hidden = !(out.closed_through && out.to > out.closed_through);
  ```
  with
  ```js
  // Never closed at all (a centre whose nightly job has not run yet) is the
  // same fact as "reaches past the last closed night": nothing here is final.
  $("absOpen").hidden = !(out.closed_through === null || out.to > out.closed_through);
  ```

Regenerate: `node tools/gen-permissions-doc.js`.

Docs: apply the spec/plan edits listed under Files. In the spec's Decisions, extend "Honest about an unclosed night" with: `A register that has never been closed (a centre whose nightly job has not run yet) shows the same line.` In the spec's `#absOpen` bullet, change `When \`to > closed_through\`` to `When \`closed_through\` is null or \`to > closed_through\``.

- [ ] **Step 4: Run to see it pass**

Run: `cd ~/check-in && PGBIN=/opt/homebrew/opt/postgresql@16/bin ./check.sh 2>&1 | tail -30`
Expected: all green; `grep -rn "api/absences" routes public test docs/PERMISSIONS.md` returns nothing.

- [ ] **Step 5: Commit**

```bash
git add routes/reports.js public/admin.html test/api.test.js test/permissions.js docs/PERMISSIONS.md docs/superpowers/specs/2026-09-16-absences-by-date-design.md docs/superpowers/plans/2026-09-16-absences-by-date.md
git commit -m "Absences by date: /api/missed (no collision with the Authorised absences report), never-closed hint, audit test"
```

---

### Task 2: One `exportWithReason()` for the three reason-field exports

**Files:**
- Modify: `public/app-common.js` (add the helper just above `mountHistory`; use it inside `mountHistory`'s export submit handler)
- Modify: `public/admin.html` (Absences export submit handler ~line 2295; resident-record `exportBtn.onclick` ~line 1330)

**Interfaces:**
- Produces: `exportWithReason(reasonEl, buildUrl)` → `boolean`. `reasonEl` is the `<input>` holding the reason; `buildUrl(reason)` returns the download URL. Returns `true` when the download was started.

- [ ] **Step 1: Add the helper**

In `public/app-common.js`, directly above the `// A resident's history: every movement and check-in…` comment that precedes `mountHistory`, add:

```js
// Every export asks for a reason and goes on the audit record. The History
// panel, the Absences tab and the record export all do the same three
// things before downloading, so they share them here: refuse an empty
// reason, refuse an offline tablet, then navigate — the server answers with
// Content-Disposition: attachment, so the browser saves the file and the
// page stays put. buildUrl(reason) returns the URL to fetch. Returns true
// when the download was started, so a caller with a fold-out form can close
// it.
function exportWithReason(reasonEl, buildUrl) {
  const reason = reasonEl.value.trim();
  if (!reason) { toast("Give the reason for the export", "err"); reasonEl.focus(); return false; }
  if (typeof Offline !== "undefined" && !Offline.isOnline()) { toast("Exporting needs a connection", "err"); return false; }
  window.location.href = buildUrl(reason);
  toast("Export recorded and downloading", "ok");
  return true;
}
```

- [ ] **Step 2: Use it in `mountHistory`**

Replace the body of `exportForm.addEventListener("submit", (e) => { … });` in `mountHistory` with:

```js
    exportForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const ok = exportWithReason(exportForm.elements.reason,
        (reason) => `/api/residents/${residentId}/history?${query()}&format=csv&reason=${encodeURIComponent(reason)}`);
      if (ok) { exportForm.hidden = true; exportBtn.setAttribute("aria-expanded", "false"); }
    });
```

(The `dismissToastOnInput(exportForm.elements.reason);` line above it stays.)

- [ ] **Step 3: Use it on the Absences tab**

In `public/admin.html`, replace the `absExportForm.addEventListener("submit", …)` body with:

```js
absExportForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const from = $("absFrom").value, to = $("absTo").value;
  if (!from || !to) { toast("Pick two dates first", "err"); return; }
  const ok = exportWithReason(absExportForm.elements.reason,
    (reason) => `/api/reports/missed?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&reason=${encodeURIComponent(reason)}&format=xlsx`);
  if (ok) { absExportForm.hidden = true; absExportBtn.setAttribute("aria-expanded", "false"); }
});
```

Trim the comment above the block so it no longer says "Same reason-field widget as the History export." but "Shared exportWithReason() does the reason/offline/download steps." (one sentence, same voice).

- [ ] **Step 4: Use it on the resident-record export**

Replace the `exportBtn.onclick = () => { … };` body (the one using `$("exReason")` and `/api/residents/${rec.id}/export`) with:

```js
    exportBtn.onclick = () => exportWithReason($("exReason"), (reason) => `/api/residents/${rec.id}/export?reason=${encodeURIComponent(reason)}`);
```

Delete the now-redundant two-line comment about "A plain navigation…" there (the helper carries it).

- [ ] **Step 5: Check**

Run: `cd ~/check-in && PGBIN=/opt/homebrew/opt/postgresql@16/bin ./check.sh 2>&1 | tail -30`
Expected: all green (the parse step evaluates admin.html's inline script and app-common.js). `grep -c "Give the reason for the export" public/admin.html public/app-common.js` should show the string only in the helper, in `reportQuery`/`packQuery` on the Reports tab (two, untouched), and nowhere else.

- [ ] **Step 6: Commit**

```bash
git add public/app-common.js public/admin.html
git commit -m "One exportWithReason() for the History, Absences and record exports"
```

---

## Done when

- `./check.sh` green; `grep -rn "api/absences"` across `routes public test docs/PERMISSIONS.md` is empty.
- Two more commits on `main`, still unpushed; the owner pushes.
