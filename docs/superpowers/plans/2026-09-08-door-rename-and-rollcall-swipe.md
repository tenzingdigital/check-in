# "Door" Rename and Roll-Call Swipe — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Call the gate app "Door" everywhere a person reads it, and let a warden swipe a roll-call row either way to mark someone safe.

**Architecture:** Copy-only rename across five pages and the brochure site; no code identifiers change. The shared swipe binder gains a `selector` option and passes the element to its callbacks; the gate page mounts it a second time for roll-call rows, which are wrapped like register cards only while they may be swiped.

**Tech Stack:** Vanilla HTML/JS/CSS, no build step. `./check.sh` parse layer for verification.

**Spec:** `docs/superpowers/specs/2026-09-08-door-rename-and-rollcall-swipe-design.md`

## Global Constraints

- Branch `claude/security-hardening-roadmap-k7vtwv` (main is fast-forwarded from it). `git fetch origin && git rebase origin/claude/security-hardening-roadmap-k7vtwv` before starting and before pushing; other sessions push to this repo.
- No route, migration, SQL, CSS class, `data-view`, body class or anchor id changes. `routes/gate.js`, `gate_events`, `.gate`, `app-gate`, `#gate` all stay.
- Parse check per page: `node -e "const fs=require('fs'),vm=require('vm');const h=fs.readFileSync('public/PAGE.html','utf8');[...h.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].forEach((m,i)=>new vm.Script(m[1],{filename:'PAGE.html:'+i}));console.log('ok')"`. Full: `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./check.sh` once per task.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01QMp1iENRi9GJLzm3baLCQy
  ```

---

### Task 1: The label is Door

**Files:**
- Modify: `public/index.html:10,80,102,136`, `public/checkin.html:118,146`, `public/admin.html:144`, `public/app-common.js:344`, `public/help.html:54,63,68,83,85,98,120,121,134,149,160,194`, `site/index.html:57`, `README.md` (the `**\`index.html\` — the gate app.**` line, ~46)

- [ ] **Step 1: The app pages**

`public/index.html`:
- line 10: `<title>CheckSteady — Door</title>`
- line 80: `<h1>CheckSteady <span>Door</span></h1>`
- line 102: `<span aria-current="page">Door</span>`
- line 136: `<p class="jobline"><b class="gate">Door:</b><span>swipe right to sign IN, left to sign OUT. Today's check-in is on the Daily register.</span></p>`

`public/checkin.html`:
- line 118: `<a href="/index.html">Door</a>`
- line 146: `<p class="jobline"><b class="register">Daily register:</b><span>swipe a card either way to record today's check-in. Movements in and out are on the Door.</span></p>`

`public/admin.html` line 144: `<a href="/index.html">Door</a>`

`public/app-common.js` line 344: `<b>Door — in and out</b>` (the `<span>` description beneath it is unchanged; the `class="choice gate"` and `data-view="gate"` stay).

- [ ] **Step 2: The help page**

In `public/help.html`, change only the quoted words; keep every `class`, `href`, `id` and the rest of each sentence:
- 54: `<a href="/index.html">Door</a>`
- 63: `the <span class="gate">Door</span> records people passing in and out, and the <span class="register">Daily register</span> records the once-a-day check-in.`
- 68: `<li><a href="#gate">The door<small>Sign in and out, tiles, the log</small></a></li>`
- 83: `<span class="gate">blue</span> is the door, <span class="register">green</span> is the daily register.`
- 85: `Records at the door and on the register, runs a roll call, reads the log.`
- 98: `<td>Sign residents in and out at the door</td>`
- 120: `<h2 id="gate">The door <span class="who">every staff member</span></h2>`
- 121: `The door answers one question: who is on site right now?`
- 134: `Being signed in at the door does not count; the check-in is its own act.`
- 149: `On the Door, the <span class="ui">Roll call</span> tab lists everyone recorded on site`
- 160: `The <span class="ui">Visitors</span> tab on the Door is for anyone on site who is not a resident`
- 194: `The door and the register keep working when the connection drops.`

Then `grep -nE "\b[Gg]ate\b" public/help.html` — the only hits left should be `class="gate"`, `href="#gate"`, `id="gate"` and the CSS rule `.guide .gate`.

- [ ] **Step 3: The brochure site and the README**

`site/index.html` line 57: `<b>Door log</b>` (the sentence after it is unchanged).

`README.md`: the line beginning `**\`index.html\` — the gate app.**` becomes `**\`index.html\` — the Door (the gate app in older notes).**` with the rest of the sentence unchanged.

- [ ] **Step 4: Check and commit**

Run the parse snippet for index, checkin, admin (help has no script; open the changed lines). Run `grep -rnE "\bGate\b" public/*.html public/app-common.js site/index.html` — expected: no hits. Then `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./check.sh` — all pass.

```bash
git add public/index.html public/checkin.html public/admin.html public/app-common.js public/help.html site/index.html README.md
git commit -m "The gate app is the Door

Every centre has a door; not every centre has a gate, and the brochure
already says \"door log\". Labels only: routes, tables, classes and anchors
keep their names.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QMp1iENRi9GJLzm3baLCQy"
```

---

### Task 2: Swipe a roll-call row to mark safe

**Files:**
- Modify: `public/app-common.js:571-585` (`mountCardSwipe`), `public/app-common.css:284` (the `.swipe > button.card` rule)
- Modify: `public/index.html` — styles near `:22-29` (`.rollrow`), `renderRoll()` row markup `:672-694`, the mount at `:990-993`
- Modify: `public/help.html:149` (roll-call paragraph)

**Interfaces:**
- Consumes: `markRoll(residentId)` and `markVisit(visitId)` in `public/index.html` (both no-op when already marked or no roll is running); `state.roll` (`null` when no roll call is active; `roll.marks[id]` / `roll.vmarks[id]` when marked).
- Produces: `mountCardSwipe({ selector = "button.card", onRight, onLeft })`, callbacks called as `onRight(id, el)`.

- [ ] **Step 1: The binder takes a selector and passes the element**

In `public/app-common.js`, change the signature and the two lines that use it:

```js
//   onRight / onLeft — called with the card's data-id and the element. Omit
//   one to disable that direction (the card then will not slide that way).
//   selector — which elements swipe; "button.card" unless a page says
//   otherwise (the gate's roll call swipes its own rows).
function mountCardSwipe({ selector = "button.card", onRight, onLeft } = {}) {
```

and in the `pointerdown` handler:

```js
    const card = e.target.closest(selector);
```

and in `end(fire)`:

```js
    if (s.dx >=  FIRE && onRight) onRight(s.id, s.card);
    if (s.dx <= -FIRE && onLeft)  onLeft(s.id, s.card);
```

Update the comment block above the function: the sentence "Shared because both apps use it: the register swipes right to record a check-in, the gate swipes right to sign in and left to sign out." gains ", and the roll call swipes either way to mark safe".

- [ ] **Step 2: The wrapper styles a roll row like a card**

`public/app-common.css` line 284: `.swipe > button.card, .swipe > .rollrow { position: relative; z-index: 1; }`

In `public/index.html`'s `<style>`, after the `.rollrow.done .btn` rule, add:

```css
  /* A roll row slides like a register card: either direction is "Safe", in
     the register's green, whatever the gate's strips are coloured. */
  .rollrow.swipe-arm, .rollrow.swipe-arm-out { background: color-mix(in srgb, var(--ok) 18%, var(--surface)); border-color: var(--ok); }
  .swipe > .rollrow { margin-bottom: 0; }
  .swipe:has(> .rollrow) { margin-bottom: 6px; }
  .swipe:has(> .rollrow) .swipe-bg.right, .swipe:has(> .rollrow) .swipe-bg.left { background: color-mix(in srgb, var(--ok) 26%, var(--surface)); color: var(--ok); }
```

(`.swipe-bg` rules in app-common.css already set the layout and the fade; these only recolour and keep the row's 6px rhythm on the wrapper instead of the row.)

- [ ] **Step 3: Wrap the rows that may be swiped**

In `renderRoll()` in `public/index.html`, add a helper above the `list` construction:

```js
  // A row swipes only while it can be marked: a roll call is running and the
  // person is not yet safe. Marked rows and rows outside a roll call render
  // bare and do not slide. Either direction is "Safe"; nothing un-marks.
  const swipeWrap = (inner, can) => can
    ? `<div class="swipe"><span class="swipe-bg right" aria-hidden="true">Safe ✓</span><span class="swipe-bg left" aria-hidden="true">Safe ✓</span>${inner}</div>`
    : inner;
```

Resident rows: replace the row template so the whole `<div class="rollrow" …>…</div>` is passed through `swipeWrap(…, !!(roll && !roll.marks[r.id]))`. The row keeps `data-id="${esc(r.id)}"`.

Visit rows: pass `<div class="rollrow ${roll && vmarks[v.id] ? "done" : ""}" data-vid="${esc(v.id)}">…</div>` through `swipeWrap(…, !!(roll && !vmarks[v.id]))`. (The visit row currently has no data attribute; `data-vid` is new.)

- [ ] **Step 4: Mount the second binder**

After the existing `mountCardSwipe({ onRight: …, onLeft: … })` for gate cards (around line 990), add:

```js
// Roll call: a swipe either way on a row marks the person safe. Rows render
// with a swipe wrapper only while a roll call is running and the person is
// not yet marked (see swipeWrap in renderRoll), so nothing else slides.
const markBySwipe = (id, el) => (el.dataset.vid ? markVisit(el.dataset.vid) : markRoll(id));
mountCardSwipe({ selector: ".swipe > .rollrow", onRight: markBySwipe, onLeft: markBySwipe });
```

The click handler at `:1023-1026` (`[data-mark]` / `[data-vmark]`) is unchanged; the binder's capture-phase click swallow already stops a swipe from also tapping the button.

- [ ] **Step 5: Help**

`public/help.html` line 149, append one sentence to the roll-call paragraph, before `</p>`: ` During a roll call, swipe a row either way, or tap <span class="ui">Safe</span>; a swipe never un-marks anyone.`

- [ ] **Step 6: Check and commit**

Parse snippet for index.html; `node -e "new (require('vm').Script)(require('fs').readFileSync('public/app-common.js','utf8'))"`; then `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./check.sh` — all pass. If Playwright is installed (`node -e "require.resolve('playwright')"`), run `./test/e2e.sh` too; otherwise say so.

```bash
git add public/app-common.js public/app-common.css public/index.html public/help.html
git commit -m "Roll call: swipe a row either way to mark safe

Same gesture as the register, in the register's green. A row slides only
while a roll call is running and the person is not yet marked; a swipe
never un-marks. Visitors' rows swipe too. mountCardSwipe() takes a
selector and hands the element to its callbacks.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QMp1iENRi9GJLzm3baLCQy"
```

---

### Task 3: Push and fast-forward main

- [ ] `git fetch origin && git rebase origin/claude/security-hardening-roadmap-k7vtwv && PGBIN=/opt/homebrew/opt/postgresql@16/bin ./check.sh && git push origin HEAD && git checkout main && git merge --ff-only claude/security-hardening-roadmap-k7vtwv && git push origin main && git checkout claude/security-hardening-roadmap-k7vtwv`
