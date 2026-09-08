# A Door sign-in counts as the day's check-in — per-site switch — design

Written 8 September 2026 from the owner's decision ("add the door sign-in
as a switch"), after the question of whether a sign-in should count was
argued both ways.

## The line the product keeps

TAO 13 says a sign-in is not a check-in, because the duty is to present, not
merely to be seen leaving. That stays true by default. This switch lets a
centre say: at our door, a sign **in** is the presentation. A sign **out**
never counts. The register records the presentation with its source, so a
manager can always tell a door-derived check-in from one taken at the desk,
and turning the switch off later leaves the record honest.

## What changes

1. **Setting.** `app_settings.feature_door_checkin boolean not null default
   false`. Admin → Settings → Features for this site gains: "**Door sign-in
   counts as check-in.** A sign IN at the Door (never a sign OUT) also records
   today's check-in for that resident, marked as recorded at the door. Off,
   the two acts stay separate and a resident must present at the register."
   `PATCH /api/settings` accepts it; `GET /api/session` returns it.
2. **Source on the event.** `checkin_events.source text not null default
   'desk' check (source in ('desk','door'))`. `record_checkin_at()` gains a
   fifth parameter `p_source text default 'desk'` and writes it. The old
   four-argument signature is dropped first so there is one function, and
   the two existing callers (`record_checkin`, `record_checkin_late`) keep
   working through the default.
3. **The door writes the check-in.** In `record_check()` and
   `record_check_late()`, after a sign-in event is actually inserted (not
   swallowed as a double tap) and only when `p_direction = 'in'` and the
   switch is on: `perform public.record_checkin_at(p_resident_id, <the
   event's time>, <late flag>, <the event's client_ref>, 'door')`. The
   check-in's own 60-second dedupe still applies, so a desk check-in
   seconds after a door sign-in is one presentation. Under-18s are recorded
   as the desk records them (the rule is applied at close-out, not here).
4. **The register shows the source.** `GET /api/residents/:id/compliance`
   returns `source` on each of `checkins_today_events`. The detail sheet's
   events list reads "08:12 · at the door · recorded by Gina" for a door
   event; the Today fact reads "Seen at the door 08:12 (1×)" when the
   earliest check-in today came from the door. Cards are unchanged.
5. **The Door tells the guard.** After a successful sign-in with the switch
   on, the toast says "… signed IN · today's check-in recorded".
6. **Reports.** The daily register report is unchanged (it shows
   `first_seen`; the source is a detail-sheet fact). Noted in the roadmap
   as a possible later column.
7. **Docs.** help.html's register paragraph, the admin features list in the
   help, README's two sentences, TAO 13 (one caveat sentence), the product
   roadmap entry. No new personal data (a two-value source on an event the
   system already keeps); GDPR doc unchanged.
8. **Tenant template** regenerated (schema change).

## Testing

- `test/compliance.sql`: switch off → `record_check(id,'in')` adds no
  `checkin_events` row; switch on → it adds one with `source='door'` and the
  day is `presented`; `record_check(id,'out')` with the switch on adds
  nothing; a desk `record_checkin(id)` within 60 s adds no second event;
  `record_check_late(id,'in',t,ref)` with the switch on adds a door event
  with `late_entry = true`.
- `test/api.test.js`: an admin PATCHes the switch on; a guard POSTs a gate
  `in`; the resident's `/compliance` shows `seen_today` true and
  `checkins_today_events[0].source === 'door'`; a gate `out` for another
  resident leaves `seen_today` false; the admin PATCHes it off. The session
  test's settings list gains `feature_door_checkin` (default false).
