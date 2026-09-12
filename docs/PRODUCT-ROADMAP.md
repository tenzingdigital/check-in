# Product roadmap — from one hut to many centres

Written 4 September 2026 from Donal Flannery's review (Flannery Partners,
environmental health, safety and events) of the Slaney Manor trial, and from
what the product already is. It is a working plan: each stage is built,
tested and deployed on its own, and its status line is kept current here.

**Assumptions, stated so they can be corrected.** No centre has electronic
access control today, so the gate app is the access control. Slaney Manor
has three buildings (Castle, Courtyard, Manor House); other centres range
from one building to several. Centres hold evacuation needs on paper in the
office today, if at all. The customer for the rollout is an operator with
more than one centre. Nobody has yet asked for a specific HIQA report
format. Each of these is a question in the note to Donal; the plan changes
if the answers do.

**Per-site switches.** Each of these features is off by default and turned
on per centre under Admin → Settings → *Features for this site*
(`app_settings.feature_buildings`, `feature_evacuation`, `feature_households`;
migrations 017 and 018). A
centre that never turns one on sees exactly what it saw before, and a trial
centre can turn them on one at a time.

**The line the product keeps.** It holds almost nothing about a person, and
that is why a centre can adopt it in a week. Every stage below adds the
least data that does the job, from a fixed list where a list will do, with
no free text, visible only to the people who need it. Anything that would
hold health or vulnerability detail beyond an evacuation need is a separate
decision for a customer to make in writing, with a DPIA behind it.

---

## Stage 1 — Buildings, floors and rooms

**Status: built 4 September 2026 (migration 016).**

- A centre describes its buildings, floors and rooms once, under Admin →
  Buildings. Rooms have a capacity. Room numbers are whatever the centre
  paints on the doors; the system does not invent a sequence.
- A resident is assigned to a room on their record. The room shows on
  every card in the gate and the register ("Castle · 1F · 12"), so a guard
  looking at a name knows where the person lives.
- Occupancy by building and room, with who is on site right now, under
  Admin → Buildings. This is the "full building occupancy list" from
  Donal's test cases, and it is the foundation of the evacuation roll call.
- Data added: three tables and one nullable column. Nothing about the
  person beyond where they sleep. Audited like every other admin change.

## Stage 2 — Evacuation

**Status: built 4 September 2026 (migration 017), behind the
`feature_evacuation` switch.**

- An evacuation-assistance flag on the resident, from a fixed list:
  none, needs help to move, needs help to hear an alarm, needs help to see
  the way, needs a carer or has an infant, other (no detail held). No free
  text. Visible on the roll call and the occupancy list only, never on the
  gate cards or in searches. This is the PEEP (personal emergency
  evacuation plan) minimum a fire officer expects, and it is the first
  special-category field the product holds, so it goes in the DPIA.
- Roll call: one tap from the gate opens the list of everyone on site,
  grouped by building, needs-assistance first, with a tick per person at
  the assembly point. Works offline from the encrypted register copy,
  because a fire may take the power and the wifi with it. Ticks sync later
  and are kept as a record of the drill or the incident.
- A printable evacuation list per building for the fire panel, refreshed
  from the same data.
- Several wardens, several phones, one list (6 September): a roll call
  started on one phone appears on every other phone's Roll call tab, each
  warden's ticks show on the others within about five seconds, a tick is
  per resident so two wardens ticking the same person is one tick, and
  ending it on one phone ends it on all. Offline phones keep ticking and
  send when the connection returns.

## Stage 3 — Households

**Status: built 4 September 2026 (migration 018), behind the
`feature_households` switch.**

- Link residents into a household, so a child appears with a parent, a
  family evacuates as one row, and a room's occupants read as a family.
- Minors: the register already exempts under-18s from the daily rule;
  the household link is what lets the roll call show "with parent".

## Stage 4 — Reports

**Status: built 4 September 2026 (migration 019). No switch: reports are
a supervisor's tool and add no data.**

- Occupancy by building and room, attendance for a date range, the daily
  register for a date range, the evacuation list, as CSV and as a printable
  page. Each records who exported it and why, like the resident export.
- Formats to follow whatever HIQA inspectors have actually asked a centre
  for, once one has.

## Stage 5 — Many centres

**Status: built 4 September 2026 (migration 020), on the working branch and
NOT on main until it has been seen on a copy of the live database.** The
proof is the "tenancy isolation" section of `test/api.test.js`: a second
centre's admin cannot read, change, export or erase a legacy resident;
events, settings, buildings and reports stay in their own schema; an
invited staff member joins the inviter's centre; the nightly jobs run once
per centre; a suspended centre is refused at the door; a closed centre's
schema is dropped and its logins stop working.

- Tenancy isolation: a request runs inside its own centre's schema, the
  staff list and password reset are centre-scoped, and a test proves one
  centre's admin cannot read, list, write, export or erase anything in
  another. `docs/MULTI-TENANCY.md` describes each step.
- An organisation level above any one site (`/org.html`): which centres
  exist, their counts, provisioning and closing. Platform administrators
  only for now. No resident data crosses centres. Still open: an
  organisation *entity*, an operator that owns several centres with its own
  administrators who are not platform administrators; that needs a decision
  on who those people are before it is modelled.
- Provisioning a new centre from the template, and deprovisioning one.

## Stage 2b — Visitors, staff and contractors

**Status: built 7 September 2026 (migration 024), behind the
`feature_visitors` switch, on the working branch.** Donal's question
three: staff, visitors, contractors and suppliers logged as on or off
site. A Visitors tab on the gate signs anyone who is not a resident in on
arrival (kind from a fixed list, name, optional company) and out when they
leave; whoever is still on site is a group on the roll call and is marked
safe like a resident; a Visitors report covers a date range. Held as long
as the movement log. Children out at school remain residents signed out at
the gate, which the gate already records.

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

## Stage 2c — What the centre managers asked for

**Status: built 8 September 2026 (migration 027), on the working
branch.** The feedback from the IPAS centre managers, item by item:

- *View a resident's history, filtered by person and dates*: a History
  panel under every detail sheet (door, register, admin edit sheet) listing
  movements and check-ins over a range up to a year, with date, time and
  who recorded each.
- *Search the Log by name or room over a period of days*: the Log takes a
  from and to date (up to a month at a time) and a name-or-room filter.
  Filtering by room needs the Buildings feature, which is where rooms live.
- *"Off site since date and time"*: every card and detail sheet says on or
  off site since the last movement, with the day once it is not today.
- *Who was off site at midnight, historically*: the nightly job snapshots
  it (`overnight_absences`), the "Absent overnight" report reads it for any
  range, kept as long as the register.
- *Multi-select at the door*: "Select several" ticks people and signs them
  in or out from a bar at the bottom, one movement each.
- *A list of who is absent*: the "Absent now" report, and the Off site tile
  at the door for the live list.
- *The samples they sent* (a check-out and check-in spreadsheet, and a
  History screen with Today / Yesterday / This week / This month): the
  "Out and back" report is that spreadsheet, one row per absence with
  building, room, date and time out, date and time back, hours away and
  who signed each; the absent reports carry the same building, room,
  date and time columns; the Log and History have the four quick ranges.
  Two columns from the spreadsheet are not carried on purpose: gender,
  which the app does not hold (nothing in the register needs it), and a
  resident number, which the app does not assign. Residents are named.
- *Tablets and the evacuation feature*: already there. The app is a web
  page that fits any screen; the roll call is Stage 2.

## Stage 2d — The Brighton call

**Status: built 8 September 2026 (migration 028), on the working
branch.** The action items from the Brighton Accommodation call, against
what already existed:

- *Historical and current absence, searchable by resident and room*: Stage
  2c. *Visitors and staff on roll calls*, *staff sign-in with a
  resident-only count*, *under-18s in movement and evacuation views but
  not required on the register*: already so.
- *Room-number search*: `search_residents()` matches the room as painted
  and any part of the building-and-room label; the offline filter too.
- *Bulk actions for families*: ticking one member in Select several ticks
  the family on screen.
- *Evacuation reports showing who was marked safe*: the "Roll call: who
  was marked safe" report, residents and visitors, with the room they had
  at the time (from room history), printable and exportable like the rest.
- *Authorised absences, holiday blocks, child safeguarding*: a supervisor
  records first and last day, a reason from a fixed list and, for a child,
  a parent or guardian's agreement; `close_out_compliance_days()` writes
  those days as not required. Held: the category, never the story.
- *Room-assignment history*: `room_assignments`, kept by a trigger, closed
  on leaving, backfilled from the audit trail, with a report.
- *Role permissions for security users*: docs/PERMISSIONS.md, generated
  from the tests.
- Waiting on Brighton: the absence-tracking email, the IPAS weekly-register
  template, room-layout examples.

## Stage 2e — The centre call (Amy and Niamh, 8 September 2026)

**Status: P1 built 8 September 2026 (migration 029), on the working
branch.** Against the notes:

- *Historical absence from the gate log, currently-absent list, room
  search and multi-select, authorised absences, under-18s in the gate
  history*: Stages 2c and 2d. Added here: a letter alone lists the block
  ("B" for Manor House), "All shown" ticks a whole search, and every
  absence report carries a child column so the safeguarding pattern is
  visible.
- *Holiday blocks of at most 14 consecutive days*: `holiday_max_days` in
  Settings, enforced by `authorise_absence()`; an IPO interview is its own
  reason and is not capped.
- *Record that a breach was issued*: `breach_reports`, on the edit sheet,
  on the Absences tab (with a name-or-room filter and a "today" column
  that separates not-yet-checked-in from away), and a report.
- *Approval status in the weekly report*: an absence in the app is
  approved by construction (a supervisor recorded it); an unrecorded
  absence is unapproved. The weekly IPAS report will read both.

Added 8 September (migration 030): **the site staff list**. Supervisors
paste the centre's own staff in under Admin → Staff; on the Visitors tab,
under Staff, each name is one tap to sign in with the job title filled;
the visit points back at the list entry, and the roll call names them.

Still to do from the call, in the order the centre ranked them:
rename Door to In & out (done 8 September, at the centre's request); archive rooms rather than delete, with contracted
capacity and bed configuration (done 8 September, migration 031); the weekly IPAS report — the Sunday email is
Stage 2f; matching head office's two Excel files column for column waits on copies of them. Done
8 September: a search box and building filter on the roll call;
"Practice drill" and "Real evacuation" wording; a default view per tablet
(`?view=` or the tick on the chooser); bulk depart; the nightly House
Rules reminder by email (migration 032, a switch in Settings); the help
site pinned to the light palette; a note for the record when a drill or
evacuation ends (migration 033). Still to confirm with the centre: the
"not seen after N hours" figure, and whether 90 days is long enough for
the movement log.

## Stage 2f — The Sunday report (Brighton's Weekly Register document, 10 September 2026)

**Status: built 10 September 2026 (migrations 035, 036 and 037), on the
working branch.** Spec: `docs/superpowers/specs/2026-09-10-weekly-register-update-design.md`.

- *Absences as "from Monday to Wednesday"*: consecutive nights in the
  overnight snapshot become one span, approved by construction when every
  night is inside an authorised absence, "partly approved (2 of 3
  nights)" otherwise. Spans that begin on a Friday or Saturday night are
  "Updates from the weekend". Departures in the week are "Resident
  removals". Rooms gain a status (open, maintenance) and a one-line note
  for the return; "Room updates" lists maintenance and free contracted
  beds. One SQL function builds the rows and the sentences; the report
  under Admin → Reports, viewed or downloaded as a CSV, reads them in
  full, but the emailed version reads only their counts (below).
- *Sent on a Sunday, counts and a link only* (migration 037): the staff
  ticked "Gets the Sunday report" on their record — offered only to
  supervisors and admins, since only they may run the report it
  summarises — are emailed the previous Sunday night through Saturday
  night as a count per section and a link into the app, never a resident
  name, room or date. A switch under Settings turns the send on or off
  for the site; "Send last week's now" checks it regardless of the
  switch, on the audit record. Recipients moved off a comma-separated
  address list typed into Settings: they are now always known staff, so a
  colleague who leaves stops receiving resident data automatically, and
  because no resident data leaves by this email at all, none of it lives
  on in an inbox, a forward, or a mail provider's own backups outside the
  app's retention rules.
- *The IPAS permitted periods*: dates under Settings; a holiday outside
  every window is recorded with a warning, never refused.
- *The iPad as a fixed terminal*: a manifest and the Apple meta tags, so
  the app installs to the home screen without Safari's bar; Guided Access
  does the locking. In the guide.
- Not done: the "Weekly Register Change" section (nobody has said what
  goes in it); matching head office's two Excel files (we do not have
  them); an hours-based rule (nights at midnight is the centre's own
  midnight list).

## Stage 5b — Self-serve trials

**Status: built 9 September 2026 (migration 034).** Stage 5 made many centres
possible; this makes a centre able to start one without us. The lifecycle was
already there from migration 009 — the missing piece was only the front door.

- `POST /signup` from the brochure site writes a pending request and sends one
  email. It provisions nothing: the click on the emailed link is the proof of
  an inbox, and only that creates a schema.
- `GET /signup/confirm` provisions, seeds if asked, creates the first
  administrator and redirects into the app to choose a password — one email and
  one click, not two.
- The form asks sample-or-empty. A demo centre with nothing in it teaches
  nobody anything; a register with fabricated people in it that somebody
  believed was empty is worse. So it is a question, and every seeded row is
  registered so Admin can clear exactly those.
- Rate limits per address and per connection, throwaway domains refused, an
  existing account told to sign in, single-use links that expire in a day.
- `test/signup.test.js` and `./test/signup.sh`, wired into `check.sh`.

**Still open.** A trial has no banner of its own inside the app yet: a centre
on day six is not told so, and a centre on day eight discovers the site is
read-only by trying to record a check-in and being refused. The refusal is
correct and the data is safe, but it should be announced before it happens —
the session endpoint would need to return the tenant's status and
`trial_ends_at`, and both front ends a strip under the header. That is the next
piece of this stage.

## Stage 6 — Access control integration

**Status: not planned until a centre has hardware.**

- Where a centre has fobs, turnstiles or a door controller, an inbound
  webhook records entry and exit events from it, so the gate app and the
  hardware agree on who is on site. Designed only against a real device;
  the gate app remains the access control everywhere else.

---

## What each stage costs in data terms

| Stage | New personal data | Who sees it |
|---|---|---|
| 1 | A resident's room | All staff |
| 2 | One evacuation-need code from a fixed list | Roll call and occupancy only |
| 3 | Which residents share a household | All staff |
| 4 | None; reports draw on what exists, and each export is logged | Admins |
| 5 | None | — |
| 6 | Entry and exit events from a device, same as the gate records today | All staff |

Every stage keeps the rules the product already has: append-only events,
no free text, the identity number on the detail view only, erasure that
removes everything and leaves a proof.
