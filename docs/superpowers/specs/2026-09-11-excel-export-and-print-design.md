# Excel export and a printable report — design

Written 11 September 2026, from the owner's two asks: export reports as
Excel rather than CSV and make them look presentable, and offer a PDF for
some of them. It turned out both are the same problem — CSV has no types, so
every machine that opens one guesses — and that one of them is already half
built.

Decisions taken while writing it: Excel is written without a dependency;
CSV stays alongside it; PDF is the existing print view made
inspection-grade rather than a PDF generated on the server; and the printed
header names the person who ran the report.

## What is wrong now

Every export is CSV, and CSV carries no types. Excel therefore decides for
itself what each cell means, differently on different machines:

- a resident reference of `0142` opens as `142`;
- a date is reinterpreted by the machine's locale, so a sheet written in
  Ireland and opened elsewhere can shift day and month;
- a long identity number becomes scientific notation;
- a value beginning `=`, `+`, `-` or `@` is a formula, which is why
  `lib/csv.js` had to gain an apostrophe-prefixing guard.

This is the same class of defect as `dobFromSheet()` reading every
`dd/mm/yyyy` as day-first regardless of origin: text without a type is a
guess, and the guess is silent.

The print side exists but stops short. `admin.html` has a Print button that
sets `body.printing` and calls `window.print()`, and the print stylesheet
hides the chrome and unsets `nowrap`. That is the whole of it. There is no
header saying what the report is, column headings do not repeat across
pages, rows split across page breaks, and there are no page numbers. It
prints; it is not something to hand an inspector.

## The line the product keeps

**No new dependency.** The service has four runtime dependencies and no
build step. An `.xlsx` is a zip of XML parts and Node ships `zlib`, so the
writer is ours. A formatting convenience is not worth thirty transitive
packages in a system holding children's dates of birth.

**No PDF generated on the server.** That means a headless browser or a PDF
library — the heaviest dependency in this work — and nothing needs it.
Emails carry counts and a link, never an attachment, so no unattended
process ever has to produce a document. The browser's own Save as PDF
produces selectable text and paginates properly; it only needs a stylesheet
worth printing.

**CSV stays.** Some things genuinely want a plain text file, and a format
that has worked for two years should not be removed because a better one
arrived.

## What changes

### 1. `lib/xlsx.js` — a minimal writer

One exported function, taking the same `rows` array the CSV path takes plus
a little metadata, returning a Buffer. It writes the four parts a
single-sheet workbook needs: `[Content_Types].xml`, `_rels/.rels`,
`xl/workbook.xml` and `xl/worksheets/sheet1.xml`, with a shared string
table. Zipped with `zlib.deflateRawSync` and `zlib.crc32`, both builtins on Node
20.12 and later (the service runs 22), so the zip container is about forty
lines and there is no CRC table to hand-roll.

Typing is the point of the whole exercise:

- a value that is a `Date`, or an ISO date string the column is known to
  hold, is written as a real date cell with a date format;
- a value that is a number is a number cell, so sorting and totals work;
- everything else is a string cell, which preserves a leading zero and
  makes `=HYPERLINK(...)` inert text — a formula in xlsx is an explicitly
  marked cell type, so the injection guard in `lib/csv.js` has nothing to
  do here.

Presentation, in the same pass:

- the header row bold, with a fill, and frozen so it stays put on scroll;
- an autofilter across the header;
- column widths from the widest value in each column, capped so one long
  note does not produce a 200-character column;
- numbers right-aligned, everything else left.

### 2. `format=xlsx` on the export endpoints

`GET /api/reports/:name` already takes `format`, defaulting to CSV with
`json` for the printable view. It gains `xlsx`, content type
`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, and the
same filename convention with an `.xlsx` extension.
`GET /api/residents/:id/history` gains the same.

`note_report()` is unchanged and still runs in the same transaction: the
format a report was taken in does not change that it was taken, and the
audit record should not imply otherwise.

The Reports screen gains an Excel button beside the existing CSV one.

### 3. The print view made inspection-grade

A header block, rendered into the printable view and visible only when
printing: the centre's name, the report's title, the date range it covers,
when it was run, and who ran it. The app already records all five for
`admin_audit`; putting them on the page means a printout that leaves the
building says what it is and where it came from.

The stylesheet gains what a multi-page table needs:

- `thead { display: table-header-group }` so column headings repeat on
  every page;
- `tr { break-inside: avoid }` so a resident's row is never split;
- a footer with page numbers and a line naming the app;
- `@page { size: landscape }` for the wide reports — occupancy, the
  movement log, the evacuation list — and portrait for the rest;
- black text on white, with the screen's dark palette overridden, so it
  does not print a page of ink.

### 4. Who ran it

The printed header names the staff member. An inspector asking where a
document came from is asking exactly that, and the alternative — a page
with no provenance — is worse. It does mean a staff name leaves the
building on every printout, which is a fair thing to weigh; it is one line
to remove if a centre objects, and this spec is where that decision is
recorded rather than discovered later.

## Tests

- `lib/xlsx.js` unit tests: a workbook with a leading-zero string, a date,
  a number and a formula-shaped string opens as a valid zip; each cell has
  the expected type; the formula-shaped string is a string cell, not a
  formula. Asserted against the produced XML, not by opening Excel.
- The zip container: entries have correct CRC32 and sizes, so a strict
  reader accepts it.
- `test/api.test.js`: `format=xlsx` returns the spreadsheet content type
  and a body beginning `PK`; a guard gets 403, as with every other export;
  `note_report()` wrote its row.
- `test/permissions.js` gains no new row — the format is a parameter of an
  action already in the matrix.
- The print header renders the five fields, asserted against the DOM the
  printable view builds.

## Out of scope

**A PDF produced on the server.** Revisit only if something has to produce a
document unattended. Nothing does today.

**Drive, and any off-site copy.** Considered and set aside on cost: the
encrypted backup route needs no paid account, because `tools/backup.sh`
encrypts with age before writing and what would be stored is ciphertext.
But `backup.sh` cannot currently run at all — `hut-db` has an empty IP
allow list and the script needs the external connection string — so the
backup working again comes before anywhere to put it.

**Styling beyond the above.** No logos, no colour theming, no charts. The
reports are evidence, and evidence should be legible rather than designed.

**`dobFromSheet()`'s day-first assumption.** A real defect, raised by the
same conversation, and a separate piece of work: it silently produces the
wrong date from a sheet written anywhere that writes month first, and a
wrong date of birth changes whether a resident is an adult and therefore
whether they must check in at all.
