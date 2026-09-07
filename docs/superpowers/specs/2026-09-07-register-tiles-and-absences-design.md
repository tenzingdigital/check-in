# Register tiles and the Absences view — design

Written 7 September 2026 from a screenshot of the live register and the
owner's reaction to it: "the missed days number makes it confusing".

## The problem

The register has three tiles: Not seen, Missed days, Seen today. The
middle one counts every resident who has *ever* had a required-and-missed
closed day. It never clears, because `open_breaches` in
`v_resident_compliance` is a lifetime tally bounded only by retention. On
a centre a few months in, nearly everyone is on it; the number stops
meaning anything; and the list under it is full of cards that say
"SEEN TODAY" in green beside "10 missed days" in red. A guard reads that
as a contradiction. The label makes it worse: the tile reads "177 Missed
days", the caption reads "177 with missed days".

The guard's question is "who has not checked in today". The manager's
question is "who is near the House Rules thresholds": 7 consecutive days,
or 10 days in a rolling 4 weeks (IPAS House Rules 2025, 3.2.14). A
lifetime tally answers neither.

## What changes

### 1. The register (`public/checkin.html`) answers today only

- **Two tiles: Not seen, Seen today.** The Missed days tile, its filter
  (`FILTERS.breach`), its "worst first" ordering (`orderFor`), its filter
  label, its empty-state copy and its tone rule are removed. The register
  still opens on Not seen. `state.filter` takes `all | not_seen | seen`.
- **Cards carry no history.** The meta line is `room · last seen X`. The
  badge in the meta line is shown only when it says something the pill on
  the right does not: "Under 18 — not required", "Not required" (departed),
  "Due today" (past the due-soon hour and not seen), "Not yet seen" (never
  presented on a closed day). Seen-today and expected cards have no badge;
  the pill already says it. The "N missed days" text goes.
- **The card's colour follows today.** The server's `state` still ranks
  `breach_open` above `seen_today` (that precedence is right for the
  manager's report and is not changed in the database). The page derives a
  `view_state` for the card class and badge: `seen_today` if seen today;
  else `never` if no closed presented day; else `due_today` if past the
  due-soon hour; else `expected`; with `exempt` / `not_required` passing
  through. `.card.breach_open` and `.badge.breach_open` styles go; `.never`
  keeps its red edge, `.due_today` its amber. `applyCheckin()` sets
  `seen_today` and re-renders; it no longer special-cases `breach_open`.
- **The detail sheet keeps the history.** It already shows Consecutive
  nights and Absent in N days. Add the thresholds beside them ("3 of 7",
  "8 of 10") from the row's `warn_after_consecutive_nights` and
  `absence_window_limit`, and add "Missed days on record: N" from
  `open_breaches`. The Status fact shows the same `view_state` label as the
  card. The 30-day strip is unchanged.
- **Tile tips** (`data-tip`) on the branch: the Missed days tip goes with
  its tile. The coach card copy already describes two lists and needs no
  change.
- The nightly-close-out banner text stays: close-out still writes the
  missed days the Absences view reads.

### 2. Admin gains an Absences tab (`public/admin.html`)

For supervisors and administrators, beside Residents. The list a manager
reads before writing a letter.

- **Source:** the existing `GET /api/residents?q=&limit=1000&compliance=1`
  (already returns `consecutive_missed`, `absent_in_window`,
  `open_breaches`, `last_seen_on`, `room_label`) and the thresholds already
  on the admin page's `state.settings`. No new endpoint, no migration.
- **Rows:** active residents with `consecutive_missed > 0` or
  `absent_in_window > 0`. Residents whose only misses are older than the
  window are not listed; their total stays on the detail sheet.
- **Order:** consecutive nights desc, then absent in window desc, then name.
- **Columns:** Name, Room (when buildings are on), Consecutive nights
  ("5 of 7"), Absent in last N days ("8 of 10"), Last seen. A cell that has
  reached its figure is marked (the same `bad` tone the tiles use).
- **Copy above the table:** "Facts against the figures in Settings. The
  app never decides that a threshold was met; the decision, and the
  letter, are the manager's." The thresholds in use are stated in the
  same line so nobody has to open Settings to know what "of 7" means.
- **Empty state:** "Nobody has a run of missed nights or a missed day in
  the last N days."
- **Refresh:** on tab open and on the page's existing periodic refresh if
  it has one; otherwise on tab open only.

### 3. Docs

- `README.md`: the "three tiles" sentence and the "Breaches tile" paragraph
  become the two tiles plus the Absences tab.
- `docs/PRODUCT-ROADMAP.md`: a short "Absences view" entry, status built,
  and the note that the IPAS 2025 rules put the consecutive figure at 7
  (the setting's default is still 3 from the earlier policy; a centre sets
  its own).
- `docs/UX-REVIEW.md`: one line under the existing "Missed days" items
  recording the change.

### What does not change

- `v_resident_compliance`, `attention_list()`, `/api/attention`,
  `/api/checkin-summary`, the reports, and every test in
  `test/compliance.sql`. The database keeps reporting counts and states as
  it does; only the two pages read them differently.
- No new personal data. The Absences tab shows numbers the register
  already computes, to people who can already see them.

## Testing

- `test/offline.e2e.test.js` clicks `data-filter="seen"` and `"not_seen"`
  and expects every tile to be un-pressed after a second tap; it must still
  pass with two tiles. Any assertion on `statOpenBreach` or
  `data-filter="breach"` is removed.
- Add a browser assertion in the same file, or a static one in `check.sh`'s
  parse step, that `checkin.html` contains no `data-filter="breach"` and no
  `statOpenBreach`, so the tile cannot come back by accident.
- Add an HTTP-level assertion in `test/api.test.js` that the residents list
  with `compliance=1` still carries `consecutive_missed` and
  `absent_in_window` (the Absences tab's contract). Line ~724 already
  asserts the values; extend it to the presence of the fields on a list
  row, not only the single-resident row.
- Manual: on a phone, the register opens on Not seen with two tiles; a
  seen-today card shows no red; Admin → Absences lists the seeded
  Brennan/Haddad-style rows worst first with "of N" figures.

## Branch

Built on `claude/security-hardening-roadmap-k7vtwv`, the working branch.
It reaches the phone when that branch merges to main, which is the same
event that puts visitors, the help site and the CheckSteady rename live.
