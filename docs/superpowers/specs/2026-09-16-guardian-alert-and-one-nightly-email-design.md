# The 22:00 guardian alert, the register conflict flag, and one nightly email — design

Written 16 September 2026. Piece B of the child-welfare bundle; builds on
piece A (`2026-09-16-families-and-supervision-arrangements-design.md`:
households as guardians and children, `supervision_arrangements`,
`v_household_care`). The owner's defaults of 16 September are taken as
agreed: evaluate at 22:00 site time and again at the 00:30 snapshot; email
the ticked managers at 22:00 **with names**; flag a register check-in
recorded while the gate shows that person out; merge the two nightly emails
into one.

## The incident this answers

A mother signed OUT at the gate in the evening and did not return; she had
checked in on the register earlier that day, so the register read "verified
present"; her children were on site with nobody responsible; nothing said so
until Monday, and IPAS asked why. House Rules 3.5.4 (June 2026): children
must not be left overnight with another resident except with prior
approval; a parent leaving a child unsupervised is a matter staff are
required by law to report to Tusla.

## Decisions

- **The fact:** a household with children on site and **no guardian on
  site** and **no running supervision arrangement**. Guardians and children
  as piece A defines them; "on site" is gate presence (`v_resident_status.presence`).
  A household whose children are all off site is not this fact (they are a
  child-away case, which the existing overnight alert already reports).
- **Two looks a night, one email.** At **22:00 site time** the manager email
  goes if any household is in that state; at the **00:30 snapshot** the
  state is recorded per night (`overnight_guardian_gaps`) for the reports,
  and anything new since 22:00 goes in the existing nightly email. 22:00 is
  when a child left for the evening has plainly been left overnight, and
  early enough that a manager can still act; the snapshot is the record.
- **Names, at 22:00, to the managers.** This email goes to the staff ticked
  for the safeguarding alert (supervisors and admins with a login — the
  people who must act on it), and it names the household, the children on
  site (first names and ages), the guardians who are off site with the time
  each signed out, and the room. It is the one email in the app that names a
  resident in its body, because a count cannot be acted on at 22:00 and the
  recipient is the person whose duty it is. docs/GDPR.md says so.
- **The register conflict.** A daily check-in whose `occurred_at` falls
  while the gate had that resident **OUT** (last gate event before it was an
  OUT, or there is none and the resident has never signed in) is a
  **conflict**: somebody verified presence for a person who was not in the
  building — a delegated or off-site check-in, exactly the pattern security
  reported. It is computed, not stored: a view `v_checkin_conflicts` over
  `checkin_events` × `gate_events`. Shown on the register's detail sheet
  ("Recorded while signed out at the gate"), counted in the nightly email,
  and listed in a report. Never undone — the register is append-only; the
  flag is the correction.
- **One nightly email.** The House Rules reminder (032) and the overnight
  safeguarding alert (041) become one message, "Tonight at <site>", sent
  after the snapshot to the staff ticked for the safeguarding alert (the
  House Rules switch and its all-supervisors audience are retired: one tick,
  one audience). Sections, each a count and a link, in this order:
  **Children on site without a guardian** (new, from the snapshot),
  **Children away overnight without authorisation** (041),
  **Check-ins recorded while signed out** (new), **At the House Rules
  figures** (032). Sent every night when anything is non-zero, and on
  Sundays regardless (so silence is never ambiguous for a week). Counts and
  links only — the 22:00 message is the one that names people.
- **Feature switches:** the 22:00 alert and the guardian-gap section depend
  on `feature_households`; the conflict flag on nothing; the one nightly
  email replaces the two existing switches with `nightly_email` (default: on
  where either old switch was on).
- **Nothing decides.** The emails say what the register recorded; a
  guardian off site with children on site is a fact the manager judges
  (there may be a paper form not yet in the app).

## Data

Migration `054_guardian_alert_and_conflicts.sql`:

- `overnight_guardian_gaps (night date, household_id uuid, children_on_site int, guardians_out int, first_out_at timestamptz, recorded_at timestamptz, primary key (night, household_id))` — the snapshot's record, written by `snapshot_guardian_gaps(p_night date)` from `v_household_care` for households with `children_on_site > 0 and guardians_on_site = 0 and arrangement_id is null`. Retention with the register.
- View `v_checkin_conflicts (checkin_id, resident_id, occurred_at, guard_id, source, last_gate_kind, last_gate_at)` — one row per check-in in the last `compliance_retention_days` whose preceding gate event (by `occurred_at`) is `out`, or none exists.
- `app_settings.nightly_email boolean not null default false`; migration sets it `true` where `notify_thresholds_email or (exists a profile with safeguarding_alert)`; `notify_thresholds_email` is left in place but no longer read (dropping a column the deployed code selects is the 037 hazard; a later migration removes it).
- Function `guardian_gaps_now()` returns the 22:00 rows with names: household label, room label(s), children (first name + age), guardians off site (full name, signed out at), for the email. Supervisor/admin, SECURITY DEFINER, no audit row (it is a read for an email; the email itself is the record — `job_runs`).
- Tenant schemas: table/column creation looped as in 052/053.

## Jobs and email

- `node jobs.js evening` — a third mode, run by cron `hut-evening` at 21:00 and 22:00 UTC daily (`"0 21,22 * * *"`), gated like the weekly job: local hour ≥ 22, once per night (`job_runs` guard on `guardian-alert-email` for the site date), `feature_households` on, `nightly_email` on, recipients present. Sends `guardianAlert.compose({ siteName, gaps, link, unsubscribe })` — subject "<Site>: children on site without a guardian — <n> household(s)"; body: one block per household (label, room, children with ages, guardians off site and since when, "no supervision arrangement recorded"), then "Open Families" link and the standard footer with the wording "This email names residents because it needs acting on tonight — treat it as you would the register itself."
- The nightly (`node jobs.js`) after the snapshot: `snapshot_guardian_gaps(last night)`; then **one** `nightly.compose(...)` replacing `notifyThresholds()` and `safeguardingNightly()`: the four counts and four deep links (Families tab, Absent overnight report, the new Conflicts report, the Absences tab), sent to the safeguarding recipients when `nightly_email` is on and any count > 0 or it is Sunday. Recorded in `job_runs` as `nightly-email` (the two old job names stop being written; `v_system_health` unchanged).
- `lib/emailPrefs.js` unsubscribe kinds: `guardian_alert` and `nightly` (existing `safeguarding_alert` / `house_rules` kinds map to `nightly`).

## Reports and screens

- Report `guardian-gaps` ("Children on site without a guardian", ranged by night): night, household, room, children, guardians off site, first out at, arrangement (none).
- Report `checkin-conflicts` ("Check-ins recorded while signed out", ranged): date, resident, time, recorded by, source, last gate movement.
- Register detail sheet: a line on today's check-ins that conflict.
- Admin → Settings: the two old switches become one — "Nightly email to the staff ticked for alerts" with the four sections named; the Staff tick "Gets the overnight safeguarding alert" is relabelled "Gets the nightly email and the 22:00 alert".
- Help: the Sunday/nightly sections updated; a paragraph on the 22:00 alert.
- Copy: GDPR.md "What leaves by email" — the 22:00 alert names residents (new); the nightly email is counts and links (unchanged in kind); the two old emails retired. Brochure site: any sentence describing "two nightly emails" or the House Rules reminder as its own email updated.

## Out of scope

- Blocking a sign-out, or any change to what a guard may do.
- A real-time push to the hut screen (the 22:00 email is the mechanism).
- Retiring the `notify_thresholds_email` column (later migration).
- The guardian flag per adult; Appendix 5 part (B).

## Testing

- DB: `snapshot_guardian_gaps` writes exactly the households in the state and none with an arrangement or a guardian on site; `v_checkin_conflicts` flags a check-in recorded after an OUT and not one after an IN, and a check-in by a resident who never signed in; `guardian_gaps_now()` refuses a guard and names the right people.
- HTTP/jobs: the evening mode gate (hour, once a night, switch, recipients); the 22:00 email names the household, children and off-site guardians and not the carer-covered household; the nightly compose carries four counts and four links and no names; Sunday sends with zero counts; both reports audited; Settings PATCH of `nightly_email`; unsubscribe kinds.
- `./check.sh` green.
