# Excel export and a printable report — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reports and a resident's history download as `.xlsx` with typed
cells and a presentable header row, and the existing print view becomes
something an inspector can be handed.

**Architecture:** A new `lib/xlsx.js` writes a single-sheet workbook as a zip
of XML parts using Node's built-in `zlib`. `routes/reports.js` and
`routes/residents.js` gain `format=xlsx` beside the existing CSV and JSON.
The print work is a header block in `public/admin.html` plus its stylesheet.

**Tech Stack:** Node 22, `zlib` (`deflateRawSync`, `crc32`), plain
`assert/strict` tests run directly by `check.sh`.

## Global Constraints

- **No new dependency.** `package.json` keeps exactly four runtime
  dependencies: `dotenv`, `express`, `geoip-country`, `pg`. Adding one fails
  this plan.
- **Node 22.** `.node-version` is `22`; `zlib.crc32` requires 20.12+.
- **CSV is not removed.** `lib/csv.js` and every existing `format=csv`
  response keep working unchanged.
- **`note_report()` is not touched.** The audit write stays in the same
  transaction as the query, before the format is chosen.
- **Tests use `assert/strict` and no framework**, following
  `test/mail.test.js`, and run in `check.sh` layer 1 so they pass without
  PostgreSQL.
- **Spelling is British** (`authorised`, `recognised`) to match the codebase.

---

### Task 1: The zip container

**Files:**
- Create: `lib/xlsx.js`
- Create: `test/xlsx.test.js`
- Modify: `check.sh` (add the test to layer 1, beside `test/mail.test.js`)

**Interfaces:**
- Produces: `zipSync(entries)` — internal, not exported. `entries` is
  `Array<{name: string, data: Buffer}>`; returns a `Buffer` holding a valid
  ZIP with local file headers, a central directory and an end-of-central-
  directory record. Task 2 builds the workbook parts that go through it.

- [ ] **Step 1: Write the failing test**

```js
// test/xlsx.test.js
const assert = require('assert/strict');
const zlib = require('zlib');
const { _zipSync } = require('../lib/xlsx');

// A zip we build ourselves has to be readable by a strict reader, and the
// only one guaranteed to be here is zlib itself: inflate each entry back and
// compare. If the CRC or the sizes in the header are wrong, Excel refuses
// the file with no useful message, so they are asserted directly.
const buf = _zipSync([
  { name: 'a.xml', data: Buffer.from('<a/>') },
  { name: 'b/c.xml', data: Buffer.from('<c>hello</c>') },
]);

assert.equal(buf.subarray(0, 2).toString(), 'PK', 'zip starts with PK');

// End of central directory: last 22 bytes when there is no comment.
const eocd = buf.length - 22;
assert.equal(buf.readUInt32LE(eocd), 0x06054b50, 'EOCD signature');
assert.equal(buf.readUInt16LE(eocd + 10), 2, 'two entries in the directory');

// First local header: check the stored CRC and sizes against the real data.
assert.equal(buf.readUInt32LE(0), 0x04034b50, 'local file header signature');
const data = Buffer.from('<a/>');
assert.equal(buf.readUInt32LE(14), zlib.crc32(data), 'crc32 of entry 1');
assert.equal(buf.readUInt32LE(22), data.length, 'uncompressed size of entry 1');

console.log('ok  zip container');
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node test/xlsx.test.js`
Expected: FAIL — `Cannot find module '../lib/xlsx'`

- [ ] **Step 3: Write the minimal implementation**

```js
// lib/xlsx.js — a single-sheet .xlsx, written without a dependency.
//
// An .xlsx is a zip of XML parts. Node ships zlib, which gives both the
// deflate and (since 20.12) the crc32 the zip container needs, so the whole
// writer is ours and package.json keeps its four dependencies. The reason
// for going to this trouble rather than staying with CSV is types: a CSV
// cell has none, so Excel guesses, and it guesses differently on different
// machines — 0142 becomes 142, a date moves with the opener's locale, and a
// value starting "=" is a formula.
const zlib = require('zlib');

// DOS date/time, which the zip format wants. Fixed rather than "now" so a
// workbook built from the same rows is byte-identical and testable.
const DOS_TIME = 0;
const DOS_DATE = (2026 - 1980) << 9 | (1 << 5) | 1;

function zipSync(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const crc = zlib.crc32(e.data);
    const deflated = zlib.deflateRawSync(e.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0, 6);            // flags
    local.writeUInt16LE(8, 8);            // method: deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);           // no extra field
    locals.push(local, name, deflated);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);     // central directory header
    dir.writeUInt16LE(20, 4);             // version made by
    dir.writeUInt16LE(20, 6);             // version needed
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(DOS_TIME, 12);
    dir.writeUInt16LE(DOS_DATE, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(deflated.length, 20);
    dir.writeUInt32LE(e.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);        // where its local header starts
    central.push(dir, name);

    offset += local.length + name.length + deflated.length;
  }

  const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dirBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, dirBuf, end]);
}

module.exports = { _zipSync: zipSync };
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node test/xlsx.test.js`
Expected: `ok  zip container`

- [ ] **Step 5: Wire it into check.sh**

In `check.sh`, beside the existing `node test/mail.test.js || fail=1`, add:

```bash
node test/xlsx.test.js || fail=1
```

- [ ] **Step 6: Run the gate**

Run: `ALLOW_SKIP=1 ./check.sh`
Expected: `All checks passed.`

- [ ] **Step 7: Commit**

```bash
git add lib/xlsx.js test/xlsx.test.js check.sh
git commit -m "feat: a zip container for .xlsx, written with zlib alone"
```

---

### Task 2: Typed cells

**Files:**
- Modify: `lib/xlsx.js`
- Modify: `test/xlsx.test.js`

**Interfaces:**
- Consumes: `zipSync(entries)` from Task 1.
- Produces: `xlsx(rows, { sheetName })` → `Buffer`. `rows` is the same
  `Array<Object>` `csv()` takes in `lib/csv.js`; column order comes from
  `Object.keys(rows[0])`. Task 4 calls this.

- [ ] **Step 1: Write the failing test**

Append to `test/xlsx.test.js`:

```js
const { xlsx } = require('../lib/xlsx');

// The whole point of the format. Each of these is a way CSV loses.
const book = xlsx([
  { ref: '0142', name: '=HYPERLINK("http://evil","x")', count: 7, when: '2026-09-11' },
], { sheetName: 'Test' });

// Pull sheet1.xml back out of the zip we just wrote.
function entry(buf, want) {
  let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const comp = buf.readUInt32LE(i + 18);
    const name = buf.subarray(i + 30, i + 30 + nameLen).toString();
    const start = i + 30 + nameLen + extraLen;
    if (name === want) return zlib.inflateRawSync(buf.subarray(start, start + comp)).toString();
    i = start + comp;
  }
  throw new Error('no entry ' + want);
}

const sheet = entry(book, 'xl/worksheets/sheet1.xml');

// A leading zero survives only if the cell is a string, not a number.
assert.match(sheet, /t="inlineStr"[^>]*><is><t>0142<\/t>/, '0142 stays text');
// A formula-shaped value is a string cell, so nothing executes on open.
assert.ok(!/<f>/.test(sheet), 'no formula cells anywhere');
assert.match(sheet, /=HYPERLINK/, 'the formula-shaped value is present as text');
// A number is a number cell, so sorting and totals work.
assert.match(sheet, /<c r="C2"><v>7<\/v><\/c>/, '7 is a number cell');
// A date is a serial with a date format, not a string.
assert.match(sheet, /<c r="D2" s="2"><v>46276<\/v><\/c>/, '2026-09-11 is a date cell');

console.log('ok  typed cells');
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node test/xlsx.test.js`
Expected: FAIL — `xlsx is not a function`

- [ ] **Step 3: Implement typed cells**

Add to `lib/xlsx.js`, above `module.exports`:

```js
// Excel counts days from 1899-12-30 (the Lotus leap-year bug, preserved).
const EPOCH = Date.UTC(1899, 11, 30);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function serial(iso) {
  return Math.round((Date.parse(iso + 'T00:00:00Z') - EPOCH) / 86400000);
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    // Excel refuses control characters outright rather than ignoring them.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function col(n) {                       // 0 -> A, 26 -> AA
  let s = '';
  for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  }
  return s;
}

// s="1" is the bold header style, s="2" the date style — both defined in
// styles.xml below. A cell with no s= uses the default.
function cell(ref, value, header) {
  if (header) return `<c r="${ref}" s="1" t="inlineStr"><is><t>${esc(value)}</t></is></c>`;
  if (value === null || value === undefined || value === '') return `<c r="${ref}"/>`;
  if (value instanceof Date) return `<c r="${ref}" s="2"><v>${serial(value.toISOString().slice(0, 10))}</v></c>`;
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
  const s = String(value);
  if (ISO_DATE.test(s)) return `<c r="${ref}" s="2"><v>${serial(s)}</v></c>`;
  // Everything else is a string. This is what keeps 0142 as 0142 and makes
  // a value beginning "=" inert: a formula in xlsx is an explicitly marked
  // cell type, never inferred from the text.
  return `<c r="${ref}" t="inlineStr"><is><t>${esc(s)}</t></is></c>`;
}
```

and the workbook itself:

```js
function xlsx(rows, { sheetName = 'Report' } = {}) {
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const lines = [];

  lines.push('<row r="1">' + cols.map((c, i) => cell(col(i) + '1', c, true)).join('') + '</row>');
  rows.forEach((r, n) => {
    const ref = n + 2;
    lines.push(`<row r="${ref}">` + cols.map((c, i) => cell(col(i) + ref, r[c], false)).join('') + '</row>');
  });

  const sheet =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${lines.join('')}</sheetData>` +
    '</worksheet>';

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>';

  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';

  const workbook =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets><sheet name="${esc(sheetName).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets>` +
    '</workbook>';

  const workbookRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>';

  // numFmtId 14 is the locale's own short date, so a sheet opened in Ireland
  // and one opened elsewhere each render the date the way that machine
  // expects — which is the opposite of the CSV problem, where the TEXT was
  // reinterpreted. Here the value is a number and only its display varies.
  const styles =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>' +
    '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="3"><fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFEDF0F4"/><bgColor indexed="64"/></patternFill></fill></fills>' +
    '<borders count="1"><border/></borders>' +
    '<cellStyleXfs count="1"><xf/></cellStyleXfs>' +
    '<cellXfs count="3">' +
    '<xf xfId="0"/>' +
    '<xf xfId="0" fontId="1" fillId="2" applyFont="1" applyFill="1"/>' +
    '<xf xfId="0" numFmtId="14" applyNumberFormat="1"/>' +
    '</cellXfs></styleSheet>';

  return zipSync([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rels, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbook, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels, 'utf8') },
    { name: 'xl/styles.xml', data: Buffer.from(styles, 'utf8') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheet, 'utf8') },
  ]);
}
```

Change the export to `module.exports = { xlsx, _zipSync: zipSync };`

- [ ] **Step 4: Run it to verify it passes**

Run: `node test/xlsx.test.js`
Expected: `ok  zip container` then `ok  typed cells`

- [ ] **Step 5: Commit**

```bash
git add lib/xlsx.js test/xlsx.test.js
git commit -m "feat: typed xlsx cells — a leading zero survives, a formula does not execute"
```

---

### Task 3: The header row stays put, and the columns fit

**Files:**
- Modify: `lib/xlsx.js`
- Modify: `test/xlsx.test.js`

**Interfaces:**
- Consumes: `xlsx(rows, opts)` from Task 2. Signature unchanged; the sheet
  XML gains `<sheetViews>`, `<cols>` and `<autoFilter>`.

- [ ] **Step 1: Write the failing test**

Append to `test/xlsx.test.js`:

```js
const wide = xlsx([
  { ref: '0001', note: 'x'.repeat(400) },
  { ref: '0002', note: 'short' },
], { sheetName: 'Wide' });
const wideSheet = entry(wide, 'xl/worksheets/sheet1.xml');

assert.match(wideSheet, /<pane ySplit="1"[^>]*state="frozen"/, 'header row frozen');
assert.match(wideSheet, /<autoFilter ref="A1:B3"\/>/, 'autofilter across the used range');
assert.match(wideSheet, /<cols>/, 'column widths present');
// One 400-character note must not produce a 400-wide column.
const widths = [...wideSheet.matchAll(/width="([\d.]+)"/g)].map((m) => Number(m[1]));
assert.ok(widths.every((w) => w <= 60), 'no column wider than the cap, got ' + widths.join(','));
assert.ok(widths.some((w) => w > 5), 'a column is sized to its content');

console.log('ok  presentation');
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node test/xlsx.test.js`
Expected: FAIL at `header row frozen`

- [ ] **Step 3: Implement**

In `xlsx()`, before building `sheet`, add:

```js
  // Width in Excel's units is roughly characters. The cap stops one long
  // note from producing a column nobody can scroll past; the floor keeps a
  // short heading readable.
  const widths = cols.map((c, i) => {
    const longest = rows.reduce((max, r) => {
      const v = r[c];
      const len = v === null || v === undefined ? 0 : String(v).length;
      return len > max ? len : max;
    }, String(c).length);
    return Math.min(60, Math.max(8, longest + 2));
  });
  const colsXml = cols.length
    ? '<cols>' + widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>'
    : '';
  const lastCol = cols.length ? col(cols.length - 1) : 'A';
  const lastRow = rows.length + 1;
```

and change the `sheet` string to:

```js
  const sheet =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView workbookViewId="0">' +
    '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
    '</sheetView></sheetViews>' +
    colsXml +
    `<sheetData>${lines.join('')}</sheetData>` +
    `<autoFilter ref="A1:${lastCol}${lastRow}"/>` +
    '</worksheet>';
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node test/xlsx.test.js`
Expected: three `ok` lines

- [ ] **Step 5: Commit**

```bash
git add lib/xlsx.js test/xlsx.test.js
git commit -m "feat: frozen header, autofilter and fitted columns in the workbook"
```

---

### Task 4: `format=xlsx` on the two export endpoints

**Files:**
- Modify: `routes/reports.js`
- Modify: `routes/residents.js`
- Modify: `public/admin.html` (an Excel button beside CSV)

**Interfaces:**
- Consumes: `xlsx(rows, { sheetName })` from Task 2.

- [ ] **Step 1: Add the format to the reports route**

In `routes/reports.js`, require it beside the CSV helper:

```js
const { xlsx } = require('../lib/xlsx');
```

After the existing `if (format === 'json') return res.json(...)` and before
the CSV response, add:

```js
  if (format === 'xlsx') {
    // note_report() has already run inside the transaction above: the format
    // a report was taken in does not change that it was taken.
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
    return res.send(xlsx(rows, { sheetName: def.title }));
  }
```

Use whatever local the CSV branch already uses for the filename stem; do
not invent a second one.

- [ ] **Step 2: Add the same to the history export**

In `routes/residents.js`, in the history handler, beside the CSV response:

```js
  if (format === 'xlsx') {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`);
    return res.send(xlsx(out, { sheetName: 'History' }));
  }
```

- [ ] **Step 3: Add the button**

In `public/admin.html`, beside the existing CSV download control in the
report actions, add an Excel button that requests the same URL with
`format=xlsx`. Follow the existing control exactly — same class, same
reason-prompt path, same `guarded()` wrapper.

- [ ] **Step 4: Verify the front end still parses**

Run: `ALLOW_SKIP=1 ./check.sh`
Expected: `All checks passed.`

- [ ] **Step 5: Commit**

```bash
git add routes/reports.js routes/residents.js public/admin.html
git commit -m "feat: download any report or a resident's history as .xlsx"
```

---

### Task 5: A printout worth handing over

**Files:**
- Modify: `public/admin.html` (the printable header block and its stylesheet)

**Interfaces:**
- Consumes: nothing from earlier tasks. Independent of 1-4.

- [ ] **Step 1: Add the header block to the printable view**

In the report panel, above `#rpTable`, add a block that is hidden on screen
and shown when printing. Populate it where the report is rendered, from
values the page already holds: the centre name from `state.settings`, the
report title, the date range, the time it was run, and the signed-in
staff member's name from `state.profile`.

```html
<div id="rpPrintHead" class="printonly" aria-hidden="true">
  <h1 id="rpPrintTitle"></h1>
  <p id="rpPrintMeta"></p>
</div>
```

```js
// Provenance on the page. An inspector asking where a printout came from is
// asking exactly this, and a page that cannot answer is worth less. It does
// put a staff name on every sheet that leaves the building — recorded as a
// decision in the design, not an accident.
function fillPrintHead(def, from, to) {
  $("rpPrintTitle").textContent = `${state.settings?.site_name || "CheckSteady"} — ${def.title}`;
  const range = def.ranged && from && to ? `${dayLabel(from)} to ${dayLabel(to)}` : "";
  const who = state.profile?.full_name || "";
  $("rpPrintMeta").textContent = [range, `Run ${new Date().toLocaleString("en-IE")}`, who && `by ${who}`]
    .filter(Boolean).join(" · ");
}
```

- [ ] **Step 2: Extend the print stylesheet**

In the `@media print` block in `public/admin.html`:

```css
    .printonly { display: block !important; }
    body.printing #rpPrintHead h1 { font-size: 16pt; margin: 0 0 4px; }
    body.printing #rpPrintHead p { font-size: 9pt; color: #333; margin: 0 0 12px; }
    /* Column headings repeat on every page, and a resident's row is never
       split across a page break. */
    body.printing #rpTable thead { display: table-header-group; }
    body.printing #rpTable tr { break-inside: avoid; }
    body.printing #rpTable th { position: static; background: #fff; color: #000; }
    body.printing, body.printing #rpTable td, body.printing #rpTable th {
      background: #fff !important; color: #000 !important;
    }
    @page { margin: 14mm; }
```

`.printonly { display: none }` goes in the ordinary stylesheet so the block
is invisible on screen.

- [ ] **Step 3: Call it when the report renders**

Wherever the report table is filled, call `fillPrintHead(def, from, to)` with
the same values used for the request.

- [ ] **Step 4: Verify**

Run: `ALLOW_SKIP=1 ./check.sh`
Expected: `All checks passed.`

Then check by eye in a browser: the header is invisible on screen and
present in the print preview, headings repeat on page two, and the page is
black on white.

- [ ] **Step 5: Commit**

```bash
git add public/admin.html
git commit -m "feat: a report printout that says what it is and who ran it"
```

---

## Self-Review

**Spec coverage.** `lib/xlsx.js` (§1) → Tasks 1-3. `format=xlsx` on both
endpoints and the button (§2) → Task 4. The print header and stylesheet
(§3, §4) → Task 5. Tests (§Tests) → the test steps in Tasks 1-3 plus the
`check.sh` wiring in Task 1. CSV staying, `note_report()` untouched and the
no-dependency rule → Global Constraints and asserted by `check.sh`.

**Not covered by a task, on purpose:** the spec's own out-of-scope list —
server-side PDF, Drive, `dobFromSheet()`.

**Type consistency.** `zipSync(entries)` in Task 1 is consumed as `zipSync`
in Task 2 and exported as `_zipSync` for the test. `xlsx(rows, {sheetName})`
in Task 2 keeps that signature in Tasks 3 and 4. `col()`, `cell()`, `esc()`
and `serial()` are defined once in Task 2 and used in Task 3.

**One known gap, deliberately left:** Task 4's `format=xlsx` has no HTTP
test, because the HTTP suite needs PostgreSQL and will not run on the
machine this was written on. The xlsx unit tests do run there. An HTTP
assertion should be added when the suite is next run somewhere with
postgresql-16 — noted here rather than written as a step that cannot be
verified.
