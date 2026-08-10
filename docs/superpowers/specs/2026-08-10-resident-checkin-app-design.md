# Resident check-in app — design

**Date:** 2026-08-10
**Status:** approved in brainstorming, not yet implemented
**Supersedes:** the 24-hour compliance behaviour currently in `index.html` and `supabase/schema.sql`

---

## Why this exists

The first build treated "sign in at the gate" and "present at the hut daily" as one
action. They are two different obligations serving two different masters:

| Purpose | Question it answers | App |
|---|---|---|
| Site security / headcount | Who is on site *right now*? | Gate app |
| Statutory / licensing + occupancy verification | Did this person present today? | **Check-in app** (this spec) |

Merging them produced a system that was wrong for both. This spec covers the
check-in app and the shared-core changes it needs. The gate app is a follow-on.

---

## Decisions

Each of these was settled during brainstorming and reversed a decision in the
current build.

### 1. Compliance is measured per calendar day, not on a rolling 24-hour window

The current build sets the deadline at `last_in_at + 24h`. A resident who
presents at 09:00 Monday must present by 09:00 Tuesday; arriving at 10:00 Tuesday
is recorded as a breach *despite them presenting every single day*. Over a week of
slightly later arrivals a fully compliant resident drifts into breach.

Tolerable under a welfare reading. Not tolerable here: a false breach against
someone whose licence or residency depends on the record is a serious defect.

**A resident is compliant for a day if at least one check-in is recorded between
midnight and midnight in the site's local timezone.**

### 2. Breaches are never suppressed

A missed day is always recorded as a missed day. Staff may attach a reason; the
reason never flips the outcome, and annotated breaches still appear in every
export and count.

Suppression happens only in the guard's *attention* — annotated breaches sort
lower and grey out so the working list stays actionable — never in the record.

### 3. The daily register is materialised and outlives the movement log

Compliance is currently derived on the fly from `check_events`, which
`purge_expired_check_events()` deletes at 90 days. After 90 days the system can no
longer show whether anyone met the requirement, and a resident who presented every
day for a year becomes indistinguishable from one who never did.

Retention therefore splits:

| Data | Retained | Rationale |
|---|---|---|
| `gate_events`, `checkin_events` | 90 days | Granular movement data — minimise (GDPR Art. 5(1)(e)) |
| `daily_compliance`, `compliance_annotations` | statutory period (default 7 years) | Proof of daily reporting |

The register row is tiny — resident, date, two booleans, a count — so keeping it
far longer than the movement log is proportionate.

### 4. Register rows are written twice: on the event, and at close-out ("approach C")

Rejected alternative — a single nightly job writing the whole day: if that job
fails to run, the day has **no** rows at all, including for residents who
demonstrably attended. The evidence goes missing exactly where it is needed.

Instead:

1. **On check-in.** `record_checkin()` writes the `daily_compliance` row for that
   resident and day in the same transaction as the event. If the check-in saved,
   the proof saved.
2. **After midnight.** `close_out_compliance_days()` writes only the *negative*
   rows for residents who never appeared, and marks the day closed.

A dead cron job can then never destroy evidence that someone did present. The
worst case is a temporarily missing breach row, which the next run backfills. The
failure mode is asymmetric in the safe direction.

### 5. Escalation is out of scope

Missing a day produces a record and an optional reason. Phone calls, welfare
checks and reports to the regulator happen outside the system. No notifications —
they would add a processor and a delivery-failure mode that itself looks like
non-compliance.

### 6. No `present` event kind

An earlier draft added a third event kind so an on-site resident could be marked
seen without changing their in/out state. Splitting the apps removes the need:
check-ins live in their own table and never touch presence.

Consequently a gate sign-out does **not** satisfy the daily requirement. A
check-in is a deliberate, separately recorded act — a truer record of "a guard
laid eyes on this person" than inferring it from someone leaving the site.

---

## Scope

**In scope**
- `checkin_events`, `daily_compliance`, `compliance_annotations` and their RLS
- `record_checkin()`, `close_out_compliance_days()`, retention functions
- Splitting `check_events` into `gate_events` and `checkin_events`
- A separate front end, `checkin.html`
- Acceptance-suite coverage for all of the above

**Out of scope**
- Escalation tracking, notifications, resident-facing anything
- Trimming the 24-hour UI out of the gate app — follow-on, after this lands, so
  the gate app keeps working untouched while this is built

---

## Data model

### Shared-core changes

`check_events` is renamed to `gate_events` and keeps `kind` (`'in' | 'out'`). The
branch has never been deployed, so there is no migration cost.

`app_settings`:

| Change | Field | Note |
|---|---|---|
| drop | `compliance_window_hours` | meaningless under a calendar-day rule |
| drop | `warn_before_hours` | replaced by `due_soon_after_hour` |
| add | `due_soon_after_hour` (default 18) | when "not seen yet" starts being flagged |
| add | `compliance_retention_days` (default 2555) | ~7 years — **placeholder, must be set to the real statutory period before go-live** |
| keep | `local_timezone` | **now load-bearing** — see below |
| keep | `adult_age_years` | |
| keep | `event_retention_days` | applies to **both** `gate_events` and `checkin_events`; one window for all granular movement data |

`residents` gains `departed_on date`. Close-out needs to know when a resident
stopped being subject to the rule; `status` alone cannot answer that for a past
date, which would corrupt backfill.

> **`local_timezone` becomes load-bearing.** It defines where the day boundary
> falls, so it decides whether a 00:15 check-in counts for today or yesterday. The
> gate app's Log tab currently filters by *browser* local day; on a terminal set to
> the wrong zone the two disagree. Both must move onto `local_timezone` so the
> system has one definition of a day.

### New tables

```
checkin_events
  id, resident_id, guard_id, occurred_at, note
  append-only; no kind column — a check-in is a check-in

daily_compliance                          -- the permanent register
  resident_id + compliance_date  (PK)
  required        boolean   was the rule in force for this person that day
  presented       boolean   did a check-in happen
  first_seen_at   timestamptz
  checkin_count   integer
  closed_at       timestamptz   null while the day is still open

compliance_annotations                    -- append-only, many per day
  id, resident_id, compliance_date, note, author_id, created_at
  FK → daily_compliance, on delete cascade
```

Annotations are a separate table rather than columns on the register row
specifically because of decision 2: if the reason lived on the row, editing it
would erase what was said before. A supervisor adding context in March must not
overwrite a guard's note from January.

`required` is stored per row, not inferred at read time. A resident who turns 18
mid-history then has an honest register showing exactly when the duty began, and
backfill must compute age **as of that date**, never today's age.

### Access rules

Consistent with the existing model:

- Guards: insert check-ins (attributed to `auth.uid()`), read the register, add annotations
- Supervisors: also manage residents and `departed_on`
- Admins: settings, GDPR export and erasure
- Nobody: UPDATE or DELETE on `checkin_events`, `daily_compliance` or annotations

An annotation can never alter `presented`. Enforced by there being no update path
to that column outside the two writer functions.

GDPR: `erase_resident()` must cascade to the new tables, and
`export_resident_record()` must include the register and its annotations.

---

## Compliance states

**Today (open):**

| State | Meaning |
|---|---|
| `seen_today` | Check-in recorded today |
| `expected` | None yet, before `due_soon_after_hour` — normal, not flagged |
| `due_today` | None yet, past the cutoff — nudge |
| `exempt` | Under 18, or not active |

**History (closed days):**

| State | Meaning |
|---|---|
| `breach_open` | Missed day(s), unexplained |
| `breach_noted` | Missed day(s), reason attached |
| `not_required` | Rule did not apply that day (under 18, or before registration / after departure) |
| `never` | On the register, never once seen |

A register row is written for **every** active resident every day, including
those the rule does not apply to — with `required = false`. Storing the
non-obligation explicitly is what lets the register explain itself years later,
rather than leaving a gap that could be read as a missing record.

`never` stays distinct from a long breach run: it usually means a registration
error rather than a missing person, and the two need different responses.

**Consecutive missed days is the headline number, not the total.** Three days
running is a welfare or enforcement matter; three scattered Tuesdays over six
months is administrative. Same total, different response.

---

## Front end — `checkin.html`

A second static file alongside `index.html`, same stack, no build step.

**Check-in tab** — search by name (reusing `search_residents`), tap a resident,
one large *Record check-in* button. Confirmation shows the day is satisfied.

**Attention tab** — worst first:
1. Unexplained missed days, ordered by consecutive count
2. Explained missed days — greyed, still listed, still counted
3. Not seen today, past the cutoff

**Resident detail** — a 30-day strip (present / missed / not required), and the
ability to attach a reason to any missed day.

**Header** — `Not seen today`, `Open breaches`, `Check-ins today`.

---

## Failure modes

| Situation | Behaviour |
|---|---|
| Cron outage for N days | Next run backfills every missing date; positive rows already exist from decision 4 |
| Close-out runs twice | Idempotent — keyed on (resident, date), never overwrites an existing row |
| Duplicate check-ins same day | `checkin_count` increments; `presented` stays true; `first_seen_at` unchanged |
| Resident registered mid-period | Rows begin at `registered_at`, never earlier |
| Resident departs | Rows stop at `departed_on` |
| Resident turns 18 mid-history | `required` false before the birthday, true from it — computed per date |
| DST transition | Day boundaries derived in `local_timezone`, so 23- and 25-hour days are handled by the platform |
| Check-in at 00:15 | Counts for the new day, per `local_timezone` |

---

## Testing

Extends `supabase/tests/`, which already asserts the authorisation model. The
security model stays as it is; these are the new behaviours:

- Calendar-day boundary in site timezone: 23:59 and 00:01 land on different days
- The Monday-09:00 / Tuesday-10:00 case is **compliant** (the defect this fixes)
- 18th birthday mid-history: `required` flips on the correct date, and backfill
  computes age as of each date rather than today
- Close-out idempotency: two runs produce no duplicates and no overwrites
- Backfill after a simulated 10-day outage fills every missing date
- An annotation cannot flip `presented`
- Guards cannot update or delete register rows, annotations or check-in events
- Retention: `checkin_events` purged at 90 days while `daily_compliance` survives
- Erasure removes register rows and annotations along with the resident

---

## Follow-on

1. Trim the 24-hour compliance UI out of the gate app (badges, Overdue tab, compliance counters)
2. Move the gate app's Log date filter onto `local_timezone`
3. Update `README.md`, `docs/GDPR.md` (retention table, new categories) and `docs/TECH-STACK.md` (two front ends)
