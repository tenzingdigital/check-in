# UX review — CheckSteady gate and daily register

A full pass over both front ends as they stand on `main` after the offline,
resilience and phone-layout work of 4 September 2026. Reviewed on a rendered
iPhone-sized viewport (390 × 844) in Chromium and against the source, from
the standpoint of the people who actually use it: a guard at a door at any
hour, a centre manager on a phone, and an administrator setting the site up.

The method is deliberately unglamorous: walk every screen, every state
(loading, empty, error, offline, filtered), and every role, and ask three
questions of each — *what is the person trying to do here, how many steps and
how much reading does it take, and what happens when it goes wrong.*
Findings are ranked by the harm they do to that person, not by how
interesting they are to fix.

---

## The short version

**What is already right, and should be protected.** The product does one
thing per screen and puts the whole register on screen before anyone types,
which is exactly the right call for a doorway. Two taps or one swipe records
the thing. The confirmation is immediate and specific ("Check-in recorded —
day satisfied"). Corrections are impossible by design and the interface never
pretends otherwise. The amber House Rules note states a fact with the rule
named and never a verdict, which is the single most humane piece of copy in
the system. Offline behaviour is honest: the pill changes colour, the card
says Queued, and nothing is silently lost.

**The five things I would fix first.**

1. **A dark-only theme at a doorway.** The app has no light mode. In daylight
   at a gate, on a phone with the brightness turned down to save battery, dark
   grey text on near-black is the difference between reading a name and
   guessing it. (P0)
2. **Zero is red.** "0 Breaches" is rendered in alarm red. A number should be
   coloured by what it means, not by which tile it sits in. Every glance at
   the register today starts with a false alarm. (P1, ten-minute fix)
3. **Search is not reachable while scrolling.** With 190 cards, a guard who
   has scrolled to the M's and needs to find a new arrival must scroll back
   to the top to type. The search box should stay pinned under the header on
   a phone, or the header should shrink further to make room for it. (P1)
4. **The word BREACH.** It is the correct statutory term and it belongs in the
   export. It does not belong in 24-point red on a card a guard reads while
   the person it refers to is standing at the window. A softer on-screen
   label ("Missed days") with the same red border keeps the information and
   loses the accusation. (P1, and a product decision)
5. **Errors vanish in three seconds.** A failed save is shown as a toast that
   disappears whether or not anyone read it. Errors should stay until
   dismissed; successes can fade. (P1)

Everything else is below, grouped by priority, then screen by screen.

**Status, 4 September 2026.** All five of the above are done, along with
P1.2, P1.4, P1.5, P1.6, P1.7, P1.8, the strip legend, `role="status"` on the
connection pill and the vocabulary pass ("Missed days", "Not yet seen",
"Under 18 — not required"). The idle lock from the security roadmap (F7)
landed in the same batch, with its minutes under Settings. What remains of
P2 is listed in place below.

---

## Who is using this, and where

Three people, three contexts, and they want different things from the same
screens.

| Person | Where | What they need in the first second |
|---|---|---|
| Guard | At a door or window, standing, one hand free, any hour, any weather, often on a shared tablet or their own phone | The name in front of them, and a way to record it without looking away for long |
| Centre manager | On a phone, walking, between other tasks | Who is missing, who is in trouble under the rules, and how long it has been |
| Administrator | At a desk, occasionally on a phone | Staff accounts, settings, exports — rarely, but correctly |

Most of the design serves the guard well. The manager is served by the
tiles and the Attention tab. The administrator is the least served: staff
management is a tab inside the guard's app, resident management does not
exist in the interface at all, and settings and exports need a database
console. `docs/SECURITY-ROADMAP.md` already carries those as Phase 2.

---

## P0 — Fix before the next centre goes live

### P0.1 A light theme, chosen by the device — *done 4 September*

`<meta name="color-scheme" content="dark">` and a palette of greys on
near-black. There is no light mode and no response to the device's setting.
Outdoors, or on a dimmed phone, `--muted` grey on `--surface` is hard to
read, and the small uppercase labels on the tiles and pills go first. A
security hut has a window; a gate has the sky.

*Do:* define the palette as tokens under `prefers-color-scheme: light` as
well, with a high-contrast light set (near-black text on off-white), and let
the device choose. Keep dark as the default for a night terminal. Check every
`color-mix()` pill against both. This is a stylesheet change with no
behaviour risk, and it is the largest single readability gain available.

### P0.2 Errors that stay

`toast()` shows every message, success or failure, for 3.2 seconds. "Not
recorded: Resident is not active" disappears before a guard who looked up at
the person has looked back down. On a shared terminal at night, that is a
check-in that did not happen and nobody knows.

*Do:* give `toast()` a `sticky` mode for errors that stays until tapped, and
keep the auto-fade for successes. Consider rendering errors inline in the
detail sheet where the action was taken, not floating over the list.

### P0.3 The register on a first run

A fresh site shows "No residents on the register" and offers nothing to do
about it, because there is no add-resident screen. The first thing an
administrator meets is a dead end with a database console behind it. This is
the roadmap's Phase 2.1 and it is the most important missing screen in the
product. Until it exists, the empty state should at least say how residents
get onto the register today.

---

## P1 — Fix soon; each is a daily irritation

### P1.1 Colour by meaning, not by tile

"0 Breaches" is red. "179 Not seen" is red at 09:00 when nobody is expected
yet. The tiles use a fixed colour per tile; the number should decide: zero
breaches is calm (neutral or green), a non-zero count is red, and "not seen"
should be neutral until `due_soon_after_hour`, when it becomes amber, and red
only for people still missing at close of day. The data to do this is already
in `v_resident_compliance` (`state` carries `expected` versus `due_today`).

### P1.2 Pin the search box on a phone — *done 4 September*

Under 600 px, keep `#q` pinned beneath the sticky bar while the list
scrolls. The bar is now short enough to afford it. Alternatively a small
"to top" affordance appears after scrolling a screen's worth — but the pinned
box is the more honest answer because typing is the primary action.

### P1.3 "BREACH" on a card — *done 4 September: "Missed days"*

Keep the red left border, keep the state in the data and the export, and
change the on-card label to something a guard can read aloud with the
resident present: "Missed days" or "Absent 4 nights". The detail sheet can
say more; the list should not. The same applies to "Never checked in" on a
resident who arrived yesterday — that reads as an accusation and is usually
just "new".

### P1.4 Section the long list — *done 4 September: surname letters*

190 names in one scroll with no landmarks. Add sticky letter headers (A, B,
C…) as the list is sorted by surname anyway, or a right-edge index on phones.
Cheap, and it turns a scroll into a jump.

### P1.5 The tabs and the switch look alike — *done 4 September: underline tabs*

The Gate / Daily register switch and the Search / Log / Staff tabs are the
same visual component two rows apart. A new guard cannot tell which is
"which app am I in" and which is "which view of it". Make the app switch
visually distinct: a segmented control with the accent fill is fine for the
app level; the view tabs underneath should be plain text tabs with an
underline, not another pill row.

### P1.6 Swipe is invisible — *done 4 September: a one-time nudge on the first card*

Swipe-to-record is the fastest path and nothing on a card suggests it exists
except one line of grey hint text. First-run coaching — a one-time nudge that
slides the first card a few pixels with "swipe right to sign in" — or a
subtle chevron on the card's edge would surface it. Keep the tap path as the
canonical one.

### P1.7 The Staff tab is in the wrong app — *done the same afternoon*

Administration lived inside the gate app's tab row, one tap from a guard's
working screen. It now lives on an Admin page reached from the header
(`public/admin.html`), with Residents for supervisors and Staff for admins,
and the two working apps are left for working. Settings will join it there.

### P1.8 Password reset through `prompt()` — *done the same afternoon: a login link is sent instead*

The last browser prompt in the product. Same failure as the ID editor had:
suppressed dialogs make it silently do nothing, and it types a password into a
system dialog. The roadmap's invite-by-email flow removes the need for an
admin to type anyone's password at all.

---

## P2 — Polish; do these as the screens are touched anyway

- **Tile labels tell the reader what, not so what.** "Not seen · 179" is a
  count; "179 still to present" is a state. Micro-copy that names the
  obligation reads faster.
- **The 30-day strip has no legend and no dates.** Green, red and grey cells
  with a `title` attribute nobody on a phone can see. *Legend done 4
  September;* marking the Mondays is still open.
- **"Refresh" on the Attention tab** duplicated the automatic refresh.
  *Done:* the tab is gone; the list now refreshes with the counts each minute.
- **Toast size.** On a phone the toast is a five-line card covering two
  residents. Shorter copy ("Queued — sends when back online") and a narrower
  box.
- **Log tab date field.** The native date input is fine, but "121 events"
  next to it does not say for which day, and there is no way to see a
  resident's own movements from their card. A "Movements" link on the gate
  detail sheet that opens the log filtered to that person would be a
  five-line change.
- **Case and voice.** "Sign IN", "ON SITE", "NOT YET", "Log in", "Log out",
  "Record check-in": four capitalisation styles on one screen. Pick one
  (sentence case for buttons, small caps for status pills) and apply it.
- **The site name is "Security Hut" and the page titles say "Hut Check-In".**
  The product is CheckSteady on the brochure site and in the legal
  documents. The app should say what it is called.
- **Login screen.** Says "Guard sign-in required" to supervisors and admins
  too, and the forgotten-password link is the only thing below the fold that
  matters. Fine, but the title wraps to two lines on a phone; "CheckSteady"
  would not.
- **Focus rings** exist and are visible, which is more than most products
  manage. Keyboard order on the detail sheet puts Close after the primary
  action, which is right.
- **Reduced motion** is respected. Good.

---

## Screen by screen

### Login
Clear, single-purpose, no distractions. The subtitle is a privacy statement
rather than a help line, which is appropriate for this product. Two nits:
the title wraps, and there is no indication of *which site* this login is
for — a multi-tenant future will need the centre name here. An "Offline —
you cannot log in until the connection returns" state is missing: the form
just fails with a network error.

### Gate — Search
The strongest screen. Full register, swipe and tap both work, the pill on
each card says the one thing that matters at a gate. The queued state is
well signposted. Fixes: pinned search (P1.2), section headers (P1.4), swipe
discoverability (P1.6). *Later the same day:* the On site / Off site chip row
duplicated the tiles above it, so it went; the tiles (On site, Off site,
Moved today) are the one filter, counted from the list itself, exactly as on
the register.

### Gate — detail sheet
Two facts and two big buttons. Correct. "Last check-in 1h 49m ago" is
labelled *check-in* but shows the last *gate movement* — the product
deliberately distinguishes those, so the label should say "Last movement".
Sign IN and Sign OUT are both always enabled; greying the one that matches
the current state would prevent the most likely mis-tap.

### Gate — Log
Clean rows, right information density, the "by Gina Guard" attribution is
exactly what an auditor wants to see. Synced-later events are marked, which
is new and good. Missing: any way to filter by person, and the day's total
is labelled "events" without the date.

### Gate — Staff
Functional and now stacked properly on a phone. The form asks the admin to
invent a twelve-character password and hand it over in person; the roadmap
replaces that. The role hint under the form is good copy. "Reset password"
opens a browser prompt (P1.8).

### Daily register — Check in
Tiles now filter, chips scroll, cards are two lines. The red left border
plus red badge plus red "Not seen" count is three red signals for one fact;
one would do (P1.1, P1.3). The empty states per filter are well written.

### Daily register — detail sheet
Dense but readable. The identity line and inline editor are right. The five
facts are more than a guard needs at the window and about what a manager
needs; consider showing three by default (Status, Today, Consecutive nights)
and the rest on a tap. The House Rules note is the best copy in the product.
The 30-day strip needs a legend (P2).

### Daily register — Breaches view (was the Attention tab)

*Updated the same afternoon:* the Attention tab and the chip row were
removed. The tiles are the only filter, and the Breaches tile lists
worst-first exactly as the Attention tab did. The paragraph below describes
the tab as reviewed; the ordering note still applies to the tile's list.

### Daily register — Attention (as reviewed)
Does what it says. The pip count in the tab is alarming with demo data, but
correct. Ordering (open breaches, then never seen, then due today) is
sensible and explained in the README, not on screen; a one-line grouping
header per bucket would explain it in place.

### Offline and error states
Reviewed after the day's work: the pill, the queued pill on the card, the
amber "Working offline" notice with the one instruction that matters, and
the rejected-events list with reasons. This is better than most consumer
apps manage. Two remaining gaps: an offline *login* screen state, and the
error-toast lifetime (P0.2).

---

## Accessibility notes

- **Contrast.** Body text passes. `--muted` (#8d9bb0) on `--surface`
  (#161b23) is roughly 5.5:1, which passes for normal text; at 10–11px
  uppercase with letter-spacing on the tile labels it is borderline in
  practice even where it passes on paper. The light theme (P0.1) is the real
  fix; until then, raise the tile label size by a point.
- **Targets.** Every control is at or above 44 px on the phone layout. The
  30-day strip cells are 10 px, but they are not interactive, so that is
  fine as long as they never become so.
- **Screen readers.** Tabs carry roles and `aria-selected`; chips and tiles
  carry `aria-pressed`; the toast is a live region. The connection pill
  carries `role="status"` (done 4 September) so a change is announced.
  Cards are buttons whose accessible name is the whole card text, which is
  long but correct.
- **Motion.** `prefers-reduced-motion` is honoured.
- **Language.** The register is used by staff whose first language is often
  not English; the copy is short and plain, which helps. Avoid "breach",
  "annotate", "exempt" on screen where "missed", "note", "not required"
  will do.

---

## Suggested order

1. P1.1 (zero is red) and P0.2 (sticky errors): an hour, no risk.
2. P0.1 light theme: a day, all stylesheet.
3. P1.2 pinned search and P1.4 section headers: a day.
4. P1.3 and the vocabulary pass across both apps: half a day, after a
   product decision on the words.
5. P1.5 and P1.7 (navigation shape, Admin area): with Phase 2 of the roadmap,
   since that is when the admin screens arrive.
6. The P2 list as each screen is next opened.

None of this changes the security model, the database, or the offline
machinery. All of it is presentation, copy and stylesheet, and every item can
be checked in the browser test the way today's changes were.
