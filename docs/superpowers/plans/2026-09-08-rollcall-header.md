# Roll-Call Header: End at the Top, and the Mode in Plain Sight — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The End button sits in the roll-call header where a warden can see it, and the header says whether this is a drill or a real evacuation roll call in a way the eye catches.

**Architecture:** Markup and CSS in `public/index.html`'s `renderRoll()` only; the delegated click handler already finds `#rollEnd` anywhere. One help sentence.

## Global Constraints
- Branch `claude/security-hardening-roadmap-k7vtwv`; `git fetch origin && git rebase origin/claude/security-hardening-roadmap-k7vtwv` first; do not push.
- Only `public/index.html` and `public/help.html` change. No data, route or migration change; `roll_calls.kind` stays `'drill' | 'incident'`.
- Parse check: `node -e "const fs=require('fs'),vm=require('vm');const h=fs.readFileSync('public/index.html','utf8');[...h.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].forEach((m,i)=>new vm.Script(m[1],{filename:'index.html:'+i}));console.log('ok')"`; full `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./check.sh` once.
- Commit message ends with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01QMp1iENRi9GJLzm3baLCQy
  ```

---

### Task 1: The header

**Files:** `public/index.html` (styles near lines 13-19 and 36; `renderRoll()` `head` around line 662 and `foot` around line 708), `public/help.html:154`

- [ ] **Step 1: Styles**

Replace the `.rollend { margin-top: 16px; display: flex; gap: 10px; }` rule with:

```css
  /* The mode line: a real evacuation must not look like a practice. Red for
     an incident, amber for a drill, and the End button beside the count so
     it is on screen from the first second, not below two hundred rows. */
  .rollmode { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 12px; padding: 10px 12px; border-radius: 12px; border: 1px solid transparent; font-weight: 650; }
  .rollmode.incident { background: color-mix(in srgb, var(--bad) 22%, var(--surface)); border-color: var(--bad); color: var(--text); }
  .rollmode.drill    { background: color-mix(in srgb, var(--warn) 22%, var(--surface)); border-color: var(--warn); color: var(--text); }
  .rollmode small { display: block; font-weight: 400; font-size: 12px; color: var(--muted); }
  .rollmode .btn { flex: none; }
```

- [ ] **Step 2: The header markup**

In `renderRoll()`, change the `head` template for a running roll so it begins with the mode line and no longer relies on the footer:

```js
  const head = roll ? `
    <div class="rollmode ${roll.kind === "drill" ? "drill" : "incident"}" role="status">
      <div>${roll.kind === "drill" ? "Drill" : "Evacuation roll call"}<small>${roll.kind === "drill" ? "A practice. The record says so." : "A real event. Account for everyone."} Started ${esc(timeOfDay(roll.started_at))}.</small></div>
      <button class="btn ghost sm" type="button" id="rollEnd">End ${roll.kind === "drill" ? "drill" : "roll call"}</button>
    </div>
    <div class="rollhead">
      <div><b>${accounted} of ${total}</b> <span class="hint">safe</span></div>
      <span class="hint">${total - accounted} still to find</span>
    </div>
    <div class="rollprog"><div id="rollProg"></div></div>${needChip}` : `
```

(The `else` branch of that ternary, for no running roll, is unchanged.)

Change the `foot` line to `const foot = "";` and leave the `body.innerHTML = head + … + foot;` line as it is, so nothing else in the function moves. If `.btn.sm` does not exist in `app-common.css` (`grep -n "\.btn\.sm\|\.btn.sm" public/app-common.css`), use `class="btn ghost"` instead.

- [ ] **Step 3: Help**

`public/help.html` line 154: change `Tap <span class="ui">End</span>.` to `Tap <span class="ui">End</span> at the top of the list.` and, at the end of the same step's sentence, add: ` A drill and a real roll call work the same way; the header says which one is running, and the record keeps the difference.`

- [ ] **Step 4: Check and commit**

Parse check; `./check.sh`. Then:

```bash
git add public/index.html public/help.html
git commit -m "Roll call: End at the top, and the header says drill or evacuation

A warden could not see the End button under two hundred rows, and a drill
looked exactly like a real roll call. The mode line is red for an incident,
amber for a drill, with End beside it; the count and the bar stay under it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QMp1iENRi9GJLzm3baLCQy"
```
