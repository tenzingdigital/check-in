# Incident response

*ISO 27001:2022 5.24–5.28; GDPR Articles 33 and 34; DPA section 7. One page,
because at 2 am nobody reads a long one.*

## Who

| Role | Who | How to reach |
|---|---|---|
| Incident lead (Tenzing) | The owner of the Render account | *phone number here* |
| Deputy | *name* | *phone* |
| Centre contact | The centre manager named in the customer's onboarding | From the customer record |
| Regulator | Data Protection Commission, Ireland | dataprotection.ie — the breach form |

Fill the blanks in before the first customer is live. This document is
useless with blanks.

## What counts

An incident is anything that could mean resident or staff data was seen,
changed, lost or made unavailable by someone or something that should not
have. Examples, all real possibilities for this system:

- The tablet is stolen, or a phone with the app logged in is lost.
- A staff member's login is used by someone else, or after they have left.
- An administrator exported a record with no good reason (the reason is in
  `admin_audit`; read it).
- Render, GitHub or Resend reports a breach on their side.
- The service is down or the database is unreachable for longer than the
  offline window can cover (this is availability, and it counts).
- A migration or a purge deleted more than it should.
- A bug shows one centre's data to another (multi-tenancy, once there is a
  second tenant).

If in doubt, it is an incident. Deciding it was nothing is step 3, not
step 0.

## The clocks

- **48 hours** from Tenzing becoming aware to telling the affected customer
  (DPA section 7). This is a promise we made; it is shorter than the law.
- **72 hours** from the *controller* (the centre) becoming aware to the DPC
  (Art. 33), unless the breach is unlikely to result in a risk. The centre
  makes that notification; we give them what they need to.
- **Without undue delay** to the residents themselves (Art. 34) if the
  breach is likely to result in a high risk — which, for identity numbers
  that can reveal immigration status, it may well be.

Start the clock at the moment anyone at Tenzing first knew. Write that time
down.

## Steps

1. **Contain.** Whatever stops it continuing, first:
   - Lost or stolen device: under Admin → Staff, *disable* the account that
     was logged in on it. That ends every session at once. Re-enable and
     send a new login link when the person has a new device. The register
     copy on the device is encrypted with a key that died with the tab; the
     queue likewise.
   - A compromised staff login: disable it; the person gets a fresh
     invitation.
   - A leaked connection string: rotate it in the Render dashboard
     (Database → *Rotate credentials*), update the web service and cron
     job's environment, redeploy.
   - A leaked Resend key: revoke it in Resend, set the new one in Render.
   - A bug leaking data: roll back the deploy in Render (Deploys → previous
     → *Rollback*). Rolling back does not undo a migration; if the migration
     is the bug, take the service down (suspend it) rather than serve.
2. **Record.** Open a note with: time first known, who reported it, what
   was seen, what was done and when. Keep adding to it. This is what the
   DPC and the customer will ask for.
3. **Assess.** What data, whose, how many, how sensitive, who could have
   seen it, for how long. Sources: `admin_audit` (who exported or changed
   what), `auth.login_events` (who logged in from where), `job_runs` (what
   the nightly job did), Render's logs (`hut-check-in` and `hut-db`). Decide
   whether it is a personal data breach at all, and whether it is likely to
   result in a risk. Write the reasoning down even when the answer is no.
4. **Tell the customer** inside 48 hours, by phone and then in writing:
   what happened, the categories and approximate number of people and
   records, the likely consequences, what has been done. Offer the
   `admin_audit` and `login_events` extracts they will need for the DPC
   form. Do not wait for the assessment to be complete; tell them what is
   known and follow up.
5. **Support the notifications.** The centre notifies the DPC and, if
   needed, residents. We draft whatever they ask for.
6. **Fix the cause**, not just the symptom, and add the assertion to the
   test suite that would have caught it.
7. **Review** within two weeks: what happened, what worked, what to change.
   Add or update a row in `RISK-REGISTER.md`. Update this document if it
   was wrong.

## Evidence that already exists

- `admin_audit`: every change to residents, staff and settings, and every
  export with its reason, for the register retention period.
- `auth.login_events`: every login attempt, outcome, IP and user agent, 90
  days.
- `auth.sessions`: live sessions, with the IP and user agent they started
  from.
- `job_runs`: what the nightly job did and whether it succeeded.
- Render: deploy history, service logs, database logs and metrics.
- GitHub: every change to the code, with the test run that accompanied it.

None of these can be edited from the app. That is the point of them.
