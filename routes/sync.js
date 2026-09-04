// Replay of events a terminal recorded while it was offline.
//
// The front end queues gate events and check-ins in encrypted browser storage
// when the link is down and sends them here when it returns. Each item carries
// the terminal's timestamp and a client_ref it minted itself; the database
// functions (migrations/010_offline_sync.sql) bound the timestamp, flag the
// row as a late entry, and treat a repeated client_ref as already done.
//
// Same posture as every other router: thin transport, no authorisation here.
// Identity comes from the session through withIdentity(); the functions
// re-check is_staff() and take auth.uid() themselves.
//
// One transaction PER ITEM, on purpose. A batch is a set of independent facts
// from a shift, and one that the database refuses — a resident departed since,
// a timestamp outside the window — must not take the others down with it. The
// response says what happened to each, by ref, so the terminal can drop what
// was recorded and keep showing what was not (Tao 2: never destroy proof that
// somebody attended).
const express = require('express');
const { wrap } = require('../lib/asyncRoute');
const db = require('../database');
const { HttpError, translateDbError } = require('../lib/api');

const router = express.Router();

// A shift's worth, with room to spare. The client sends in pages of this size.
const MAX_BATCH = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Validate one queued item into the exact arguments the SQL function takes,
// or explain why it never will. Throws HttpError(400) with a message written
// for the guard who will see it next to the resident's name.
function parseItem(raw) {
  const item = raw && typeof raw === 'object' ? raw : {};
  const ref = String(item.ref || '');
  if (!UUID_RE.test(ref)) throw new HttpError(400, 'ref must be a uuid');

  const kind = String(item.kind || '');
  if (!['checkin', 'gate', 'rollcall_start', 'rollcall_mark', 'rollcall_end'].includes(kind)) {
    throw new HttpError(400, "kind must be 'checkin', 'gate', 'rollcall_start', 'rollcall_mark' or 'rollcall_end'");
  }

  const at = new Date(String(item.occurred_at || ''));
  if (Number.isNaN(at.getTime())) throw new HttpError(400, 'occurred_at must be a timestamp');

  // Roll-call items (migration 017) carry the roll call's id, chosen by the
  // terminal so one started offline keeps its identity.
  if (kind.startsWith('rollcall_')) {
    const rollCallId = String(item.roll_call_id || '');
    if (!UUID_RE.test(rollCallId)) throw new HttpError(400, 'roll_call_id must be a uuid');
    let rcKind = null, residentId = null;
    if (kind === 'rollcall_start') {
      rcKind = String(item.rc_kind || '');
      if (rcKind !== 'drill' && rcKind !== 'incident') throw new HttpError(400, "rc_kind must be 'drill' or 'incident'");
    }
    if (kind === 'rollcall_mark') {
      residentId = String(item.resident_id || '');
      if (!UUID_RE.test(residentId)) throw new HttpError(400, 'resident_id must be a uuid');
    }
    return { ref, kind, rollCallId, rcKind, residentId, occurredAt: at.toISOString() };
  }

  const residentId = String(item.resident_id || '');
  if (!UUID_RE.test(residentId)) throw new HttpError(400, 'resident_id must be a uuid');

  let direction = null;
  if (kind === 'gate') {
    direction = String(item.direction || '');
    if (direction !== 'in' && direction !== 'out') throw new HttpError(400, "direction must be 'in' or 'out'");
  }

  return { ref, kind, residentId, direction, occurredAt: at.toISOString() };
}

// POST /api/sync  { events: [{ ref, kind, resident_id, direction?, occurred_at }] }
//   → { results: [{ ref, status: 'ok' | 'rejected', error? }] }
//
// 'ok' means the database now holds this event (or already did — a replay is
// answered 'ok' too, which is what lets the terminal retry a sync whose
// response was lost). 'rejected' means it never will, and says why.
router.post('/sync', wrap(async (req, res) => {
  const events = req.body && Array.isArray(req.body.events) ? req.body.events : null;
  if (!events) throw new HttpError(400, 'events must be an array');
  if (events.length > MAX_BATCH) throw new HttpError(400, `Send at most ${MAX_BATCH} events per request`);

  const results = [];
  for (const raw of events) {
    // The ref is echoed back even when the item is malformed, so the client
    // can match the verdict to the queue entry. A missing ref is the one case
    // it cannot, and the client treats an unmatched entry as still pending.
    const echoRef = raw && typeof raw === 'object' && typeof raw.ref === 'string' ? raw.ref : null;

    let item;
    try {
      item = parseItem(raw);
    } catch (err) {
      results.push({ ref: echoRef, status: 'rejected', error: err.message });
      continue;
    }

    try {
      await db.withIdentity(req.session.userId, async (client) => {
        if (item.kind === 'rollcall_start') {
          await client.query('select public.start_roll_call($1, $2, $3)', [item.rollCallId, item.rcKind, item.occurredAt]);
        } else if (item.kind === 'rollcall_mark') {
          await client.query('select public.mark_roll_call($1, $2, $3, $4)', [item.rollCallId, item.residentId, item.ref, item.occurredAt]);
        } else if (item.kind === 'rollcall_end') {
          await client.query('select public.end_roll_call($1, $2)', [item.rollCallId, item.occurredAt]);
        } else if (item.kind === 'checkin') {
          await client.query(
            'select * from public.record_checkin_late($1, $2, $3)',
            [item.residentId, item.occurredAt, item.ref],
          );
        } else {
          await client.query(
            'select * from public.record_check_late($1, $2, $3, $4)',
            [item.residentId, item.direction, item.occurredAt, item.ref],
          );
        }
      });
      results.push({ ref: item.ref, status: 'ok' });
    } catch (err) {
      // Only the four SQLSTATEs the RPCs raise on purpose carry a message a
      // guard may read (lib/api.js). Anything else is an outage or a bug:
      // let it become a 500 so the whole batch is retried later, rather than
      // telling the terminal an event is permanently unrecordable.
      const translated = translateDbError(err);
      if (!(translated instanceof HttpError)) throw err;
      results.push({ ref: item.ref, status: 'rejected', error: translated.message });
    }
  }

  res.json({ results });
}));

module.exports = router;
