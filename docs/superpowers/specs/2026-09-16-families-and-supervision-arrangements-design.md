# Families and child-supervision arrangements (Appendix 5) — design

Written 16 September 2026 from the Slaney Manor visit (15 September) and
Niamh Slevin's follow-up email the next day. Piece A of the child-welfare
bundle; piece B (the 22:00 guardian alert, the register conflict flag and
one nightly email) is a separate spec that builds on this one.

The owner's rulings for the bundle, taken as defaults on 16 September:
every adult in a household is a guardian of its children; arrangements are
recorded by supervisors and admins; no contact number and no free text
(the paper form keeps those); security see the carer's name and room at
the door; the Families tab is rebuilt as part of this; the sample residents
are the test bed until the centre's register arrives.

## What the centre does today

House Rules 3.5.4 (June 2026): children must not be left overnight with
another resident except exceptionally, with prior approval; a parent leaving
a child in another adult resident's care for any time completes Appendix 5
of the Child Protection and Welfare Safeguarding Policy (child, room,
anticipated duration, the nominated carer's name and room, a contact number,
both signatures). Management approves; the form is filed. Daytime
arrangements are routine; overnight is rare — none approved since June.
Security are never told. A real incident followed: a mother off site
overnight, children unsupervised, nothing flagged until Monday.

## Decisions

- **A household is still only "who shares a family"** — but the app now
  reads it: the **adults** of a household are its **guardians**, the
  under-adult-age members its **children**. No parent/guardian flag; if a
  household ever needs one (an adult sibling who is not responsible), that
  is a later column. Households with no children have no guardian logic.
- **An arrangement is a fact about children, a carer and a period.**
  `supervision_arrangements`: the household whose children are covered, the
  nominated carer (an active adult resident who is **not** in that
  household), `from_at`/`to_at` (timestamps, site time in the UI), whether
  overnight is approved, who recorded it and when, and an `ended_at` for an
  arrangement cut short. Nothing else: no phone number, no reason, no note.
  The paper form on file is the record of those.
- **Children, not a child.** An arrangement covers every child in the
  household at the time (Appendix 5 lists them by name, but a carer minding
  "the Brennan children" is the real case, and a per-child list invites a
  child being forgotten). If a household later gains a child, the
  arrangement covers them too — it is about who is responsible, not a roll.
- **Overnight is a tick with a warning, never a refusal.** Recording an
  arrangement whose period crosses a night shows "Overnight care by another
  resident needs the manager's exceptional approval (House Rules 3.5.4)" and
  requires the `overnight` tick; the app records the fact and never decides.
- **Security see it where they act.** On the In & out screen, a guardian's
  card carries "Children with Fatima Al-Sayed · Ground G4 until Thu 18 Sep
  20:00" while an arrangement runs; the carer's card carries "Minding the
  Brennan children until …"; each child's card carries "With Fatima Al-Sayed
  · G4". The line is data guards already see (names, rooms) about people
  already on their screen. When the last guardian of a household signs OUT
  and children are on site with **no** arrangement running, the guard's
  confirmation reads "Children stay on site — no supervision arrangement
  recorded" (a fact, not a block; the arrangement may be on paper only).
- **Recorded from the family, by supervisors and admins**, on the rebuilt
  Families tab and on any household member's edit sheet. Ending early is a
  button; nothing is deleted (`ended_at`), so the history of who minded whom
  survives for the retention period and the export.
- **The Families tab is rebuilt** as agreed on 15 September: one card per
  household (label, room(s), guardians and children with ages, current
  arrangement if any), add a member by search, remove a member, and an
  "Unassigned" list of residents in no household. The existing "Select
  several → Family" on the Residents tab stays as the quick way to make one.
- **Retention:** arrangements are purged with the register
  (`compliance_retention_days`) by the nightly job like other per-day facts.
- **Feature switch:** everything here sits behind the existing
  `feature_households` switch — no arrangement can exist without households.

## Data

Migration `053_supervision_arrangements.sql`:

```sql
create table if not exists public.supervision_arrangements (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households (id) on delete cascade,
  carer_id      uuid not null references public.residents (id) on delete cascade,
  from_at       timestamptz not null,
  to_at         timestamptz not null,
  overnight     boolean not null default false,
  recorded_by   uuid not null references public.profiles (id),
  recorded_at   timestamptz not null default now(),
  ended_at      timestamptz,
  constraint supervision_period check (to_at > from_at),
  constraint supervision_ended_inside check (ended_at is null or ended_at >= from_at)
);
create index on public.supervision_arrangements (household_id, from_at desc);
create index on public.supervision_arrangements (carer_id, from_at desc);
```

- RLS: staff read; insert/update through two SECURITY DEFINER functions
  (supervisor or admin): `record_supervision(household, carer, from, to,
  overnight)` — refuses a carer who is not an active adult, or who is a
  member of the household; refuses overlapping arrangements for the same
  household; `end_supervision(id)` sets `ended_at = now()`. Admin audit via
  the existing trigger pattern (insert/update rows written to `admin_audit`).
- View `v_household_care`: per household — `guardians` (count of active
  adults), `children` (count of active under-age), `guardians_on_site`
  (adults with presence 'in'), `children_on_site`, and the running
  arrangement (`arrangement_id, carer_id, carer_name, carer_room_label,
  to_at, overnight`) where `now() between from_at and to_at and ended_at is
  null`. Piece B reads this view at 22:00.
- `v_resident_status` / the resident list gain nothing; the list endpoint
  joins `v_household_care` on `household_id` when `feature_households` is on
  so the gate can draw the lines without a second request.
- Purge: `purge_supervision_arrangements()` deletes rows with
  `to_at < now() - compliance_retention_days`, added to `TENANT_JOBS`.

## API

- `GET /api/households` (staff): households with members (id, full_name,
  is_adult, age_years, room_label, presence) and the running arrangement;
  plus `unassigned: [...]` active residents with no household. Powers the
  Families tab.
- `POST /api/households/:id/supervision` (supervisor/admin) body
  `{ carer_id, from_at, to_at, overnight }` → 201 the arrangement. 400 on a
  carer in the household, a non-adult or departed carer, an overlap, or a
  period crossing a night without `overnight: true` (the UI ticks it; the
  server insists).
- `POST /api/supervision/:id/end` (supervisor/admin) → 200.
- `GET /api/households/:id/supervision?from&to` (staff): history for the
  edit sheet, newest first.
- `GET /api/residents` rows gain `care: { role: 'guardian'|'child'|'carer', carer_name, carer_room_label, until, overnight } | null` when an arrangement is running that involves the resident.
- Report `supervision` ("Child supervision arrangements", ranged, audited):
  household, children (names), carer, carer room, from, to, overnight,
  recorded by, ended early.

## UI

**Admin → Families** (replaces the Residents-tab-only handling; the tab
appears when `feature_households` is on):
- Cards, one per household, sorted by label: label ("Brennan family (2)"),
  members grouped guardians then children with age, room label(s), presence
  dots as on the roll call. A running arrangement shows as a line with
  "End early". A "Supervision…" button opens the recording form: carer
  (search among active adults not in the household), from/to (date + time,
  defaulting to now → 20:00 today), overnight tick (forced on, with the
  3.5.4 warning, when the period crosses midnight site time).
- "Add a member" on a card: a search box over unassigned/other residents;
  picking joins them (the existing `household_with`). "Remove" on a member
  clears `household_id` (existing). A card of one member offers "Dissolve".
- Below the cards: **Unassigned** — active residents with no household,
  with "Make a family" (tick two or more → one household) mirroring the
  Residents-tab flow.
- Edit sheet Household section: shows the running arrangement and the same
  "Supervision…" button, so a supervisor on a resident's record can record
  it without leaving.

**In & out (gate)** — with `feature_households` on:
- Card meta line gains the care line described in Decisions.
- Sign-OUT confirmation for a guardian whose household would then have no
  guardian on site but children on site: an extra sentence "Children stay on
  site — no supervision arrangement recorded" (or "— in Fatima Al-Sayed's
  care until 20:00" when one runs). The button stays "Sign out"; nothing is
  blocked.

**Help** gains a "Families and supervision" section.

## Out of scope (piece B and later)

- The 22:00 guardian alert email and the conflict flag (piece B).
- A guardian flag per adult; Appendix 5 part (B) (already an authorised
  absence for a child); contact numbers; free text.
- Visitor-hours enforcement (roadmap).
- Gender field, room column, night-worker flag (roadmap).

## Testing

- DB: `record_supervision` refuses a guard (42501), a carer in the same
  household, a child carer, a departed carer, an overlap; `end_supervision`
  sets `ended_at`; `v_household_care` counts guardians/children on site and
  surfaces the running arrangement; purge removes old rows only.
- HTTP: Families endpoint shape with the three sample families; record →
  201 and the `care` lines appear on guardian, carer and children in
  `/api/residents`; end early → lines vanish; crossing-midnight without
  `overnight` → 400; report audited; guard 403 on record/end.
- Parse step for admin.html/index.html; browser pass on the sample site.
- `./check.sh` green.
