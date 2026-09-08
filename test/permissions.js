// test/permissions.js — the permission matrix: who may do what.
//
// One row per thing a person can do through the API, one expectation per
// role. This file is the single source for two things that must never
// disagree:
//
//   * docs/PERMISSIONS.md, generated from it by tools/gen-permissions-doc.js
//     (check.sh fails if the document is stale);
//   * the "permission matrix" section of the HTTP suite, which makes every
//     request in every row as every role and holds the server to the
//     expectation here.
//
// Expectations:
//   allow    the role may do it (any answer but 401, 403, 404 or 500 — the
//            request may still fail validation, that is not the question)
//   deny     refused, 403
//   unauth   must log in first, 401
//   hidden   404: the row policy makes the record not exist for that role
//
// "platform" is a platform administrator, who is also an ordinary admin of
// their own site: where a row says nothing about them they behave as an admin.
//
// path and body take the fixtures object the test builds (ids of a resident,
// a building, a room, a roll call, a staff account, a centre). A row with
// `fresh` consumes its fixture when allowed (an erasure, a deletion, ending a
// roll call), so the test makes a fresh one before each allowed attempt.

const crypto = require('crypto');

const STAFF = { anon: 'unauth', guard: 'allow', supervisor: 'allow', admin: 'allow' };
const SUPERVISOR = { anon: 'unauth', guard: 'deny', supervisor: 'allow', admin: 'allow' };
const ADMIN = { anon: 'unauth', guard: 'deny', supervisor: 'deny', admin: 'allow' };
const PLATFORM = { anon: 'unauth', guard: 'deny', supervisor: 'deny', admin: 'deny', platform: 'allow' };
const ANYONE = { anon: 'allow', guard: 'allow', supervisor: 'allow', admin: 'allow' };

const dob = '1990-01-01';

module.exports = [
  // ---- own account -------------------------------------------------------
  { area: 'Own account', name: 'Who am I (session, settings, feature switches)', method: 'GET', path: () => '/api/session', expect: STAFF },
  { area: 'Own account', name: 'Is the nightly job on time (health banner)', method: 'GET', path: () => '/api/session/health', expect: STAFF },
  { area: 'Own account', name: 'Log out', method: 'DELETE', path: () => '/api/session', expect: ANYONE, note: 'Ends the session cookie; harmless when there is none', endsSession: true },
  { area: 'Own account', name: 'Ask for a password-reset link', method: 'POST', path: () => '/api/password-reset', body: () => ({ email: 'nobody@hut.example' }), expect: ANYONE, note: 'Same answer whether or not the address exists' },

  // ---- the gate and the register (every staff member) ---------------------
  { area: 'Gate and register', name: 'Search residents (name, age, state; never the ID number)', method: 'GET', path: () => '/api/residents?q=a&compliance=1', expect: STAFF },
  { area: 'Gate and register', name: "Open a resident's detail sheet (the ID number; logged)", method: 'GET', path: (fx) => `/api/residents/${fx.residentId}/compliance`, expect: STAFF },
  { area: 'Gate and register', name: 'The 30-day strip under the sheet', method: 'GET', path: (fx) => `/api/residents/${fx.residentId}/days`, expect: STAFF },
  { area: 'Gate and register', name: "A resident's household members", method: 'GET', path: (fx) => `/api/residents/${fx.residentId}/household`, expect: STAFF },
  { area: 'Gate and register', name: "A resident's history: every movement and check-in over a range", method: 'GET', path: (fx) => `/api/residents/${fx.residentId}/history`, expect: STAFF },
  { area: 'Gate and register', name: 'The movement log over a range, filtered by name or room', method: 'GET', path: () => '/api/gate-events?from=2026-01-01&to=2026-01-07&q=a', expect: STAFF },
  { area: 'Gate and register', name: 'Who is on site now (summary)', method: 'GET', path: () => '/api/summary', expect: STAFF },
  { area: 'Gate and register', name: "The day's movement log", method: 'GET', path: () => '/api/gate-events', expect: STAFF },
  { area: 'Gate and register', name: 'Sign a resident in or out at the gate', method: 'POST', path: () => '/api/gate-events', body: (fx) => ({ resident_id: fx.residentId, direction: 'in' }), expect: STAFF },
  { area: 'Gate and register', name: 'Record the daily check-in', method: 'POST', path: () => '/api/checkins', body: (fx) => ({ resident_id: fx.residentId }), expect: STAFF },
  { area: 'Gate and register', name: 'The register counts (not seen, missed days, seen today)', method: 'GET', path: () => '/api/checkin-summary', expect: STAFF },
  { area: 'Gate and register', name: 'The attention list (open breaches, worst first)', method: 'GET', path: () => '/api/attention', expect: STAFF },
  { area: 'Gate and register', name: 'Replay events recorded while offline', method: 'POST', path: () => '/api/sync', body: () => ({ events: [] }), expect: STAFF },
  { area: 'Gate and register', name: "Read the site's settings", method: 'GET', path: () => '/api/settings', expect: STAFF },
  { area: 'Gate and register', name: 'Buildings, rooms and who is in them', method: 'GET', path: () => '/api/buildings', expect: STAFF },

  // ---- evacuation and roll call (every staff member) -----------------------
  { area: 'Evacuation and roll call', name: 'The evacuation list (needs-assistance first)', method: 'GET', path: () => '/api/evacuation', expect: STAFF },
  { area: 'Evacuation and roll call', name: 'The roll call in progress, if any', method: 'GET', path: () => '/api/roll-calls/active', expect: STAFF },
  { area: 'Evacuation and roll call', name: 'Past drills and incidents', method: 'GET', path: () => '/api/roll-calls', expect: STAFF },
  { area: 'Evacuation and roll call', name: 'Start a roll call', method: 'POST', path: () => '/api/roll-calls', body: () => ({ id: crypto.randomUUID(), kind: 'drill' }), expect: STAFF },
  { area: 'Evacuation and roll call', name: 'Tick a person at the assembly point', method: 'POST', path: (fx) => `/api/roll-calls/${fx.rollCallId}/marks`, body: (fx) => ({ resident_id: fx.residentId }), expect: STAFF },
  { area: 'Evacuation and roll call', name: 'Mark a visitor or contractor safe', method: 'POST', path: (fx) => `/api/roll-calls/${fx.rollCallId}/visit-marks`, body: (fx) => ({ visit_id: fx.visitId }), expect: STAFF },
  { area: 'Evacuation and roll call', name: 'End a roll call', method: 'POST', path: (fx) => `/api/roll-calls/${fx.rollCallId}/end`, body: () => ({}), expect: STAFF, fresh: 'rollcall' },

  // ---- visitors (every staff member) ---------------------------------------
  { area: 'Visitors', name: "Today's visitors, staff and contractors, and who is still on site", method: 'GET', path: () => '/api/visits', expect: STAFF },
  { area: 'Visitors', name: 'Sign a visitor, contractor, supplier or staff member in', method: 'POST', path: () => '/api/visits', body: () => ({ kind: 'contractor', name: 'Matrix Electrician', company: 'Sparks Ltd' }), expect: STAFF },
  { area: 'Visitors', name: 'Sign them out', method: 'POST', path: (fx) => `/api/visits/${fx.visitId}/leave`, body: () => ({}), expect: STAFF, fresh: 'visit' },

  // ---- residents and buildings (supervisors and admins) --------------------
  { area: 'Residents and buildings', name: 'Add a resident', method: 'POST', path: () => '/api/residents', body: () => ({ first_name: 'Matrix', last_name: `Row${crypto.randomInt(1e6)}`, date_of_birth: dob }), expect: SUPERVISOR },
  { area: 'Residents and buildings', name: 'Import residents from a spreadsheet (preview and for real)', method: 'POST', path: () => '/api/residents/import', body: () => ({ dry_run: true, rows: [{ first_name: 'Sheet', last_name: 'Row', date_of_birth: '01/01/1990' }] }), expect: SUPERVISOR },
  { area: 'Residents and buildings', name: "Change a resident's details, room, need or family", method: 'PATCH', path: (fx) => `/api/residents/${fx.residentId}`, body: () => ({ first_name: 'Matrix' }), expect: SUPERVISOR },
  { area: 'Residents and buildings', name: "Open a resident's full record (date of birth, the edit sheet; logged)", method: 'GET', path: (fx) => `/api/residents/${fx.residentId}/record`, expect: { anon: 'unauth', guard: 'hidden', supervisor: 'allow', admin: 'allow' }, note: 'A guard reads residents through a view that carries age, never the date of birth; the table itself does not exist for them' },
  { area: 'Residents and buildings', name: 'Add a building', method: 'POST', path: () => '/api/buildings', body: () => ({ name: `Wing ${crypto.randomInt(1e6)}` }), expect: SUPERVISOR },
  { area: 'Residents and buildings', name: 'Rename or reorder a building', method: 'PATCH', path: (fx) => `/api/buildings/${fx.buildingId}`, body: () => ({ name: `Wing ${crypto.randomInt(1e6)}` }), expect: SUPERVISOR },
  { area: 'Residents and buildings', name: 'Remove an empty building', method: 'DELETE', path: (fx) => `/api/buildings/${fx.buildingId}`, expect: SUPERVISOR, fresh: 'building' },
  { area: 'Residents and buildings', name: 'Add rooms to a building', method: 'POST', path: (fx) => `/api/buildings/${fx.buildingId}/rooms`, body: () => ({ rooms: [{ number: String(crypto.randomInt(1e6)), capacity: 2 }] }), expect: SUPERVISOR },
  { area: 'Residents and buildings', name: "Change a room's number, floor or capacity", method: 'PATCH', path: (fx) => `/api/rooms/${fx.roomId}`, body: () => ({ capacity: 3 }), expect: SUPERVISOR },
  { area: 'Residents and buildings', name: 'Remove an empty room', method: 'DELETE', path: (fx) => `/api/rooms/${fx.roomId}`, expect: SUPERVISOR, fresh: 'room' },

  // ---- reports (supervisors and admins; one is the admin's) ---------------
  { area: 'Reports', name: 'See which reports exist', method: 'GET', path: () => '/api/reports', expect: STAFF },
  { area: 'Reports', name: 'Export a report (register, attendance, movements, occupancy, evacuation, drills); logged', method: 'GET', path: (fx) => `/api/reports/register?from=${fx.today}&to=${fx.today}&reason=matrix&format=json`, expect: SUPERVISOR },
  { area: 'Reports', name: 'Who viewed which record (the access log)', method: 'GET', path: (fx) => `/api/reports/access?from=${fx.today}&to=${fx.today}&reason=matrix&format=json`, expect: ADMIN },

  // ---- the resident's rights and the site (admins) ------------------------
  { area: 'Administration', name: "Export a resident's whole record (Art. 15); logged", method: 'GET', path: (fx) => `/api/residents/${fx.residentId}/export?reason=matrix`, expect: ADMIN },
  { area: 'Administration', name: 'Erase a resident and their history (Art. 17)', method: 'DELETE', path: (fx) => `/api/residents/${fx.residentId}`, body: (fx) => ({ reason: 'matrix', confirm_name: fx.residentName }), expect: ADMIN, fresh: 'resident' },
  { area: 'Administration', name: "Change the site's settings, retention and feature switches", method: 'PATCH', path: () => '/api/settings', body: () => ({ site_name: 'Matrix Site' }), expect: ADMIN },
  { area: 'Administration', name: 'List staff accounts', method: 'GET', path: () => '/api/staff', expect: STAFF, note: 'Names, roles and last sign-in; no more than the header of the app already shows' },
  { area: 'Administration', name: 'Invite a staff member', method: 'POST', path: () => '/api/staff', body: () => ({ email: `m${crypto.randomInt(1e9)}@hut.example`, full_name: 'Matrix Staff', role: 'guard' }), expect: ADMIN },
  { area: 'Administration', name: 'Send a staff member a login link', method: 'POST', path: (fx) => `/api/staff/${fx.staffId}/link`, body: () => ({}), expect: ADMIN },
  { area: 'Administration', name: 'Disable or re-enable a staff account', method: 'POST', path: (fx) => `/api/staff/${fx.staffId}/active`, body: () => ({ active: true }), expect: ADMIN },
  { area: 'Administration', name: "Change a staff member's role", method: 'POST', path: (fx) => `/api/staff/${fx.staffId}/role`, body: () => ({ role: 'guard' }), expect: ADMIN },
  { area: 'Administration', name: "Set a staff member's password", method: 'POST', path: (fx) => `/api/staff/${fx.staffId}/password`, body: () => ({ password: 'a-fresh-long-password-12' }), expect: ADMIN },

  // ---- the organisation (platform administrators only) --------------------
  { area: 'Organisation', name: 'List every centre on the service', method: 'GET', path: () => '/api/tenants', expect: PLATFORM },
  { area: 'Organisation', name: 'Provision a new centre', method: 'POST', path: () => '/api/tenants', body: () => { const n = crypto.randomInt(1e6); return { name: `Centre ${n}`, slug: `centre-${n}`, admin_name: 'First Admin', admin_email: `first${n}@hut.example` }; }, expect: PLATFORM },
  { area: 'Organisation', name: 'Close a centre (drops its schema)', method: 'DELETE', path: (fx) => `/api/tenants/${fx.tenantId}`, body: (fx) => ({ confirm_slug: fx.tenantSlug }), expect: PLATFORM, fresh: 'tenant' },
];

module.exports.ROLES = ['anon', 'guard', 'supervisor', 'admin', 'platform'];
module.exports.expectFor = (row, role) => row.expect[role] || (role === 'platform' ? row.expect.admin : undefined);
