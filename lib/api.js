// lib/api.js — the small pieces every route in routes/ needs.
//
// HttpError is thrown by a handler and turned into a JSON response by the
// error handler in server.js, so a route never has to decide how an error is
// rendered — it only decides the status and the message.

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Postgres error codes the RPCs raise on purpose. Anything else is a bug or an
// outage, and must not have its message forwarded to the browser — a raw
// database error can carry column names, constraint definitions and row
// contents. These four are messages the RPC authors wrote for a guard to read.
const USER_FACING_SQLSTATES = new Set([
  '42501', // insufficient_privilege — "Not authorised to ..."
  'P0002', // no_data_found — "No register row for that resident and date"
  '22023', // invalid_parameter_value
  '23514', // check_violation
]);

function translateDbError(err) {
  if (USER_FACING_SQLSTATES.has(err.code)) return new HttpError(400, err.message);
  return err;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Malformed ids are rejected here rather than in Postgres. Letting a bad string
// reach the query means a 22P02 from the driver, which is a 500 and a stack
// trace for what is really a client mistake.
function uuidParam(value, field) {
  const v = String(value || '');
  if (!UUID_RE.test(v)) throw new HttpError(400, `${field} must be a uuid`);
  return v;
}

function intParam(value, fallback, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

function dateParam(value, field) {
  const v = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, `${field} must be YYYY-MM-DD`);
  return v;
}

module.exports = { HttpError, translateDbError, uuidParam, intParam, dateParam };
