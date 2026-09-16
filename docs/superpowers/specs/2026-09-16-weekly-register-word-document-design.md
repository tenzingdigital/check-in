# The Weekly Register Update as a Word document — design

Written 16 September 2026 from the Slaney Manor visit (15 September) and the
owner's rulings today: "update the weekly Sunday email to better match the
email format example that was shared previously" → "she wants it as a Word
doc" → "names".

Amy White's Sunday today: a midnight text from security, a cross-check of
the sign-in app, a hand-compiled SharePoint Word document to Mick by
~10:30, which Mick copies into the two IPAS Excel registers. Her example
document (Weekly Register – Explanation Document.pdf, 10 Sep) has a header
"Weekly Register Updates WK Ending <date>", the line "Updates for the
period between <from> – <to>", and five headed lists — **Room Updates**,
**Resident Absences**, **Updates from the Weekend**, **Resident Removals**,
**Weekly Register Change** — one plain sentence per person, with a
not-approved absence highlighted yellow and ending "please mark as
unauthorised absence". The visit agreed the report should go to **Amy
first** as an **editable Word document** at **10:00 on Sunday**; she
reviews, edits and forwards it, and Mick never needs a login.

The in-app report (migration 035 and successors) already produces those
five sections and a ready-made sentence per row. What is missing is the
document, the attachment, the 10:00 send, and a button to fetch it any day.

## Decisions

- **A `.docx`, written by hand.** `lib/docx.js` builds a minimal Word
  document as a zip of XML parts, reusing `lib/xlsx.js`'s zip writer. No new
  dependency — the same reasoning as the spreadsheet writer: nothing to
  trust, byte-identical output the tests can assert. It supports exactly
  what the document needs: a title, a subtitle, a bold heading, a plain
  paragraph, an underlined paragraph, a bullet, and a yellow highlight on a
  bullet. Bullets are indented paragraphs with a "•" glyph, not Word
  numbering, so no `numbering.xml` is needed.
- **The document names people.** The owner's ruling ("names"), and the
  point of the document: Mick copies names into the registers. Each bullet
  is the report row's existing `line` (e.g. "John Smith from Manor B1 was
  absent from Monday 31 August to Wednesday 2 September 2026 (3 nights),
  back on Thursday 3 September. Approved by management."). Nothing that the
  report does not already show is added: no date of birth, identity number
  or evacuation need. The child marker stays as the report has it.
- **Amy's wording for the ones she acts on.** A row with status
  `not approved` gets " Please mark as unauthorised absence." appended and is
  highlighted yellow; `partly approved` gets " Please mark the nights not
  approved as unauthorised absence." and the same highlight. Approved rows
  are plain. The app records the fact; the sentence is the instruction Amy
  writes today, so the document reads as hers.
- **Attached, behind a per-site switch.** `app_settings.weekly_report_attach_document`
  (boolean, default **false**; migration 052). When on, the Sunday email
  carries the document as an attachment. When off, the email is exactly as
  today. Default off because the brochure site tells refuges and treatment
  centres "Counts only, never a name", and that stays true for any service
  that does not turn this on. The owner ticks it for Slaney under
  Settings → Weekly register update.
- **The email body stays counts and a link.** With the attachment on, one
  sentence is added: "The Weekly Register Update is attached as a Word
  document." and the footer for this email reads "The attached document
  names residents — treat it as you would the register itself." rather than
  "It carries counts only". The nightly House Rules reminder and the
  overnight safeguarding alert are untouched: counts only, as before.
- **10:00 Sunday, site time.** The weekly send leaves the 00:30 nightly run.
  `node jobs.js weekly` is a second Render cron (`hut-weekly`), Sundays at
  09:00 and 10:00 UTC. It sends only when (a) the site's local time is at or
  past 10:00, and (b) Saturday night's `snapshot-overnight-absences` run is
  recorded ok for today. The first run at or past 10:00 local sends; the
  existing "already sent today" guard makes the second a no-op. That lands
  at 10:00 Irish time in summer (09:00 UTC) and winter (10:00 UTC). The
  nightly run no longer calls `weeklyRegister()`; the snapshot's
  "skipped: snapshot failed" branch stays for the safeguarding alert only.
- **"Send last week's now" is unchanged** except that it, too, attaches the
  document when the switch is on — same `compose()` and `document()`, so the
  test send Amy is promised is the real thing.
- **A Word button on the report.** `GET /api/reports/weekly?…&format=docx`
  returns the same document for the range; any other report with
  `format=docx` is 400. Audited with a reason like every export. The
  Reports tab shows "Word" beside "Excel" on the Weekly register update card
  only.
- **No resident data changes.** Rows come from `weekly_register_rows()` /
  `_unchecked()` exactly as now.

## Data

Migration `052_weekly_report_attach_document.sql`:

```sql
alter table public.app_settings
  add column if not exists weekly_report_attach_document boolean not null default false;
comment on column public.app_settings.weekly_report_attach_document is
  'Attach the Weekly Register Update to the Sunday email as a Word document. It names residents and rooms; off unless the centre turns it on.';
```

Exposed through the existing settings read/write path like `weekly_report_email`
(same permission: administrators write, staff read).

## The document

`weeklyReport.document({ siteName, from, to, rows, generatedOn })` →
`{ filename, buffer, contentType }`.

- `filename`: `Weekly-Register-Update-week-ending-<to>.docx` (ISO date).
- `contentType`: `application/vnd.openxmlformats-officedocument.wordprocessingml.document`.
- Content, in order:
  1. Title: **Weekly Register Update**
  2. Subtitle: `<Site name> · Week ending <Saturday 12 September 2026>`
  3. Underlined: `Updates for the period between <Sunday 6 September 2026> and <Saturday 12 September 2026>`
  4. For each section in this order — Room Updates, Resident Absences,
     Updates from the Weekend, Resident Removals, Weekly Register Change —
     a bold heading with a trailing colon, then one bullet per row in the
     order `weekly_register_rows()` returns them; if the section has no
     rows, one bullet "None." Not-approved / partly-approved rows carry the
     appended sentence and the yellow highlight.
  5. Closing paragraph: `Produced by CheckSteady on <Sunday 13 September 2026>. Nights are counted at midnight, site time. A night inside an authorised absence recorded in CheckSteady is approved; any other is not.`
- Section headings map from the DB section names ('Room updates' →
  'Room Updates', etc.). Only the document uses Title Case; the app keeps
  sentence case.

## `lib/docx.js`

`docx(blocks)` → `Buffer`. `blocks` is an array of
`{ kind: 'title' | 'subtitle' | 'heading' | 'para' | 'underline' | 'bullet', text, highlight?: boolean }`.
Parts: `[Content_Types].xml`, `_rels/.rels`, `word/document.xml`,
`word/styles.xml` (Normal + the few run properties used inline). All text
XML-escaped. `highlight: true` emits `<w:highlight w:val="yellow"/>` on the
run. Exports `docx` only.

## Email

- `mail.send({ …, attachments })`: `attachments` is an optional array of
  `{ filename, content: Buffer, contentType }`. Resend receives
  `attachments: [{ filename, content: <base64> }]`. The test sink records
  `attachments` as given (Buffers), so tests can inspect the bytes.
- `mail.layout({ …, footer })`: optional footer sentence replacing the
  default "It carries counts only — the detail stays behind your login."
- `weeklyReport.compose({ …, attached })`: when `attached` is true, the
  paragraph "The Weekly Register Update is attached as a Word document." is
  added to both parts after the counts, and `footer` is set to "The attached
  document names residents — treat it as you would the register itself."
  When false, output is byte-identical to today.
- Both senders (jobs.js `weeklyRegister`, routes/settings.js send-now) read
  `weekly_report_attach_document`; when on they build the document once per
  run and pass it as the attachment to every recipient.

## Scheduling

- `jobs.js`: `main()` takes an optional mode from `process.argv[2]`.
  - No mode (the nightly): everything as today **minus** the
    `weeklyRegister()` call.
  - `weekly`: for each live tenant, `weeklyRegister(schema, label)` only,
    then exit (no purges, no platform jobs).
- `weeklyRegister()` gains two gates after the existing Sunday gate, both
  recorded in `job_runs` when they stop the run:
  - `'before 10:00'` when the site's local hour (`extract(hour from now() at time zone local_timezone)`) is below 10;
  - `'snapshot not run'` when no `snapshot-overnight-absences` row for
    today (site date) with `ok` exists.
  `force` bypasses all three calendar/clock gates (Sunday, hour, snapshot)
  — its documented job is "send now regardless of when", and the existing
  tests and manual runs rely on that — but never the "already sent today"
  guard. The decision is a pure function exported for testing:
  `sendGate({ dow, localHour, snapshotOk, force })` → `null` (send) or the
  reason string, checked in that order.
- `render.yaml`: a second cron `hut-weekly`, same runtime/region/plan/env
  as `hut-nightly`, `schedule: "0 9,10 * * 0"`, `startCommand: node jobs.js weekly`,
  with a comment explaining the two hours and the local-time gate.

## API and UI

- `routes/reports.js`: `format=docx` accepted only when `req.params.name === 'weekly'`
  (else 400 "Only the Weekly register update is available as a Word
  document"). Uses `weekly.document()` with the report's rows and the
  site name; `Content-Disposition: attachment; filename="<document filename>"`.
- `public/admin.html`: on the Reports tab, the Weekly register update card
  gets a "Word" button (`data-docx="weekly"`) beside Excel, same
  reason-then-download flow (`reportQuery()` + `&format=docx`).
- Settings → Weekly register update: a second tick under the existing one:
  **"Attach it as a Word document."** with the hint "The document names
  residents and rooms: the week's update, ready to review, edit and
  forward. Off, the email carries counts and a link only."

## Copy that changes

The promise "no resident is ever named in an outbound email" becomes "…
unless the centre turns on the Word attachment for the Sunday report":
`docs/GDPR.md` (lines ~23-27, the "What leaves by email" section, the
processors table row for Resend), `public/help.html` Sunday report facts,
`public/admin.html` Settings label, `docs/PRODUCT-ROADMAP.md` line ~294,
`lib/weeklyReport.js` header comment, `tools/build-site.py` (IPAS FAQ
"What is the weekly register update?", refuges FAQ "Does anyone outside the
service see the data?", refuges pair "Counts only, never a name" → "Counts
only, unless you choose otherwise"), then `python3 tools/build-site.py`.
`docs/legal/*` untouched (owner's call).

`docs/PRODUCT-ROADMAP.md` gains a section **"Site visit, 15 September
2026"** recording the asks and their status: Sunday document to Amy at
10:00 (this spec); nightly emails merged into one to the manager (open);
overnight parent-away-children-remain alert (open, highest stakes);
in/out-vs-register conflict flag in the nightly email (open); Families
tab linking parents and children (open); gender field (open); room number
column in the resident list (open); admin override of absence records
(open); known night-worker flag in the absence report (open); security
role review — flag a welfare concern without edit rights (open); dry run
28–30 Sep, go-live 1 Oct 2026.

## Out of scope

- PDF. Amy asked for Word; Mick forwards what Amy edits.
- Any change to which rows the report produces or their wording in the app.
- The nightly merge, child-welfare alert, conflict flag and the rest of the
  visit list — recorded in the roadmap, built separately.
- Moving the House Rules or safeguarding emails.

## Testing

- `test/docx.test.js` (no database, like `test/xlsx.test.js`): the zip
  container is valid and lists the four parts; `document.xml` contains each
  block's text escaped (`&`, `<`), a highlighted bullet carries
  `w:highlight w:val="yellow"`, an underlined block carries `<w:u`, output is
  byte-identical for identical input.
- `test/api.test.js`, weekly block:
  - `document()` on the existing compose fixtures: five headings in order,
    "None." for an empty section, the not-approved row's sentence plus
    "Please mark as unauthorised absence.", names present, filename.
  - `compose({ attached: true })` adds the attachment sentence and the new
    footer; `compose()` without it is unchanged (the existing "never a name
    in the body" assertions still pass in both modes).
  - Send-now with the switch off: sink mail has no `attachments`. Switch on
    (PATCH settings): each sink mail has one attachment named
    `Weekly-Register-Update-week-ending-<to>.docx` whose content starts
    `PK` and contains a fixture resident's name inside `document.xml`.
  - `GET /api/reports/weekly?…&format=docx` → 200, Word content type,
    `PK`, audited; `GET /api/reports/register?…&format=docx` → 400; a
    guard → 403.
  - `sendGate()` as a table: not Sunday → `'not Sunday'`; Sunday before
    10 → `'before 10:00'`; Sunday, 10, no snapshot → `'snapshot not run'`;
    Sunday, 10, snapshot → `null`; any of those with `force` → `null`.
    The existing `weeklyRegister()` tests (all `force: true`) keep passing
    unchanged; the non-Sunday integration assertion stays.
  - `node jobs.js weekly` runs only `weeklyRegister()` per live tenant
    (asserted by requiring `jobs` and calling the exported `main('weekly')`
    against the test database with the switch off: one `job_runs` row
    `'off'` for `weekly-register-email`, and no new `close-out-compliance-days`
    row).
- `./check.sh` green.
