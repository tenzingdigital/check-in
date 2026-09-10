# Permissions — who may do what

*Generated from `test/permissions.js` by `tools/gen-permissions-doc.js`. Do not
edit by hand: change the matrix, regenerate, and the HTTP suite will hold the
server to the new row. `./check.sh` fails if this file is stale.*

Four roles, one site each: a **guard** records at the gate and on the
register; a **supervisor** also manages residents, buildings and reports; an
**admin** also manages staff, settings, and a resident's rights (export,
erasure) and reads the access log. A **platform admin** is an admin of their
own site who may also provision and close centres; they see no other centre's
residents. Someone **logged out** can ask for a password-reset link and
nothing else.

Legend: ✓ allowed · ✗ refused (403) · — must log in first (401) · hidden
(404: the row policy makes the record not exist for that role). "Allowed"
means the role is not the reason a request would fail; it may still fail
validation.

## Own account

| What | Logged out | Guard | Supervisor | Admin | Platform admin |
|---|:---:|:---:|:---:|:---:|:---:|
| Who am I (session, settings, feature switches)<br><code>GET /api/session</code> | — | ✓ | ✓ | ✓ | ✓ |
| Is the nightly job on time (health banner)<br><code>GET /api/session/health</code> | — | ✓ | ✓ | ✓ | ✓ |
| Log out<br><small>Ends the session cookie; harmless when there is none</small><br><code>DELETE /api/session</code> | ✓ | ✓ | ✓ | ✓ | ✓ |
| Ask for a password-reset link<br><small>Same answer whether or not the address exists</small><br><code>POST /api/password-reset</code> | ✓ | ✓ | ✓ | ✓ | ✓ |

## Gate and register

| What | Logged out | Guard | Supervisor | Admin | Platform admin |
|---|:---:|:---:|:---:|:---:|:---:|
| Search residents (name, age, state; never the ID number)<br><code>GET /api/residents</code> | — | ✓ | ✓ | ✓ | ✓ |
| Open a resident's detail sheet (the ID number; logged)<br><code>GET /api/residents/:id/compliance</code> | — | ✓ | ✓ | ✓ | ✓ |
| The 30-day strip under the sheet<br><code>GET /api/residents/:id/days</code> | — | ✓ | ✓ | ✓ | ✓ |
| A resident's household members<br><code>GET /api/residents/:id/household</code> | — | ✓ | ✓ | ✓ | ✓ |
| A resident's history: every movement and check-in over a range<br><code>GET /api/residents/:id/history</code> | — | ✓ | ✓ | ✓ | ✓ |
| Export a resident's history as a file; logged<br><code>GET /api/residents/:id/history</code> | — | ✗ | ✓ | ✓ | ✓ |
| A resident's authorised absences<br><code>GET /api/residents/:id/absences</code> | — | ✓ | ✓ | ✓ | ✓ |
| A resident's room history<br><code>GET /api/residents/:id/rooms</code> | — | ✓ | ✓ | ✓ | ✓ |
| A resident's breach reports<br><code>GET /api/residents/:id/breaches</code> | — | ✓ | ✓ | ✓ | ✓ |
| The movement log over a range, filtered by name or room<br><code>GET /api/gate-events</code> | — | ✓ | ✓ | ✓ | ✓ |
| Who is on site now (summary)<br><code>GET /api/summary</code> | — | ✓ | ✓ | ✓ | ✓ |
| The day's movement log<br><code>GET /api/gate-events</code> | — | ✓ | ✓ | ✓ | ✓ |
| Sign a resident in or out at the gate<br><code>POST /api/gate-events</code> | — | ✓ | ✓ | ✓ | ✓ |
| Record the daily check-in<br><code>POST /api/checkins</code> | — | ✓ | ✓ | ✓ | ✓ |
| The register counts (not seen, missed days, seen today)<br><code>GET /api/checkin-summary</code> | — | ✓ | ✓ | ✓ | ✓ |
| The attention list (open breaches, worst first)<br><code>GET /api/attention</code> | — | ✓ | ✓ | ✓ | ✓ |
| Replay events recorded while offline<br><code>POST /api/sync</code> | — | ✓ | ✓ | ✓ | ✓ |
| Read the site's settings<br><code>GET /api/settings</code> | — | ✓ | ✓ | ✓ | ✓ |
| The permitted absence periods (Christmas, Ramadan, Easter, the summer school holiday)<br><code>GET /api/settings/absence-windows</code> | — | ✓ | ✓ | ✓ | ✓ |
| Buildings, rooms and who is in them<br><code>GET /api/buildings</code> | — | ✓ | ✓ | ✓ | ✓ |

## Evacuation and roll call

| What | Logged out | Guard | Supervisor | Admin | Platform admin |
|---|:---:|:---:|:---:|:---:|:---:|
| The evacuation list (needs-assistance first)<br><code>GET /api/evacuation</code> | — | ✓ | ✓ | ✓ | ✓ |
| The roll call in progress, if any<br><code>GET /api/roll-calls/active</code> | — | ✓ | ✓ | ✓ | ✓ |
| Past drills and incidents<br><code>GET /api/roll-calls</code> | — | ✓ | ✓ | ✓ | ✓ |
| Start a roll call<br><code>POST /api/roll-calls</code> | — | ✓ | ✓ | ✓ | ✓ |
| Tick a person at the assembly point<br><code>POST /api/roll-calls/:id/marks</code> | — | ✓ | ✓ | ✓ | ✓ |
| Mark a visitor or contractor safe<br><code>POST /api/roll-calls/:id/visit-marks</code> | — | ✓ | ✓ | ✓ | ✓ |
| End a roll call<br><code>POST /api/roll-calls/:id/end</code> | — | ✓ | ✓ | ✓ | ✓ |

## Visitors

| What | Logged out | Guard | Supervisor | Admin | Platform admin |
|---|:---:|:---:|:---:|:---:|:---:|
| Today's visitors, staff and contractors, and who is still on site<br><code>GET /api/visits</code> | — | ✓ | ✓ | ✓ | ✓ |
| Sign a visitor, contractor, supplier or staff member in<br><code>POST /api/visits</code> | — | ✓ | ✓ | ✓ | ✓ |
| Sign them out<br><code>POST /api/visits/undefined/leave</code> | — | ✓ | ✓ | ✓ | ✓ |
| The site staff list<br><code>GET /api/roster</code> | — | ✓ | ✓ | ✓ | ✓ |
| Sign a listed staff member in with one tap<br><code>POST /api/visits</code> | — | ✓ | ✓ | ✓ | ✓ |
| Add to the staff list (one, or a pasted list)<br><code>POST /api/roster</code> | — | ✗ | ✓ | ✓ | ✓ |
| Rename, retitle or archive a listed staff member<br><code>PATCH /api/roster/undefined</code> | — | ✗ | ✓ | ✓ | ✓ |

## Residents and buildings

| What | Logged out | Guard | Supervisor | Admin | Platform admin |
|---|:---:|:---:|:---:|:---:|:---:|
| Add a resident<br><code>POST /api/residents</code> | — | ✗ | ✓ | ✓ | ✓ |
| Import residents from a spreadsheet (preview and for real)<br><code>POST /api/residents/import</code> | — | ✗ | ✓ | ✓ | ✓ |
| Authorise an absence (a holiday, a family matter)<br><code>POST /api/residents/:id/absences</code> | — | ✗ | ✓ | ✓ | ✓ |
| Record that a breach report was issued to IPAS<br><code>POST /api/residents/:id/breaches</code> | — | ✗ | ✓ | ✓ | ✓ |
| Cut an authorised absence short or cancel it<br><code>POST /api/residents/:id/absences/undefined/end</code> | — | ✗ | ✓ | ✓ | ✓ |
| Change a resident's details, room, need or family<br><code>PATCH /api/residents/:id</code> | — | ✗ | ✓ | ✓ | ✓ |
| Open a resident's full record (date of birth, the edit sheet; logged)<br><small>A guard reads residents through a view that carries age, never the date of birth; the table itself does not exist for them</small><br><code>GET /api/residents/:id/record</code> | — | hidden | ✓ | ✓ | ✓ |
| Add a building<br><code>POST /api/buildings</code> | — | ✗ | ✓ | ✓ | ✓ |
| Rename or reorder a building<br><code>PATCH /api/buildings/:id</code> | — | ✗ | ✓ | ✓ | ✓ |
| Remove an empty building<br><code>DELETE /api/buildings/:id</code> | — | ✗ | ✓ | ✓ | ✓ |
| Add rooms to a building<br><code>POST /api/buildings/:id/rooms</code> | — | ✗ | ✓ | ✓ | ✓ |
| Change a room's number, floor, beds, contracted beds or bed set-up<br><code>PATCH /api/rooms/:id</code> | — | ✗ | ✓ | ✓ | ✓ |
| Take a room out of use (archived if ever lived in, else removed)<br><code>DELETE /api/rooms/:id</code> | — | ✗ | ✓ | ✓ | ✓ |
| Put an archived room back into use<br><code>POST /api/rooms/:id/restore</code> | — | ✗ | ✓ | ✓ | ✓ |

## Reports

| What | Logged out | Guard | Supervisor | Admin | Platform admin |
|---|:---:|:---:|:---:|:---:|:---:|
| See which reports exist<br><code>GET /api/reports</code> | — | ✓ | ✓ | ✓ | ✓ |
| Export a report (register, attendance, movements, occupancy, evacuation, drills); logged<br><code>GET /api/reports/register</code> | — | ✗ | ✓ | ✓ | ✓ |
| Who viewed which record (the access log)<br><code>GET /api/reports/access</code> | — | ✗ | ✗ | ✓ | ✓ |

## Administration

| What | Logged out | Guard | Supervisor | Admin | Platform admin |
|---|:---:|:---:|:---:|:---:|:---:|
| Export a resident's whole record (Art. 15); logged<br><code>GET /api/residents/:id/export</code> | — | ✗ | ✗ | ✓ | ✓ |
| Erase a resident and their history (Art. 17)<br><code>DELETE /api/residents/:id</code> | — | ✗ | ✗ | ✓ | ✓ |
| Change the site's settings, retention and feature switches<br><code>PATCH /api/settings</code> | — | ✗ | ✗ | ✓ | ✓ |
| Send the Weekly register update by email now<br><code>POST /api/settings/weekly-report/send</code> | — | ✗ | ✗ | ✓ | ✓ |
| Add a permitted absence period<br><code>POST /api/settings/absence-windows</code> | — | ✗ | ✗ | ✓ | ✓ |
| Remove a permitted absence period<br><code>DELETE /api/settings/absence-windows/:id</code> | — | ✗ | ✗ | ✓ | ✓ |
| List staff accounts<br><small>Names, roles and last sign-in; no more than the header of the app already shows</small><br><code>GET /api/staff</code> | — | ✓ | ✓ | ✓ | ✓ |
| Invite a staff member<br><code>POST /api/staff</code> | — | ✗ | ✗ | ✓ | ✓ |
| Send a staff member a login link<br><code>POST /api/staff/:id/link</code> | — | ✗ | ✗ | ✓ | ✓ |
| Disable or re-enable a staff account<br><code>POST /api/staff/:id/active</code> | — | ✗ | ✗ | ✓ | ✓ |
| Change a staff member's role<br><code>POST /api/staff/:id/role</code> | — | ✗ | ✗ | ✓ | ✓ |
| Tick or untick whether a staff member receives the weekly report<br><code>POST /api/staff/:id/weekly-report</code> | — | ✗ | ✗ | ✓ | ✓ |
| Set a staff member's password<br><code>POST /api/staff/:id/password</code> | — | ✗ | ✗ | ✓ | ✓ |

## Organisation

| What | Logged out | Guard | Supervisor | Admin | Platform admin |
|---|:---:|:---:|:---:|:---:|:---:|
| List every centre on the service<br><code>GET /api/tenants</code> | — | ✗ | ✗ | ✗ | ✓ |
| Provision a new centre<br><code>POST /api/tenants</code> | — | ✗ | ✗ | ✗ | ✓ |
| Close a centre (drops its schema)<br><code>DELETE /api/tenants/:id</code> | — | ✗ | ✗ | ✗ | ✓ |

## Field-level rules

These are not per-request permissions but per-column ones, enforced in the
database by which view or table a role can read. The SQL suite
(`test/acceptance.sql`) proves each.

| Data | Guard | Supervisor | Admin |
|---|:---:|:---:|:---:|
| Name, age, presence, register state | ✓ | ✓ | ✓ |
| Date of birth | ✗ (a view carries age only) | ✓ | ✓ |
| Identity document number | Detail sheet only, never a list; searchable | same | same |
| Room | ✓ | ✓ | ✓ |
| Evacuation need | Roll call, evacuation list and occupancy only; never the gate cards | same | same |
| Household | ✓ | ✓ | ✓ |
| Audit trail (who changed what) | ✗ | ✗ | ✓ |
| Access log (who viewed whom) | ✗ | ✗ | ✓ |
| Login attempts, countries, risk | ✗ | ✗ | ✗ (platform only, in SQL) |
| Another centre's anything | ✗ | ✗ | ✗ |

## Where each rule is enforced

* **Row policies and `SECURITY DEFINER` functions in Postgres** carry every
  rule about residents, events, buildings, roll calls, reports, settings and
  staff. A request runs as the `authenticated` role inside the caller's own
  schema with their user id set on the transaction; the route cannot bypass
  the policy because it holds no other credential.
* **The route** turns a refusal (`42501`) into a 403 with the message the
  function author wrote, and checks the two things the database cannot see:
  the platform-admin flag for organisation routes, and an administrator
  disabling or demoting themselves.
* **The session** decides logged-in or not (401) before any route runs.
