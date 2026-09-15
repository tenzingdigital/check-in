# Unsubscribing from site emails — design

Written 15 September 2026 from the owner's ask: the managers and other
people a centre adds to its site emails should be able to stop receiving
them without asking anyone; Admin should show that they did; and they
should be able to come back.

Decisions taken while writing it: the link stops one email or all of them
(the owner's call — "per email but an option for all too"); both the
person and an admin can put someone back on; transactional email is out
of scope; and opting out is recorded as its own fact rather than by
clearing the tick, so Admin can tell "unsubscribed themselves" from
"never ticked".

## What exists now

Three recurring emails reach staff. Two are chosen per person, one is not:

| Email | Sent by | Who receives it |
|---|---|---|
| Sunday Weekly register update | `jobs.js` weekly job, `routes/settings.js` manual send | `profiles.weekly_report` (migration 037) |
| Nightly safeguarding alert | `jobs.js` nightly job | `profiles.safeguarding_alert` (migration 041) |
| Nightly House Rules reminder | `jobs.js` `notifyThresholds` | every active supervisor or admin with an email address |

All three are rendered by `mail.layout()` in `lib/mail.js`, whose footer
says "You are receiving this because your CheckSteady account is ticked
for it" and offers no way out. `mail.send()` posts to Resend with no
custom headers.

Password reset, login codes and invites are transactional. They are not
touched by anything below.

## Scope

- An Unsubscribe link in the footer of the three recurring emails, and
  `List-Unsubscribe` / `List-Unsubscribe-Post` headers on them, so mail
  clients can show their own Unsubscribe button.
- A public page the link opens, offering to stop that one email or all
  site emails, and — for anyone already opted out — to get them again.
- An indicator on the Admin → Staff card for each email the person has
  opted out of, and the means for an admin to reinstate them.

Out of scope: transactional email; a per-person tick for the House Rules
reminder (it keeps going to every supervisor and admin, minus opt-outs);
any change to who may carry the weekly or safeguarding ticks.

## Data — migration 049, mirrored in `tenant/template.sql`

```sql
create table email_opt_outs (
  id              bigint generated always as identity primary key,
  profile_id      uuid not null references profiles (id) on delete cascade,
  kind            text not null check (kind in ('weekly_report', 'safeguarding_alert', 'house_rules')),
  unsubscribed_at timestamptz not null default now(),
  unique (profile_id, kind)
);

create table email_link_keys (
  profile_id  uuid primary key references profiles (id) on delete cascade,
  key         text not null unique,
  created_at  timestamptz not null default now()
);
```

- A row in `email_opt_outs` means *this person opted themselves out of
  this email*. It is the only thing the indicator reads. Absence of a row
  with the tick off means an admin unticked them, and shows nothing. The
  `id` column exists so `audit_row()` (migration 012) can be attached to it
  unchanged; every opt-out and opt-in then lands in `admin_audit`.
- `email_link_keys` holds one random key per person (32 CSPRNG bytes,
  base64url), minted the first time a link is needed and reused for every
  email after — so the link in an old email keeps working. It is stored in
  clear, unlike a password-reset token, because it must be re-sent, and
  because what it can do is toggle that one person's opt-outs and nothing
  else. The table is readable by nobody but the database owner: no grant to
  `authenticated` or `anon`. A SECURITY DEFINER function
  `email_link_key(uuid) returns text` mints-or-returns the key; it refuses
  any caller with a session who is not an admin (`auth.uid() is not null
  and not is_admin()`), so the send-now route — which runs as the admin —
  can build links, and nobody else can read a colleague's key. Deleting a
  person's row invalidates their links; the next send mints a fresh one.
- Same grants as 037/041 otherwise: the app role reads and writes both,
  `authenticated` reads `email_opt_outs` (the staff list shows them) and
  writes neither directly — the routes go through owner or admin paths.
- `tenant/template.sql` is regenerated (`./tools/gen-tenant-template.sh`)
  or migration 048's drift check fires on the next nightly run.

## Behaviour

**Opting out, by link.** `POST /unsubscribe` with the key and a kind inserts
the row; for `weekly_report` and `safeguarding_alert` it also sets the tick
false, so the recipient queries and Admin agree. Kind `all` inserts all
three. Inserting an existing row is a no-op.

**Coming back, by link.** The same page lists what the person is opted out
of, each with a *Get these again* button, and *Get all site emails again*.
Deleting the row sets the tick back to true for the two ticked kinds.

**Coming back, by admin.** Ticking "Gets the Sunday report" or "Gets the
nightly safeguarding alert" in Admin → Staff deletes the matching opt-out
row inside the existing PATCH. House Rules has no tick, so its indicator
line carries a *Reinstate* button that deletes the row.

**Recipient queries.** `lib/weeklyReport.js` and `lib/safeguardingAlert.js`
need no change: the tick is already false. `jobs.js` `notifyThresholds`
adds `and not exists (select 1 from email_opt_outs o where o.profile_id =
p.id and o.kind = 'house_rules')`.

**Audit.** `admin_audit` records profile changes by trigger, attributed to
the current session. A link action has no session; the route sets the
audit actor to the profile the key belongs to before writing, so the
record reads as the person acting on their own account, as it should.

**The indicator.** On the staff card, under the ticks, one muted line per
opt-out: *Unsubscribed themselves from the Sunday report on 14 Sep.* The
House Rules line ends with the Reinstate button. `GET /api/staff` returns
`opt_outs: [{ kind, unsubscribed_at }]` per profile.

## The link and the page

**URL.** `${PUBLIC_URL}/unsubscribe?t=<slug>&k=<key>&e=<kind>`. The tenant
slug is in the URL (`default` for the legacy `public` schema, per
`lib/tenancy.js`) so the page never derives the tenant from the Host
header — the same weakness already logged against the auth routes. The
slug is validated against `public.tenants` and mapped by
`schemaForSlug()`; a closed or unknown tenant 404s.

**Routes.** `routes/unsubscribe.js`, mounted in `server.js` before
`auth.requireSession`, next to `routes/signup`, with the form-encoded body
parser it already has. Rate-limited per IP with `auth.lockedOut` /
`auth.noteFailure` under its own bucket, as password-reset is, because the
key is looked up by value and a wrong key must cost the caller.

- `GET /unsubscribe` renders the page and changes nothing. Mail scanners
  fetch links; a GET that acted would unsubscribe people who never clicked.
- `POST /unsubscribe` performs the action from the form (`kind` =
  one of the three or `all`; `action` = `stop` | `resume`), then renders
  the page again in its new state with a one-line confirmation.
- A `POST` whose body is exactly `List-Unsubscribe=One-Click` (RFC 8058,
  sent by the mail client) stops the kind named in the URL and returns
  200 with no page.
- Wrong or missing key, unknown slug, unknown kind: 404 with a plain
  "This link is not valid" page — identical whether or not the person
  exists.

**The page.** Server-rendered HTML in the app's plain style, no script,
same CSP as the rest (`form-action 'self'`). It names the email and the
address it goes to ("the Sunday report, sent to amy@…"), never the site's
residents. Two buttons for a person not yet opted out; the list with
*Get these again* for one who is. A footer line: "Login codes and
password resets are not affected."

## Email changes

`lib/mail.js`:

- `send()` accepts an optional `headers` object and forwards it to Resend.
- `layout()` accepts an optional `unsubscribe` href. When present the
  footer becomes: "You are receiving this because your CheckSteady account
  is ticked for it. It carries counts only — the detail stays behind your
  login. Unsubscribe" with the last word a link. The text alternative ends
  with "To stop these emails: <url>".
- Nothing about `resetEmail`, `codeEmail` or the invite changes.

`lib/emailPrefs.js` (new, single owner of the rules):

- `linkFor(client, schemaSlug, profileId, kind)` — returns the URL,
  minting and storing the key if the profile has none.
- `optOut(client, profileId, kinds)` / `optIn(client, profileId, kinds)` —
  the row and tick changes above, in one statement each.
- `KINDS` and their display names ("the Sunday report", "the nightly
  safeguarding alert", "the nightly House Rules reminder"), used by the
  page, the footer and Admin.

Callers: `jobs.js` (three sends), `lib/weeklyReport.js` /
`lib/safeguardingAlert.js` if they build the message, and
`routes/settings.js` manual send. Each passes `unsubscribe` to the layout
and sets `List-Unsubscribe: <url>` and
`List-Unsubscribe-Post: List-Unsubscribe=One-Click`.

## Admin and help

`public/admin.html`: the indicator lines and the Reinstate button on the
staff card; the existing tick handlers already PATCH and re-render, so the
indicator clears on re-tick without more work. `public/help.html`: one
line under the Sunday report and safeguarding sections — every one of
these emails has an Unsubscribe link, Admin shows who used it, and
ticking them again puts them back.

## Testing

`test/api.test.js`:

- GET with a valid key changes nothing.
- POST stop `weekly_report`: row present, tick false, the person is absent
  from the recipient query.
- POST stop `all`: three rows; House Rules recipient query skips them.
- POST resume: row gone, tick true.
- Admin PATCH ticking the box deletes the row; `GET /api/staff` shows
  `opt_outs` before and not after.
- Wrong key, wrong slug, closed tenant, bad kind: 404, same body.
- One-Click POST body: 200, row present.
- Repeated wrong keys lock the IP out.

`test/mail.test.js`: the three recurring messages carry the footer link,
the text fallback and both headers; the reset and code messages carry
none.

`test/sql.sh` / tenant template: the new table exists in a freshly
provisioned tenant schema.
