# GDPR notes

Working notes on the data protection posture of this system — what it holds,
why, and which decisions in the code were made for compliance reasons. It is
written to be useful to whoever fills in the actual paperwork.

**This is not legal advice.** A system that logs the daily movements of
residents at a guarded site is a genuinely sensitive piece of infrastructure.
Have a practitioner review the DPIA before it goes live.

---

## What is held

| Data | Where | Why |
|---|---|---|
| Name | `residents` | Identifying the person the guard is looking at |
| Date of birth | `residents` | Applying the 18+ rule, computed as of each date |
| Room / unit reference | `residents` | Distinguishing people with similar names |
| Operational note | `residents` | Free text, e.g. "works nights" |
| Departure date | `residents.departed_on` | Stops the daily duty applying after move-out |
| Sign-in / sign-out events | `gate_events` | Who is on site right now — the gate app |
| Check-in events | `checkin_events` | Deliberate daily presentation at the hut — the statutory record |
| Daily attendance register | `daily_compliance` | One row per resident per day: required, presented, first-seen time, count. Retained for the statutory period — see "Retention" below |
| Annotations on missed days | `compliance_annotations` | A staff-supplied reason for a missed day; never changes the outcome |
| Guard name and role | `profiles` | Attribution of each event |

No PINs, no photographs, no biometrics, no ID document numbers, no health data.
The absence of biometrics is a deliberate design choice: identity is established
by the guard looking at the person, which keeps the system clear of Art. 9
special-category data entirely.

`residents.note` is free text and is therefore the most likely place for
special-category data to arrive by accident — a guard typing "diabetic, keeps
insulin at the hut" has created a health record. The column comment says so.
Worth a line in the staff briefing, and worth periodically reviewing.

---

## Lawful basis

Two candidates, and the choice has consequences:

- **Legitimate interests (Art. 6(1)(f))** — the usual basis for site security.
  Requires a documented Legitimate Interests Assessment, and gives residents an
  Art. 21 right to object that you must be able to handle.
- **Legal obligation (Art. 6(1)(c))** — if the daily presence requirement comes
  from a statutory or licensing requirement on the site, this is stronger and
  removes the right to object.

The daily presence requirement points strongly at the second: a rule that
everyone over 18 must physically present every calendar day is unusual outside
a regulated setting. **Establish which it is before go-live**, because the
retention period, the privacy notice, and residents' rights all follow from it.

If it is legitimate interests, note that a daily attendance record is a
meaningful intrusion, and the balancing test needs to reflect that rather than
waving at "security".

---

## Design decisions made for compliance

### Data minimisation is enforced by the schema, not by convention

Guards never hold `SELECT` on `residents`. They read `v_resident_status`, which
exposes `age_years` and `is_adult` but **no date of birth**. A guard has no
operational need for a resident's birthday, so they cannot see it. The
acceptance suite asserts this — the same query returns 0 rows to a guard and 10
to a supervisor.

### Why a full date of birth is stored at all

Storing "is an adult" as a boolean would be less data. It would also be wrong
within a year: a 17-year-old becomes subject to the rule on their 18th birthday,
and a boolean requires someone to notice and flip it. A missed flip means either
a minor wrongly flagged in breach, or an adult silently exempt from a rule the
site is obliged to enforce.

Deriving age from date of birth makes the transition automatic and correct on
the day — and `compliance_required()` always computes it as of the day being
evaluated, not as of today, so backfilling a resident's history never
retroactively applies the duty to a day when they were still a minor. That is
the necessity argument for holding the field, and it is paired with never
showing it to the people who don't need it.

### Storage limitation now splits into two horizons

The original design derived compliance on the fly from the movement log, which
`purge_expired_check_events()` deleted at 90 days. After 90 days the system
could no longer show whether anyone had met the requirement, and a resident
who presented every day for a year became indistinguishable from one who never
did — a real defect the current design fixes by separating the granular log
from the durable proof of attendance:

| Data | Purge function | Retained (default) | Rationale |
|---|---|---|---|
| `gate_events` | `purge_expired_gate_events()` | `app_settings.event_retention_days` (90 days) | Granular movement data — minimise (Art. 5(1)(e)) |
| `checkin_events` | `purge_expired_checkin_events()` | `app_settings.event_retention_days` (90 days) | Same window as gate events; one setting covers both |
| `daily_compliance`, `compliance_annotations` | `purge_expired_compliance()` | `app_settings.compliance_retention_days` (2555 days, ≈ 7 years) | Proof of daily reporting — needs to outlive the movement log it was derived from |

All three purge functions are database settings rather than code constants, so
retention can be aligned to the actual retention schedule without a deploy,
and all three need scheduling with `pg_cron` — see `README.md`.

**Both defaults are placeholders.** 90 days for the event logs and 2555 days
(~7 years) for the compliance register are starting points, not the answer.
Set both to whatever the retention schedule actually says; if the lawful basis
is a legal obligation, the source of that obligation usually specifies a
period for the compliance register specifically.

The register itself is deliberately tiny — one row per resident per day,
holding a resident reference, a date, two booleans (`required`, `presented`),
a count, and a timestamp. No name, no note, no location beyond "the hut", no
free text unless a guard chooses to annotate a missed day. That minimalism is
what makes retaining the register for years — rather than the 90-day window
that applies to the movement log — proportionate: the data that must survive a
long time is a thin factual record, not the rich event stream it was derived
from.

### The audit trail is genuinely append-only

No role holds `UPDATE` or `DELETE` on `gate_events`, `checkin_events`,
`daily_compliance` or `compliance_annotations`. This serves accuracy
(Art. 5(1)(d)) in both directions: a record cannot be quietly altered after the
fact, and a resident disputing an entry has an intact history to point at.
Corrections are recorded as new events; a missed day is never edited to look
attended, only annotated with a reason that sits alongside it.

### Erasure leaves proof without leaving data

`erase_resident()` deletes the resident and cascades to `gate_events`,
`checkin_events`, `daily_compliance` and (via `daily_compliance`)
`compliance_annotations` — the entire event and register history — then writes
to `erasure_log`: a SHA-256 digest of the resident's internal id, the number of
events removed, the reason, the admin, and the timestamp. That demonstrates
the erasure happened (Art. 5(2) accountability) without retaining anything
identifying about the person who asked for it.

Note that erasure is **not** automatic on request. If the lawful basis is a
legal obligation, Art. 17(3)(b) may mean the request can be refused. The
function is the mechanism; the decision is a human one.

### Access is gated on a session, not on obscurity

Every table has RLS enabled; the guard-facing views (`v_resident_status`,
`v_check_log`, `v_resident_compliance`) and every RPC are revoked from `anon`.
A logged-out caller holding the publishable key — which is in the page source
and always will be — can read nothing, search nothing, and write nothing. This
is asserted by the acceptance suite rather than assumed.

---

## Data subject rights

| Right | How |
|---|---|
| Access (Art. 15) | `select public.export_resident_record('<uuid>')` — admin only |
| Portability (Art. 20) | Same function; returns JSON |
| Rectification (Art. 16) | Supervisor edits `residents`; ledger corrections are new events |
| Erasure (Art. 17) | `select public.erase_resident('<uuid>', 'reason')` — admin only |
| Objection (Art. 21) | Procedural; depends on the lawful basis above |

The export includes the resident's record, every gate and check-in event with
the recording guard's name, and the daily compliance register with its
annotations. Consider whether guard names should be redacted before handing an
export to a resident — they are the personal data of a third party, and in a
setting where a resident may be in dispute with staff, that matters.

---

## Transfers and processors

Both providers in the default stack are **US companies**, even when the data
sits in the EU:

| Processor | Role | Where the data sits |
|---|---|---|
| Supabase Inc. (US) | Database, auth | The region chosen at project creation — **pick Frankfurt or Ireland** |
| Vercel Inc. (US) | Static hosting | Edge; serves `index.html` only, but sees request IPs |
| jsDelivr / Fastly | CDN for `supabase-js` | Sees the visitor's IP on page load |

Actions:

1. **Sign the DPA with both.** Each publishes one; neither is signed by default.
2. **Choose an EU region at project creation.** It cannot be changed afterwards.
3. **Record the transfer basis.** Both rely on Standard Contractual Clauses plus
   the EU–US Data Privacy Framework. Note the current status of both in your
   ROPA; this area moves.
4. **Consider the CDN.** Loading `supabase-js` from jsDelivr sends the browser's
   IP to a third party before anyone logs in — the same issue that made hotlinked
   Google Fonts a finding in German case law. Both `index.html` and
   `checkin.html` load it the same way, so both need the change. It is easy to
   remove:

   ```bash
   curl -o supabase.js https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.58.0/dist/umd/supabase.js
   # then in both index.html and checkin.html:
   #   <script src="/supabase.js"></script>
   ```

   Still no build step, one fewer processor, and it removes a supply-chain
   dependency from a security system. The SRI hash in each file pins the exact
   bytes either way.

If EU-owned infrastructure is a requirement rather than a preference,
`docs/TECH-STACK.md` sets out what that costs.

---

## Before go-live

- [ ] Decide and document the lawful basis
- [ ] DPIA — this is systematic monitoring of individuals' movements
- [ ] Privacy notice for residents: what is logged, why, retention, their rights
- [ ] Set `event_retention_days` to the real retention period for `gate_events` / `checkin_events`
- [ ] Set `compliance_retention_days` to the real statutory period — the default (2555 days) is a placeholder, not a decision
- [ ] Confirm `pg_cron` is enabled and all four scheduled jobs are running (`select * from cron.job`), in particular `close-out-compliance-days` — without it the register only ever gains positive rows and no one is ever recorded as having missed a day
- [ ] DPAs signed with every processor
- [ ] Supabase project confirmed in an EU region
- [ ] Public sign-up disabled (verify by trying to register)
- [ ] Staff briefed that `note` must not carry health or other sensitive data
- [ ] A named person who can action access and erasure requests
- [ ] Decide whether guard names are redacted from resident-facing exports
