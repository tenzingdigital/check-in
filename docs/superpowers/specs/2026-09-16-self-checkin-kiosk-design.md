# The Register role — resident self check-in on a tablet — design

Written 16 September 2026 from the owner's ask, refined in conversation:
"Resident history shouldn't be viewable by all … a permission that only
allows the account to see the 24 hour register and check-in and search
their own names … it should be locked down as it's a generic account" —
and then, decisively: "the sole purpose is for residents to use this
screen on a tablet to check themselves in for the night only … search
only, no list, no filters."

So this is not a fourth staff role. It is a **resident-facing kiosk**: a
login that can do exactly two things — find one person, and record that
person's check-in for today — and nothing else, enforced in the database.

## Decisions

- **A new role `kiosk`**, spelled that way in the schema and shown as
  "Self check-in tablet" in Admin. It is *not* a member of `is_staff()`,
  so every existing row policy and SECURITY DEFINER function that asks
  `is_staff()` / `is_supervisor()` / `is_admin()` refuses it. It reaches
  resident data only through two new SECURITY DEFINER functions built for
  it.
- **Search, never list.** `kiosk_search(q)` needs at least two characters,
  matches the name (trigram/prefix on `search_key`), the room label
  (exact, case-insensitive) or the identity number (**exact** match only,
  so a number cannot be enumerated a digit at a time), and returns at most
  five rows of `resident_id, full_name, room_label, checked_in_today`.
  `room_label` is returned only when two or more matches share a
  `full_name`, so one resident is not shown another's room by default.
  Never DOB, ID, history, counts or states beyond "checked in today".
- **Check in only.** `kiosk_checkin(resident_id)` calls the existing
  `record_checkin_at(...)` with `source = 'kiosk'` (migration 026's
  `source` check gains the value). No undo in the database — the register
  is append-only; the screen offers a 10-second "That's not me" which
  simply does not send until the 10 seconds pass (a local delay, not a
  server undo). Children: the kiosk refuses to check in a resident under
  the site's adult age ("Please ask a member of staff") — a child's
  check-in needs an adult present.
- **A dedicated page, `/kiosk.html`**: one search box, results as large
  buttons showing the name (and room only when disambiguating), a
  confirmation screen with the name large, "That's not me", then back to
  the search after a few seconds. No header tabs, no counts, no list,
  nothing else on the page. Idle: the search clears after 30 seconds of
  no input so the next resident never sees the previous search. The
  session does not idle-lock for this role (it lives on a tablet in
  Guided Access; the owner locks the device, not the session).
- **Routing.** A `kiosk` session may call only `POST /api/kiosk/search`
  and `POST /api/kiosk/checkin`; every other `/api` route answers 403 for
  the role at `auth.requireSession` level (one check, not per route), and
  `index.html`/`checkin.html`/`admin.html` redirect a kiosk session to
  `/kiosk.html`. Logging in as kiosk lands on `/kiosk.html`.
- **Honest register.** The daily register and the resident's history show
  a kiosk check-in with a small "self" mark and "checked in at the
  tablet"; exports carry `source`. Staff can see at a glance which
  check-ins nobody witnessed.
- **Rate limit** on `/api/kiosk/search`: 60 searches a minute per session
  — enough for a queue at the door, too few for scraping names.
- **Setup.** Admin → Staff → Add account, role "Self check-in tablet"; the
  invite email lands as usual; log the tablet in once. The role cannot
  receive the Sunday report or the safeguarding alert (the existing guard
  constraints extend to it); cannot be promoted to admin by itself — an
  admin changes the role like any other.

## Out of scope

PIN or photo confirmation of identity (a different product decision);
sign-out at the door; visitors; anything on the kiosk beyond the two
actions. If a centre wants a witnessed check-in, they use a staff login.

## Data

Migration 051: `profiles.role` check gains `'kiosk'`; `checkin_events.source`
check gains `'kiosk'`; `kiosk_search(text)` and `kiosk_checkin(uuid)`
SECURITY DEFINER functions gated on `my_role() = 'kiosk'` (and callable by
supervisors/admins for testing); the weekly_report / safeguarding_alert
"not guard" constraints and triggers become "not guard and not kiosk";
`v_resident_status`/history views expose `last_checkin_source`. Tenant
template regenerated.

## Testing

HTTP suite: a kiosk session gets 403 on `GET /api/residents`, `/api/residents/:id/compliance`,
`/api/checkins`, `/api/gate/*`, `/api/settings`, `/api/staff`, and any
admin route (add the role to the permission matrix as a fifth column —
every existing row expects `deny` for it, and the two kiosk routes expect
`allow` for kiosk and `deny` for guard); search needs 2+ chars, returns
≤5, never DOB/ID, room only on a name collision, ID search exact-only;
check-in writes `source='kiosk'` and shows in the register with the mark;
a child is refused; rate limit fires at 61. DB suite: `is_staff()` is
false for kiosk; a direct `select from residents` as kiosk returns
nothing. Front end: the page parses, no list endpoint is ever called.
