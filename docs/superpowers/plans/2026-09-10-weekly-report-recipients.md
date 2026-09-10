# Weekly report recipients on the staff record — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Recipients of the Sunday Weekly register update become a tick on a staff record rather than a free-text list of addresses, and the email carries counts and a link instead of resident names.

**Architecture:** `profiles.weekly_report` replaces `app_settings.weekly_report_recipients`. The job and the send-now route read the flag, joined to `auth.users` for the address. `lib/weeklyReport.js` composes a counts-and-link message; the named detail stays in the app behind the existing report.

**Tech Stack:** Express 4 on Node 22, PostgreSQL 16, plain HTML/JS front ends, `test/api.test.js` run by `./check.sh`.

## Global Constraints

- Branch `claude/security-hardening-roadmap-k7vtwv`, currently equal to `main` at `c85d6e8`. Fetch and merge `origin/main` before starting. Never push to main.
- Tests: `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./check.sh` must pass in full before each commit.
- Any migration requires `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./tools/gen-tenant-template.sh` and `tenant/template.sql` committed with it.
- New routes must be added to `test/permissions.js` and `docs/PERMISSIONS.md` regenerated, or the matrix layer of `check.sh` fails.
- The email must contain NO resident name, room, date of birth, identity number or child marker. Counts and a link only. This is the whole point of the change.
- Copy: British English, no exclamation marks. The app records facts and never decides.
- Commit trailer:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Vr5PKm4KnWKvtjheJzL74A
  ```

## Context the implementer needs

Shipped this afternoon and now being changed: `app_settings.weekly_report_email` (a site switch, keep it) and `app_settings.weekly_report_recipients` (comma-separated addresses, remove it). The Sunday job `weeklyRegister()` in `jobs.js` and `POST /api/settings/weekly-report/send` both read the recipients column and send the full report text from `lib/weeklyReport.js` `compose()`.

The feature has never sent anything: the Sunday job only fires on Sundays and production has no mail credentials. So the recipients column is empty everywhere and dropping it needs no data migration.

`profiles` is `(id, full_name, role, active, created_at)`; addresses live on `auth.users`. Staff routes follow the pattern `POST /api/staff/:id/active` and `POST /api/staff/:id/role`.

---

### Task 1: The flag, the route, and the staff screen

**Files:**
- Create: `migrations/037_weekly_report_recipients.sql`
- Modify: `routes/staff.js`, `routes/settings.js`, `public/admin.html`, `test/permissions.js`, `docs/PERMISSIONS.md`, `test/api.test.js`
- Regenerate: `tenant/template.sql`

**Interfaces produced:** `profiles.weekly_report boolean not null default false`; `POST /api/staff/:id/weekly-report { on: boolean }` (admins only) returning the updated staff row; `GET /api/staff` rows carry `weekly_report`.

- [ ] **Step 1: Write the failing tests** in `test/api.test.js`, in a new section after the absence-windows section. Cover: the flag defaults false on a new staff member; an admin can set and clear it; a supervisor is refused with 403; setting it on a guard is refused with 400 (only supervisors and admins may receive a report they are allowed to run); demoting a ticked supervisor to guard clears the flag; `GET /api/staff` exposes it. Use the existing admin client pattern in that file.

- [ ] **Step 2: Run the tests to verify they fail.** `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./test/api.sh`

- [ ] **Step 3: Write migration 037.** Add `weekly_report boolean not null default false` to `public.profiles` with a comment explaining it marks who receives the Sunday email and that only supervisors and admins may carry it. Drop `app_settings.weekly_report_recipients` (with a comment recording that it shipped on 10 September, was never configured because production had no mail credentials, and is replaced by the per-staff flag). Add a database-level guarantee that a guard cannot carry the flag: either a check constraint spanning role and weekly_report, or a trigger that clears the flag when a role changes to guard. Prefer the check constraint plus a trigger that clears rather than refuses on demotion, so demoting someone never fails. Follow the file-header style of migrations 035 and 036.

- [ ] **Step 4: The route.** `POST /api/staff/:id/weekly-report` in `routes/staff.js`, admins only, mirroring `POST /:id/active`. Reject with a plain 400 when the target is a guard. Add `weekly_report` to whatever `GET /api/staff` selects.

- [ ] **Step 5: Remove the old setting.** Delete `weekly_report_recipients` from `COLUMNS` in `routes/settings.js` and delete the now-unused `emails` validation kind if nothing else uses it. Keep `weekly_report_email`.

- [ ] **Step 6: The staff screen.** In `public/admin.html`, add a tick per staff row in the Staff tab, shown only for supervisors and admins, labelled so it is obvious what it does, e.g. "Gets the Sunday report". Wire it to the new route. Remove the Recipients field from the Settings tab and reword the switch to say recipients are chosen on the staff record. Keep the "Send last week's now" button.

- [ ] **Step 7: Permission matrix.** Add the new route to `test/permissions.js` and regenerate `docs/PERMISSIONS.md`.

- [ ] **Step 8: Regenerate the template, run `./check.sh` in full, commit.**

---

### Task 2: Counts and a link, not names

**Files:**
- Modify: `lib/weeklyReport.js`, `jobs.js`, `routes/settings.js`, `render.yaml`, `test/api.test.js`

**Interfaces produced:** `compose({ siteName, from, to, rows, link })` returning `{ subject, text }` containing counts and the link but no resident detail; `recipients()` resolving the ticked staff.

- [ ] **Step 1: Write the failing tests.** `compose()` output must contain the four section counts and the link, and must NOT contain any resident name present in the rows it was given — assert that explicitly, since it is the security property. The job and the send-now route must resolve recipients from the ticked staff and send to their addresses. Keep the existing idempotence test working.

- [ ] **Step 2: Run the tests to verify they fail.**

- [ ] **Step 3: Rewrite `compose()`.** Subject stays as it is. Body: the site name and the week, then a line per section giving the count, e.g. "Resident absences: 6 (2 not approved by management)". Then the link, then one sentence saying the named detail is in the app under Admin → Reports and that it can be downloaded as a spreadsheet. Then the existing paragraph about nights counted at midnight. No resident data anywhere. Take `link` as a parameter so the caller decides how it is built.

- [ ] **Step 4: Resolve recipients from staff.** Add a shared helper that selects active staff with `weekly_report` true, joined to `auth.users` for the address, and use it in both `weeklyRegister()` in `jobs.js` and the send-now route. The job runs as owner and the route under the caller's identity, so the helper takes a client rather than opening its own.

- [ ] **Step 5: Build the link.** The cron process has no request, so it must read `PUBLIC_URL` from the environment. Add `PUBLIC_URL` to the `hut-nightly` service in `render.yaml`, and correct the existing value on `hut-check-in` from `https://app.checksteady.ie` to `https://hut-check-in.onrender.com`. The `.ie` domain was NEVER REGISTERED and is simply wrong; the owner bought `checksteady.com`, so the comment must record that this value becomes `https://app.checksteady.com` once the custom domain is wired, and must not mention `.ie` at all. Grep the repo for other stale `checksteady.ie` references while you are there and list any you find in your report without fixing them. When `PUBLIC_URL` is unset, the email must still send, with the link omitted and a line naming where to find the report instead — never a broken or relative link.

- [ ] **Step 6: The send-now route** uses the same composer and recipients, and its response still reports how many were sent so the existing toast stays honest.

- [ ] **Step 7: Run `./check.sh` in full, commit.**

---

### Task 3: Guide, documents and the agreement draft

**Files:**
- Modify: `public/help.html`, `README.md`, `docs/PRODUCT-ROADMAP.md`, `docs/GDPR.md`, `docs/legal/DPA-2026-09-10-DRAFT.md`

- [ ] **Step 1: The guide.** Update the "Send the Sunday report" recipe: recipients are ticked on the staff record under Admin → Staff, not typed into Settings. Say plainly that the email carries counts and a link, and that the names are in the app. Match the surrounding markup exactly.

- [ ] **Step 2: README and roadmap.** Correct the description of the Sunday email in both. Add a short note to the Stage 2f block recording the change and why: recipients are always known staff, so a departing colleague stops receiving resident data automatically, and no resident detail leaves by email.

- [ ] **Step 3: `docs/GDPR.md`.** Rewrite the Sunday-report paragraph in the "What leaves by email" passage. It now carries counts and a link only, to the centre's own ticked staff. Keep the House Rules paragraph as it is, since that email still carries names and rooms. Make sure the passage as a whole remains true.

- [ ] **Step 4: `docs/legal/DPA-2026-09-10-DRAFT.md`.** Annex III described recipients as addresses an administrator configures which need not belong to the centre. That is no longer true: correct it to the centre's own staff, and say the Sunday message carries no resident data. Update the "What changed in this version" note. Leave the issued `DPA-2026-09-03.md` untouched.

- [ ] **Step 5: Run `./check.sh`, commit.**

---

### Task 4: Final check

- [ ] Run `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./check.sh` in full and confirm every layer passes.
- [ ] Push the branch only. Do not push to main; the owner merges.
