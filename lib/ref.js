// lib/ref.js — the resident reference, both directions.
//
// Stored as an integer from resident_ref_seq (migration 040), shown
// zero-padded to four digits. The two directions have to agree: what a person
// reads off a record or an export must resolve back to the same row when they
// type it into a spreadsheet, whether or not they keep the leading zeros.
//
// parseRef is the load-bearing half. A reference that fails to resolve becomes
// an import error, which is recoverable; one that resolves to the WRONG thing
// updates the wrong resident, which is not. So anything that is not plainly a
// positive whole number is null — never 0, never NaN, both of which would sit
// in a conditional looking almost like a valid answer.
const PAD = 4;

function formatRef(n) {
  if (n === null || n === undefined || n === '') return '';
  const v = Number(n);
  if (!Number.isInteger(v) || v <= 0) return '';
  return String(v).padStart(PAD, '0');
}

function parseRef(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!/^\d+$/.test(s)) return null;      // digits only: no signs, no decimals
  const v = Number(s);
  return Number.isInteger(v) && v > 0 ? v : null;
}

module.exports = { formatRef, parseRef };
