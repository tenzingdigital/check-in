# The Sunday Weekly Register Update — design

Written 10 September 2026 from Brighton Accommodation's "Weekly Register -
Explanation Document" (Niamh Slevin, Amy White) and the owner's four
decisions on 10 September: absence is counted by midnights, rooms gain a
status and a note, the report is emailed on Sunday and kept under Reports,
and the IPAS permitted-absence periods become a setting.

## What the centre does today

Every Sunday the assistant centre manager emails head office ("Mick") a
Weekly Register Update. Head office copies it into two IPAS Excel registers.
The update has a period line and these sections: Room Updates (rooms free,
rooms under maintenance, single beds free), Resident Absences ("John Smith
from B1 was absent from Monday 31st August to Wednesday 2nd September 2026.
This was approved by management."), Updates from the Weekend (the same for
Friday and Saturday nights, "not approved by management, please mark as
unauthorised absence"), Resident Removals, and Weekly Register Change.

Their rule: off site for 24 hours or more without explanation is an
unauthorised absence. Security emails the manager at midnight with who left
during the day and is still out; the manager checks next morning who came
back. Children are not on the daily register, so the movement log, not the
register, is the source.

The app already takes that midnight list itself (migration 027,
`overnight_absences`, one row per resident per night off site at site
midnight) and keeps it as long as the register. Nothing in the app yet
groups those nights into "from Monday to Wednesday", says approved or not
in words, lists the week's departures, or sends anything on a Sunday.

## The line the product keeps

The report states facts the app already holds: which nights a resident was
off site at midnight, whether those nights fall inside an authorised
absence a supervisor recorded, who left the centre and when, which rooms
have free beds or are out of use. It holds no new fact about a person. The
one new free text is a note on a *room*, written by a supervisor for the
vacancy line; nothing about a resident is typed into it. Approval is
approved-by-construction: a night inside an authorised absence is approved,
a night outside one is not. The app never decides that an absence was
"unauthorised absence" in the House Rules sense; it reports the nights and
whether they were authorised, and the manager writes the letter.

## What changes

Migration 035 `weekly_register.sql`, on the working branch. Every object is
per tenant, so `tenant/template.sql` is regenerated.

### 1. Absence spans

A function collapses consecutive nights into one span per resident:

```
weekly_absence_spans(p_from date, p_to date)
returns table (
  resident_id uuid, resident text, building text, room text, child boolean,
  first_night date, last_night date, nights integer,
  back_on date,              -- null while still away at p_to's midnight
  authorised_nights integer, -- nights inside an authorised absence
  approval text,             -- 'approved' | 'not approved' | 'partly approved'
  weekend boolean            -- first_night is a Friday or Saturday
)
```

- Source: `overnight_absences` rows with `night between p_from and p_to`,
  gaps-and-islands by resident (`night - row_number()` grouping).
- A span that reaches `p_to` has `back_on null`; otherwise `back_on =
  last_night + 1`, the day on whose midnight they were on site again.
  Movement times are not used, so the answer is the same after the
  movement log is purged.
- `authorised_nights` counts the span's nights where
  `absence_authorised(resident_id, night)`. `approval` is `approved` when
  every night is authorised, `not approved` when none is, otherwise
  `partly approved`.
- `weekend` is `extract(isodow from first_night) in (5, 6)`.
- Names come from `residents` (first + last, trimmed); building and room
  from `v_resident_room` as the resident's room today. Departed residents
  keep their rows (the view carries departed residents). `child` follows
  `v_resident_status.is_adult` as the other absence reports do.
- Security: `security definer`, `set search_path = public`, refused unless
  `is_supervisor()`, execute granted to `authenticated`, like
  `resident_views_between`. The nightly job calls it as owner.

### 2. Removals

Residents with `status = 'departed' and departed_on between p_from and
p_to`, with building and room from `v_resident_room` and the child flag.

### 3. Rooms: status and note

```
alter table rooms
  add column status text not null default 'open' check (status in ('open', 'maintenance')),
  add column note   text check (note is null or length(note) <= 120);
```

`v_room_occupancy` gains `status` and `note` appended after `archived`
(a view's existing columns cannot be reordered). `PATCH /api/rooms/:id`
accepts both (`status` from the two values; `note` trimmed, empty → null).
The room edit form under Admin → Buildings gains a Status select (Open /
Under maintenance) and a Note field, placeholder "e.g. 1 bed free for a
single woman". A room under maintenance shows a small "maintenance" pill
in the list. The "Vacancies against contracted capacity" report gains
`status` and `note` columns at the end. Nobody is refused a room for being
under maintenance: it is a note for the return, not a lock.

### 4. The report rows

```
weekly_register_rows(p_from date, p_to date)
returns table (
  section text,   -- 'Resident absences' | 'Updates from the weekend' | 'Resident removals' | 'Room updates'
  building text, room text, resident text, child text,   -- child: '' or 'child'
  from_date date, to_date date, nights integer, back_on date,
  status text,    -- approval in words, or 'departed', 'maintenance', 'N free'
  line text       -- the sentence
)
```

Ordered: absences (by first night, then name), weekend, removals (by
departure date), room updates (by building sort, room sort). The sentence
is built in SQL so the CSV, the printable page and the email agree:

- Absence: `"{resident}{ (child)} from {building} {room} was absent from
  {Day D Month} to {Day D Month}{ YYYY} ({n} night(s)), back on {Day D
  Month}. Approved by management."` / `"…still away. Not approved."` /
  `"…Partly approved ({k} of {n} nights)."` Building and room are omitted
  when the resident has no room. The year is written once, on the last
  date. `to_char(date, 'FMDay FMDD FMMonth')`.
- Removal: `"{resident}{ (child)} from {building} {room} departed on {Day
  D Month YYYY}."`
- Room, maintenance: `"{building} {room} is under maintenance{: note}."`
- Room, free beds: `"{building} {room}: {k} of {contracted} bed(s) free{
  (bed_config)}{: note}."` Only rooms with `k > 0`, not archived.

`REPORTS.weekly = { title: 'Weekly register update', ranged: true, sql:
'select * from weekly_register_rows($1, $2)' }` in `routes/reports.js`.
Reason, audit (`note_report`), CSV, JSON and the 366-day cap apply as to
every report. The printable page renders the table as it does today; the
`line` column is the last column and reads on its own.

### 5. The Sunday email

Settings (`app_settings`):

```
weekly_report_email      boolean not null default false
weekly_report_recipients text    -- comma-separated addresses, null when none
```

`routes/settings.js` `COLUMNS` gains `weekly_report_email: { kind: 'bool'
}` and `weekly_report_recipients: { kind: 'emails' }`: a new kind that
splits on commas, trims, lower-cases, requires each part to match the
address shape already used for staff invites, allows at most 10, and
stores null for an empty string. Admin → Settings gains a "Weekly register
update" heading with the checkbox ("**Email the Weekly register update
every Sunday.** Early Sunday morning, after Saturday night's snapshot, the
addresses below receive the week's absences, weekend updates, removals and
room updates as plain text. Needs email configured on the service."), a
Recipients field, and a "Send last week's now" button.

`jobs.js`: a `weeklyRegister(schema, label)` step after
`snapshot-overnight-absences` in the live-only run, named
`weekly-register-email` in `job_runs`. It reads the settings and the site
weekday; unless `weekly_report_email` is on, recipients exist and
`extract(isodow from site_today()) = 7`, it records `off` / `not Sunday`
/ `no recipients` and returns. Otherwise `p_from = site_today() - 7`,
`p_to = site_today() - 1` (the previous Sunday night through Saturday
night), rows from `weekly_register_rows`, text composed as:

```
{site_name}: Weekly register update, {D Month} to {D Month YYYY}

Resident absences
- {line}
- …
(none)

Updates from the weekend
…

Resident removals
…

Room updates
…

Nights are counted at midnight, site time. An absence inside an
authorised absence recorded in CheckSteady is approved; any other is not.
The full report, printable and as CSV, is under Admin → Reports.
```

One `mail.send` per recipient; the run records `"{rows} rows, {d}/{n}
emailed"`. An empty week still sends (head office expects the email), with
`(none)` under each heading.

`POST /api/settings/weekly-report/send` (admin only, no body): composes
the same text for the last complete week and sends it to the saved
recipients now, returning `{ sent, recipients, from, to }`. Refused with
400 when there are no recipients. Written to `admin_audit` through
`note_report('weekly', 'sent by hand', from, to)` so a manual send is on
the record like an export. The text composer lives in `lib/weeklyReport.js`
and is shared by the route and the job.

### 6. Permitted absence periods

```
create table absence_windows (
  id         bigserial primary key,
  name       text not null check (length(name) between 1 and 60),
  from_date  date not null,
  to_date    date not null check (to_date >= from_date),
  created_by uuid references profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
```

RLS: staff read; insert/update/delete through the admin write policy
pattern used by `app_settings` (`is_admin()`); audited by `audit_row()`.
Routes under `routes/settings.js`: `GET /api/settings/absence-windows`,
`POST` (name, from_date, to_date), `DELETE /:id`. Admin → Settings gains a
"Permitted absence periods" list with an add form (name, first day, last
day) and a remove link per row, with the hint: "IPAS notices: Christmas,
Ramadan, Easter, the summer school holiday. A holiday authorised outside
these periods still goes through; the screen says so."

Effect: `POST /api/residents/:id/absences` with `reason = 'holiday'`
checks whether `[from, to]` lies inside any window; when it does not, the
201 response carries `warning: 'Outside the permitted absence periods in
Settings'` and the record sheet shows it as a toast. No window recorded
means no warning. The 14-day holiday cap and the guardian rule are
unchanged.

### 7. Documents and guide

- `docs/PRODUCT-ROADMAP.md`: a "Stage 2f — The Sunday report" status
  block, and the "waiting on the template" line updated to say the
  sentences are built and the Excel columns are still to match.
- `public/help.html`: under "Print or export a report", a short recipe
  "Send the Sunday report" (turn it on in Settings, add the addresses,
  Send last week's now to check) and a line under "See who is off site"
  pointing to the Weekly register update.
- `README.md`: the report and the two settings in the features list.

## Tests

In `test/api.test.js`, after the reports block:

1. **Spans and approval.** As owner, insert `overnight_absences` for a
   seeded resident on three consecutive nights and one separate night;
   authorise an absence covering the first two. `weekly_register_rows`
   over the range returns one span of 3 nights `partly approved (2 of 3
   nights)` with `back_on` the day after, and one span of 1 night `not
   approved`; the sentence contains "was absent from" and "Partly
   approved (2 of 3 nights)".
2. **Weekend.** A span starting on a Friday night lands in "Updates from
   the weekend"; one starting Thursday does not.
3. **Removals and rooms.** Depart a resident on a date in range; set a room
   to maintenance with a note and another with a free contracted bed. The
   rows carry `Resident removals` and `Room updates` lines with the note.
4. **Report plumbing.** `/api/reports` lists 17 entries; `weekly` needs a
   reason and a supervisor; CSV header starts
   `section,building,room,resident,child,from_date,to_date,nights,back_on,status,line`.
5. **Recipients.** `PATCH /api/settings` accepts `"mick@example.ie,
   Niamh@Example.ie"` and stores it lower-cased; rejects `"not-an-address"`
   with 400; an empty string stores null.
6. **Send now.** With `HUT_MAIL_SINK=1`, `POST
   /api/settings/weekly-report/send` as admin puts one message per
   recipient in the sink whose text contains the site name, "Resident
   absences" and a line from test 1; as a supervisor it is 403; with no
   recipients it is 400; the send is in `admin_audit`.
7. **Job.** `weeklyRegister()` exported from `jobs.js` (as `notifyThresholds`
   is exercised) run for the test schema with the site weekday forced to
   Sunday via a parameter defaulting to the real weekday: sends to the
   sink; with the switch off it records `off`.
8. **Windows.** Add a window; a holiday inside it returns no warning; one
   outside returns the warning; a `family` absence outside never warns;
   removing the window removes the warning.
9. **Tenant template drift.** The existing provisioning test fails if
   `tenant/template.sql` is not regenerated.

`./check.sh` passes on this Mac with
`PGBIN=/opt/homebrew/opt/postgresql@16/bin`.

## Out of scope

- The "Weekly Register Change" section: nobody has said what goes in it.
- Matching head office's two Excel files column for column: we do not
  have them. The report's columns are the facts; the mapping comes when
  the files do.
- An hours-based absence rule. Nights at midnight is the centre's own
  midnight list; if they answer that the clock starts at the door, "Out
  and back" already has the hours.
- Per-bed rows or a resident's sex. The room note carries the "single
  lady" line by hand.

## 8. The iPad as a fixed sign-in terminal

Added 10 September on the owner's question: can the sign-in page take over
the whole iPad so a resident cannot leave it? The lock is the tablet's, not
the page's: iOS Guided Access (or Single App Mode under an MDM) pins the
iPad to one app until a passcode is entered. The app's part is to run as an
installed web app so Safari's bar and tabs are gone, and to open on the
right screen. The second half already exists ("Always open this on this
tablet"); this adds the first.

- `public/manifest.webmanifest`: name "CheckSteady", short_name
  "CheckSteady", `start_url: "/"`, `display: "standalone"`,
  `background_color` and `theme_color` in the app blue, icons at 192 and
  512 from a new `public/icon.svg` (the tick-in-a-square already used as
  the favicon) plus `public/apple-touch-icon.png` (180 px, since iOS
  ignores SVG for the home screen). `express.static` already sends
  `no-cache` for `.webmanifest`.
- `index.html`, `checkin.html`, `admin.html`, `org.html`: `<link
  rel="manifest">`, `<link rel="apple-touch-icon">`, `<meta
  name="apple-mobile-web-app-capable" content="yes">`, `<meta
  name="apple-mobile-web-app-status-bar-style" content="default">`,
  `<meta name="theme-color">`. The CSP gains `manifest-src 'self'` if it
  lists sources per directive.
- Standalone mode has no back button and no address bar, so every page
  must be reachable from within the app; it already is (the view pill,
  Admin link, Log out). `?view=` pins still work because `start_url` is
  `/` and the choice is in `localStorage`, which the installed app shares
  with Safari on iOS.
- `help.html`, "Set up a tablet": three added steps — Share → Add to Home
  Screen, open from the icon, then Guided Access (Settings → Accessibility
  → Guided Access → passcode; open the app; triple-click the side button;
  Start). A line that the same is called Single App Mode when an MDM
  manages the tablets.
- Test: `check.sh` layer 1 parses the pages; the HTTP suite asserts
  `/manifest.webmanifest` is served as `application/manifest+json` with
  `display: standalone`.
