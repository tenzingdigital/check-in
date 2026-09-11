// lib/csv.js — rows to CSV, the way the reports have always written it: a
// header from the first row's keys, RFC 4180 quoting, CRLF line ends, and
// dates as ISO strings. Shared by the reports and a resident's history export.
function csv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    let s = v instanceof Date ? v.toISOString() : String(v);
    // These files exist to be opened in Excel by an inspector, so a cell that
    // begins like a formula is executable content, not text: a resident named
    // `=HYPERLINK(...)`, or a room note beginning `+`, fires on open. The
    // reports now carry staff-typed free text — room and roll-call notes, a
    // breach reference — so the payload path is real. An apostrophe is how
    // Excel and LibreOffice are told "this is a literal". Applied before the
    // quoting test below, so a value starting with CR still quotes correctly.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n') + '\r\n';
}

module.exports = { csv };
