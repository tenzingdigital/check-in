// The .xlsx writer. Run:  node test/xlsx.test.js
/* ============================================================================

   lib/xlsx.js writes a workbook as a zip of XML parts with no dependency, so
   there is no library to trust and the file has to be checked directly. A zip
   Excel rejects gives no useful message — it just refuses to open — so the
   container's CRCs and sizes are asserted against the real data rather than
   assumed, and every cell's TYPE is asserted, because types are the entire
   reason for preferring this format to CSV.

   Assertions are plain throws, following test/mail.test.js: no framework, no
   cluster, no database, so this runs in check.sh layer 1.
   ========================================================================= */

const assert = require('assert/strict');
const zlib = require('zlib');
const { xlsx, _zipSync } = require('../lib/xlsx');

/* ---------------------------------------------------------------- container */

const buf = _zipSync([
  { name: 'a.xml', data: Buffer.from('<a/>') },
  { name: 'b/c.xml', data: Buffer.from('<c>hello</c>') },
]);

assert.equal(buf.subarray(0, 2).toString(), 'PK', 'zip starts with PK');

const eocd = buf.length - 22;
assert.equal(buf.readUInt32LE(eocd), 0x06054b50, 'end-of-central-directory signature');
assert.equal(buf.readUInt16LE(eocd + 10), 2, 'two entries in the directory');

assert.equal(buf.readUInt32LE(0), 0x04034b50, 'local file header signature');
const first = Buffer.from('<a/>');
assert.equal(buf.readUInt32LE(14), zlib.crc32(first), 'crc32 of entry 1');
assert.equal(buf.readUInt32LE(22), first.length, 'uncompressed size of entry 1');

console.log('ok  zip container');

/* -------------------------------------------------------------- typed cells */

// Read a named entry back out of a zip we just wrote.
function entry(zip, want) {
  let i = 0;
  while (i + 30 < zip.length && zip.readUInt32LE(i) === 0x04034b50) {
    const nameLen = zip.readUInt16LE(i + 26);
    const extraLen = zip.readUInt16LE(i + 28);
    const comp = zip.readUInt32LE(i + 18);
    const name = zip.subarray(i + 30, i + 30 + nameLen).toString();
    const start = i + 30 + nameLen + extraLen;
    if (name === want) return zlib.inflateRawSync(zip.subarray(start, start + comp)).toString();
    i = start + comp;
  }
  throw new Error('no entry ' + want);
}

const book = xlsx([
  { ref: '0142', name: '=HYPERLINK("http://evil","x")', count: 7, when: '2026-09-11' },
], { sheetName: 'Test' });

const sheet = entry(book, 'xl/worksheets/sheet1.xml');

assert.match(sheet, /t="inlineStr"><is><t>0142<\/t>/, '0142 stays text, not 142');
assert.ok(!/<f>/.test(sheet), 'no formula cells anywhere');
assert.match(sheet, /=HYPERLINK/, 'the formula-shaped value is present as inert text');
assert.match(sheet, /<c r="C2"><v>7<\/v><\/c>/, '7 is a number cell');
assert.match(sheet, /<c r="D2" s="2"><v>46276<\/v><\/c>/, '2026-09-11 is a date cell');

console.log('ok  typed cells');

/* ------------------------------------------------------------- presentation */

const wide = xlsx([
  { ref: '0001', note: 'x'.repeat(400) },
  { ref: '0002', note: 'short' },
], { sheetName: 'Wide' });
const wideSheet = entry(wide, 'xl/worksheets/sheet1.xml');

assert.match(wideSheet, /<pane ySplit="1"[^>]*state="frozen"/, 'header row frozen');
assert.match(wideSheet, /<autoFilter ref="A1:B3"\/>/, 'autofilter across the used range');
assert.match(wideSheet, /<cols>/, 'column widths present');

const widths = [...wideSheet.matchAll(/width="([\d.]+)"/g)].map((m) => Number(m[1]));
assert.ok(widths.every((w) => w <= 60), 'no column wider than the cap, got ' + widths.join(','));
assert.ok(widths.some((w) => w > 5), 'a column is sized to its content');

console.log('ok  presentation');

/* ------------------------------------------------------------- empty report */

// A report with no rows must still open. Excel refuses a sheet with an
// autoFilter over a range that does not exist.
const none = xlsx([], { sheetName: 'Empty' });
assert.equal(none.subarray(0, 2).toString(), 'PK', 'an empty report is still a workbook');
console.log('ok  empty report');
