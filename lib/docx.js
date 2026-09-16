// A Word document (.docx) written by hand, for the Sunday Weekly Register
// Update (lib/weeklyReport.js document()). The same reasoning as lib/xlsx.js:
// a .docx is a zip of XML parts, the document needs six kinds of paragraph
// and nothing else, and a hand-written writer means no dependency to trust
// and byte-identical output the tests can assert on.
//
//   docx(blocks) -> Buffer
//
// blocks: [{ kind, text, highlight }]
//   kind       'title' | 'subtitle' | 'heading' | 'para' | 'underline' | 'bullet'
//   highlight  bullets only: true paints the text run yellow, the way the
//              centre manager marks the absences head office must act on
//
// Bullets are indented paragraphs with a "•" glyph and a tab, not Word
// numbering, so there is no numbering.xml to keep consistent. Every string
// is XML-escaped here; callers pass plain text.

const { _zipSync: zipSync } = require('./xlsx');

const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function esc(s) {
  return String(s ?? '')
    // Word refuses a file containing these outright rather than ignoring
    // them, and a note typed on a tablet can carry one (lib/xlsx.js esc()).
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// One run: optional run properties, then the text. xml:space="preserve"
// keeps a leading or trailing space Word would otherwise drop.
function run(text, rPr = '') {
  return `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

function paragraph(block) {
  switch (block.kind) {
    case 'title':
      return `<w:p><w:pPr><w:spacing w:after="60"/></w:pPr>${run(block.text, '<w:b/><w:sz w:val="32"/>')}</w:p>`;
    case 'subtitle':
      return `<w:p><w:pPr><w:spacing w:after="240"/></w:pPr>${run(block.text, '<w:color w:val="5B6478"/>')}</w:p>`;
    case 'heading':
      return `<w:p><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/></w:pPr>${run(block.text, '<w:b/>')}</w:p>`;
    case 'underline':
      return `<w:p>${run(block.text, '<w:u w:val="single"/>')}</w:p>`;
    case 'para':
      return `<w:p>${run(block.text)}</w:p>`;
    case 'bullet':
      return '<w:p><w:pPr><w:spacing w:after="60"/><w:ind w:left="720" w:hanging="360"/></w:pPr>' +
        '<w:r><w:t>•</w:t></w:r><w:r><w:tab/></w:r>' +
        run(block.text, block.highlight ? '<w:highlight w:val="yellow"/>' : '') +
        '</w:p>';
    default:
      throw new Error(`docx: unknown block kind "${block.kind}"`);
  }
}

function docx(blocks) {
  const body = blocks.map(paragraph).join('');
  const document =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<w:document xmlns:w="${W}"><w:body>${body}` +
    // A4, 2.54 cm margins — the sectPr is required for Word to open the body.
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>' +
    '</w:body></w:document>';

  const styles =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<w:styles xmlns:w="${W}">` +
    '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:lang w:val="en-IE"/></w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
    '</w:styles>';

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '</Types>';

  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';

  const documentRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>';

  const part = (name, xml) => ({ name, data: Buffer.from(xml, 'utf8') });
  return zipSync([
    part('[Content_Types].xml', contentTypes),
    part('_rels/.rels', rels),
    part('word/_rels/document.xml.rels', documentRels),
    part('word/document.xml', document),
    part('word/styles.xml', styles),
  ]);
}

module.exports = { docx, DOCX_CONTENT_TYPE };
