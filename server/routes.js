"use strict";

/* ============================================================================
   routes.js — the API the two front ends call.

   Every handler is a thin wrapper: parse the request, call the same view or
   RPC the browser used to call directly through PostgREST, return the rows.
   There is deliberately no authorisation logic in this file beyond "is there a
   session at all" — the `where public.is_staff()` in each view and the
   role checks inside each SECURITY DEFINER function are still the things
   deciding what a caller may see, and they run inside withIdentity() exactly
   as they ran inside a Supabase request.

   The rule to hold onto when adding an endpoint: pass auth.uid() implicitly
   through withIdentity(), never accept a user or guard id as a parameter. The
   RPCs take the guard identity from auth.uid() precisely so that no argument
   can be used to act as somebody else.
   ========================================================================= */

import { withIdentity } from "./db.js";

const MAX_LOG_ROWS = 500;
const MAX_ATTENTION = 200;
const STRIP_DAYS = 30;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Malformed ids are rejected here rather than in Postgres. Letting a bad
// string reach the query means a 22P02 from the driver, which is a 500 and a
// stack trace for what is really a client mistake.
function uuidParam(value, field) {
  const v = String(value || "");
  if (!UUID_RE.test(v)) throw new HttpError(400, `${field} must be a uuid`);
  return v;
}

function intParam(value, fallback, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

// Postgres error codes the RPCs raise on purpose. Anything else is a bug or an
// outage, and must not have its message forwarded to the browser — a raw
// database error can carry column names, constraint definitions and row
// contents. These four are messages the RPC authors wrote for a guard to read.
const USER_FACING_SQLSTATES = new Set([
  "42501", // insufficient_privilege — "Not authorised to ..."
  "P0002", // no_data_found — "No register row for that resident and date"
  "22023", // invalid_parameter_value
  "23514", // check_violation
]);

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function translateDbError(err) {
  if (USER_FACING_SQLSTATES.has(err.code)) return new HttpError(400, err.message);
  return err;
}

/* ------------------------------------------------------------------------
   Handlers

   Each takes ({ session, query, body, params }) and returns a JSON-able value.
   ---------------------------------------------------------------------- */

// The gate app and the check-in app both call this on boot. It answers "who am
// I and what is this site called" in one round trip; the browser holds no
// token of its own, so this is also how a page decides whether to show the
// login form or the app.
export async function getSession({ session }) {
  return withIdentity(session.userId, async (client) => {
    const { rows } = await client.query(
      `select site_name, local_timezone, adult_age_years, due_soon_after_hour,
              event_retention_days, compliance_retention_days
         from public.app_settings limit 1`,
    );
    return {
      profile: { full_name: session.fullName, role: session.role },
      settings: rows[0] || null,
    };
  });
}

export async function getSummary({ session }) {
  return withIdentity(session.userId, async (client) => {
    const { rows } = await client.query(`select * from public.hut_summary()`);
    return rows[0] || { on_site: 0, events_today: 0 };
  });
}

// Resident search. `compliance=1` merges the matching v_resident_compliance
// rows in, which is what the check-in app needs on every card: the old client
// issued search_residents() and then a second `in (...)` query from the
// browser and merged them in JavaScript. Doing it in one transaction here is
// both fewer round trips and a consistent read.
export async function searchResidents({ session, query }) {
  const q = String(query.get("q") || "").trim();
  const limit = intParam(query.get("limit"), 20, 100);
  const wantCompliance = query.get("compliance") === "1";

  return withIdentity(session.userId, async (client) => {
    const { rows } = await client.query(
      `select * from public.search_residents($1, false, $2)`,
      [q, limit],
    );
    if (!wantCompliance || rows.length === 0) return rows;

    const { rows: comp } = await client.query(
      `select id, state, required_today, seen_today, checkins_today,
              open_breaches, noted_breaches, consecutive_missed, last_seen_on
         from public.v_resident_compliance
        where id = any($1::uuid[])`,
      [rows.map((r) => r.id)],
    );
    const byId = new Map(comp.map((c) => [c.id, c]));
    return rows.map((r) => ({ ...r, ...(byId.get(r.id) || {}) }));
  });
}

export async function getResidentCompliance({ session, params }) {
  return withIdentity(session.userId, async (client) => {
    const { rows } = await client.query(
      `select id, full_name, room_ref, age_years, required_today, seen_today,
              checkins_today, open_breaches, noted_breaches, consecutive_missed,
              last_seen_on, state
         from public.v_resident_compliance where id = $1`,
      [uuidParam(params.id, "resident id")],
    );
    if (!rows[0]) throw new HttpError(404, "No such resident");
    return rows[0];
  });
}

// The 30-day strip under the detail panel.
export async function getResidentDays({ session, params }) {
  return withIdentity(session.userId, async (client) => {
    const { rows } = await client.query(
      `select compliance_date, required, presented
         from public.daily_compliance
        where resident_id = $1
          and compliance_date >= (public.site_today() - ($2::integer - 1))
        order by compliance_date`,
      [uuidParam(params.id, "resident id"), STRIP_DAYS],
    );
    return rows;
  });
}

export async function recordGateEvent({ session, body }) {
  const direction = String(body.direction || "");
  if (direction !== "in" && direction !== "out") {
    throw new HttpError(400, "direction must be 'in' or 'out'");
  }
  return withIdentity(session.userId, async (client) => {
    const { rows } = await client.query(
      `select * from public.record_check($1, $2, $3)`,
      [uuidParam(body.resident_id, "resident_id"), direction, body.note ?? null],
    );
    if (!rows[0]) throw new HttpError(404, "Resident not found");
    return rows[0];
  });
}

// The day's movement log.
//
// The window is computed from app_settings.local_timezone rather than from the
// browser's clock, which is a small behaviour change from the Supabase client:
// it used to build the range in the terminal's local time. The site's timezone
// is the one the rest of the compliance model already uses (site_today()), and
// a terminal with a mis-set timezone should not be able to shift what "today's
// log" means.
export async function getGateLog({ session, query }) {
  const date = String(query.get("date") || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, "date must be YYYY-MM-DD");
  const limit = intParam(query.get("limit"), MAX_LOG_ROWS, MAX_LOG_ROWS);

  return withIdentity(session.userId, async (client) => {
    const { rows } = await client.query(
      `with s as (select local_timezone as tz from public.app_settings limit 1)
       select l.id, l.resident_id, l.kind, l.occurred_at, l.note,
              l.resident_name, l.room_ref, l.guard_id, l.guard_name
         from public.v_check_log l, s
        where l.occurred_at >= ($1::date)::timestamp at time zone s.tz
          and l.occurred_at <  (($1::date) + 1)::timestamp at time zone s.tz
        order by l.occurred_at desc
        limit $2`,
      [date, limit],
    );
    return rows;
  });
}

export async function getAttention({ session, query }) {
  const limit = intParam(query.get("limit"), MAX_ATTENTION, MAX_ATTENTION);
  return withIdentity(session.userId, async (client) => {
    const { rows } = await client.query(`select * from public.attention_list($1)`, [limit]);
    return rows;
  });
}

// The check-in app's header. Three separate Supabase calls became one.
//
// The counts are queried from v_resident_compliance rather than derived from
// the attention list, for the reason the old client documented at length:
// attention_list() only admits breach_open | breach_noted | never | due_today,
// so a resident who is required today but not yet past due_soon_after_hour
// would silently fall out of a count derived from it.
export async function getCheckinSummary({ session }) {
  return withIdentity(session.userId, async (client) => {
    const [attention, counts] = await Promise.all([
      client.query(`select * from public.attention_list($1)`, [MAX_ATTENTION]),
      client.query(
        `select count(*) filter (where seen_today)::integer as seen_today,
                count(*) filter (where required_today and not seen_today)::integer as not_seen
           from public.v_resident_compliance`,
      ),
    ]);
    return {
      attention: attention.rows,
      seen_today: counts.rows[0]?.seen_today ?? 0,
      not_seen: counts.rows[0]?.not_seen ?? 0,
    };
  });
}

export async function recordCheckin({ session, body }) {
  return withIdentity(session.userId, async (client) => {
    const { rows } = await client.query(
      `select * from public.record_checkin($1, $2)`,
      [uuidParam(body.resident_id, "resident_id"), body.note ?? null],
    );
    return rows[0];
  });
}

export async function annotateDay({ session, body }) {
  const date = String(body.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, "date must be YYYY-MM-DD");
  const note = String(body.note || "").trim();
  if (!note) throw new HttpError(400, "note cannot be empty");

  return withIdentity(session.userId, async (client) => {
    const { rows } = await client.query(
      `select * from public.annotate_compliance_day($1, $2, $3)`,
      [uuidParam(body.resident_id, "resident_id"), date, note],
    );
    return rows[0];
  });
}

/* ------------------------------------------------------------------------
   Route table
   ---------------------------------------------------------------------- */

// `:id` is the only pattern segment supported, which is all this API needs.
// Anything not listed here 404s before a database connection is taken.
export const ROUTES = [
  { method: "GET",  path: "/api/session",                    handler: getSession },
  { method: "GET",  path: "/api/summary",                    handler: getSummary },
  { method: "GET",  path: "/api/residents",                  handler: searchResidents },
  { method: "GET",  path: "/api/residents/:id/compliance",   handler: getResidentCompliance },
  { method: "GET",  path: "/api/residents/:id/days",         handler: getResidentDays },
  { method: "GET",  path: "/api/gate-events",                handler: getGateLog },
  { method: "POST", path: "/api/gate-events",                handler: recordGateEvent },
  { method: "GET",  path: "/api/attention",                  handler: getAttention },
  { method: "GET",  path: "/api/checkin-summary",            handler: getCheckinSummary },
  { method: "POST", path: "/api/checkins",                   handler: recordCheckin },
  { method: "POST", path: "/api/compliance-annotations",     handler: annotateDay },
];

export function matchRoute(method, pathname) {
  const parts = pathname.split("/").filter(Boolean);
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const want = route.path.split("/").filter(Boolean);
    if (want.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < want.length; i++) {
      if (want[i].startsWith(":")) params[want[i].slice(1)] = decodeURIComponent(parts[i]);
      else if (want[i] !== parts[i]) { ok = false; break; }
    }
    if (ok) return { route, params };
  }
  return null;
}
