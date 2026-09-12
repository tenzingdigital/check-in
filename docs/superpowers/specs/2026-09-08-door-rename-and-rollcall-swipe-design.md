# "Door", and swipe to mark safe — design

Written 8 September 2026 from two owner decisions after the register work.

## 1. The gate app is called the Door

"Gate" is Slaney Manor's reality: the hut is at a gate. It is not true of a
converted hotel or a hostel, and the brochure site already calls the product
"the daily welfare register and door log". The **label** becomes **Door**.
Nothing else changes: `routes/gate.js`, `gate_events`, the `gate` CSS
classes, `data-view="gate"`, `body.app-gate` and the help anchor `#gate` all
stay, because renaming code is churn with no benefit to a guard.

Every user-facing occurrence changes, in `public/index.html`,
`public/checkin.html`, `public/admin.html`, `public/help.html`,
`public/app-common.js` (the chooser card) and `site/index.html` ("Door log").
Lower-case prose "the gate" in the help page becomes "the door". The
register's job line becomes "Movements in and out are on the Door."
`README.md` gets one parenthetical on its `index.html` line: "the Door (the
gate app in older notes)". Docs elsewhere keep "gate" as history.

## 2. Swipe a roll-call row to mark safe

The roll call's Safe button stays; a swipe on the row does the same thing.

- **Either direction marks safe**, like the register: one act, no direction
  to remember at an assembly point in the dark. The strip behind the row
  reads "Safe ✓" on both sides, in the register's green, not the gate's
  blue/amber.
- **A swipe never un-marks.** Un-marking stays the deliberate tap on
  "Safe ✓". A row that is already marked, and every row when no roll call
  is running, is rendered without the swipe wrapper and does not slide.
- **Visitors' rows swipe too**, calling the existing visitor mark, which
  still needs a connection and says so.
- **Mechanism.** `mountCardSwipe()` in `app-common.js` gains a `selector`
  option (default `"button.card"`, so both existing mounts are unchanged)
  and passes the element as a second argument to `onRight`/`onLeft`. The
  gate page mounts it a second time with `selector: ".swipe > .rollrow"`.
  Roll rows that may be swiped are wrapped exactly like register cards:
  `<div class="swipe"><span class="swipe-bg right">Safe ✓</span><span
  class="swipe-bg left">Safe ✓</span><div class="rollrow" …>`. Visit rows
  carry `data-vid` instead of `data-id`; the handler picks by which is set.
- **Sync.** Marks already sync across phones every few seconds and
  `renderRoll()` re-renders; a row another warden marked re-renders without
  its wrapper, so it stops sliding. Nothing new to store.
- **Help.** The roll-call paragraph says: "Swipe a row either way, or tap
  Safe."

## Testing

`./check.sh` (parse layer covers both pages and app-common.js; the suites
are unaffected). Manual on a phone: start a drill, swipe a row right, swipe
another left, both show Safe ✓; swipe a marked row, nothing moves; end the
drill, rows no longer slide.
