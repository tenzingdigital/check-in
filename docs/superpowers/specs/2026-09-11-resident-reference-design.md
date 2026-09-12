# The resident reference — design

Written 11 September 2026 from the owner's ask: every resident should have
an ID of our own, so a bulk update can be keyed on something stable instead
of a name. It need not be secret; it should not be complicated.

Decisions taken while writing it: the app generates the number rather than
storing the centre's own; it is unique per centre and never reused; and
date of birth stops being part of deciding who a row is, because a date
parsed from a spreadsheet is a guess.

## What is wrong now

There is no stable handle on a resident that a person can use. There are
three candidates and each fails:

- **The UUID** is stable and unique, but thirty-six characters, and nobody
  is pasting it into a spreadsheet column.
- **`id_number`** (the TRC or IRP number) is optional — `has_id` exists
  precisely because many residents have none — and it is sensitive, so it
  should not be the thing staff keep in a working file.
- **Name and date of birth**, which is what the import actually uses today:
  `routes/residents.js` builds a set of
  `lower(first_name)|lower(last_name)|date_of_birth` over active residents
  and marks a row `exists` when it matches.

That last one is the live defect. Two residents with the same name and
birthday are indistinguishable to it, and the load-test data already
contains three people called Amara Adeyemi. Correcting a spelling makes a
returning row look like a new person. And it rests on `dobFromSheet()`,
which reads **every** `dd/mm/yyyy` as day-first regardless of where the
sheet came from: `03/04/1990` is always 3 April, silently, because it parses
successfully. With the pivot at the current year, `26` becomes 2026 and `27`
becomes 1927.

A misparsed date of birth is worse than a bad match. It changes the age,
which changes whether the person is an adult, which changes whether they are
required to check in at all — and whether the overnight safeguarding alert
would ever flag them.

## The line the product keeps

**The app owns this number.** Centres have their own references from IPAS
paperwork and their own spreadsheets, and storing theirs would mean one
person with two identifiers and no way to tell which a given sheet means.
Ours is generated, ours is authoritative, and theirs stays in `id_number`
where it belongs.

**Unique per centre, never reused.** Each centre's schema has its own
sequence, so every centre counts from one. A sequence rather than `max + 1`
means erasing a resident does not hand their number to the next arrival —
an erased number must never reappear against a different person.

**Date of birth is data, not identity.** It is still imported, still drives
age and the daily rule. It stops being part of deciding *who a row is*.

## What changes

### 1. The column — next free migration number

```sql
alter table public.residents
  add column if not exists ref integer;

create sequence if not exists public.resident_ref_seq;
```

`ref` is assigned from the sequence on insert, by a `before insert` trigger
so no route can forget it, and is unique per schema. Existing residents are
backfilled in `registered_at` order, so the numbers read as the order people
arrived.

Displayed zero-padded to four digits — `0001`, `0142`, `1034` — by a small
helper shared between the server and the browser. Input accepts either form:
someone typing `142` gets `0142`.

**Not** shown on the gate cards. Those exist so a guard recognises a person
by face; a number there is noise. It belongs on the record, in exports, and
in the import template.

### 2. The import keys on it

`POST /api/residents/import` gains a `ref` column in the sheet. Per row:

- **`ref` present and it matches a resident** → that is the person. Update
  or skip as the sheet says.
- **`ref` present and it matches nothing** → an error on that line, not an
  insert. A typo in a reference must never quietly create a duplicate
  person.
- **`ref` absent** → match on **name alone**, case- and accent-folded:
  - exactly one active resident with that name → that is the person;
  - more than one → the line is returned as `ambiguous`, naming how many
    matched, and the person resolves it by putting the reference in;
  - none → insert, and the response carries the reference the new row was
    given.

Date of birth is no longer part of the key. A row that inserts still needs
one, and it is still parsed by `dobFromSheet()`, so the parser's day-first
assumption remains a defect — it is now a defect about *data* rather than
about *identity*, which is a smaller blast radius but not a fix.

### 3. The dry run has to earn its name

Today the preview says `exists` or `ready`. Because a reference now lets a
row update a resident confidently, the preview must show **which resident**
it matched — the reference and the name it resolved to — so a wrong
reference is visible before it is applied rather than after. A row keyed on
a reference that would change a name shows both the old and the new.

### 4. Exports carry it

Every report that names a resident gains a `ref` column, first. That is what
makes adoption gradual: export, and the references come with you, so the
next sheet a centre sends back is keyed without anybody typing a number.

## Tests

- `test/compliance.sql`: two residents inserted in order get consecutive
  references; erasing the second and inserting a third gives the third a
  new number, not the erased one.
- `test/api.test.js`: an import row with a known `ref` updates that
  resident; with an unknown `ref` it is an error and inserts nothing; with
  no `ref` and a unique name it matches; with no `ref` and a duplicated
  name it returns `ambiguous` and inserts nothing.
- `test/api.test.js`: the dry run names the matched resident.
- A unit test for the padding helper: `142` and `0142` and `00142` all
  resolve to the same reference; `abc` does not resolve.

## Out of scope

**`dobFromSheet()`'s day-first assumption.** Named in two specs now. It
needs its own work: either the import asks which order the sheet uses, or
the dry run shows the parsed date back in an unambiguous form so a person
can catch it. Not this change.

**Changing `id_number`.** The centre's own references stay where they are.

**A barcode or QR.** A number that can be typed is what was asked for.
