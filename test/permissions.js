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
// The self check-in kiosk (migration 051 + the gate in lib/auth.js): a
// shared tablet, not staff. It may search for one adult and record its own
// check-in; supervisors and admins may exercise the same two doors, per
// kiosk_search()/kiosk_checkin()'s own guard. Everywhere else in this file,
// a row that says nothing about 'kiosk' means deny — see expectFor() below —
// because lib/auth.js's requireSession refuses that role every route but
// these two, plus reading and ending its own session.
const KIOSK = { anon: 'unauth', kiosk: 'allow', guard: 'deny', supervisor: 'allow', admin: 'allow' };

const dob = '1990-01-01';

module.exports = [
  // ---- own account -------------------------------------------------------
  { area: 'Own account', name: 'Who am I (session, settings, feature switches)', method: 'GET', path: () => '/api/session', expect: { ...STAFF, kiosk: 'allow' }, note: 'A kiosk session may read this too, so the tablet can learn its own role and the site name' },
  { area: 'Own account', name: 'Is the nightly job on time (health banner)', method: 'GET', path: () => '/api/session/health', expect: STAFF },
  { area: 'Own account', name: 'Log out', method: 'DELETE', path: () => '/api/session', expect: { ...ANYONE, kiosk: 'allow' }, note: 'Ends the session cookie; harmless when there is none', endsSession: true },
  { area: 'Own account', name: 'Ask for a password-reset link', method: 'POST', path: () => '/api/password-reset', body: () => ({ email: 'nobody@hut.example' }), expect: { ...ANYONE, kiosk: 'allow' }, note: 'Same answer whether or not the address exists; mounted ahead of the kiosk gate like every other unauthenticated route' },

  // ---- the self check-in kiosk (a shared tablet, not staff) ---------------
  { area: 'Self check-in tablet', name: 'Search for one adult resident by name, room or exact ID', method: 'POST', path: () => '/api/kiosk/search', body: () => ({ q: 'an' }), expect: KIOSK },
  { area: 'Self check-in tablet', name: 'Record my own daily check-in', method: 'POST', path: (fx) => '/api/kiosk/checkin', body: (fx) => ({ id: fx.residentId }), expect: KIOSK },

  // ---- the gate and the register (every staff member) ---------------------
  { area: 'Gate and register', name: 'Search residents (name, age, state; never the ID number)', method: 'GET', path: () => '/api/residents?q=a&compliance=1', expect: STAFF },
  { area: 'Gate and register', name: "Open a resident's detail sheet (the ID number; logged)", method: 'GET', path: (fx) => `/api/residents/${fx.residentId}/compliance`, expect: STAFF },
  { area: 'Gate and register', name: 'The 30-day strip under the sheet', method: 'GET', path: (fx) => `/api/residents/${fx.residentId}/days`, expect: STAFF },
  { area: 'Gate and register', name: "A resident's household members", method: 'GET', path: (fx) => `/api/residents/${fx.residentId}/household`, expect: STAFF },
  { area: 'Gate and register', name: "A resident's history: every movement and check-in over a range", method: 'GET', path: (fx) => `/api/residents/${fx.residentId}/history`, expect: STAFF },
  { area: 'Gate and register', name: "Export a resident's history as a file; logged", method: 'GET', path: (fx) => `/api/residents/${fx.residentId}/history?format=csv&reason=matrix`, expect: SUPERVISOR },
  { area: 'Gate and register', name: "A resident's authorised absences", method: 'GET', path: (fx) => `/api/residents/${fx.residentId}/absences`, expect: STAFF },
  { area: 'Gate and register', name: "A resident's room history", method: 'GET', path: (fx) => `/api/residents/${fx.residentId}/rooms`, expect: STAFF },
  { area: 'Gate and register', name: "A resident's breach reports", method: 'GET', path: (fx) => `/api/residents/${fx.residentId}/breaches`, expect: STAFF },
  { area: 'Gate and register', name: 'The movement log over a range, filtered by name or room', method: 'GET', path: () => '/api/gate-events?from=2026-01-01&to=2026-01-07&q=a', expect: STAFF },
  { area: 'Gate and register', name: 'Who is on site now (summary)', method: 'GET', path: () => '/api/summary', expect: STAFF },
  { area: 'Gate and register', name: "The day's movement log", method: 'GET', path: () => '/api/gate-events', expect: STAFF },
  { area: 'Gate and register', name: 'Sign a resident in or out at the gate', method: 'POST', path: () => '/api/gate-events', body: (fx) => ({ resident_id: fx.residentId, direction: 'in' }), expect: STAFF },
  { area: 'Gate and register', name: 'Record the daily check-in', method: 'POST', path: () => '/api/checkins', body: (fx) => ({ resident_id: fx.residentId }), expect: STAFF },
  { area: 'Gate and register', name: 'The register counts (not seen, missed days, seen today)', method: 'GET', path: () => '/api/checkin-summary', expect: STAFF },
  { area: 'Gate and register', name: 'The attention list (open breaches, worst first)', method: 'GET', path: () => '/api/attention', expect: STAFF },
  { area: 'Gate and register', name: 'Replay events recorded while offline', method: 'POST', path: () => '/api/sync', body: () => ({ events: [] }), expect: STAFF },
  { area: 'Gate and register', name: "Read the site's settings", method: 'GET', path: () => '/api/settings', expect: STAFF },
  { area: 'Gate and register', name: 'The permitted absence periods (Christmas, Ramadan, Easter, the summer school holiday)', method: 'GET', path: () => '/api/settings/absence-windows', expect: STAFF },
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
  { area: 'Visitors', name: 'The site staff list', method: 'GET', path: () => '/api/roster', expect: STAFF },
  { area: 'Visitors', name: 'Sign a listed staff member in with one tap', method: 'POST', path: () => '/api/visits', body: (fx) => ({ roster_id: fx.rosterId }), expect: STAFF, fresh: 'roster' },
  { area: 'Visitors', name: 'Add to the staff list (one, or a pasted list)', method: 'POST', path: () => '/api/roster', body: () => ({ name: `Matrix Cook ${crypto.randomInt(1e6)}`, role: 'Kitchen' }), expect: SUPERVISOR },
  { area: 'Visitors', name: 'Rename, retitle or archive a listed staff member', method: 'PATCH', path: (fx) => `/api/roster/${fx.rosterId}`, body: () => ({ role: 'Kitchen' }), expect: SUPERVISOR },

  // ---- residents and buildings (supervisors and admins) --------------------
  { area: 'Residents and buildings', name: 'Add a resident', method: 'POST', path: () => '/api/residents', body: () => ({ first_name: 'Matrix', last_name: `Row${crypto.randomInt(1e6)}`, date_of_birth: dob }), expect: SUPERVISOR },
  { area: 'Residents and buildings', name: 'Import residents from a spreadsheet (preview and for real)', method: 'POST', path: () => '/api/residents/import', body: () => ({ dry_run: true, rows: [{ first_name: 'Sheet', last_name: 'Row', date_of_birth: '01/01/1990' }] }), expect: SUPERVISOR },
  { area: 'Residents and buildings', name: 'Authorise an absence (a holiday, a family matter)', method: 'POST', path: (fx) => `/api/residents/${fx.residentId}/absences`, body: () => ({ from_date: '2030-01-01', to_date: '2030-01-03', reason: 'holiday' }), expect: SUPERVISOR, fresh: 'resident' },
  { area: 'Residents and buildings', name: 'Record that a breach report was issued to IPAS', method: 'POST', path: (fx) => `/api/residents/${fx.residentId}/breaches`, body: () => ({ kind: 'house_rules' }), expect: SUPERVISOR },
  { area: 'Residents and buildings', name: 'Cut an authorised absence short or cancel it', method: 'POST', path: (fx) => `/api/residents/${fx.residentId}/absences/${fx.absenceId}/end`, body: () => ({ last_day: '1900-01-01' }), expect: SUPERVISOR, fresh: 'absence' },
  { area: 'Residents and buildings', name: "Change a resident's details, room, need or family", method: 'PATCH', path: (fx) => `/api/residents/${fx.residentId}`, body: () => ({ first_name: 'Matrix' }), expect: SUPERVISOR },
  { area: 'Residents and buildings', name: "Open a resident's full record (date of birth, the edit sheet; logged)", method: 'GET', path: (fx) => `/api/residents/${fx.residentId}/record`, expect: { anon: 'unauth', guard: 'hidden', supervisor: 'allow', admin: 'allow' }, note: 'A guard reads residents through a view that carries age, never the date of birth; the table itself does not exist for them' },
  { area: 'Residents and buildings', name: 'Add a building', method: 'POST', path: () => '/api/buildings', body: () => ({ name: `Wing ${crypto.randomInt(1e6)}` }), expect: SUPERVISOR },
  { area: 'Residents and buildings', name: 'Rename or reorder a building', method: 'PATCH', path: (fx) => `/api/buildings/${fx.buildingId}`, body: () => ({ name: `Wing ${crypto.randomInt(1e6)}` }), expect: SUPERVISOR },
  { area: 'Residents and buildings', name: 'Remove an empty building', method: 'DELETE', path: (fx) => `/api/buildings/${fx.buildingId}`, expect: SUPERVISOR, fresh: 'building' },
  { area: 'Residents and buildings', name: 'Add rooms to a building', method: 'POST', path: (fx) => `/api/buildings/${fx.buildingId}/rooms`, body: () => ({ rooms: [{ number: String(crypto.randomInt(1e6)), capacity: 2 }] }), expect: SUPERVISOR },
  { area: 'Residents and buildings', name: "Change a room's number, floor, beds, contracted beds or bed set-up", method: 'PATCH', path: (fx) => `/api/rooms/${fx.roomId}`, body: () => ({ capacity: 3 }), expect: SUPERVISOR },
  { area: 'Residents and buildings', name: 'Take a room out of use (archived if ever lived in, else removed)', method: 'DELETE', path: (fx) => `/api/rooms/${fx.roomId}`, expect: SUPERVISOR, fresh: 'room' },
  { area: 'Residents and buildings', name: 'Put an archived room back into use', method: 'POST', path: (fx) => `/api/rooms/${fx.roomId}/restore`, body: () => ({}), expect: SUPERVISOR, fresh: 'room' },

  // ---- families (child-supervision arrangements, migration 053) ----------
  // The Families tab is the only reader of these two; the door takes its
  // care lines from /api/residents. A guard therefore has no business here.
  { area: 'Families', name: 'Every household, its members and the running arrangement, plus the unassigned', method: 'GET', path: () => '/api/households', expect: SUPERVISOR },
  // overnight: true, because the window is relative to the clock and would
  // otherwise be refused for crossing midnight when the suite runs after 21:00.
  { area: 'Families', name: 'Record a supervision arrangement (a household child in another resident\'s care)', method: 'POST', path: (fx) => `/api/households/${fx.householdId}/supervision`, body: (fx) => ({ carer_id: fx.carerId, from_at: new Date(Date.now() - 3600e3).toISOString(), to_at: new Date(Date.now() + 3 * 3600e3).toISOString(), overnight: true }), expect: SUPERVISOR, fresh: 'household' },
  { area: 'Families', name: "A household's supervision history over a range", method: 'GET', path: (fx) => `/api/households/${fx.householdId}/supervision?from=${fx.today}&to=${fx.today}`, expect: SUPERVISOR },
  { area: 'Families', name: 'End a supervision arrangement early', method: 'POST', path: (fx) => `/api/supervision/${fx.arrangementId}/end`, body: () => ({}), expect: SUPERVISOR, fresh: 'arrangement' },

  // ---- reports (supervisors and admins; one is the admin's) ---------------
  { area: 'Reports', name: 'See which reports exist', method: 'GET', path: () => '/api/reports', expect: STAFF },
  { area: 'Reports', name: 'Export a report (register, attendance, movements, occupancy, evacuation, drills); logged', method: 'GET', path: (fx) => `/api/reports/register?from=${fx.today}&to=${fx.today}&reason=matrix&format=json`, expect: SUPERVISOR },
  { area: 'Reports', name: 'Who missed the register over a range (the Absences tab); not logged', method: 'GET', path: (fx) => `/api/missed?from=${fx.today}&to=${fx.today}`, expect: SUPERVISOR },
  { area: 'Reports', name: 'Child supervision arrangements over a range; logged', method: 'GET', path: (fx) => `/api/reports/supervision?from=${fx.today}&to=${fx.today}&reason=matrix&format=json`, expect: SUPERVISOR },
  { area: 'Reports', name: 'Children on site without a guardian, night by night; logged', method: 'GET', path: (fx) => `/api/reports/guardian-gaps?from=${fx.today}&to=${fx.today}&reason=matrix&format=json`, expect: SUPERVISOR },
  { area: 'Reports', name: 'Check-ins recorded while signed out at the gate; logged', method: 'GET', path: (fx) => `/api/reports/checkin-conflicts?from=${fx.today}&to=${fx.today}&reason=matrix&format=json`, expect: SUPERVISOR },
  { area: 'Reports', name: 'Who viewed which record (the access log)', method: 'GET', path: (fx) => `/api/reports/access?from=${fx.today}&to=${fx.today}&reason=matrix&format=json`, expect: ADMIN },

  // ---- the resident's rights and the site (admins) ------------------------
  { area: 'Administration', name: "Export a resident's whole record (Art. 15); logged", method: 'GET', path: (fx) => `/api/residents/${fx.residentId}/export?reason=matrix`, expect: ADMIN },
  { area: 'Administration', name: 'Erase a resident and their history (Art. 17)', method: 'DELETE', path: (fx) => `/api/residents/${fx.residentId}`, body: (fx) => ({ reason: 'matrix', confirm_name: fx.residentName }), expect: ADMIN, fresh: 'resident' },
  { area: 'Administration', name: "Change the site's settings, retention and feature switches", method: 'PATCH', path: () => '/api/settings', body: () => ({ site_name: 'Matrix Site' }), expect: ADMIN },
  { area: 'Administration', name: "Send the Weekly register update by email now", method: 'POST', path: () => '/api/settings/weekly-report/send', body: () => ({}), expect: ADMIN },
  { area: 'Administration', name: 'Add a permitted absence period', method: 'POST', path: () => '/api/settings/absence-windows', body: () => ({ name: `Matrix ${crypto.randomInt(1e6)}`, from_date: '2030-01-01', to_date: '2030-01-02' }), expect: ADMIN },
  { area: 'Administration', name: 'Edit a permitted absence period', method: 'PATCH', path: (fx) => `/api/settings/absence-windows/${fx.absenceWindowId}`, body: () => ({ name: 'Edited' }), expect: ADMIN, fresh: 'absenceWindow' },
  { area: 'Administration', name: 'Remove a permitted absence period', method: 'DELETE', path: (fx) => `/api/settings/absence-windows/${fx.absenceWindowId}`, expect: ADMIN, fresh: 'absenceWindow' },
  { area: 'Administration', name: 'List staff accounts', method: 'GET', path: () => '/api/staff', expect: STAFF, note: 'Names, roles and last sign-in; no more than the header of the app already shows' },
  { area: 'Administration', name: 'Invite a staff member', method: 'POST', path: () => '/api/staff', body: () => ({ email: `m${crypto.randomInt(1e9)}@hut.example`, full_name: 'Matrix Staff', role: 'guard' }), expect: ADMIN },
  { area: 'Administration', name: 'Send a staff member a login link', method: 'POST', path: (fx) => `/api/staff/${fx.staffId}/link`, body: () => ({}), expect: ADMIN },
  { area: 'Administration', name: 'Disable or re-enable a staff account', method: 'POST', path: (fx) => `/api/staff/${fx.staffId}/active`, body: () => ({ active: true }), expect: ADMIN },
  { area: 'Administration', name: "Change a staff member's role", method: 'POST', path: (fx) => `/api/staff/${fx.staffId}/role`, body: () => ({ role: 'guard' }), expect: ADMIN },
  { area: 'Administration', name: 'Tick or untick whether a staff member receives the weekly report', method: 'POST', path: (fx) => `/api/staff/${fx.weeklyReportStaffId}/weekly-report`, body: () => ({ on: true }), expect: ADMIN, fresh: 'weeklyReportStaff' },
  { area: 'Administration', name: 'Tick or untick whether a staff member receives the nightly email and the 22:00 alert', method: 'POST', path: (fx) => `/api/staff/${fx.safeguardingStaffId}/safeguarding-alert`, body: () => ({ on: true }), expect: ADMIN, fresh: 'safeguardingStaff' },
  { area: 'Administration', name: "Set a staff member's password", method: 'POST', path: (fx) => `/api/staff/${fx.staffId}/password`, body: () => ({ password: 'a-fresh-long-password-12' }), expect: ADMIN },

  // ---- the organisation (platform administrators only) --------------------
  { area: 'Organisation', name: 'List every centre on the service', method: 'GET', path: () => '/api/tenants', expect: PLATFORM },
  { area: 'Organisation', name: 'Provision a new centre', method: 'POST', path: () => '/api/tenants', body: () => { const n = crypto.randomInt(1e6); return { name: `Centre ${n}`, slug: `centre-${n}`, admin_name: 'First Admin', admin_email: `first${n}@hut.example` }; }, expect: PLATFORM },
  { area: 'Organisation', name: 'Close a centre (drops its schema)', method: 'DELETE', path: (fx) => `/api/tenants/${fx.tenantId}`, body: (fx) => ({ confirm_slug: fx.tenantSlug }), expect: PLATFORM, fresh: 'tenant' },
];

module.exports.ROLES = ['anon', 'guard', 'kiosk', 'supervisor', 'admin', 'platform'];
// A row that never mentions 'kiosk' means deny for it: the kiosk role is
// deliberately not staff (see KIOSK above, and lib/auth.js's requireSession),
// so unless a row says otherwise, the tablet is refused everything on this
// list. Checked after the platform fallback so a row naming both wins as
// written; a row naming neither falls all the way through to deny.
module.exports.expectFor = (row, role) => row.expect[role]
  || (role === 'platform' ? row.expect.admin : undefined)
  || (role === 'kiosk' ? 'deny' : undefined);
