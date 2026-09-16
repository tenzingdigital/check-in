// The .docx writer. Run:  node test/docx.test.js
/* ============================================================================

   lib/docx.js writes a Word document as a zip of XML parts with no
   dependency, like lib/xlsx.js. Word gives no useful message for a file it
   rejects, so the container and the parts are checked directly: the entries
   are the ones Word needs, text is escaped, and the two run properties the
   Sunday document depends on — the yellow highlight and the underline — are
   actually emitted. Plain throws, no framework, no database: check.sh layer 1.
   ========================================================================= */

const assert = require('assert/strict');
const zlib = require('zlib');
const { docx, DOCX_CONTENT_TYPE } = require('../lib/docx');

// Read the stored (uncompressed or deflated) entries back out of the zip so
// the parts can be asserted on as text.
function entries(buf) {
  const out = {};
  let off = 0;
  while (buf.readUInt32LE(off) === 0x04034b50) {
    const method = buf.readUInt16LE(off + 8);
    const csize = buf.readUInt32LE(off + 18);
    const nlen = buf.readUInt16LE(off + 26), xlen = buf.readUInt16LE(off + 28);
    const name = buf.subarray(off + 30, off + 30 + nlen).toString('utf8');
    const data = buf.subarray(off + 30 + nlen + xlen, off + 30 + nlen + xlen + csize);
    out[name] = (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
    off += 30 + nlen + xlen + csize;
  }
  return out;
}

const blocks = [
  { kind: 'title', text: 'Weekly Register Update' },
  { kind: 'subtitle', text: 'Slaney · Week ending Saturday 12 September 2026' },
  { kind: 'underline', text: 'Updates for the period between Sunday 6 September 2026 and Saturday 12 September 2026' },
  { kind: 'heading', text: 'Resident Absences:' },
  { kind: 'bullet', text: 'Smith & Sons <B1> was absent. Approved by management.' },
  { kind: 'bullet', text: 'Jane Doe was absent. Not approved. Please mark as unauthorised absence.', highlight: true },
  { kind: 'para', text: 'Produced by CheckSteady.' },
];
const buf = docx(blocks);

assert.equal(buf.subarray(0, 2).toString(), 'PK', 'zip starts with PK');
assert.equal(DOCX_CONTENT_TYPE, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

const parts = entries(buf);
assert.deepEqual(Object.keys(parts).sort(), [
  '[Content_Types].xml', '_rels/.rels', 'word/_rels/document.xml.rels', 'word/document.xml', 'word/styles.xml',
], 'exactly the parts Word needs');
assert.match(parts['[Content_Types].xml'], /wordprocessingml\.document\.main\+xml/);
assert.match(parts['_rels/.rels'], /Target="word\/document\.xml"/);

const doc = parts['word/document.xml'];
assert.match(doc, /^<\?xml version="1\.0" encoding="UTF-8" standalone="yes"\?>/);
assert.match(doc, /<w:document xmlns:w="http:\/\/schemas\.openxmlformats\.org\/wordprocessingml\/2006\/main">/);
assert.ok(doc.includes('Smith &amp; Sons &lt;B1&gt; was absent.'), 'text is XML-escaped');
assert.ok(!doc.includes('<B1>'), 'no raw angle brackets from content');

// Title is bold and larger; heading is bold; underline carries w:u.
assert.match(doc, /<w:b\/><w:sz w:val="32"\/><\/w:rPr><w:t xml:space="preserve">Weekly Register Update<\/w:t>/);
assert.match(doc, /<w:b\/><\/w:rPr><w:t xml:space="preserve">Resident Absences:<\/w:t>/);
assert.match(doc, /<w:u w:val="single"\/><\/w:rPr><w:t xml:space="preserve">Updates for the period between/);

// Bullets: the glyph, a tab, then the text run; only the flagged one is highlighted.
const bullets = doc.match(/<w:p><w:pPr><w:spacing w:after="60"\/><w:ind w:left="720" w:hanging="360"\/>.*?<\/w:p>/g);
assert.equal(bullets.length, 2, 'two bullet paragraphs');
assert.match(bullets[0], /<w:t>•<\/w:t><\/w:r><w:r><w:tab\/><\/w:r><w:r><w:t xml:space="preserve">Smith/);
assert.ok(!bullets[0].includes('w:highlight'), 'an approved row is not highlighted');
assert.match(bullets[1], /<w:rPr><w:highlight w:val="yellow"\/><\/w:rPr><w:t xml:space="preserve">Jane Doe was absent\. Not approved\. Please mark as unauthorised absence\.<\/w:t>/);

// A4 page and the section properties Word requires to open the body.
assert.match(doc, /<w:sectPr><w:pgSz w:w="11906" w:h="16838"\/>/);
assert.match(parts['word/styles.xml'], /w:styleId="Normal"/);

// Deterministic: the same blocks give the same bytes (the zip uses a fixed
// timestamp, like the spreadsheet writer).
assert.ok(buf.equals(docx(blocks)), 'byte-identical for identical input');

// Unknown kinds are a programming error, not silently a paragraph.
assert.throws(() => docx([{ kind: 'table', text: 'x' }]), /unknown block kind/);

// esc() strips XML-illegal control characters, not just entity-escapes them (lib/xlsx.js parity).
const ctrlDoc = entries(docx([{ kind: 'para', text: 'A\x0Bname' }]))['word/document.xml'];
assert.ok(ctrlDoc.includes('Aname') && !ctrlDoc.includes('\x0B'), 'control characters are stripped from text');

console.log('PASS: docx writer — container, parts, escaping, highlight, underline, determinism.');
