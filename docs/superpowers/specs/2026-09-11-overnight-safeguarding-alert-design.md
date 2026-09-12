# The overnight safeguarding alert — design

Written 11 September 2026 from the owner's question: how does a centre
manager see that an under-18 has been away overnight without authorisation?
The answer today is that they cannot, and this is what changes that.

Four decisions were taken while writing it: the source is the In & out
register and not the daily register; the exception is an authorised absence
entered per occasion, with no standing per-child arrangement; recipients are
a flag of their own and not the Sunday report's; and a night with nothing to
report still sends a message.

## What the centre does today

The Brighton explanation document behind
`2026-09-10-weekly-register-update-design.md` records the practice: security
emails the manager at midnight with who left during the day and is still
out, and the manager checks the next morning who came back. **Children are
not on the daily register, so the movement log, not the register, is the
source.**

The app already takes that midnight list itself — migration 027,
`overnight_absences`, one row per resident per night off site at site
midnight, derived from `gate_events` and kept as long as the register. The
Absent overnight report reads it.

## What is wrong now

An under-18 is exempt from the daily check-in rule, and in
`v_resident_compliance` that exemption is evaluated **second**, before
everything else:

```sql
when r.status <> 'active'            then 'not_required'
when not compliance_required(...)    then 'exempt'      -- a child stops here
when coalesce(t.open_breaches,0) > 0 then 'breach_open'
when coalesce(tr.presented,false)    then 'seen_today'
...
```

So for a child:

- `required_today` is false, so they never appear under **Not seen** — the
  tile the register opens on and its default filter;
- `state` is always `exempt`, so they never reach `attention_list()`, which
  selects only `breach_open`, `never` and `due_today`;
- an open breach report on a child would not surface either, because
  `exempt` wins before `breach_open`.

A fifteen-year-old not seen for three days looks exactly like one seen an
hour ago. The only way to find them is to scroll Everyone and know to look.

That is defensible as *compliance* — IPAS puts the daily obligation on
adults, and a child is not in breach of anything. But it has been built as
"exempt from the rule" and it reads as "not our concern", and those are
different things. A child missing is a safeguarding matter whether or not
they owed a check-in.

The Absent overnight report already carries both halves of the answer:

```sql
case when vs.is_adult then '' else 'child' end as child,
concat_ws('; ', … case when absence_authorised(o.resident_id, o.night)
                       then 'authorised' end) as note
```

They are never combined. An unauthorised child is a `child` cell beside an
empty `note` cell, sorted by night then surname, among authorised adults. A
manager must read two columns, combine them, and notice the absence of a
word.

## The line the product keeps

**The app records facts and never decides.** The alert says a child was away
on a night with no authorised absence recorded. It does not say anyone did
anything wrong, and it does not say the child is missing — only that the
centre has no record of agreement for that night.

**Email carries counts and a link, never personal data.** Commit `ec793da`
took resident names out of the Sunday email deliberately; migration `037`
moved recipients from typed-in addresses to a flag on the staff record so
every recipient is a person with a login. A nightly message naming a child
would undo both, and a child is the worst case to put in an inbox. The name
is one tap away, behind a login, on a view that is logged.

**A child is flagged, an adult is not.** An adult away overnight without
authorisation is a compliance matter that already has machinery — the
absence window, the breach report, the Sunday return. For a child it is a
safeguarding matter with no rule behind it. One column carrying both would
blur two different meanings.

## What changes

### 1. The report says what it knows

`REPORTS.overnight` in `routes/reports.js` gains a derived `concern` column,
filled only when the resident is under 18 **and** the night is not covered
by an authorised absence:

- away overnight, unauthorised → `CHILD AWAY — NOT AUTHORISED`
- no gate movement on record at all (`off_site_since is null`) →
  `CHILD — NEVER SIGNED IN`

Blank for everyone else. Flagged rows sort first within each night, so they
are the first thing on the page rather than alphabetical among authorised
adults. No schema change; both facts are already in the query.

The second case is included because that row already exists in
`overnight_absences` and means nobody knows where the child has been, which
is the more serious of the two.

### 2. A recipient flag of its own — the next free migration

Numbered 040 if `claude/review-fixes-2026-09-11` has merged (it adds 038 and
039); 038 if this is built first. Whichever it is, take the next free number
at the time of writing rather than the one named here — a collision fails at
boot, which is how 038 and 039 came to be renumbered in the first place.

`profiles.safeguarding_alert boolean not null default false`, mirroring
`weekly_report` from migration 037 exactly:

- a check constraint refusing `safeguarding_alert and role = 'guard'`, so
  the guarantee is in the database and not only in the route;
- a trigger clearing the flag on demotion to guard, so a role change never
  fails because of it;
- the definer function revoked from `public, anon, authenticated`.

Separate from `weekly_report` because they are different audiences: a
designated safeguarding person may want the nightly alert and not the weekly
return, or the reverse. Ticking one should never tick the other.

A checkbox on the staff record beside the weekly one.

### 3. The job — inside the existing 00:30 cron

`jobs.js` runs the nightly alert immediately after
`snapshot-overnight-absences`, and **only if that succeeded** — the same
guard the Sunday email already uses, for the same reason: no snapshot means
no honest answer, so skip and record the skip rather than send something
wrong.

The night examined is the one that just ended. The count is children with a
row in `overnight_absences` for that night not covered by
`absence_authorised(resident_id, night)`.

One send per night. The idempotence guard requires a real delivery — a night
where nothing reached anybody retries rather than recording itself as done
— matching the fix applied to the weekly job on
`claude/review-fixes-2026-09-11`.

Every run is recorded in `job_runs` whether it sends or not, so "did the
check run last night?" is answerable in the app without relying on the mail.

### 4. The email — `lib/safeguardingAlert.js`

Mirrors `lib/weeklyReport.js`: counts and a link, composed in one place so
the wording cannot drift.

On a night with a concern:

> **Slaney Manor: overnight safeguarding check, 11 September — 1 to look at**
>
> 1 child was away overnight with no authorised absence recorded.
>
> Open the app: https://…
>
> The detail — names, rooms and times — is in the app under
> Admin → Reports, Absent overnight.
>
> Nights are counted at midnight, site time. A night inside an authorised
> absence recorded in CheckSteady is authorised; any other is not.

On a clear night:

> **Slaney Manor: overnight safeguarding check, 11 September — nothing to
> report**
>
> No children were away overnight without an authorised absence.

**The subject line differs between the two.** An identical nightly email
saying "nothing to report" is filtered to a folder within a fortnight, and
then the one that matters is filtered with it. The count in the subject is
what keeps it readable in a list. This is also why every run is recorded in
`job_runs`: the nil email is a convenience, not the only evidence the check
ran.

## Tests

- `test/compliance.sql`: a child with an `overnight_absences` row and no
  authorised absence is counted; the same child with an authorised absence
  covering that night is not; an adult in the same position is not.
- `test/compliance.sql`: `profiles.safeguarding_alert` cannot be set on a
  guard by direct SQL as the owner (check constraint), and demoting a
  ticked supervisor to guard clears it rather than failing (trigger). This
  mirrors section N, added for `weekly_report`.
- `test/api.test.js`: the Absent overnight report's `concern` column is
  filled for an unauthorised child, blank for an authorised child and blank
  for an adult; flagged rows come first within a night.
- `test/api.test.js`: a guard cannot tick the flag through the API (403),
  and `test/permissions.js` gains a row for it.
- The composed email body contains no resident name, for both the concern
  and the nil case. Asserted against the composer directly, the way the
  weekly report's body is.

## Out of scope

**The live view.** This tells a manager after the night, when the mail
arrives or the report is run. It does not answer "is a child missing right
now?" during the day. That needs `state` to mean something other than
`exempt` for a child, which touches the register tiles and
`attention_list()`, and it is a larger decision about what the register is
for. Worth doing; not this.

**Standing per-child arrangements.** A child who is expected to be away
regularly — a relative, a care placement — still needs an authorised
absence entered per occasion. A standing exception would need a reason
recorded against a child, which is likely special-category data and brings
a DPIA question with it. Considered and deliberately deferred.

**Adults.** Unchanged. Their unauthorised nights already reach the absence
window, the breach report and the Sunday return.
