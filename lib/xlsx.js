// lib/xlsx.js — a single-sheet .xlsx, written without a dependency.
//
// Why not CSV: a CSV cell has no type, so Excel guesses, and it guesses
// differently on different machines. A resident reference of 0142 opens as
// 142, a date moves with the opener's locale, a long identity number becomes
// scientific notation, and a value beginning "=" is a formula — which is the
// only reason lib/csv.js needs its apostrophe guard at all. In xlsx every
// cell states its type, so all four stop being possible rather than being
// defended against.
//
// Why no library: an .xlsx is a zip of XML parts, and Node ships zlib, which
// gives both the deflate and (since 20.12) the crc32 the container needs. The
// service runs Node 22 and keeps exactly four runtime dependencies; a
// formatting convenience is not worth thirty transitive packages in a system
// holding children's dates of birth.
const zlib = require('zlib');

// The zip format wants a DOS date and time. Fixed rather than "now", so the
// same rows always produce a byte-identical file and the tests can say so.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

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
    local.writeUInt16LE(20, 4);           // version needed to extract
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
    dir.writeUInt32LE(offset, 42);        // where this entry's local header is
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

// Excel counts days from 1899-12-30 — the Lotus leap-year bug, preserved for
// compatibility ever since.
const EPOCH = Date.UTC(1899, 11, 30);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function serial(iso) {
  return Math.round((Date.parse(iso + 'T00:00:00Z') - EPOCH) / 86400000);
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Excel refuses a file containing these outright rather than ignoring
    // them, and a note typed on a tablet can carry one.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function col(n) {                         // 0 -> A, 25 -> Z, 26 -> AA
  let s = '';
  for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  }
  return s;
}

// s="1" is the bold header style, s="2" the date format; both are defined in
// styles.xml below. A cell with no s= takes the default.
function cell(ref, value, header) {
  if (header) return `<c r="${ref}" s="1" t="inlineStr"><is><t>${esc(value)}</t></is></c>`;
  if (value === null || value === undefined || value === '') return `<c r="${ref}"/>`;
  if (value instanceof Date) return `<c r="${ref}" s="2"><v>${serial(value.toISOString().slice(0, 10))}</v></c>`;
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
  const s = String(value);
  if (ISO_DATE.test(s)) return `<c r="${ref}" s="2"><v>${serial(s)}</v></c>`;
  // Everything else is a string cell. This is what keeps 0142 as 0142, and
  // what makes a value beginning "=" inert: a formula in xlsx is an
  // explicitly marked cell type, never inferred from the text.
  return `<c r="${ref}" t="inlineStr"><is><t>${esc(s)}</t></is></c>`;
}

function xlsx(rows, { sheetName = 'Report' } = {}) {
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const lines = [];

  if (cols.length) {
    lines.push('<row r="1">' + cols.map((c, i) => cell(col(i) + '1', c, true)).join('') + '</row>');
    rows.forEach((r, n) => {
      const ref = n + 2;
      lines.push(`<row r="${ref}">` + cols.map((c, i) => cell(col(i) + ref, r[c], false)).join('') + '</row>');
    });
  }

  // Width is roughly characters. The cap stops one long note producing a
  // column nobody can scroll past; the floor keeps a short heading readable.
  const widths = cols.map((c) => {
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

  // An autoFilter over a range that does not exist makes Excel refuse the
  // file, so an empty report gets none.
  const filter = cols.length
    ? `<autoFilter ref="A1:${col(cols.length - 1)}${rows.length + 1}"/>`
    : '';

  const sheet =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView workbookViewId="0">' +
    '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
    '</sheetView></sheetViews>' +
    colsXml +
    `<sheetData>${lines.join('')}</sheetData>` +
    filter +
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
  // and one opened elsewhere each render it the way that machine expects.
  // That is the opposite of the CSV failure: there the TEXT was reinterpreted
  // and the underlying day changed; here the value is a number and only its
  // display varies.
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

module.exports = { xlsx, _zipSync: zipSync };
