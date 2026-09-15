# Unsubscribing from site emails — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every recurring staff email (Sunday report, nightly safeguarding alert, nightly House Rules reminder) carries an Unsubscribe link that works without a login; Admin → Staff shows who used it; the person or an admin can put them back.

**Architecture:** A per-person random key in an owner-only table (`email_link_keys`) is the whole credential; `email_opt_outs` records the fact of opting out separately from the ticks so Admin can tell "unsubscribed themselves" from "never ticked". `lib/emailPrefs.js` owns the rules; `routes/unsubscribe.js` serves a public page (GET shows, POST acts); the three senders pass a per-recipient link into `mail.layout()` and set `List-Unsubscribe` headers.

**Tech Stack:** Node 22, Express, Postgres 16 (numbered migrations in `migrations/`, tenant copy in `tenant/template.sql`), Resend over `fetch`, no test framework (plain `assert`), suites run by `./check.sh`.

Spec: `docs/superpowers/specs/2026-09-15-email-unsubscribe-design.md`.

## Global Constraints

- Migrations are numbered SQL files under `migrations/`; the next is `049`. Every migration that touches a per-tenant table must be followed by `./tools/gen-tenant-template.sh` (needs Postgres 16 binaries; on this Mac `PGBIN=/opt/homebrew/opt/postgresql@16/bin`).
- Links are built from `PUBLIC_URL` only, never from the request (`Host` / `X-Forwarded-Proto`). Unset → no link, no headers, footer unchanged.
- Transactional email (`resetEmail`, `inviteEmail`, `codeEmail`) gets no link and no headers.
- The unsubscribe page names the email and the address it goes to, never a resident.
- GET must change nothing; only POST acts.
- Every user-visible error is a sentence written for a manager, not Postgres text.
- Comments match the surrounding density: each file opens with a paragraph saying why it exists; non-obvious decisions get a sentence.
- Commit after every task with the attribution footer:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01FofqrXrLKdxybZvZYupwRB
  ```
- Run the relevant suite before every commit. The HTTP suite: `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./test/api.sh`. Everything: `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./check.sh`.

## File map

| File | Responsibility |
|---|---|
| `migrations/049_email_unsubscribe.sql` (create) | the two tables, the key function, grants, audit trigger |
| `tenant/template.sql` (regenerate) | tenant copy of the above |
| `lib/emailPrefs.js` (create) | KINDS, `slugForSchema`, `keyFor`, `urlFor`, `linkFor`, `headersFor`, `optOut`, `optIn`, `optOutsFor` |
| `lib/mail.js` (modify) | `send()` forwards `headers`; `layout()` takes `unsubscribe`; `textFooter()` |
| `lib/weeklyReport.js`, `lib/safeguardingAlert.js` (modify) | `compose()` takes `unsubscribe`; `recipients()` returns `{ id, email }` |
| `jobs.js`, `routes/settings.js` (modify) | per-recipient link + headers; House Rules query excludes opt-outs |
| `lib/page.js` (create, extracted from `routes/signup.js`) | `pageHtml`, `esc` |
| `lib/security.js` (modify) | export `cspAllowingForms()` |
| `routes/unsubscribe.js` (create), `server.js` (modify) | the public page and its POST |
| `routes/staff.js` (modify) | `opt_outs` in the list; ticks clear the row; `/:id/house-rules` reinstate |
| `public/admin.html`, `public/help.html`, `docs/GDPR.md` (modify) | indicator, Reinstate, help line, GDPR line |
| `test/api.test.js`, `test/mail.test.js`, `test/emailPrefs.test.js` (create), `check.sh` | tests |

---

### Task 1: Migration 049 and the tenant template

**Files:**
- Create: `migrations/049_email_unsubscribe.sql`
- Regenerate: `tenant/template.sql`
- Test: `test/api.test.js` (new block, before the `server.close()` at the end of `main()`)

**Interfaces:**
- Produces: tables `email_opt_outs(id, profile_id, kind, unsubscribed_at)` and `email_link_keys(profile_id, key, created_at)`; function `email_link_key(uuid) returns text`.

- [ ] **Step 1: Write the failing test**

Add this block to `test/api.test.js` immediately before the final `server.close();` in `main()`:

```js
  console.log("\n== unsubscribing from site emails (migration 049) ==");

  const unsubAdmin = client(base);
  await withOwner((c) => c.query(`select auth.create_user($1, $2, $3, $4)`, ["unsubadmin@hut.example", PASSWORD, "Una Admin", "admin"]));
  assert.equal((await unsubAdmin.fetch("/api/session", { method: "POST", body: { email: "unsubadmin@hut.example", password: PASSWORD } })).status, 200);
  const unsubSup = client(base);
  await withOwner((c) => c.query(`select auth.create_user($1, $2, $3, $4)`, ["unsubsup@hut.example", PASSWORD, "Ursula Supervisor", "supervisor"]));
  assert.equal((await unsubSup.fetch("/api/session", { method: "POST", body: { email: "unsubsup@hut.example", password: PASSWORD } })).status, 200);
  const unsubSupId = (await withOwner((c) => c.query(`select id from auth.users where email = 'unsubsup@hut.example'`))).rows[0].id;

  await test("email_link_key() mints once, returns the same key after, and refuses anyone with a session who is not an admin", async () => {
    const first = (await withOwner((c) => c.query(`select email_link_key($1) as k`, [unsubSupId]))).rows[0].k;
    assert.match(first, /^[A-Za-z0-9_-]{43}$/, "32 random bytes, base64url");
    const again = (await withOwner((c) => c.query(`select email_link_key($1) as k`, [unsubSupId]))).rows[0].k;
    assert.equal(again, first, "the key is stable so an old email's link keeps working");
    const asAdmin = await withIdentity((await withOwner((c) => c.query(`select id from auth.users where email = 'unsubadmin@hut.example'`))).rows[0].id,
      (c) => c.query(`select email_link_key($1) as k`, [unsubSupId]));
    assert.equal(asAdmin.rows[0].k, first, "an admin may build a colleague's link");
    await assert.rejects(
      withIdentity(unsubSupId, (c) => c.query(`select email_link_key($1) as k`, [unsubSupId])),
      /administrator/i, "a supervisor may not read even their own key");
    await assert.rejects(
      withIdentity(unsubSupId, (c) => c.query(`select key from email_link_keys`)),
      /permission denied/i, "the table itself is owner-only");
  });
```

- [ ] **Step 2: Run the suite to see it fail**

Run: `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./test/api.sh 2>&1 | tail -5`
Expected: `FAIL: function email_link_key(uuid) does not exist`

- [ ] **Step 3: Write the migration**

Create `migrations/049_email_unsubscribe.sql`:

```sql
-- 049_email_unsubscribe.sql — a way out of the site emails.
--
-- Three recurring emails reach staff: the Sunday Weekly register update
-- (035/037), the nightly safeguarding alert (041) and the nightly House
-- Rules reminder (032). Until now none of them could be stopped by the
-- person receiving it; the first two by an admin unticking them, the third
-- not at all. This adds an Unsubscribe link to all three, and records the
-- fact of opting out SEPARATELY from the tick, so Admin → Staff can say
-- "unsubscribed themselves on the 14th" rather than showing an unticked box
-- indistinguishable from one an admin never ticked.
--
-- Spec: docs/superpowers/specs/2026-09-15-email-unsubscribe-design.md

-- ---------------------------------------------------------------------------
-- The fact of opting out. One row per person per kind of email.
--
-- An `id` column even though (profile_id, kind) is the natural key, because
-- audit_row() (012) writes new.id and is attached below unchanged — every
-- opt-out and opt-in then lands in admin_audit, attributed to whoever the
-- request set request.jwt.claim.sub to (the person, when they used the link).
-- ---------------------------------------------------------------------------
create table if not exists public.email_opt_outs (
  id              bigint generated always as identity primary key,
  profile_id      uuid not null references public.profiles (id) on delete cascade,
  kind            text not null check (kind in ('weekly_report', 'safeguarding_alert', 'house_rules')),
  unsubscribed_at timestamptz not null default now(),
  unique (profile_id, kind)
);

comment on table public.email_opt_outs is
  'A staff member opted themselves out of one of the site emails via the link in its footer. Absence of a row with the tick off means an admin unticked them. Read by the staff list; written only through the owner (the unsubscribe page) or an admin (re-ticking).';

alter table public.email_opt_outs enable row level security;
drop policy if exists email_opt_outs_read on public.email_opt_outs;
create policy email_opt_outs_read on public.email_opt_outs for select using (public.is_staff());
drop policy if exists email_opt_outs_admin on public.email_opt_outs;
create policy email_opt_outs_admin on public.email_opt_outs for delete using (public.is_admin());
revoke all on public.email_opt_outs from anon, public, authenticated;
grant select, delete on public.email_opt_outs to authenticated;

drop trigger if exists email_opt_outs_audit on public.email_opt_outs;
create trigger email_opt_outs_audit
  after insert or update or delete on public.email_opt_outs
  for each row execute function public.audit_row();

-- ---------------------------------------------------------------------------
-- The key in the link. One per person, minted on first use, reused after.
--
-- Stored in clear, unlike a password-reset token, because it has to be put
-- in every email that goes out — a hash cannot be re-sent — and because all
-- it can do is toggle that one person's rows above. Nobody but the owner
-- can read the table: no grant to authenticated or anon at all. Deleting a
-- row invalidates that person's links; the next send mints a fresh one.
-- ---------------------------------------------------------------------------
create table if not exists public.email_link_keys (
  profile_id  uuid primary key references public.profiles (id) on delete cascade,
  key         text not null unique,
  created_at  timestamptz not null default now()
);

comment on table public.email_link_keys is
  'The random key carried by a staff member''s Unsubscribe links (049). Owner-only; handed out by email_link_key().';

alter table public.email_link_keys enable row level security;
revoke all on public.email_link_keys from anon, public, authenticated;

-- Mint or return. The nightly job calls this as the owner (auth.uid() is
-- null); the send-now route calls it as the admin who pressed the button.
-- Anyone else with a session — including the person themselves — is refused:
-- a supervisor reading their own key gains nothing they cannot do from the
-- email, and a supervisor reading a colleague's could unsubscribe them.
create or replace function public.email_link_key(p_profile uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'Only an administrator can build an unsubscribe link.' using errcode = '42501';
  end if;
  select key into v_key from public.email_link_keys where profile_id = p_profile;
  if v_key is not null then return v_key; end if;
  -- 32 bytes, base64url without padding: 43 characters that survive a URL.
  v_key := replace(translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/', '-_'), '=', '');
  insert into public.email_link_keys (profile_id, key) values (p_profile, v_key)
    on conflict (profile_id) do update set key = public.email_link_keys.key
    returning key into v_key;
  return v_key;
end;
$$;

revoke all on function public.email_link_key(uuid) from public, anon;
grant execute on function public.email_link_key(uuid) to authenticated;
```

Check `extensions.gen_random_bytes` is how other migrations spell pgcrypto: `grep -rn "gen_random_bytes" migrations/ | head -3`. Use whatever prefix they use (it may be bare `gen_random_bytes` with `extensions` on the search_path).

- [ ] **Step 4: Regenerate the tenant template**

Run: `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./tools/gen-tenant-template.sh`
Expected: `==> wrote .../tenant/template.sql (N lines)`. Then `git diff --stat tenant/template.sql` shows additions for `email_opt_outs`, `email_link_keys`, `email_link_key`.

- [ ] **Step 5: Run the suite**

Run: `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./test/api.sh 2>&1 | tail -5`
Expected: the new test passes, and "every view, function, policy and index is provisioned too" still passes (the template is current). If the permission-denied assertion fails with a different message, print the actual error and match it — the point is that the select is refused.

- [ ] **Step 6: Commit**

```bash
git add migrations/049_email_unsubscribe.sql tenant/template.sql test/api.test.js
git commit -m "Migration 049: opt-out rows and a per-person unsubscribe key"
```

---

### Task 2: `lib/emailPrefs.js`

**Files:**
- Create: `lib/emailPrefs.js`
- Create: `test/emailPrefs.test.js`
- Modify: `check.sh` (add `node test/emailPrefs.test.js || fail=1` after the `mail.test.js` line)
- Test: `test/api.test.js` (extend the migration-049 block)

**Interfaces:**
- Produces:
  - `KINDS`: `{ weekly_report: { name: 'the Sunday report', tick: 'weekly_report' }, safeguarding_alert: { name: 'the nightly safeguarding alert', tick: 'safeguarding_alert' }, house_rules: { name: 'the nightly House Rules reminder', tick: null } }`
  - `isKind(k) → boolean`
  - `urlFor({ slug, key, kind }) → string | null` (null when `PUBLIC_URL` unset)
  - `headersFor(url) → { 'List-Unsubscribe': '<url>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } | {}`
  - `slugForSchema(client, schema) → Promise<string>`
  - `keyFor(client, profileId) → Promise<string>` (calls `email_link_key`)
  - `linkFor(client, { slug, profileId, kind }) → Promise<string | null>`
  - `optOut(client, profileId, kinds: string[]) → Promise<void>`
  - `optIn(client, profileId, kinds: string[]) → Promise<void>`
  - `optOutsFor(client, profileId) → Promise<Array<{ kind, unsubscribed_at }>>`

- [ ] **Step 1: Write the failing unit test**

Create `test/emailPrefs.test.js`:

```js
// The pure parts of lib/emailPrefs.js: the link and the headers. Run:
//   node test/emailPrefs.test.js
// The database parts are covered by test/api.test.js.
const assert = require('assert/strict');

const prefs = require('../lib/emailPrefs');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`   ok  ${name}`); }

test('urlFor builds from PUBLIC_URL and carries slug, key and kind', () => {
  process.env.PUBLIC_URL = 'https://app.checksteady.com/';
  const url = prefs.urlFor({ slug: 'default', key: 'abc_-123', kind: 'weekly_report' });
  assert.equal(url, 'https://app.checksteady.com/unsubscribe?t=default&k=abc_-123&e=weekly_report');
});

test('urlFor is null with PUBLIC_URL unset — never a relative or invented link', () => {
  delete process.env.PUBLIC_URL;
  assert.equal(prefs.urlFor({ slug: 'default', key: 'k', kind: 'house_rules' }), null);
});

test('urlFor refuses a kind it does not know', () => {
  process.env.PUBLIC_URL = 'https://app.checksteady.com';
  assert.throws(() => prefs.urlFor({ slug: 'default', key: 'k', kind: 'marketing' }), /kind/);
});

test('headersFor gives both RFC 8058 headers for a link, and nothing for none', () => {
  assert.deepEqual(prefs.headersFor('https://x/unsubscribe?t=a&k=b&e=house_rules'), {
    'List-Unsubscribe': '<https://x/unsubscribe?t=a&k=b&e=house_rules>',
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  });
  assert.deepEqual(prefs.headersFor(null), {});
});

test('KINDS names every kind the migration accepts, and only those', () => {
  assert.deepEqual(Object.keys(prefs.KINDS).sort(), ['house_rules', 'safeguarding_alert', 'weekly_report']);
  assert.equal(prefs.KINDS.weekly_report.tick, 'weekly_report');
  assert.equal(prefs.KINDS.house_rules.tick, null);
  assert.ok(prefs.isKind('house_rules') && !prefs.isKind('all') && !prefs.isKind(''));
});

console.log(`\nPASS: ${passed} emailPrefs assertions.`);
```

- [ ] **Step 2: Run it to see it fail**

Run: `node test/emailPrefs.test.js`
Expected: `Error: Cannot find module '../lib/emailPrefs'`

- [ ] **Step 3: Write the module**

Create `lib/emailPrefs.js`:

```js
// lib/emailPrefs.js — who has opted out of which site email, and the link
// that lets them.
//
// The single owner of the rules in migration 049. Three callers: the nightly
// jobs and the send-now route build a link per recipient; the unsubscribe
// page looks a key up and toggles rows; the staff routes read the rows and
// clear them when an admin re-ticks. None of them writes SQL against these
// tables directly — if the shape changes, it changes here.
//
// Links come from PUBLIC_URL only, the same rule as every other link this
// app puts in an email (see lib/mail.js publicUrl()). Unset means no link,
// and the callers then send the email without one.
const { publicUrl } = require('./mail');
const tenancy = require('./tenancy');

// The three emails a person can stop, keyed as the migration's `kind`.
// `tick` names the profiles column the two chosen-per-person emails read,
// so opting out and back in keeps the tick and the row agreeing; the House
// Rules reminder has no tick — it goes to every supervisor and admin — so
// only the row decides.
const KINDS = Object.freeze({
  weekly_report:      { name: 'the Sunday report',                 tick: 'weekly_report' },
  safeguarding_alert: { name: 'the nightly safeguarding alert',    tick: 'safeguarding_alert' },
  house_rules:        { name: 'the nightly House Rules reminder',  tick: null },
});

function isKind(kind) {
  return Object.prototype.hasOwnProperty.call(KINDS, kind);
}

function urlFor({ slug, key, kind }) {
  if (!isKind(kind)) throw new Error(`unknown email kind: ${kind}`);
  const base = publicUrl();
  if (!base) return null;
  return `${base}/unsubscribe?${new URLSearchParams({ t: slug, k: key, e: kind })}`;
}

// RFC 8058: the mail client shows its own Unsubscribe button and POSTs the
// literal body "List-Unsubscribe=One-Click" to the URL. routes/unsubscribe.js
// treats that body as "stop the kind in the URL".
function headersFor(url) {
  if (!url) return {};
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

// The nightly job knows the schema it is running in, not the slug; the link
// must carry the slug because that is what public.tenants validates. The
// mapping is one-way in lib/tenancy.js (hyphen → underscore) but slugs may
// not contain underscores, so reversing it through the table is exact.
async function slugForSchema(client, schema) {
  if (schema === 'public') return tenancy.LEGACY_SLUG;
  const { rows } = await client.query(
    `select slug from public.tenants where 't_' || replace(slug, '-', '_') = $1`, [schema]);
  if (!rows[0]) throw new Error(`no tenant owns schema ${schema}`);
  return rows[0].slug;
}

// Mint-or-return, via the SECURITY DEFINER function so the caller may be
// the owner (jobs) or an admin (send-now) and nobody else.
async function keyFor(client, profileId) {
  const { rows } = await client.query('select email_link_key($1) as key', [profileId]);
  return rows[0].key;
}

async function linkFor(client, { slug, profileId, kind }) {
  if (!publicUrl()) return null;
  const key = await keyFor(client, profileId);
  return urlFor({ slug, key, kind });
}

function checkKinds(kinds) {
  if (!Array.isArray(kinds) || !kinds.length || !kinds.every(isKind)) {
    throw new Error(`bad email kinds: ${JSON.stringify(kinds)}`);
  }
}

// Insert the rows and clear the matching ticks, in one statement each so a
// half-applied "stop all" cannot happen. Re-opting-out is a no-op.
async function optOut(client, profileId, kinds) {
  checkKinds(kinds);
  await client.query(
    `insert into email_opt_outs (profile_id, kind)
       select $1, unnest($2::text[])
       on conflict (profile_id, kind) do nothing`, [profileId, kinds]);
  const ticks = kinds.map((k) => KINDS[k].tick).filter(Boolean);
  if (ticks.length) {
    await client.query(
      `update profiles set ${ticks.map((t) => `${t} = false`).join(', ')} where id = $1`, [profileId]);
  }
}

// Delete the rows and set the ticks back. Setting a tick true on a guard is
// refused by the check constraints (037/041) — the callers only ever reach
// here for a supervisor or admin, because a guard never received the email.
async function optIn(client, profileId, kinds) {
  checkKinds(kinds);
  await client.query(
    `delete from email_opt_outs where profile_id = $1 and kind = any($2::text[])`, [profileId, kinds]);
  const ticks = kinds.map((k) => KINDS[k].tick).filter(Boolean);
  if (ticks.length) {
    await client.query(
      `update profiles set ${ticks.map((t) => `${t} = true`).join(', ')} where id = $1`, [profileId]);
  }
}

async function optOutsFor(client, profileId) {
  const { rows } = await client.query(
    `select kind, unsubscribed_at from email_opt_outs where profile_id = $1 order by unsubscribed_at`, [profileId]);
  return rows;
}

module.exports = { KINDS, isKind, urlFor, headersFor, slugForSchema, keyFor, linkFor, optOut, optIn, optOutsFor };
```

The tick column names in `optOut`/`optIn` are interpolated but come only from the frozen `KINDS` table, never from input — say so in a comment above each.

- [ ] **Step 4: Run the unit test**

Run: `node test/emailPrefs.test.js`
Expected: `PASS: 5 emailPrefs assertions.`

- [ ] **Step 5: Add the database round-trip to the HTTP suite**

Append to the migration-049 block in `test/api.test.js`:

```js
  await test("optOut inserts the row and clears the tick; optIn reverses both; House Rules has no tick to clear", async () => {
    const prefs = require("../lib/emailPrefs");
    assert.equal((await unsubAdmin.fetch(`/api/staff/${unsubSupId}/weekly-report`, { method: "POST", body: { on: true } })).status, 200);
    await withOwner((c) => prefs.optOut(c, unsubSupId, ["weekly_report", "house_rules"]));
    let p = (await withOwner((c) => c.query(`select weekly_report, safeguarding_alert from public.profiles where id = $1`, [unsubSupId]))).rows[0];
    assert.equal(p.weekly_report, false, "the tick follows the opt-out");
    let outs = await withOwner((c) => prefs.optOutsFor(c, unsubSupId));
    assert.deepEqual(outs.map((o) => o.kind).sort(), ["house_rules", "weekly_report"]);
    await withOwner((c) => prefs.optOut(c, unsubSupId, ["weekly_report"]));
    assert.equal((await withOwner((c) => prefs.optOutsFor(c, unsubSupId))).length, 2, "opting out twice is a no-op");
    await withOwner((c) => prefs.optIn(c, unsubSupId, ["weekly_report", "house_rules"]));
    p = (await withOwner((c) => c.query(`select weekly_report from public.profiles where id = $1`, [unsubSupId]))).rows[0];
    assert.equal(p.weekly_report, true, "opting back in restores the tick");
    assert.equal((await withOwner((c) => prefs.optOutsFor(c, unsubSupId))).length, 0);
    assert.equal(await withOwner((c) => prefs.slugForSchema(c, "public")), "default");
    assert.equal((await unsubAdmin.fetch(`/api/staff/${unsubSupId}/weekly-report`, { method: "POST", body: { on: false } })).status, 200);
  });
```

- [ ] **Step 6: Run the HTTP suite**

Run: `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./test/api.sh 2>&1 | tail -5`
Expected: passes.

- [ ] **Step 7: Wire the unit test into check.sh and commit**

In `check.sh`, after the line `node test/mail.test.js || fail=1` add `node test/emailPrefs.test.js || fail=1`.

```bash
git add lib/emailPrefs.js test/emailPrefs.test.js test/api.test.js check.sh
git commit -m "lib/emailPrefs.js: the link, the headers, and opting out and back in"
```

---

### Task 3: `lib/mail.js` — headers on `send()`, an Unsubscribe footer on `layout()`

**Files:**
- Modify: `lib/mail.js:63-100` (`send`), `lib/mail.js:173-232` (`layout`), export a `textFooter`
- Test: `test/mail.test.js`

**Interfaces:**
- Produces: `send({ to, subject, text, html, headers })` forwards `headers` to Resend as `headers`; the sink records `headers` too. `layout({ ..., unsubscribe })` renders the footer link when `unsubscribe` is a string. `textFooter(unsubscribe) → string | null` returns `"To stop these emails: <url>"` or null.

- [ ] **Step 1: Write the failing tests**

Append to `test/mail.test.js` before the final `PASS` line (look at how the existing tests call `withFetch` — it yields the captured request; if it does not expose the request body, capture it in the stand-in as below):

```js
await test('send() forwards headers to the provider, and sends none when not given', async () => {
  const seen = [];
  await withFetch(async (url, init) => { seen.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }); }, async () => {
    await mail.send({ to: 'a@example.ie', subject: 's', text: 't', headers: { 'List-Unsubscribe': '<https://x/u>' } });
    await mail.send({ to: 'a@example.ie', subject: 's', text: 't' });
  });
  assert.deepEqual(seen[0].headers, { 'List-Unsubscribe': '<https://x/u>' });
  assert.equal(seen[1].headers, undefined);
});

await test('layout() adds an Unsubscribe link to the footer only when given one; the transactional emails never carry it', async () => {
  const withLink = mail.layout({ siteName: 'Slaney', heading: 'h', unsubscribe: 'https://x/unsubscribe?t=default&k=k&e=house_rules' });
  assert.match(withLink, /href="https:\/\/x\/unsubscribe\?t=default&amp;k=k&amp;e=house_rules"[^>]*>Unsubscribe<\/a>/);
  const without = mail.layout({ siteName: 'Slaney', heading: 'h' });
  assert.doesNotMatch(without, /Unsubscribe/);
  assert.doesNotMatch(mail.resetEmail({ fullName: 'A', link: 'https://x/r', minutes: 30 }).text, /nsubscribe/);
  assert.doesNotMatch(mail.codeEmail({ fullName: 'A', code: '123456', minutes: 10 }).text, /nsubscribe/);
  assert.equal(mail.textFooter('https://x/u'), 'To stop these emails: https://x/u');
  assert.equal(mail.textFooter(null), null);
});
```

- [ ] **Step 2: Run to see it fail**

Run: `node test/mail.test.js`
Expected: fails at the first new test (`headers` undefined on both) or `mail.textFooter is not a function`.

- [ ] **Step 3: Implement**

In `send()`: change the signature to `async function send({ to, subject, text, html, headers })`; push `headers` into the sink record (`{ to, subject, text, html, headers }`); in the Resend body add `...(headers && Object.keys(headers).length ? { headers } : {})`. Above the function, add to the doc comment: "`headers` is optional and forwarded verbatim; the recurring emails use it for `List-Unsubscribe` (lib/emailPrefs.js)."

In `layout()`: add `unsubscribe` to the destructured params. Replace the footer `<p>` with:

```js
      <p style="margin:0;font:13px/1.5 ${FONT};color:${MUTED};">You are receiving this because your CheckSteady account is ticked for it. It carries counts only — the detail stays behind your login.${unsubscribe && safeHref(unsubscribe) ? ` <a href="${escapeHtml(safeHref(unsubscribe))}" style="color:${MUTED};">Unsubscribe</a>` : ''}</p>
```

Note: the House Rules reminder does carry names (see `jobs.js` comment). The footer sentence "It carries counts only" is already wrong for that one email today; leave that wording alone in this task — it is not this feature's problem — but do not make it worse.

Add and export:

```js
// The plain-text twin of the footer link. Callers append it as the last
// paragraph so a text-only client still has the way out.
function textFooter(unsubscribe) {
  return unsubscribe ? `To stop these emails: ${unsubscribe}` : null;
}
```

Add `textFooter` to `module.exports`.

- [ ] **Step 4: Run**

Run: `node test/mail.test.js`
Expected: `PASS: N mail assertions.` with N two higher than before.

- [ ] **Step 5: Commit**

```bash
git add lib/mail.js test/mail.test.js
git commit -m "lib/mail.js: forward headers, and an Unsubscribe link in the layout footer"
```

---

### Task 4: The three senders carry the link

**Files:**
- Modify: `lib/weeklyReport.js:39-82,97-101`, `lib/safeguardingAlert.js:34-93`, `jobs.js:134-196` (`notifyThresholds`), `jobs.js:248-298` (`safeguardingNightly`), `jobs.js:306-370` (`weeklyRegister`), `routes/settings.js:185-208`
- Test: `test/api.test.js` (migration-049 block), `test/safeguardingAlert.test.js`

**Interfaces:**
- Consumes: `emailPrefs.linkFor`, `emailPrefs.headersFor`, `emailPrefs.slugForSchema`, `mail.textFooter`.
- Produces: `weekly.recipients(client) → [{ id, email }]`, `safeguarding.recipients(client) → [{ id, email }]`; `compose({ ..., unsubscribe })` on both.

- [ ] **Step 1: Write the failing tests**

Append to the migration-049 block in `test/api.test.js`:

```js
  await test("every recurring email carries its own unsubscribe link and List-Unsubscribe headers; House Rules skips the opted-out", async () => {
    const prefs = require("../lib/emailPrefs");
    const { weeklyRegister, notifyThresholds } = require("../jobs");
    process.env.PUBLIC_URL = "https://hut-check-in.onrender.com";
    assert.equal((await unsubAdmin.fetch(`/api/staff/${unsubSupId}/weekly-report`, { method: "POST", body: { on: true } })).status, 200);
    assert.equal((await unsubAdmin.fetch(`/api/staff/${unsubSupId}/safeguarding-alert`, { method: "POST", body: { on: true } })).status, 200);
    const key = await withOwner((c) => prefs.keyFor(c, unsubSupId));

    // The Sunday report, sent by hand.
    let before = (global.__mailSink || []).length;
    const sent = await unsubAdmin.fetch("/api/settings/weekly-report/send", { method: "POST" });
    assert.equal(sent.status, 200, sent.text);
    let mine = (global.__mailSink || []).slice(before).find((m) => m.to === "unsubsup@hut.example");
    assert.ok(mine, "the supervisor was emailed");
    const wkUrl = `https://hut-check-in.onrender.com/unsubscribe?t=default&k=${key}&e=weekly_report`;
    assert.ok(mine.text.endsWith(`To stop these emails: ${wkUrl}`), mine.text);
    assert.match(mine.html, /Unsubscribe<\/a>/);
    assert.equal(mine.headers["List-Unsubscribe"], `<${wkUrl}>`);
    assert.equal(mine.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
    const others = (global.__mailSink || []).slice(before).filter((m) => m.to !== "unsubsup@hut.example");
    assert.ok(others.every((m) => !m.text.includes(key)), "nobody else's email carries this person's key");

    // The Sunday report, by the job (forced past the Sunday gate).
    await withOwner((c) => c.query(`update public.app_settings set weekly_report_email = true`));
    await withOwner((c) => c.query(`delete from public.job_runs where job = 'weekly-register-email'`));
    before = (global.__mailSink || []).length;
    assert.equal(await weeklyRegister("public", "", { force: true }), true);
    mine = (global.__mailSink || []).slice(before).find((m) => m.to === "unsubsup@hut.example");
    assert.ok(mine && mine.text.endsWith(`To stop these emails: ${wkUrl}`), "the job builds the same link as the route");
    await withOwner((c) => c.query(`update public.app_settings set weekly_report_email = false`));

    // The House Rules reminder: everyone, minus opt-outs.
    await withOwner((c) => c.query(`delete from public.job_runs where job = 'notify-thresholds-email'`));
    await withOwner((c) => c.query(`update public.app_settings set notify_thresholds_email = true`));
    before = (global.__mailSink || []).length;
    assert.equal(await notifyThresholds("public", ""), true);
    mine = (global.__mailSink || []).slice(before).find((m) => m.to === "unsubsup@hut.example");
    assert.ok(mine, "a supervisor gets the House Rules reminder");
    assert.ok(mine.text.endsWith(`To stop these emails: https://hut-check-in.onrender.com/unsubscribe?t=default&k=${key}&e=house_rules`));
    await withOwner((c) => prefs.optOut(c, unsubSupId, ["house_rules"]));
    before = (global.__mailSink || []).length;
    assert.equal(await notifyThresholds("public", ""), true);
    assert.ok(!(global.__mailSink || []).slice(before).some((m) => m.to === "unsubsup@hut.example"), "opted out of House Rules: not emailed");
    await withOwner((c) => prefs.optIn(c, unsubSupId, ["house_rules"]));
    await withOwner((c) => c.query(`update public.app_settings set notify_thresholds_email = false`));

    // With PUBLIC_URL unset: no link, no headers, still sent.
    delete process.env.PUBLIC_URL;
    before = (global.__mailSink || []).length;
    const sent2 = await unsubAdmin.fetch("/api/settings/weekly-report/send", { method: "POST" });
    assert.equal(sent2.status, 200, sent2.text);
    mine = (global.__mailSink || []).slice(before).find((m) => m.to === "unsubsup@hut.example");
    assert.ok(mine && !/nsubscribe/.test(mine.text) && !mine.headers, "no link is invented without PUBLIC_URL");
    process.env.PUBLIC_URL = "https://hut-check-in.onrender.com";
    assert.equal((await unsubAdmin.fetch(`/api/staff/${unsubSupId}/weekly-report`, { method: "POST", body: { on: false } })).status, 200);
    assert.equal((await unsubAdmin.fetch(`/api/staff/${unsubSupId}/safeguarding-alert`, { method: "POST", body: { on: false } })).status, 200);
  });
```

The House Rules assertion needs a resident at a figure. The earlier House Rules test (search `"Missing Nights"`) already created one and its `daily_compliance` rows persist, so the job has someone to list; if the run reports `nobody`, insert the same rows again in this test (copy the two `withOwner` inserts from that test).

In `test/safeguardingAlert.test.js`, add after the existing composes:

```js
const withOut = compose({ siteName: 'Slaney Manor', night: '2026-09-11', count: 1, link: 'https://example.test', unsubscribe: 'https://example.test/unsubscribe?t=default&k=k&e=safeguarding_alert' });
assert.ok(withOut.text.endsWith('To stop these emails: https://example.test/unsubscribe?t=default&k=k&e=safeguarding_alert'), 'the text ends with the way out');
assert.match(withOut.html, /Unsubscribe<\/a>/, 'and so does the html');
assert.doesNotMatch(nil.text, /nsubscribe/, 'no link when none is given');
```

- [ ] **Step 2: Run to see it fail**

Run: `node test/safeguardingAlert.test.js` → fails on `withOut.text.endsWith`. Then `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./test/api.sh 2>&1 | tail -5` → fails at `mine.text.endsWith`.

- [ ] **Step 3: `recipients()` returns id and email in both libs**

`lib/weeklyReport.js` `recipients()`: select `p.id, u.email`, return `rows` (not `rows.map(r => r.email)`). Update the doc comment: "Returns `{ id, email }` — the id is what the per-person unsubscribe link is minted from (049)." Same change in `lib/safeguardingAlert.js`.

- [ ] **Step 4: `compose()` takes `unsubscribe` in both libs**

`lib/weeklyReport.js` `compose({ siteName, from, to, rows, link, unsubscribe })`:
- `const text = [title, counts.join('\n'), openLine, detail, midnight, textFooter(unsubscribe)].filter(Boolean).join('\n\n');`
- pass `unsubscribe` into `layout({...})`.
- Import: `const { layout, textFooter } = require('./mail');` (check the existing import line and extend it).

`lib/safeguardingAlert.js` `compose({ siteName, night, count, link, unsubscribe })`: same two changes in **both** the nil branch and the count branch (the nil email is sent nightly too, so it needs the way out).

- [ ] **Step 5: The three loops build a link per recipient**

`jobs.js` — at the top with the other requires: `const prefs = require('./lib/emailPrefs');`.

`weeklyRegister`: after `const staff = await weekly.recipients(client);` the loop becomes:

```js
      const slug = await prefs.slugForSchema(client, schema);
      const { from, to } = weekly.lastWeek(s.today);
      const { rows } = await client.query('select * from weekly_register_rows_unchecked($1, $2)', [from, to]);
      let delivered = 0;
      for (const r of staff) {
        // One compose per person: the footer link is theirs alone.
        const unsubscribe = await prefs.linkFor(client, { slug, profileId: r.id, kind: 'weekly_report' });
        const { subject, text, html } = weekly.compose({
          siteName: s.site_name, from, to, rows,
          link: reportLink({ tab: 'reports', report: 'weekly', from, to }),
          unsubscribe,
        });
        const out = await mail.send({ to: r.email, subject, text, html, headers: prefs.headersFor(unsubscribe) });
        if (out.delivered) delivered += 1;
      }
```

(Delete the earlier single `compose` call it replaces.)

`safeguardingNightly`: same shape with `kind: 'safeguarding_alert'` and `safeguarding.compose({ siteName: s.site_name, night: s.night, count, link: ..., unsubscribe })`.

`notifyThresholds`: the recipient query becomes

```js
      const { rows: to } = await client.query(
        `select p.id, u.email, p.full_name from profiles p join auth.users u on u.id = p.id
          where p.active and p.role in ('supervisor', 'admin') and u.email is not null
            and not exists (select 1 from email_opt_outs o where o.profile_id = p.id and o.kind = 'house_rules')`);
```

and the loop:

```js
      const slug = await prefs.slugForSchema(client, schema);
      let delivered = 0;
      for (const r of to) {
        const unsubscribe = await prefs.linkFor(client, { slug, profileId: r.id, kind: 'house_rules' });
        const footer = mail.textFooter(unsubscribe);
        const out = await mail.send({
          to: r.email,
          subject: `${s.site_name || 'CheckSteady'}: ${rows.length} at a House Rules figure`,
          text: footer ? `${text}\n\n${footer}` : text,
          html: mail.layout({ ...layoutArgs, unsubscribe }),
          headers: prefs.headersFor(unsubscribe),
        });
        if (out.delivered) delivered += 1;
      }
```

To make that work, turn the existing `const html = mail.layout({ ... })` into `const layoutArgs = { ... }` (the same object literal, without calling `layout`), so it can be spread with `unsubscribe` per person.

`routes/settings.js` `POST /weekly-report/send`: `const prefs = require('../lib/emailPrefs');` at the top of the section. The route needs the slug; it runs under `withIdentity`, which knows the tenant. Use `req.session` — check what `auth.attachSession` puts there (`grep -n "req.session = " lib/auth.js`). If it carries the tenant slug, use it; otherwise query `select slug from public.tenants t join auth.users u on u.tenant_id = t.id where u.id = $1` with `req.session.userId` inside the transaction. Then:

```js
    let sent = 0;
    for (const r of staff) {
      const unsubscribe = await prefs.linkFor(client, { slug, profileId: r.id, kind: 'weekly_report' });
      const { subject, text, html } = weekly.compose({
        siteName: s.site_name, from, to, rows,
        link: reportLink({ tab: 'reports', report: 'weekly', from, to }),
        unsubscribe,
      });
      const mailed = await mail.send({ to: r.email, subject, text, html, headers: prefs.headersFor(unsubscribe) });
      if (mailed.delivered) sent += 1;
    }
```

`linkFor` calls `email_link_key()` as the admin, which the function permits.

- [ ] **Step 6: Fix the callers that assumed `recipients()` returned strings**

`grep -rn "recipients(" routes lib jobs.js test | grep -v "function recipients"`. Anything that does `staff.some((e) => e === ...)` or `mails.some((m) => m.to === staff[0])` needs `.email`. The existing weekly tests in `test/api.test.js` compare `m.to` to literal addresses, so they should be unaffected — verify by running.

- [ ] **Step 7: Run everything**

Run: `node test/safeguardingAlert.test.js && PGBIN=/opt/homebrew/opt/postgresql@16/bin ./test/api.sh 2>&1 | tail -5`
Expected: both pass.

- [ ] **Step 8: Commit**

```bash
git add lib/weeklyReport.js lib/safeguardingAlert.js jobs.js routes/settings.js test/api.test.js test/safeguardingAlert.test.js
git commit -m "Every recurring email carries its own Unsubscribe link and List-Unsubscribe headers"
```

---

### Task 5: The public page — `routes/unsubscribe.js`

**Files:**
- Create: `lib/page.js` (move `esc` and `pageHtml` out of `routes/signup.js:118-140`; `routes/signup.js` requires them from there)
- Modify: `lib/security.js` (export `cspAllowingForms()`), `server.js:136` (mount after signup)
- Create: `routes/unsubscribe.js`
- Test: `test/api.test.js`

**Interfaces:**
- Consumes: `emailPrefs.isKind/KINDS/optOut/optIn/optOutsFor`, `tenancy.schemaForSlug`, `db.withOwnerIn`, `auth.lockedOut/noteFailure`.
- Produces: `GET /unsubscribe?t=&k=&e=` (200 page | 404 page), `POST /unsubscribe` (form body `t,k,e,kind,action` → 200 page; body `List-Unsubscribe=One-Click` → 200 empty).

- [ ] **Step 1: Write the failing tests**

Append to the migration-049 block in `test/api.test.js`. `client().fetch` sends JSON; these need form bodies, so use `fetch` directly:

```js
  const form = (path, fields) => fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  });

  await test("GET /unsubscribe shows the choice and changes nothing; POST stops one, or all; resume brings them back", async () => {
    const prefs = require("../lib/emailPrefs");
    assert.equal((await unsubAdmin.fetch(`/api/staff/${unsubSupId}/weekly-report`, { method: "POST", body: { on: true } })).status, 200);
    const key = await withOwner((c) => prefs.keyFor(c, unsubSupId));
    const q = `t=default&k=${key}&e=weekly_report`;

    const page = await fetch(`${base}/unsubscribe?${q}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /the Sunday report/);
    assert.match(html, /unsubsup@hut\.example/, "names the address it goes to");
    assert.match(html, /Stop this email/); assert.match(html, /Stop all site emails/);
    assert.match(page.headers.get("content-security-policy"), /form-action 'self'/, "the page may post to itself");
    assert.match(page.headers.get("cache-control"), /no-store/);
    assert.equal((await withOwner((c) => prefs.optOutsFor(c, unsubSupId))).length, 0, "GET changed nothing");

    const stop = await form("/unsubscribe", { t: "default", k: key, e: "weekly_report", kind: "weekly_report", action: "stop" });
    assert.equal(stop.status, 200);
    const stopped = await stop.text();
    assert.match(stopped, /will not be sent to you/i);
    assert.match(stopped, /Get these again/);
    let outs = await withOwner((c) => prefs.optOutsFor(c, unsubSupId));
    assert.deepEqual(outs.map((o) => o.kind), ["weekly_report"]);
    const p = (await withOwner((c) => c.query(`select weekly_report from public.profiles where id = $1`, [unsubSupId]))).rows[0];
    assert.equal(p.weekly_report, false);
    const audit = await withOwner((c) => c.query(`select actor_id from public.admin_audit where table_name = 'email_opt_outs' order by at desc limit 1`));
    assert.equal(audit.rows[0].actor_id, unsubSupId, "the audit row names the person, not nobody");

    const all = await form("/unsubscribe", { t: "default", k: key, e: "weekly_report", kind: "all", action: "stop" });
    assert.equal(all.status, 200);
    outs = await withOwner((c) => prefs.optOutsFor(c, unsubSupId));
    assert.deepEqual(outs.map((o) => o.kind).sort(), ["house_rules", "safeguarding_alert", "weekly_report"]);

    const back = await form("/unsubscribe", { t: "default", k: key, e: "weekly_report", kind: "weekly_report", action: "resume" });
    assert.equal(back.status, 200);
    assert.match(await back.text(), /will be sent to you again/i);
    outs = await withOwner((c) => prefs.optOutsFor(c, unsubSupId));
    assert.deepEqual(outs.map((o) => o.kind).sort(), ["house_rules", "safeguarding_alert"]);
    const backAll = await form("/unsubscribe", { t: "default", k: key, e: "weekly_report", kind: "all", action: "resume" });
    assert.equal(backAll.status, 200);
    assert.equal((await withOwner((c) => prefs.optOutsFor(c, unsubSupId))).length, 0);
  });

  await test("a one-click POST from a mail client stops the kind in the URL and returns 200 with no page", async () => {
    const prefs = require("../lib/emailPrefs");
    const key = await withOwner((c) => prefs.keyFor(c, unsubSupId));
    const res = await fetch(`${base}/unsubscribe?t=default&k=${key}&e=safeguarding_alert`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click",
    });
    assert.equal(res.status, 200);
    assert.equal((await res.text()).length, 0);
    assert.deepEqual((await withOwner((c) => prefs.optOutsFor(c, unsubSupId))).map((o) => o.kind), ["safeguarding_alert"]);
    await withOwner((c) => prefs.optIn(c, unsubSupId, ["safeguarding_alert"]));
  });

  await test("a wrong key, unknown slug or bad kind is one identical 404, and repeated wrong keys lock the address out", async () => {
    const bad = await fetch(`${base}/unsubscribe?t=default&k=not-a-key-at-all-xxxxxxxxxxxxxxxxxxxxxxxx&e=weekly_report`);
    assert.equal(bad.status, 404);
    const badText = await bad.text();
    assert.match(badText, /This link is not valid/);
    const badSlug = await fetch(`${base}/unsubscribe?t=nowhere&k=abc&e=weekly_report`);
    assert.equal(badSlug.status, 404);
    assert.equal(await badSlug.text(), badText, "same body whether the person or the centre exists");
    const badKind = await fetch(`${base}/unsubscribe?t=default&k=abc&e=marketing`);
    assert.equal(badKind.status, 404);
    assert.equal(await badKind.text(), badText);
    const badPost = await form("/unsubscribe", { t: "default", k: "abc", e: "weekly_report", kind: "weekly_report", action: "stop" });
    assert.equal(badPost.status, 404);
    for (let i = 0; i < 8; i++) await fetch(`${base}/unsubscribe?t=default&k=wrong${i}&e=weekly_report`);
    const locked = await fetch(`${base}/unsubscribe?t=default&k=wrong-again&e=weekly_report`);
    assert.equal(locked.status, 429);
    auth.clearFailures("unsubscribe", "127.0.0.1");
  });
```

If `auth.clearFailures` is not exported, export it (it exists at `lib/auth.js:~107`). If the lockout test's IP is not `127.0.0.1` (trust proxy may make it `::ffff:127.0.0.1`), read `req.ip` in the route's 429 log line once and match it.

- [ ] **Step 2: Run to see it fail**

Run: `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./test/api.sh 2>&1 | tail -5`
Expected: `GET /unsubscribe` returns 404 from the static handler with a different body — the first assertion `/the Sunday report/` fails.

- [ ] **Step 3: Extract `lib/page.js`**

Create `lib/page.js` containing `esc` and `pageHtml` exactly as they are in `routes/signup.js:118-140`, with a header comment: "The one server-rendered page shell: the trial sign-up pages and the unsubscribe page. Plain HTML in the app's own stylesheet, no script, so it works in any mail client's browser." Export `{ esc, pageHtml }`. In `routes/signup.js` delete the two definitions and add `const { esc, pageHtml } = require('../lib/page');`. Run `node --check routes/signup.js`.

- [ ] **Step 4: `cspAllowingForms()` in `lib/security.js`**

Below `buildCsp()`:

```js
// The unsubscribe page is the one page in this service that posts an HTML
// form to itself — it has no script, so it cannot fetch(). Everything else
// keeps form-action 'none'. The route sets this header after the global one.
function cspAllowingForms() {
  return buildCsp().replace("form-action 'none'", "form-action 'self'");
}
```

Add it to `module.exports`.

- [ ] **Step 5: Write the route**

Create `routes/unsubscribe.js`:

```js
// The Unsubscribe link in every recurring site email lands here (049).
//
// No login: the person is on their phone, in their mail client, and the
// whole point is that they should not have to ask anyone. The key in the
// URL is the credential — one per person, minted by email_link_key() — and
// all it can do is toggle that person's own opt-outs. Mail scanners fetch
// links, so GET only shows the choice; POST acts. The tenant is named in
// the URL and checked against public.tenants, never taken from the Host
// header (the same weakness logged against the auth routes).
//
// A wrong key, an unknown centre and a kind we do not send are all the one
// 404 with the one body: nothing here says whether a person exists. Wrong
// keys cost the caller — eight in five minutes and the address is refused.
const express = require('express');
const { wrap } = require('../lib/asyncRoute');
const db = require('../database');
const auth = require('../lib/auth');
const tenancy = require('../lib/tenancy');
const prefs = require('../lib/emailPrefs');
const { cspAllowingForms } = require('../lib/security');
const { esc, pageHtml } = require('../lib/page');

const router = express.Router();

const KEY_RE = /^[A-Za-z0-9_-]{20,64}$/;

// Resolve the URL to a person, or null. Runs as the owner inside the named
// tenant's schema; the key table has no other reader.
async function resolve(query) {
  const slug = String(query.t || '');
  const key = String(query.k || '');
  const kind = String(query.e || '');
  if (!KEY_RE.test(key) || !prefs.isKind(kind)) return null;
  let schema;
  try { schema = tenancy.schemaForSlug(slug); } catch (_) { return null; }
  return db.withOwner(async (client) => {
    const { rows: [t] } = await client.query(
      `select status from public.tenants where slug = $1`, [slug]);
    if (!t || t.status === 'closed') return null;
    return db.withOwnerIn(schema, async (c) => {
      const { rows: [p] } = await c.query(
        `select p.id, p.full_name, u.email
           from email_link_keys k
           join profiles p on p.id = k.profile_id
           join auth.users u on u.id = p.id
          where k.key = $1`, [key]);
      if (!p) return null;
      const optOuts = await prefs.optOutsFor(c, p.id);
      return { schema, slug, key, kind, profile: p, optOuts };
    });
  });
}

// Every write attributed to the person: audit_row() reads auth.uid(), which
// reads this setting, so the admin_audit row says they did it themselves.
function asPerson(schema, profileId, fn) {
  return db.withOwnerIn(schema, async (client) => {
    await client.query('SELECT set_config($1, $2, true)', ['request.jwt.claim.sub', String(profileId)]);
    return fn(client);
  });
}

const notValid = () => pageHtml({
  title: 'This link is not valid',
  heading: 'This link is not valid',
  body: `<p>It may have been copied incompletely, or the account it belonged to is gone. Open the link in the email exactly as it arrived, or ask an administrator at your centre to change what you receive under Admin → Staff.</p>`,
});

function choicePage(ctx, notice) {
  const { kind, profile, optOuts, slug, key } = ctx;
  const stopped = new Set(optOuts.map((o) => o.kind));
  const hidden = `<input type="hidden" name="t" value="${esc(slug)}"><input type="hidden" name="k" value="${esc(key)}"><input type="hidden" name="e" value="${esc(kind)}">`;
  const thisOne = prefs.KINDS[kind].name;
  const body = [];
  if (notice) body.push(`<div class="alert ok">${esc(notice)}</div>`);
  body.push(`<p>This link came from <b>${esc(thisOne)}</b>, sent to <b>${esc(profile.email)}</b>.</p>`);
  if (!stopped.has(kind)) {
    body.push(`<form method="post" action="/unsubscribe">${hidden}<input type="hidden" name="kind" value="${esc(kind)}"><input type="hidden" name="action" value="stop">
      <button class="btn" type="submit">Stop this email</button></form>`);
  }
  if (stopped.size < Object.keys(prefs.KINDS).length) {
    body.push(`<form method="post" action="/unsubscribe">${hidden}<input type="hidden" name="kind" value="all"><input type="hidden" name="action" value="stop">
      <button class="btn ghost" type="submit">Stop all site emails</button></form>`);
  }
  if (stopped.size) {
    body.push(`<h3>You are not receiving</h3><ul class="facts">${optOuts.map((o) => `<li>${esc(prefs.KINDS[o.kind].name)}
      <form method="post" action="/unsubscribe">${hidden}<input type="hidden" name="kind" value="${esc(o.kind)}"><input type="hidden" name="action" value="resume">
      <button class="linkish" type="submit">Get these again</button></form></li>`).join('')}</ul>`);
    if (stopped.size > 1) {
      body.push(`<form method="post" action="/unsubscribe">${hidden}<input type="hidden" name="kind" value="all"><input type="hidden" name="action" value="resume">
        <button class="btn ghost" type="submit">Get all site emails again</button></form>`);
    }
  }
  body.push(`<p class="hint">Login codes and password resets are not affected. An administrator can also change this for you under Admin → Staff.</p>`);
  return pageHtml({ title: 'Site emails', heading: 'Site emails', body: body.join('\n'), backHref: '/', backLabel: 'Open CheckSteady' });
}

function send(res, status, html) {
  res.setHeader('Content-Security-Policy', cspAllowingForms());
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.status(status).type('html').send(html);
}

async function guardedResolve(req) {
  if (auth.lockedOut('unsubscribe', req.ip)) return { locked: true };
  const ctx = await resolve(req.query);
  if (!ctx) auth.noteFailure('unsubscribe', req.ip);
  return { ctx };
}

router.get('/unsubscribe', wrap(async (req, res) => {
  const { locked, ctx } = await guardedResolve(req);
  if (locked) return send(res, 429, notValid());
  if (!ctx) return send(res, 404, notValid());
  send(res, 200, choicePage(ctx));
}));

router.post('/unsubscribe', wrap(async (req, res) => {
  // RFC 8058 one-click: the mail client posts this literal body to the URL
  // from the header, with no form fields of its own.
  const oneClick = req.body && req.body['List-Unsubscribe'] === 'One-Click';
  // The form carries the identity in its body; the one-click POST in the URL.
  const query = oneClick ? req.query : { t: req.body?.t, k: req.body?.k, e: req.body?.e };
  const { locked, ctx } = await guardedResolve({ ip: req.ip, query });
  if (locked) return send(res, 429, notValid());
  if (!ctx) return send(res, 404, notValid());

  const which = oneClick ? ctx.kind : String(req.body?.kind || '');
  const action = oneClick ? 'stop' : String(req.body?.action || '');
  const kinds = which === 'all' ? Object.keys(prefs.KINDS) : prefs.isKind(which) ? [which] : null;
  if (!kinds || !['stop', 'resume'].includes(action)) return send(res, 404, notValid());

  await asPerson(ctx.schema, ctx.profile.id, (client) =>
    action === 'stop' ? prefs.optOut(client, ctx.profile.id, kinds) : prefs.optIn(client, ctx.profile.id, kinds));
  if (oneClick) return res.status(200).end();

  const fresh = await resolve(query);
  const names = which === 'all' ? 'The site emails' : prefs.KINDS[which].name.replace(/^the /, 'The ');
  const notice = action === 'stop'
    ? `${names} will not be sent to you any more.`
    : `${names} will be sent to you again.`;
  send(res, 200, choicePage(fresh, notice));
}));

module.exports = router;
```

Check `app-common.css` has `.alert.ok`; if only `.alert` exists, use `<div class="alert">`. Check `pageHtml`'s `backHref` default and pass `/` so the "Open CheckSteady" link goes to the login. The `optIn` for a kind with a tick may hit the guard constraint if the person was demoted since — wrap the `asPerson` call in `try/catch` and on a `23514` SQLSTATE send the choice page with the notice "That email is only sent to supervisors and administrators; ask an administrator at your centre." (status 200).

- [ ] **Step 6: Mount it**

In `server.js`, directly after `app.use(require('./routes/signup'));`:

```js
// The Unsubscribe link in the recurring emails (049). Same posture as
// signup: unauthenticated by necessity, form-encoded, rate-limited in the
// route, and a GET that changes nothing.
app.use(require('./routes/unsubscribe'));
```

- [ ] **Step 7: Run the suite**

Run: `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./test/api.sh 2>&1 | tail -8`
Expected: the three new tests pass. Common failures: (a) `req.ip` under the test server is `::ffff:127.0.0.1` — fix the `clearFailures` argument in the test; (b) the CSP assertion — confirm the route's `setHeader` runs after `securityHeaders()`; (c) `audit_row` inserting into `public.admin_audit` needs the `request.jwt.claim.sub` set inside the same transaction — `asPerson` does this.

- [ ] **Step 8: Commit**

```bash
git add lib/page.js routes/signup.js lib/security.js routes/unsubscribe.js server.js test/api.test.js lib/auth.js
git commit -m "GET/POST /unsubscribe: the page behind the link, no login, GET changes nothing"
```

---

### Task 6: Admin sees it and can reinstate — `routes/staff.js`

**Files:**
- Modify: `routes/staff.js:22-34` (list), `:188-222` (weekly tick), `:225-249` (safeguarding tick); add `POST /:id/house-rules`
- Test: `test/api.test.js`

**Interfaces:**
- Produces: `GET /api/staff` rows gain `opt_outs: [{ kind, unsubscribed_at }]`; `POST /:id/weekly-report {on:true}` and `POST /:id/safeguarding-alert {on:true}` also delete the matching opt-out row; `POST /:id/house-rules {on:true}` deletes the `house_rules` row (admin only; 404/403 as the siblings).

- [ ] **Step 1: Write the failing test**

Append to the migration-049 block:

```js
  await test("the staff list shows who unsubscribed themselves; an admin re-ticking, or reinstating House Rules, clears it", async () => {
    const prefs = require("../lib/emailPrefs");
    await withOwner((c) => prefs.optOut(c, unsubSupId, ["weekly_report", "house_rules"]));
    let list = await unsubAdmin.fetch("/api/staff");
    let me = list.json.find((s) => s.id === unsubSupId);
    assert.deepEqual(me.opt_outs.map((o) => o.kind).sort(), ["house_rules", "weekly_report"]);
    assert.ok(me.opt_outs.every((o) => o.unsubscribed_at), "carries when");

    assert.equal((await unsubAdmin.fetch(`/api/staff/${unsubSupId}/weekly-report`, { method: "POST", body: { on: true } })).status, 200);
    list = await unsubAdmin.fetch("/api/staff");
    me = list.json.find((s) => s.id === unsubSupId);
    assert.deepEqual(me.opt_outs.map((o) => o.kind), ["house_rules"], "re-ticking clears the opt-out");
    assert.equal(me.weekly_report, true);

    const asSup = await unsubSup.fetch(`/api/staff/${unsubSupId}/house-rules`, { method: "POST", body: { on: true } });
    assert.equal(asSup.status, 403, "only an admin reinstates");
    const back = await unsubAdmin.fetch(`/api/staff/${unsubSupId}/house-rules`, { method: "POST", body: { on: true } });
    assert.equal(back.status, 200, back.text);
    list = await unsubAdmin.fetch("/api/staff");
    assert.deepEqual(list.json.find((s) => s.id === unsubSupId).opt_outs, []);
    const gone = await unsubAdmin.fetch(`/api/staff/00000000-0000-0000-0000-000000000000/house-rules`, { method: "POST", body: { on: true } });
    assert.equal(gone.status, 404);
    assert.equal((await unsubAdmin.fetch(`/api/staff/${unsubSupId}/weekly-report`, { method: "POST", body: { on: false } })).status, 200);
  });
```

- [ ] **Step 2: Run to see it fail**

Run: `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./test/api.sh 2>&1 | tail -5`
Expected: `me.opt_outs` is undefined.

- [ ] **Step 3: The list**

In `GET /`, change the select to:

```js
      `select p.id, u.email, p.full_name, p.role, p.active, p.weekly_report, p.safeguarding_alert,
              u.last_sign_in_at, p.created_at,
              coalesce((select json_agg(json_build_object('kind', o.kind, 'unsubscribed_at', o.unsubscribed_at) order by o.unsubscribed_at)
                          from email_opt_outs o where o.profile_id = p.id), '[]'::json) as opt_outs
         from profiles p
         join auth.users u on u.id = p.id
        order by p.active desc, p.role, p.full_name`,
```

Add to the route comment: "`opt_outs` (049) is what lets the card say 'unsubscribed themselves' — readable by any staff member like the rest of the row, since it names no resident."

- [ ] **Step 4: The two ticks clear the row**

In `POST /:id/weekly-report`, after the `update profiles ...` query and before `return rows[0]`:

```js
    // Ticking someone back on is also the admin's way of undoing an
    // unsubscribe (049): the row is what the staff card shows, so it must go.
    if (on && rows[0]) await client.query(`delete from email_opt_outs where profile_id = $1 and kind = 'weekly_report'`, [id]);
```

Same in `POST /:id/safeguarding-alert` with `kind = 'safeguarding_alert'`. The delete runs under the admin's identity; the `email_opt_outs_admin` policy allows it and a non-admin's delete matches nothing.

- [ ] **Step 5: `POST /:id/house-rules`**

After the safeguarding route:

```js
// POST /api/staff/:id/house-rules { on: true } — put someone back on the
// nightly House Rules reminder after they unsubscribed themselves (049).
// There is no tick for this email — every active supervisor and admin gets
// it — so "on" means deleting their opt-out row, and there is no "off":
// an admin who wants someone off it disables or demotes them. Admins only,
// by the same shape as the siblings: the delete matches no rows for anyone
// else, and a row that was never there is a 404 for an admin.
router.post('/:id/house-rules', wrap(async (req, res) => {
  const id = uuidParam(req.params.id, 'staff id');
  if (req.body?.on !== true) throw new HttpError(400, 'Only { on: true } is accepted here.');
  if (req.session.role !== 'admin') throw new HttpError(403, 'Only an administrator can change who receives the House Rules reminder.');
  const row = await db.withIdentity(req.session.userId, async (client) => {
    const { rows: [exists] } = await client.query('select id from profiles where id = $1', [id]);
    if (!exists) return null;
    await client.query(`delete from email_opt_outs where profile_id = $1 and kind = 'house_rules'`, [id]);
    return { id, house_rules: true };
  });
  if (!row) throw new HttpError(404, 'No such account.');
  res.json(row);
}));
```

- [ ] **Step 6: Run the suite**

Run: `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./test/api.sh 2>&1 | tail -5`
Expected: passes. Also run `node tools/gen-permissions-doc.js` if `docs/` carries a generated permissions table that lists routes (check `git status` after; commit the regenerated file if it changed).

- [ ] **Step 7: Commit**

```bash
git add routes/staff.js test/api.test.js docs
git commit -m "Staff list carries opt-outs; re-ticking or reinstating clears them"
```

---

### Task 7: Admin card, help, GDPR note

**Files:**
- Modify: `public/admin.html:1335-1365` (`staffCard`), `:1545-1575` (click handler), `public/help.html:344-360`, `docs/GDPR.md:234-250`
- Test: `check.sh` layer 1 (parse) and a look in the browser

- [ ] **Step 1: The indicator on the card**

In `staffCard(s)`, after the `safeguarding` const:

```js
  // Someone who used the Unsubscribe link in an email (049). Shown as its own
  // line rather than an unticked box, because an unticked box cannot say
  // whether it was them or an admin. Re-ticking clears the first two; the
  // House Rules reminder has no tick, so it gets its own Reinstate.
  const NAMES = { weekly_report: "the Sunday report", safeguarding_alert: "the nightly safeguarding alert", house_rules: "the nightly House Rules reminder" };
  const optOuts = (s.opt_outs || []).map((o) => `
        <span class="meta unsub">Unsubscribed themselves from ${NAMES[o.kind] || o.kind} on ${esc(shortDate(o.unsubscribed_at))}${o.kind === "house_rules" ? ` · <button class="linkish sHr" type="button" data-sid="${esc(s.id)}">Reinstate</button>` : ""}</span>`).join("");
```

and render `${optOuts}` right after `${safeguarding}` in the template. If there is no `shortDate` helper in `admin.html`, use the existing `ago()` or add next to it:

```js
function shortDate(iso) {
  return new Intl.DateTimeFormat("en-IE", { day: "numeric", month: "short", timeZone: "Europe/Dublin" }).format(new Date(iso));
}
```

Add to the `<style>` block near `.card.staff` rules: `.card.staff .meta.unsub { display: block; color: var(--warn); }` (check `--warn` exists in `app-common.css`; use `--muted` if not). The inline `<style>` is hashed into the CSP by `lib/security.js` at boot, so no CSP change is needed.

- [ ] **Step 2: The Reinstate handler**

In the staff click handler, after the `sg` block:

```js
  const hr = e.target.closest("button.sHr[data-sid]");
  if (hr) {
    const s = staffRows.get(hr.dataset.sid);
    if (!s) return;
    const out = await guarded(
      () => apiPost(`/api/staff/${s.id}/house-rules`, { on: true }),
      (err) => toast(err.message, "err"),
    );
    if (out) { toast(`${s.full_name} will get the nightly House Rules reminder again`, "ok"); loadStaff(); }
  }
```

- [ ] **Step 3: Help and GDPR**

`public/help.html`, in the "Send the Sunday report" facts list, add:

```html
    <li>Every one of these emails has an Unsubscribe link. Someone who uses it shows as "Unsubscribed themselves" on their staff card; tick them again to put them back, or they can from the same link</li>
```

and under "Staff accounts" recipe add a `<small>`: "A card that says Unsubscribed themselves means they used the link in an email; re-tick to reinstate."

`docs/GDPR.md`, after the paragraph beginning "The Sunday Weekly register update": add

```
Every recurring email carries an Unsubscribe link (migration 049) that
works without a login and stops that one email or all three; the fact is
recorded against the staff record and shown to administrators, who may
reinstate. Login codes, invitations and password resets carry no such link.
```

- [ ] **Step 4: Check it parses and looks right**

Run: `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./check.sh 2>&1 | tail -12`
Expected: every layer green.

Then start the app against the test cluster or a local DB, log in as an admin, opt a supervisor out via the SQL `insert into email_opt_outs (profile_id, kind) values (...)`, open Admin → Staff and confirm the line and Reinstate render and work. Screenshot for the PR if convenient.

- [ ] **Step 5: Commit**

```bash
git add public/admin.html public/help.html docs/GDPR.md
git commit -m "Admin → Staff shows who unsubscribed themselves, with Reinstate for House Rules"
```

---

### Task 8: Deploy notes

**Files:**
- Modify: `docs/KNOWN-ISSUES.md` (if it carries a deploy-hazards list), `README.md` (email section, if any)

- [ ] **Step 1: Note the hazard**

Migration 049 adds tables only — no column the deployed code selects is dropped — so a rolling deploy is safe. The one thing an operator must know: tenants provisioned before 049 will be missing the two tables until 048's gap check (`tenant_schema_gaps()`) reports them; the nightly job's `email_link_key()` call would then throw for that tenant and the run would record `FAILED`. Add one line under KNOWN-ISSUES #4's list of migrations that widen the gap.

- [ ] **Step 2: Full check and commit**

Run: `PGBIN=/opt/homebrew/opt/postgresql@16/bin ./check.sh 2>&1 | tail -12` — all green.

```bash
git add docs/KNOWN-ISSUES.md README.md
git commit -m "docs: unsubscribe deploy note"
```

Do **not** push; the owner pushes to main (Render auto-deploys).

---

## Self-review

**Spec coverage.** Data → Task 1. `lib/emailPrefs.js` → Task 2. Email changes (headers, footer, text) → Tasks 3–4. House Rules exclusion → Task 4. Route, page, one-click, 404 sameness, rate limit, CSP, audit actor → Task 5. Admin re-tick clears / Reinstate / `opt_outs` in list → Task 6. Indicator, help, GDPR → Task 7. Tenant template → Task 1. Testing list in spec: each bullet has an assertion in Tasks 1–6; `test/sql.sh` template coverage comes free from the existing "provisioned too" test.

**Type consistency.** `recipients()` returns `{ id, email }` in Task 4 and both `jobs.js` and `routes/settings.js` read `r.id` / `r.email`. `KINDS[k].tick` is `'weekly_report' | 'safeguarding_alert' | null` throughout. `optOutsFor` returns `{ kind, unsubscribed_at }` and the list route emits the same shape. `linkFor(client, { slug, profileId, kind })` is called with that object everywhere.

**Open detail left to the implementer, on purpose.** Task 4 Step 5 — how the send-now route learns its slug — depends on what `auth.attachSession` puts on `req.session`; the plan says where to look and gives the fallback query.
