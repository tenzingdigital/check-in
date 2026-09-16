# Absences by date — the Absences tab over a range, and "yesterday" in one tap — design

Written 16 September 2026 from the owner's ask: "B2, and also want to just
see yesterday's absence" — clarified as **who missed yesterday's register**
(`daily_compliance`), not who was off site at midnight (that is the
"Absent overnight" report, which already takes a range).

Today the Absences tab is a live list: every active resident with a
current run of missed nights or a miss inside the rolling window, counted
against the figures in Settings. It answers "who is in trouble now". It
cannot answer "who missed last night" or "who missed anything last week",
and the only thing that can — the Daily register report — lists everyone,
presented or not, needs a reason to look, and lives on Reports.

This change gives the tab a date range. The range is the filter.

## Decisions

- **The fact is a missed register day.** A row in `daily_compliance` with
  `required and not presented and closed_at is not null`. Nothing else is
  consulted: authorised absence days are written `required = false` by
  `close_out_compliance_days()`, and children are never required, so both
  fall out with no extra logic. **Today is never a missed day** — the row
  is open until the 00:30 UTC job closes it — so the range ends yesterday
  by default and an open day contributes nothing.
- **One row per resident, not per night.** For "Yesterday" the two are the
  same; for 7 or 28 nights a manager wants the count, not to count rows.
  The dates are still listed beneath the count.
- **"3 of 4", not "3 of 7".** The denominator is that resident's closed
  required days in the range, so a resident who arrived on Thursday is not
  read as having missed Monday to Wednesday.
- **Active residents only**, as the tab is today. A departed resident's
  history is on the Daily register report.
- **Looking is not audited; exporting is.** `GET /api/missed` writes no
  audit row, like the resident list the tab reads now. The Excel button
  goes through the reports route as a new report, so it asks for a reason
  and is written by `note_report()` like every other export.
- **The export covers the whole range, not the search-filtered screen.**
  The audit record says "Missed register, 9–15 September"; a sheet that
  silently left people out because a name had been typed in the filter
  box would make that record misleading. The search box is a screen
  convenience only.
- **Honest about an unclosed night.** The API says how far the register is
  closed; the tab says so when the chosen range reaches past it, instead
  of showing an empty table that reads as "nobody missed". A register that
  has never been closed (a centre whose nightly job has not run yet) shows
  the same line.
- **No migration.** Everything here is a query over tables that exist.

## Data

One SQL string, `MISSED_SQL`, defined once in `routes/reports.js` and used
by the report and by the tab endpoint. Parameters `$1 = from`, `$2 = to`
(inclusive dates). Per row:

| column | source |
| --- | --- |
| `id`, `ref`, `full_name` | `residents` / `v_resident_status`, active only |
| `building`, `room` | `v_resident_room` |
| `nights_missed` | count of `required and not presented and closed_at is not null` in range |
| `nights_required` | count of `required and closed_at is not null` in range |
| `missed_dates` | `array_agg(compliance_date order by compliance_date)` of the missed days |
| `consecutive_missed`, `absent_in_window`, `last_seen_on`, `seen_today` | `v_resident_compliance` |
| `last_breach_kind`, `last_breach_on` | latest `breach_reports` row, as `/api/residents` already computes it; the tab endpoint reshapes them to `last_breach: {kind, issued_on}` (or `null`) to match the resident list, the report keeps them as two columns |

Only residents with `nights_missed > 0` are returned. Order:
`nights_missed desc, consecutive_missed desc, last_name, first_name`.

`closed_through` = `max(compliance_date) from daily_compliance where
closed_at is not null` — one scalar beside the rows.

## API

**`GET /api/missed?from=YYYY-MM-DD&to=YYYY-MM-DD`** — supervisors and
admins only; a guard or kiosk session gets 403 (the same
`req.session.role` check `routes/residents.js` uses for supervisor-only
actions). `from` and `to` are validated with the reports route's
`dateParam`; `to` defaults to `from`; `to < from` is 400; more than 366
days is 400. Response:

```json
{ "from": "2026-09-09", "to": "2026-09-15", "closed_through": "2026-09-15",
  "rows": [ { "id": "…", "ref": 12, "full_name": "…", "building": "Manor", "room": "B4",
              "nights_missed": 3, "nights_required": 7,
              "missed_dates": ["2026-09-09", "2026-09-10", "2026-09-13"],
              "consecutive_missed": 2, "absent_in_window": 4,
              "last_seen_on": "2026-09-14", "seen_today": false,
              "last_breach": { "kind": "house_rules", "issued_on": "2026-09-01" } } ] }
```

**Report `missed` — "Missed register"** — added to `REPORTS`, `ranged:
true`, the same `MISSED_SQL` with `missed_dates` flattened to a
comma-separated `dates` text column (csv/xlsx cannot carry an array).
Inherits everything the route already does: the reason (required, ≤200
chars), `note_report()`, json/csv/xlsx, the 366-day cap, the supervisor
403. It appears on the Reports tab automatically because that list is
read from `GET /api/reports`. It is **not** added to the inspection pack's
fixed section list.

## The Absences tab

Above the existing search box:

- **Chips: Yesterday · 7 nights · 28 nights**, then From / To date inputs.
  `mountRangePresets(container, fromEl, toEl, onPick, presets)` in
  `app-common.js` gains an optional fifth argument, the list of
  `[key, label]` pairs, defaulting to the four it draws now so the Log and
  History callers are untouched. `presetRange` gains `7nights` and
  `28nights`: both end yesterday and start 6 / 27 days before that.
- **Default: 7 nights**, pressed on load. Picking a chip or editing a date
  reloads. Typing in the search box filters the loaded rows client-side,
  as now, without reloading.
- **Intro line:** the range in words, then the thresholds sentence that is
  there today. E.g. "Missed the register between Tue 9 and Mon 15 Sep.
  Facts against the figures in Settings: 3 consecutive nights, 10 days in
  28. The app never decides that a threshold was met…"
- **Table columns:** Name · Room (when buildings are on) · **Missed** ·
  Consecutive nights · Absent in 28 days · Last seen · Today · Breach
  report. "Missed" shows `3 of 7` with the dates in small text beneath
  (`Tue 9, Wed 10, Sat 13`, via `dayLabel`). The other columns are the
  ones drawn today, unchanged.
- **Empty states:** "Nobody missed the register between Tue 9 and Mon 15
  Sep." When `closed_through` is null or `to > closed_through`: an extra
  line "Last night's register is not closed yet — it closes overnight."
  shown above the table (or the empty message) whenever the range includes
  an unclosed day.
- **Excel:** the inline reason field + button the History panel uses
  (`Reason for the export`, `maxlength=200`, required), labelled "Excel".
  Navigates to `/api/reports/missed?from&to&reason&format=xlsx`; toast
  "Export recorded and downloading". Drawn for every user who can see the
  tab (all of them are supervisors or admins).

## Out of scope

- Departed residents in the range.
- A per-night log view (approach B) — the Daily register report is that.
- Adding the report to the inspection pack.
- Any change to the thresholds, the nightly job or `daily_compliance`.
- Site-timezone-aware presets: `presetRange` uses the browser's date, as
  the Log tab does today.

## Testing

`test/api.test.js`, one describe block, fixtures closed out with
`close_out_compliance_days()` as the existing compliance tests do:

- A resident who missed yesterday appears with `nights_missed 1`,
  `nights_required 1`, `missed_dates [yesterday]`.
- A presented day and an authorised-absence day are not counted, and the
  authorised day is not in `nights_required` either.
- Today's open row contributes nothing; `closed_through` is yesterday.
- Two residents sort most-missed first; a resident with no misses in the
  range is absent from `rows` even if they missed before it.
- A departed resident with misses in the range is not listed.
- A guard gets 403; no reason is needed for the tab endpoint.
- `to < from` and a 400-day range are 400.
- Report `missed`: 400 without a reason, 200 as json with the same rows and
  a `dates` string, 200 as xlsx with the spreadsheet content-type, and a
  `admin_audit` row from `note_report()` afterwards.

`test/permissions.js` gains the row `GET /api/missed` → SUPERVISOR, so
`docs/PERMISSIONS.md` regenerates with it.

`./check.sh` green before deploy.

## Docs

- `public/help.html`: one line under Absences — the range, Yesterday, and
  that Excel asks for a reason.
- `docs/PRODUCT-ROADMAP.md`: the Absences section's status line.
