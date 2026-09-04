# GDPR notes

What this system holds, why, for how long, and which decisions in the code
were made for data-protection reasons. Written to feed the record of
processing (ROPA) and the DPIA, and to agree with the schema as it is, not as
it was. The customer-facing versions of the same facts are Annex I and Annex
II of `docs/legal/DPA-2026-09-03.md`; if this file and the DPA ever disagree,
the DPA is the promise and this file is wrong.

Rewritten 4 September 2026 against migrations 001–014. The previous version
described columns that migration 006 removed, a retention period that
migration 008 changed, and a scheduler that no longer exists.

**This is not legal advice.** A system that records the daily presence of
residents in accommodation, some of whom are in the international protection
process, is systematic monitoring of people who are frequently vulnerable.
Have a practitioner review the DPIA before a centre goes live.

---

## Roles

The **centre** (the customer) is the controller: it decides that residents
are recorded, on what basis, and answers to them. **Tenzing Digital** is the
processor, and Render and Resend are its sub-processors (DPA Annex III). This
file is written from the processor's side; the centre's own privacy notice to
residents is the centre's document, and the DPA says so.

---

## What is held

### About residents

| Data | Where | Why | Who sees it |
|---|---|---|---|
| First and last name | `residents` | Identifying the person at the window | All staff |
| Date of birth | `residents` | The under-18 exemption, computed as of each day | Supervisors and admins only. Guards read a view that carries age, never the date |
| Identity document type and number (TRC or IRP) | `residents.id_type`, `id_number` | The IPAS verification policy asks that the document is checked | Detail view only, never in a list (Annex II). Searchable, so a guard can find a person by the number on the card |
| Registration and departure dates, status | `residents` | When the daily rule starts and stops applying | All staff |
| Entry and exit events | `gate_events` | Who is on site now; the door log | All staff |
| Check-in events | `checkin_events` | The daily presentation the policy requires | All staff |
| The daily register | `daily_compliance` | One row per resident per day: required, presented, first seen, count. The durable record | All staff |
| Late-entry provenance | `late_entry`, `recorded_at`, `client_ref` on both event tables | Separates "recorded live" from "recorded on the terminal during an outage and sent later" | All staff; appears in the export |
| Room | `residents.room_id` (migration 016, only where the centre turns buildings on) | Where the person sleeps; occupancy and the evacuation list | All staff |
| Evacuation need | `residents.evac_need` (migration 017, only where the centre turns evacuation on) | One code from a fixed list: needs help to move, to hear the alarm, to find the way, has an infant or is a carer, other. The PEEP minimum | The roll call, the evacuation list and room occupancy only. Never on the gate or register cards, never searchable |
| Roll calls | `roll_calls`, `roll_call_marks` | Who was accounted for in a drill or an incident, by whom, when | All staff; kept as long as the register |

Nothing else. There is no free-text note, no photograph, no biometric, and
no field in which to put any. Identity is established by the guard looking
at the person and, where the centre requires it, at their card.

**The evacuation need is the one special-category field.** It exists because
a centre has a fire-safety duty to know who needs help to get out, and a
personal emergency evacuation plan is what a fire officer expects. It is
held as a single code from a fixed list (no free text, so nothing beyond the
code can arrive), shown only where evacuation happens, and only where the
centre has turned the feature on. A centre that turns it on is holding
Article 9 data and must say so in its DPIA; Art. 9(2)(c), protecting vital
interests, and the centre's statutory fire-safety duty are the bases to
record. The old free-text room reference and note were removed in
migration 006 precisely because free text is where such detail arrives by
accident; the room is now a reference to a room a supervisor created.

**Special-category data by inference.** A TRC or IRP number is not itself
Article 9 data, but a number issued only to international protection
applicants can reveal immigration status. The DPA says this to the customer
in Annex I. The register is treated here as sensitive for that reason:
detail-view only, never in a list, and never in an email.

**Children.** Residents under 18 are excluded from the daily rule by
`compliance_required()` on the day in question. Their names, dates of birth
and any events are held like anyone else's if the centre registers them.

### About staff

| Data | Where | Why | Retention |
|---|---|---|---|
| Name, role, active flag | `profiles` | Attribution of every record; authorisation | Life of the account. A staff identity that records depend on cannot be deleted, only disabled |
| Email, password hash (bcrypt, cost 12) | `auth.users` | Login | Life of the account |
| Session tokens (SHA-256 digests), created and last-seen times, IP, user agent | `auth.sessions` | Keeping the person logged in for a shift | Until expiry (12 hours) or logout; purged nightly |
| Password-reset and invitation tokens (digests) | `auth.password_resets` | The emailed one-day link | 24 hours; purged nightly |
| Every sign-in attempt: email as typed, outcome, IP, user agent | `auth.login_events` | Detecting misuse; the privacy notice promises it | 90 days; purged nightly |
| Administrators' and supervisors' changes, with the row before and after | `admin_audit` | Accountability for changes to residents, staff and settings | Same period as the register; purged nightly |

Staff data is Tenzing Digital's own processing as well as the centre's, and
`docs/legal/PRIVACY-2026-09-03.md` is the notice for it.

### On the terminal

Since the offline work (`README.md`, "Working offline") each terminal keeps
an encrypted copy of the register it last loaded — names, identity numbers
and today's status, never dates of birth — and an encrypted queue of events
recorded while the link was down. Both are AES-GCM ciphertext in the
browser's storage; the key lives only in the tab and is gone when it closes;
the register copy is cleared at logout; the queue is cleared once sent. The
terminal is therefore a device holding resident data at rest, briefly, under
the centre's physical control, and belongs in the ROPA as such. The
mitigations are the encryption, the short life of the key, the idle lock
(`app_settings.idle_lock_minutes`, default 20), and the physical controls on
the terminal itself.

---

## Lawful basis

This is the centre's decision, and it should be made before go-live, because
the retention period, the notice to residents and their rights all follow
from it.

- **Legal obligation (Art. 6(1)(c))** where the daily presence check is
  required of the centre by its contract with IPAS and the verification
  policy behind it. This is the basis the product is designed around: the
  register's default retention (180 days) is the six months that policy
  names, and the register is the evidence the centre is inspected on.
- **Legitimate interests (Art. 6(1)(f))** for the door log, if the centre
  runs one for site security beyond what the policy requires. That needs a
  written balancing test and gives residents a right to object.

If the basis is a legal obligation, Art. 17(3)(b) may allow an erasure
request to be refused while the record is still required. The erasure
function is the mechanism; the decision is the centre's.

---

## Retention

All periods are rows in `app_settings`, editable by an administrator under
Settings, and enforced by the nightly job (`jobs.js`, run by Render's
scheduler at 00:30 UTC). Every run is recorded in `job_runs`, and the register
page shows a red banner if the close-out falls behind, so a purge that stops
running is noticed.

| Data | Setting | Default | Why that default |
|---|---|---|---|
| Entry, exit and check-in events | `event_retention_days` | 90 days | Granular movement data; minimise (Art. 5(1)(e)). The register outlives it |
| The daily register | `compliance_retention_days` | 180 days | The six-month limit in the IPAS verification policy of March 2026 (migration 008) |
| Administrators' audit trail | follows `compliance_retention_days` | 180 days | Accountability for the period the register itself exists |
| Sign-in attempts | fixed | 90 days | Long enough to investigate misuse; short because it holds IP addresses |
| Job run history | fixed | 90 days | Operational |
| Backups (Tenzing's off-provider copy) | `tools/backup.sh` | 35 days | DPA section 9 |

The register is deliberately thin — a resident reference, a date, two
booleans, a count and a timestamp — which is what makes keeping it for six
months proportionate. The rich event stream it was derived from goes at 90
days.

**Shortening a period deletes at the next nightly run.** The Settings screen
says so.

---

## Design decisions made for compliance

**Minimisation is enforced by the schema, not by convention.** Guards hold
no `SELECT` on `residents`; they read `v_resident_status`, which carries
`age_years` and `is_adult` and no date of birth. Lists never carry the
identity number; `has_id` says whether there is one. The test suites assert
both (`test/sql.sh`, `test/api.sh`).

**Why a date of birth rather than an "is adult" flag.** A flag is wrong the
day a 17-year-old turns 18 unless someone remembers to flip it, and a missed
flip either marks a minor in breach or exempts an adult. The age is computed
as of the day being evaluated, so backfilling never applies the rule to a day
the person was still a minor.

**The record is append-only.** No role, including administrator, holds
`UPDATE` or `DELETE` on `gate_events`, `checkin_events` or
`daily_compliance`. Corrections are new events; a missed day is never edited
to look attended. This serves accuracy (Art. 5(1)(d)) in both directions: a
record cannot be quietly altered, and a resident disputing an entry has an
intact history. Events synced after an outage carry `late_entry = true` and
the server's `recorded_at` beside the terminal's `occurred_at`, so a synced
event is never presented as if it had been recorded live.

**Administrators are on the record.** Triggers on `residents`, `profiles`
and `app_settings` write `admin_audit` as the table owner with the row
before and after; an export is noted with its reason. Admins can read it;
nobody can change it. A resident's change history is part of their Art. 15
export.

**Erasure leaves proof without leaving data.** `erase_resident()` removes the
person, every event, every register row and their audit rows, then writes
`erasure_log`: a SHA-256 digest of the internal id, the number of rows
removed, the reason, the admin and the time. That demonstrates the erasure
(Art. 5(2)) without keeping anything that identifies the person.

**Access is a session, not obscurity.** Every table has row-level security;
every view and function is revoked from `anon`. The API refuses a request
without a valid session before it opens a transaction, and if that check
were ever wrong the request would still run as `anon`, where the policies
deny everything. The browser holds no credential the page can read: the
session is an `HttpOnly`, `__Host-` cookie.

**Nothing third-party in the browser.** The pages load no script, font or
image from anyone else, and the content-security policy (`default-src
'none'`, `connect-src 'self'`, scripts admitted by hash, no inline styles)
enforces it. A resident's browser never exists here; a staff browser
contacts exactly one host.

**Email carries no resident data.** Resend receives a staff member's address,
name and a single-use link (invitation or password reset). Nothing about a
resident is ever emailed.

---

## Data subject rights

All three rights that touch the record have a route in the app, admin-only,
on the resident's edit sheet under Admin, and each is refused to a guard or a
supervisor by the database function itself, not just by the screen.

| Right | How | Notes |
|---|---|---|
| Access (Art. 15) and portability (Art. 20) | Export button → `GET /api/residents/:id/export?reason=…` | JSON: the record, every event with the recording staff member's name, the register, the change history. The reason is recorded in `admin_audit` |
| Rectification (Art. 16) | Edit sheet (supervisors and admins) | Names, date of birth, identity document, departure date. The change is audited. Events are corrected by new events, never edited |
| Erasure (Art. 17) | Erase button, with the reason and the full name typed back | See "Erasure leaves proof" above. The decision is the centre's; Art. 17(3)(b) may apply |
| Objection (Art. 21) | Procedural | Only arises under legitimate interests |
| Restriction (Art. 18) | Set `departed_on` | Stops the daily rule applying without deleting history |

**Third-party data in an export.** Each event carries the name of the staff
member who recorded it. Before handing an export to a resident, the centre
should decide whether staff names are redacted; in a setting where a resident
may be in dispute with staff, that matters.

---

## Processors and transfers

| Processor | Purpose | Where |
|---|---|---|
| Render Services, Inc. | Hosting, the managed database, backups, the nightly scheduler | Frankfurt (EU); fixed at creation in `render.yaml` |
| Resend, Inc. | Invitation and password-reset email to staff | EU/US; see DPA section 6 |

Both are US companies with EU data residency, so the transfer basis (Standard
Contractual Clauses plus the EU–US Data Privacy Framework, as each provider
states it) must be on file with a transfer impact assessment before the
position is claimed to a customer. `docs/legal/README.md` lists this as
outstanding. If EU-owned infrastructure becomes a requirement rather than a
preference, `docs/TECH-STACK.md` sets out the cost, and the DPIA should say in
one paragraph why the current bar was chosen over it.

**Who can read the database.** The Render dashboard's shell and the external
connection string are the only routes to the raw data outside the app. The
list of people holding either is kept in
`docs/procedures/ACCESS-JOINER-MOVER-LEAVER.md` and reviewed quarterly.

---

## Breaches, backups, continuity

- **Breach:** `docs/procedures/INCIDENT-RESPONSE.md`. The DPA gives the
  customer 48 hours; the customer has 72 to the Data Protection Commission.
- **Backups:** Render's daily managed backups (Annex II) plus an encrypted
  off-provider copy, kept 35 days, rehearsed quarterly:
  `docs/procedures/BACKUP-AND-RESTORE.md`.
- **The link goes down:** the terminal keeps working for hours and syncs
  later; beyond that, the paper sheet: `docs/procedures/PAPER-FALLBACK.md`.
- **Risks and their treatment:** `docs/procedures/RISK-REGISTER.md`.

---

## Before a centre goes live

- [ ] The centre has decided and written down its lawful basis
- [ ] DPIA done — the DPA (section 7) tells the customer one is very likely required, and Annex I and II are written to be used in it
- [ ] The centre's privacy notice to residents exists: what is recorded, why, for how long, their rights, who to ask
- [ ] `compliance_retention_days` and `event_retention_days` match the centre's retention schedule (the defaults are 180 and 90)
- [ ] The nightly job's last run is green (`/api/session/health`, or the register page shows no red banner)
- [ ] Render's and Resend's DPAs and SCCs on file; transfer impact assessment written
- [ ] Database confirmed in Frankfurt on a paid plan with point-in-time recovery, and not the smallest plan (`docs/KNOWN-ISSUES.md` 19c)
- [ ] Email configured (`RESEND_API_KEY`), so invitation links go to their owner and not to an administrator's screen
- [ ] A named person at the centre who actions access and erasure requests, and a named person at Tenzing who receives breach reports
- [ ] The list of people holding the external connection string is written down and short
- [ ] The paper fallback sheet is printed and in the hut
- [ ] Staff briefed: shared-terminal rules, the idle lock, what to do when the pill goes amber, and that no health or other sensitive detail is ever typed into the register (there is no field for it, but there is a search box)
