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
- *Tablets and the evacuation feature*: already there. The app is a web
  page that fits any screen; the roll call is Stage 2.

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
