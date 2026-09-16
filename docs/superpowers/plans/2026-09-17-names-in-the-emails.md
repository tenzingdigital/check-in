# Names in the Emails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The nightly email names the residents behind each of its four counts in its own body, and the Sunday email attaches the Word document by default — nothing the manager needs is behind a login any more.

**Architecture:** The owner (Slaney Manor, 16 Sep 2026) ruled: "include the names in the emails, not behind a login." `jobs.js nightlyEmail()` already reads the four counts as the owner; it now reads the rows behind them (base tables, as its House Rules figures query already does — the owner bypasses RLS, so no new SQL function is needed) and hands `lib/nightlyEmail.js compose()` an array of lines per section instead of a count. `lib/mail.js layout()` grows a `sections` block that lists lines under a heading. Migration 055 flips `weekly_report_attach_document` to default true and backfills every site. Copy across the app, docs and marketing site that promised "counts only / behind the login" is corrected.

**Tech Stack:** Node 22, Express, Postgres 16, `node:test` (`test/api.test.js`), `test/compliance.sql`, `./check.sh`.

## Global Constraints

- Commit each task separately; never push. Fetch is done; work on `main` as before (the owner's standing ruling for this repo).
- `./check.sh` needs `PGBIN=/opt/homebrew/opt/postgresql@16/bin`; it starts a scratch cluster on port 54329 — never run two at once. `test/sql.sh` alone runs only the DB suite (fast).
- Migrations hard-code `public.`; a new COLUMN DEFAULT / backfill on a per-tenant table gets the `do $$ … like 't\_%' escape '\' …$$` loop (052 pattern). After any migration change: `./tools/gen-tenant-template.sh` and commit `tenant/template.sql`.
- Every email part (text and html) is built from escaped values; `layout()` escapes with `escapeHtml` — new markup must go through it too.
- Times in the email are site-local (`app_settings.local_timezone`), `HH24:MI`; ages are whole years.
- The four section labels, their fixed order, the links, the subject format (`<site>: tonight — N to look at` / `— nothing to report`), the Sunday nil email, the once-a-night guard and job_runs results do not change.
- Migrations 041 and 052 are deployed and must not be edited; 053, 054 and 055 are not deployed and may be.
- Wording: "the In & out register", "House Rules figures", "Children on site without a guardian". Never "the Department" on the marketing site; site copy rules in `tools/check-site.py`.

---

### Task 1: The nightly email names its rows; the Sunday document attaches by default

**Files:**
- Modify: `lib/mail.js` (`layout()` — add `sections`)
- Modify: `lib/nightlyEmail.js` (`compose()` takes `items` per section, derives counts)
- Modify: `jobs.js` (`nightlyEmail()` — row queries; comments at ~160 and ~358)
- Create: `migrations/055_names_in_email.sql`
- Regenerate: `tenant/template.sql`
- Test: `test/api.test.js` (tests at ~1927 "nightlyEmail.compose …", ~3347 "the nightly email is one message …", ~2905–2945 send-now, ~3005–3026 weekly job), `test/compliance.sql`

**Interfaces:**
- Produces: `layout({ …, sections })` where `sections = [{ label, value, lines: [string] }]`, rendered after `rows` and before the CTA.
- Produces: `nightly.compose({ siteName, night, items, links, unsubscribe })` where `items = { guardian_gaps: [string], children_away: [string], conflicts: [string], at_figures: [string] }`; `counts` is no longer accepted (a caller passing `counts` alone gets a nil email — remove that path, don't support both).

- [ ] **Step 1: Flip the compose test to expect lines**

Rewrite the test at ~1927 (title: `nightlyEmail.compose lists each section's lines in a fixed order with its link; the subject sums the lines or says nothing to report`). Pass:

```js
const items = {
  guardian_gaps: ["Kovalenko family · Main · 12 — Sofia Kovalenko (6), Danylo Kovalenko (9); 1 adult signed out, first at 19:42", "Brennan family · Main · 4 — Ava Brennan (3); 2 adults signed out, first at 21:05"],
  children_away: ["Amina Al-Sayed (7) · Annex · 2 — off site at midnight, no authorised absence"],
  conflicts: ["Tomasz Nowak · Main · 8 — checked in 21:10, the In & out register had him out since 18:30", "Lee Lonerfixture — checked in 09:02, no sign-in on record", "Pat Famfixture · Main · 1 — checked in 22:40, the In & out register had them out since 20:00"],
  at_figures: [],
};
```

Assert: subject `Slaney: tonight — 6 to look at`; in both `out.text` and `out.html` every label appears in the fixed order and every link is carried; every line string appears in the text part and (HTML-escaped where needed — none of these need it) in the html part; text part has, for the first section, exactly:

```
Children on site without a guardian: 2 — https://hut-check-in.onrender.com/admin.html#report-guardian-gaps
  - Kovalenko family · Main · 12 — Sofia Kovalenko (6), Danylo Kovalenko (9); 1 adult signed out, first at 19:42
  - Brennan family · Main · 4 — Ava Brennan (3); 2 adults signed out, first at 21:05
```

and for the empty fourth: `At the House Rules figures: 0 — https://hut-check-in.onrender.com/admin.html#absences` with no `  - ` line under it. Assert `out.html` matches `/Open Children on site without a guardian/` and `/It names residents — treat it as you would the register itself\./` and does NOT match `/counts only/`. Keep the `later` and `nil` sub-cases (pass `items` with empty arrays / three conflict lines); the nil email keeps its existing wording. Add one escaping case: an item `"O'Brien <family> & co"` must appear in html as `O&#39;Brien &lt;family&gt; &amp; co` (check `escapeHtml` in `lib/mail.js` for the exact apostrophe entity it emits and assert that).

- [ ] **Step 2: Run it to see it fail**

Run: `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./check.sh 2>&1 | grep -A3 "nightlyEmail.compose"` — expected: fails (compose still takes `counts`; no lines).

- [ ] **Step 3: `layout()` sections**

In `lib/mail.js layout()`, add `sections = []` to the destructured options and render, after the `rows` table and before the CTA, for each section with `lines.length`:

```js
${sections.filter((s) => s.lines && s.lines.length).map((s) => `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${LINE};border-radius:10px;margin:0 0 18px;">
        <tr>
          <td style="padding:11px 16px;font:700 15px/1.4 ${FONT};color:${INK};">${escapeHtml(s.label)}</td>
          <td align="right" valign="top" style="padding:11px 16px 11px 8px;font:700 15px/1.4 ${FONT};color:${INK};">${escapeHtml(s.value)}</td>
        </tr>${s.lines.map((l) => `
        <tr><td colspan="2" style="padding:9px 16px;border-top:1px solid ${LINE};font:15px/1.45 ${FONT};color:${INK};">${escapeHtml(l)}</td></tr>`).join('')}
      </table>`).join('')}
```

Update the comment above `layout()` (if there is one describing its parts) to list `sections`.

- [ ] **Step 4: `compose()` takes items**

Rewrite `lib/nightlyEmail.js`: header comment now says the email names residents in its body (the owner's ruling of 16 Sep 2026, reversing ec793da for this email: the manager reads it at breakfast and must not need a login to know which family), the four sections each a heading, the lines, and the link. `compose({ siteName, night, items = {}, links = {}, unsubscribe })`; `rows = SECTIONS.map(s => ({ ...s, lines: Array.isArray(items[s.count]) ? items[s.count].map(String) : [], href }))`, `n = lines.length`, `total` = sum. Text part per section:

```
`${r.label}: ${r.n}${r.href ? ` — ${r.href}` : ''}` + r.lines.map((l) => `\n  - ${l}`).join('')
```

HTML: `rows` stays (the four counts), then `sections: rows.map((r) => ({ label: r.label, value: String(r.n), lines: r.lines }))`, `footer: 'It names residents — treat it as you would the register itself.'`. Summary sentence when total > 0: `${total} thing${…} to look at from the register at midnight, named below. Each link opens the page with the full record.` Nil sentence unchanged. Rename the SECTIONS key `count` → `key` if you like, but keep the four keys `guardian_gaps`, `children_away`, `conflicts`, `at_figures`.

- [ ] **Step 5: Run the compose test — passes**

Run: `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./check.sh 2>&1 | grep -B1 -A3 "nightlyEmail.compose"`. Expected: PASS (other suites may still fail on `jobs.js`; that's Step 6).

- [ ] **Step 6: Flip the job test**

In the test at ~3347 (retitle: `the nightly email names the residents behind its four counts, with the links, to the ticked staff; off, or nothing to report on a weekday, nothing goes`): keep every existing assertion except the "no resident is named" block, which becomes:

```js
for (const part of [sent[0].text, sent[0].html]) {
  assert.match(part, /Gapfixture family/, "the guardian-gap household is named");
  assert.match(part, /Missing Nights/, "the resident at a House Rules figure is named");
}
assert.match(sent[0].text, /^  - Gapfixture family.* — .*\(\d+\)/m, "the household line carries the children with ages");
assert.match(sent[0].text, /^  - Missing Nights.* — 3 nights in a row missed/m, "the figures line says which figure");
assert.match(sent[0].html, /It names residents — treat it as you would the register itself\./);
```

(Check how the Gapfixture household was seeded earlier in the file — the child's name and the parent's — and assert on the child name in the guardian-gap line too. The seeded resident "Missing Nights" has 3 consecutive missed days and `warn_after_consecutive_nights` is whatever the fixture settings say — read `app_settings` in the test and build the expected phrase from it rather than hard-coding 3 if the setting is not 3.)

- [ ] **Step 7: The row queries in `jobs.js`**

Replace the four count reads in `nightlyEmail()` with row reads, all in one place, as the owner on base tables (the owner is the table owner and bypasses RLS — the figures query already does this). Define once at the top of the function body a room-label fragment used by each query:

```js
// Room label as v_resident_room writes it (016/018): the view filters on
// is_staff(), which the owner is not, so the label is spelled out here.
const ROOM = `(select b.name || case when rm.floor <> '' then ' · ' || rm.floor else '' end || ' · ' || rm.number
                 from rooms rm join buildings b on b.id = rm.building_id where rm.id = r.room_id)`;
```

Queries (`$1` = `s.night`; `tz` and `adult` from a CTE `s as (select local_timezone as tz, adult_age_years as adult from app_settings where id)`):

1. Guardian gaps — from `overnight_guardian_gaps g where g.night = $1::date`: `household` = `string_agg(distinct btrim(last_name), ' / ')` of the household's active members `|| ' family'`; `room` = `string_agg(distinct <room label>, ', ')` over the household's active members with a room; `children` = `string_agg(first last (age), ', ' order by date_of_birth)` of active under-age members (as `REPORTS['guardian-gaps']` in `routes/reports.js` does); `g.guardians_out`; `first_out` = `to_char(g.first_out_at at time zone s.tz, 'HH24:MI')`. Order by household. Line:
   `${household}${room ? ' · ' + room : ''} — ${children || 'children on site'}; ${guardians_out} adult${guardians_out === 1 ? '' : 's'} signed out${first_out ? ', first at ' + first_out : ''}`
2. Children away — the predicate of `overnight_safeguarding_count()` (041) spelled out: `overnight_absences o join residents r on r.id = o.resident_id where o.night = $1::date and r.date_of_birth > (o.night - make_interval(years => s.adult))::date and not absence_authorised(o.resident_id, o.night)`; select name, `date_part('year', age(o.night, r.date_of_birth))::int as age`, room. Order by last_name, first_name. Line:
   `${name} (${age})${room ? ' · ' + room : ''} — off site at midnight, no authorised absence`
3. Conflicts — the predicate of `checkin_conflict_count()` (054) spelled out (the lateral latest gate event at or before the check-in; `(e.occurred_at at time zone s.tz)::date = $1::date`; `g.kind is null or g.kind = 'out'`); select name, room, `to_char(e.occurred_at at time zone s.tz, 'HH24:MI') as at`, `g.kind`, `to_char(g.occurred_at at time zone s.tz, 'HH24:MI') as gate_at`. Order by e.occurred_at. Line:
   `${name}${room ? ' · ' + room : ''} — checked in ${at}, ${kind ? 'the In & out register had them out since ' + gate_at : 'no sign-in on record'}`
4. At the figures — the existing query, extended to also select name, room, and to order by last_name, first_name. Line: `${name}${room ? ' · ' + room : ''} — ` followed by the parts that apply, joined with `; `: `${consecutive_missed} nights in a row missed` when `>= s.nights`, `${absent_in_window} missed in the last ${s.win_days} nights` when `>= s.win_limit`.

`items = { guardian_gaps: [...], children_away: [...], conflicts: [...], at_figures: [...] }`; `total` = sum of lengths; everything after (nothing-to-report gate, links, per-recipient compose with `items`, job_runs result string) unchanged. Drop the calls to `overnight_safeguarding_count()` and `checkin_conflict_count()` from this function (the functions stay; tests still call them). Update the block comment above `nightlyEmail()` (~358): "each a heading, the names behind it, and a link" and why (the owner's ruling). Update the weekly comment at ~160 to say the body carries counts and a link and, by default since 055, the Word document attached.

- [ ] **Step 8: Run the job test — passes**

Run: `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./check.sh 2>&1 | grep -B1 -A6 "the nightly email names"`. Expected: PASS.

- [ ] **Step 9: Migration 055 and its test**

Create `migrations/055_names_in_email.sql`:

```sql
-- 055_names_in_email.sql — the Sunday document attaches by default.
--
-- 16 September 2026, Slaney Manor: the manager reads the nightly email
-- and the Sunday return on her phone and does not want the names behind a
-- login. The nightly email names its rows from this deploy (jobs.js,
-- lib/nightlyEmail.js — no schema for that); the Sunday email's Word
-- document (052) becomes the default rather than a switch a centre has to
-- find. The switch stays: a centre that wants counts only can still turn
-- it off under Settings.
alter table public.app_settings alter column weekly_report_attach_document set default true;
update public.app_settings set weekly_report_attach_document = true;
-- Existing tenant schemas, as 052 did: the template cannot patch a default
-- onto an app_settings already provisioned.
do $$
declare s text;
begin
  for s in select nspname from pg_namespace where nspname like 't\_%' escape '\' loop
    execute format('alter table %I.app_settings alter column weekly_report_attach_document set default true', s);
    execute format('update %I.app_settings set weekly_report_attach_document = true', s);
  end loop;
end $$;
```

In `test/compliance.sql`, next to the 052 assertions (grep `weekly_report_attach_document`; if none, next to the 054 `nightly_email` ones), add: `select pg_temp.expect('055: the Sunday document attaches by default', (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'app_settings' and column_name = 'weekly_report_attach_document') = 'true');` (match the file's `expect` signature). Then in `test/api.test.js`: the send-now test (~2905–2928, "with the switch off, nothing is attached") and the weekly-job test (~3005–3020, "the job attaches nothing while the switch is off") both assume the default is off — each must set `weekly_report_attach_document = false` explicitly (PATCH or owner update) before the first send, and leave the default-on state restored (set it back to `true`) at the end instead of `false`. Regenerate the template: `./tools/gen-tenant-template.sh`.

- [ ] **Step 10: Full run**

Run: `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./check.sh 2>&1 | tail -15`. Expected: all suites green; note the DB/HTTP assertion counts for the report.

- [ ] **Step 11: Commit**

```bash
git add lib/mail.js lib/nightlyEmail.js jobs.js migrations/055_names_in_email.sql tenant/template.sql test/api.test.js test/compliance.sql
git commit -m "The nightly email names its rows; the Sunday document attaches by default (055)"
```

---

### Task 2: Every line of copy that promised "counts only" now says names

**Files:**
- Modify: `public/help.html` (~366, ~382), `public/admin.html` (~585 `stNightly`, ~589 `stWeeklyDoc`), `docs/GDPR.md` (new "Updated 17 September 2026" paragraph after the 053–054 one; "What leaves by email" ~271–300; ~327; processor table ~372), `README.md` (~578–587; ~800–805), `docs/PRODUCT-ROADMAP.md` (~294), `docs/KNOWN-ISSUES.md` (the 054 paragraph, if it says counts only), `tools/build-site.py` (~446, ~677, ~698) + regenerated `site/`, `migrations/054_guardian_alert_and_conflicts.sql` (header lines 13–19, the table comment at 45), `lib/safeguardingAlert.js` (~10, one line: superseded by the nightly email, which names residents), `lib/weeklyReport.js` (~5, ~51: the body is counts and a link; the document, attached by default since 055, has the names).
- Test: `python3 tools/check-site.py` must pass; `./check.sh` unchanged (copy only) — run `node --test test/api.test.js` is not needed; run `test/sql.sh` after editing 054 to confirm it still applies.

**Interfaces:** none.

- [ ] **Step 1: Read each location and rewrite**

The facts to state, in each file's own register:
- The nightly email (054, `nightly_email` on) goes to the staff ticked "Gets the nightly email" and names, in its body, each household with children on site and no guardian (family, room, children with ages, adults signed out and the first sign-out time), each child away overnight with no authorised absence, each check-in recorded while the In & out register had the person out (time and last gate movement), and each resident at the House Rules figures (which figure). Links to the reports stay. Sent on any night there is something, and every Sunday regardless.
- The Sunday email carries counts and a link in its body and, by default (055), the Weekly Register Update attached as a Word document naming residents; a centre can untick "Attach it as a Word document" under Settings.
- Why: the owner's ruling of 16 September 2026 — the manager reads these on her phone; the register's own audience are the centre's own supervisors and admins with a login, and a name in an email to them is the same disclosure as the report they open. GDPR.md should say this plainly and note the Resend processor row now carries resident names (nightly email and Sunday attachment) to the centre's own ticked staff only.
- Settings copy: `stNightly` — "…names the residents behind each count"; `stWeeklyDoc` — "Attach it as a Word document. On by default. The document names residents and rooms…".
- Help copy at 382: replace "Counts only; the names are in the app behind each link" with the names-in-body sentence; keep the report-link sentence.
- 054 header lines 13–19: the section is "the households, named, with a link to the report for that night"; table comment: "…Counts and a time; the household and children are named in the nightly email and the report."
- `tools/build-site.py` 446 (feature blurb), 677 (FAQ: "the Sunday email carries counts in its body and, by default, the update attached as a Word document naming residents; the nightly email to your ticked staff names the residents behind each of its four checks"), 698 (the "Counts only, unless you choose otherwise" tile → retitle "Names go to your own staff only" and rewrite the paragraph). Then `python3 tools/build-site.py && python3 tools/check-site.py`.

- [ ] **Step 2: Verify**

Run: `grep -rn -i -E "never a name|counts and a link only|counts only|behind the login|behind your login" lib routes public docs/GDPR.md README.md tools jobs.js migrations/05[3-5]*.sql` — expected: only history lines (GDPR.md's dated "Updated 10 September" paragraph, `lib/mail.js` default footer string, `lib/weeklyReport.js` describing the body) remain, and each remaining hit reads true today. `python3 tools/check-site.py` passes. `PGBIN=/opt/homebrew/opt/postgresql@16/bin test/sql.sh` green.

- [ ] **Step 3: Commit**

```bash
git add -A public docs README.md tools site migrations/054_guardian_alert_and_conflicts.sql lib/safeguardingAlert.js lib/weeklyReport.js
git commit -m "Copy: the nightly email and the Sunday document name residents; nothing is behind the login"
```
