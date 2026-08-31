# The Tao of the Register

The rules this system is built on. Not aspirations — every one of them names
the mechanism that enforces it, because a principle with no mechanism is a
preference, and preferences do not survive a busy Tuesday.

Cite them by number in review. If a change breaks one, that is not
automatically wrong, but it is automatically a conversation.

---

## I. The record

**1. The record is evidence, not a convenience.**
`gate_events`, `checkin_events` and `daily_compliance` have no `update` or
`delete` policy for any role — not guard, not supervisor, not admin. There is
no "fix that entry" button because there is no path to one. The only removal is
a GDPR erasure, and it writes a row to `erasure_log` proving it happened.

**2. Never destroy proof that someone attended.**
`close_out_compliance_days()` writes *only negative rows*. Positive rows are
written by `record_checkin()` in the same transaction as the event itself. A
failed or missed nightly job can therefore delay a breach being recorded; it
can never erase an attendance.

**3. Flag, but never suppress.**
`attention_list()` exempts breaches from its own row cap, ranked within their
partition rather than globally. A large backlog of never-seen residents can
push things down the list; it cannot push a breach off it.

**4. Attribution is not optional.**
Every event carries the staff member who recorded it, taken from the session.
`guard_id` is `on delete restrict`, so the database refuses to erase the
identity behind a historical trail — deactivate accounts, never delete them.

## II. Authority

**5. The screen is presentation. The database is security.**
The Staff tab is hidden from non-admins as a courtesy. It is not a control.
Every operation behind it re-checks `is_admin()` itself, and the row policies
make a non-admin's update match zero rows. Assume every screen is bypassed.

**6. Identity is taken, never given.**
No RPC accepts a user or guard id as a parameter. They read `auth.uid()` from
the transaction the API bound. There is deliberately no argument anywhere that
lets a caller act as somebody else.

**7. Fail closed, and re-close after every change.**
`anon` reaches nothing. Definer-rights helpers are revoked from the request
roles. Postgres grants `execute` to `public` on every *new* function, so a
migration that recreates one must re-revoke it — 006 and 007 both do, and that
is the standing tax on dropping a function.

**8. Know less.**
Guards hold no `SELECT` on `residents`, because that table carries dates of
birth. They read a view that never exposes one. Rooms and free-text notes were
removed outright rather than governed: data you do not hold cannot leak, cannot
go stale, and cannot become a special-category problem.

## III. Time

**9. One clock, and it is the site's.**
The day boundary comes from `app_settings.local_timezone` via `site_today()`,
computed on the server. A terminal with a wrong clock cannot shift what "today"
means, for the register or for the log.

**10. The day closes itself.**
Nobody has to remember anything. The nightly job is idempotent, recomputes its
own range from the register, and backfills every day it missed — which is what
makes an external scheduler acceptable where `pg_cron` is not available.

**11. A session is a shift, not a fortnight.**
Twelve hours by default. A hut terminal is a shared physical device, and a
session that outlives the shift is one the next person inherits.

## IV. The person at the desk

**12. Show everything; forgive the typing.**
The whole register is on screen before anything is typed. Search is
accent-blind and typo-tolerant, and fuzzy matches are a *fallback, not a
supplement* — offered only when nothing matches literally, so the card someone
expected is never crowded out at the moment they reach for it.

**13. Two taps, and no second system.**
One gesture records the thing. The gate and the register are deliberately
separate records — a sign-in is not a check-in, because the duty is to present,
not merely to be seen leaving — but they are one app, one login, one list.

**14. Say what happened, in words a guard can read.**
Only four SQLSTATEs are forwarded to the browser, the ones whose messages were
written for a person. Everything else becomes "something went wrong", because a
raw database error carries column names, constraints and row contents.

## V. Refusals

**15. Nothing from a third party.**
Three dependencies. No build step, no framework, no CDN, no fonts fetched at
first paint. Inline scripts are allowed by hash, not by `unsafe-inline`. This
is not minimalism for its own sake: it is what lets the GDPR documentation say
plainly that nothing leaves this origin.

**16. Secrets are stored as hashes or not at all.**
Session tokens and password-reset tokens exist in the database only as their
SHA-256. A leaked backup contains nothing replayable.

**17. Break loudly.**
A failed migration is fatal on purpose: serving a register against a
half-applied schema is worse than being down and obviously so. `/healthz`
touches Postgres rather than returning a cheerful 200. Where an invariant
should hold, the code raises rather than returning a quiet `NULL`.

**18. Make bad states unrepresentable.**
`departed_on_matches_status` is a biconditional, not a one-way check. Without
it a resident could be marked departed with no date, which close-out would read
as still required forever — an unclearable statutory breach against somebody
who simply moved out.

---

*If you are adding something and it does not fit here, that is worth a minute
of thought. Most of the awkward decisions in this codebase are awkward because
one of these rules held and the convenient thing lost.*
