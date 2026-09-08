// lib/csv.js — rows to CSV, the way the reports have always written it: a
// header from the first row's keys, RFC 4180 quoting, CRLF line ends, and
// dates as ISO strings. Shared by the reports and a resident's history export.
function csv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    const s = v instanceof Date ? v.toISOString() : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n') + '\r\n';
}

module.exports = { csv };
