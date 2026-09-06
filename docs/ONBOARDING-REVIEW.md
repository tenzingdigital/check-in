# Onboarding review — using CheckSteady with no training

*6 September 2026. Written from the standpoint of a technical writer whose
job is to make a product usable by a person who was handed a phone at the
start of a shift and told "use this". The test is simple: can a new guard,
supervisor or administrator do the job without anyone showing them, and
without reading anything longer than a sentence at the moment they need it?*

## What was already right

- One screen does one thing, and the screen's own words say which act it
  records ("Gate: swipe right to sign IN…", "Daily register: swipe a card
  either way…"). The colour follows: blue for the gate, green for the
  register, on the pill, the buttons and the swipe strips.
- The chooser on first login asks the only question that matters ("What
  are you recording?") and explains the two answers in a sentence each.
- The first three loads of an app slide the first card aside to show the
  swipe. A demonstration beats a paragraph.
- Refusals say who can do the thing, in words, not codes.
- Empty states say what to do next ("No residents on the register yet. Tap
  Add.").
- The import previews every line with a verdict before writing anything,
  which is the difference between a feature people use and one they fear.

## What was missing

1. **Nowhere to read more.** Every screen explained itself in one line,
   and there was no second line anywhere. A supervisor who wondered what
   "Missed days" counted, or why a report wanted a reason, had nobody to
   ask at 03:00.
2. **The tiles were unexplained.** Three numbers at the top of each app
   are the most-glanced-at thing on the screen and the most-asked-about.
3. **Labels that carry a rule had no rule beside them.** "Home countries",
   "Role", "Reason for the export", the feature switches: each does
   something a person would want explained once.
4. **The first visit had no shape.** A new person saw a list and a search
   box. Good, but three sentences at the top on the first visit would
   have told them what to do and where to read more.
5. **The brochure site described the product as it was in August.** No
   roll call, no assistance-at-a-glance, no offline, no reports, no import.

## What changed today

- **A help site inside the app** (`/help.html`), written task by task in
  the order a person meets things: start here, the gate, the daily
  register, roll call, admin (residents, import, buildings, reports,
  staff, settings), working offline, when something goes wrong, privacy on
  one page. Reachable from the round **?** beside Log out on every
  screen, from the login screen ("New here? How CheckSteady works"), from
  the coach cards, and from the brochure site. Cached by the service
  worker, so it opens with no connection. No script on the page.
- **Tips.** Hold any tile or tab for a sentence about what it counts. A
  round **?** beside a label (the export reason, the staff role, the home
  countries, the feature switches) opens the same kind of note. One bubble
  per page, dismissed by a tap anywhere, Escape, or scrolling. On a
  computer the tiles also show the note on hover.
- **Coach cards.** The first time each app is opened on a device, a card
  above the list says the three things that matter for that screen, with
  **Got it** and **Open the guide**. Dismissed once, never shown again on
  that device; a person who has read it should not see it twice.
- **The brochure site** now has an icon row under the hero naming the six
  things the product does (daily register, gate log, roll call, assistance
  required, works offline, inspection reports), two new feature blocks
  (roll call on every warden's phone; from a spreadsheet to a working
  register), and a Help link in the navigation and footer.

## What I would still change

These are recommendations, not done, in the order I would do them.

1. **A "first day" checklist for administrators**, shown once on the admin
   page until each item is done: name the site, invite a supervisor, add
   or import residents, turn on the features the centre uses, set the idle
   lock. Five ticks, and the product is configured without a call.
2. **Rename "Moved today" to "In or out today".** "Moved" reads as
   changing rooms to anyone who has just learnt that rooms exist.
3. **Say the site's time zone on the register once**, under the tiles, on
   sites not set to Europe/Dublin. "Days end at midnight, Europe/Dublin"
   is a sentence that prevents a whole class of questions.
4. **A printable one-page quick start per role**, generated from the help
   page's first sections, for the hut wall. Paper still wins at a doorway.
5. **Short screen recordings** of the swipe, the roll call and the import,
   thirty seconds each, embedded in the help page for the three tasks that
   are easier to watch than to read. Hosted on the same origin to keep the
   no-third-party rule.
6. **Language.** Guards are not all first-language English speakers. The
   help page and the coach cards are the right size to translate; the
   app's own strings are next. Polish, Ukrainian and Arabic would cover
   most Irish centres.
7. **Contextual "?" on the roll call and the import** once those screens
   have been used for a month and the questions are known. Write tips
   from real questions, not guessed ones.

## How to keep it honest

- Every sentence in the help page describes a control that exists. When a
  control changes, the help page changes in the same commit; the review of
  a pull request should read the help diff as carefully as the code diff.
- The coach cards and tips are the product's promise of what a screen
  does. If a tip needs a second sentence, the screen needs a change, not
  the tip.
- Watch a new person use it, once a quarter, without helping. Write down
  the first three things they ask. Those are the next three tips.
