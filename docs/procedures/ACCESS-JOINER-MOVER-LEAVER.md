# Access: joiners, movers, leavers, and the quarterly review

*ISO 27001:2022 5.15, 5.16, 5.18, 6.5. GDPR Art. 32.*

Two kinds of access exist. **Staff accounts** in the app, which a centre's
administrator manages under Admin → Staff. **Platform accounts**, which
Tenzing holds and which can reach everything: Render, GitHub, Resend, and the
database connection string. The first is the centre's daily routine; the
second is where a leaver is dangerous.

## Staff accounts (the centre)

| Event | Who does it | What | Within |
|---|---|---|---|
| **Joiner** | An administrator | Admin → Staff → *Invite*: name, email, role. The person gets a one-day link and chooses their own password. Nobody types a password for anyone else | Before their first shift |
| **Mover** (role change) | An administrator | Admin → Staff → change the role. Takes effect on their next request | Same day |
| **Leaver** | An administrator | Admin → Staff → *Disable*. Ends every open session immediately and the login stops working. The account is kept, disabled, because the register carries their name on every event they recorded and the database refuses to delete an identity records depend on | The same day they leave, and before the end of their last shift where possible |
| **Lost device** | An administrator | Disable, then re-enable and *Send login link* once they have a new device | Immediately |

Roles, least first: **guard** (search, sign in and out, record check-ins),
**supervisor** (also add, edit and depart residents), **admin** (also staff,
settings, export, erase). Give the lowest role that does the job; there is
no reason for a guard's account to be able to export a record.

The centre's rule for a shared terminal: the terminal is logged in as the
person on shift, not as "the hut". Log out at handover. The idle lock
(Settings, default 20 minutes) covers the case where nobody does.

## Platform accounts (Tenzing)

| Account | What it can reach | Who holds it |
|---|---|---|
| Render (workspace owner) | Every service, the database shell, environment variables including the database credential and the Resend key, backups | *name, since date* |
| GitHub (`tenzingdigital/check-in` admin) | The code, the deploy pipeline (Render deploys `main`), the CI secrets if any | *name, since date* |
| Resend | Sending email as the service; the API key | *name, since date* |
| External `DATABASE_URL` | Direct SQL against the live register | *name, since date* — and the machine it is on |
| Backup key (`age` private key, `tools/backup.sh`) | Decrypting the off-provider backups | *name, since date* — and where the key is kept |

Rules:

- MFA on all three provider accounts. No exceptions, no shared logins.
- The external connection string and the backup key live in a password
  manager, not in a file, a chat, or an email.
- **Leaver**: the same day, remove them from Render, GitHub and Resend,
  **rotate the database credential** (Render → Database → *Rotate
  credentials*; then update the web service and cron job environment and
  redeploy), rotate the Resend key, and generate a new backup key pair
  (keep the old private key until the last backup encrypted with it has
  expired, 35 days). Update the table above.
- **Mover** (a contractor who needed access for a piece of work): access is
  granted with an end date written in this table, and removed on that date
  whether or not the work is finished.

## The quarterly review

Once a quarter, dated and initialled:

1. **The centre.** The administrator opens Admin → Staff and confirms every
   active account is a current staff member with the right role. Disabled
   accounts stay disabled. The centre manager signs the list.
2. **Tenzing.** The owner confirms the platform table above is complete and
   correct, that MFA is on for every row, and that nobody who has left still
   appears. Sign and date below.
3. **Sessions.** `select count(*) from auth.sessions where expires_at >
   now()` on the live database should be about the number of terminals plus
   the number of staff on their own phones. A large number is a question.

| Review date | Reviewed by | Findings |
|---|---|---|
| | | |
