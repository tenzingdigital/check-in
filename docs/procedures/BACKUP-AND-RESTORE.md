# Backup and restore

*ISO 27001:2022 8.13, 8.14; DPA Annex II ("managed daily backups with
point-in-time recovery") and section 9 (backups deleted within 35 days).*

## Two copies

**Render's.** The managed database `hut-db` has Render's own daily backups
and, on paid plans, point-in-time recovery. Confirm both are on in the Render
dashboard (Database → *Backups*), and confirm the plan: the smallest plan is
the one that crashed under load on 4 September 2026 (`docs/KNOWN-ISSUES.md`
19c). This copy is what a Render-side accident is recovered from, and Render
restores it for you, into a new database, from the dashboard.

**Ours.** `tools/backup.sh` takes a `pg_dump` over the external connection
string, encrypts it with `age` to a public key, keeps it for 35 days and
deletes older files. This copy is what a lost Render account, a billing
failure, or the end of the Render relationship is recovered from. It must
live somewhere Tenzing controls, in the EU, and not on the same provider.

## Taking the backup

Once, on the machine that will take backups:

```sh
sudo apt install postgresql-client age     # or brew install libpq age
age-keygen -o ~/.config/checksteady/backup-key.txt
```

Put the **private** key in the password manager as well; the file on this
machine is not the only copy. The public key (`age1…`, printed by
`age-keygen`) goes in the environment below.

Daily, from cron or a scheduler:

```sh
DATABASE_URL='postgresql://…external…' \
BACKUP_RECIPIENT='age1…' \
BACKUP_DIR="$HOME/checksteady-backups" \
/path/to/check-in/tools/backup.sh
```

The script refuses a dump that is implausibly small, writes a SHA-256 beside
each file, and deletes files older than `BACKUP_KEEP_DAYS` (35). The
directory is `chmod 700`; the files `600`. Encrypt the disk the directory is
on as well; a laptop is fine if it is on every morning.

Check it ran: the newest file in the directory is from today. Put that check
somewhere you will see it fail (a calendar reminder, or a script that emails
if the newest file is older than two days).

## Restoring

Never restore over the live database. Restore into a new one and switch.

**From Render's backup.** Dashboard → `hut-db` → Backups → *Restore* to a
new database; then change `DATABASE_URL` on `hut-check-in` and `hut-nightly`
to the new database's internal string, redeploy both, and check `/healthz`
and the register page. The old database stays until the new one has run a
nightly close-out cleanly.

**From ours.** Create a new Render Postgres (Frankfurt, same plan), then from
the backup machine:

```sh
age --decrypt --identity ~/.config/checksteady/backup-key.txt \
    backups/checksteady-YYYYMMDD-HHMMSS.dump.age \
  | pg_restore --no-owner --dbname='postgresql://…new external…' --exit-on-error
```

Then switch `DATABASE_URL` as above. The service applies any migration newer
than the backup at boot, so a backup from before the latest deploy still
restores.

**What is lost.** Everything since the backup. With a nightly backup that is
up to a day of events and register rows. The paper fallback
(`PAPER-FALLBACK.md`) is how a centre fills that day: the sheet is entered
through the late-entry path inside the sync window. This is the recovery
point objective, and it is honest only while the sheet exists.

**How long.** A Render restore is minutes plus a redeploy. Ours is the same
once the new database exists. Say an hour, and the centre runs on paper for
that hour. This is the recovery time objective; if a customer needs a
shorter one, that is a conversation about plans and standby databases, not
a script.

## The rehearsal

Quarterly. An untested backup is a hope.

```sh
BACKUP_KEY=~/.config/checksteady/backup-key.txt \
  ./tools/restore-rehearsal.sh backups/checksteady-YYYYMMDD-HHMMSS.dump.age
```

The script decrypts and restores into a throwaway PostgreSQL cluster on the
machine it runs on (the same scaffolding the test suites use), prints how
many residents, register rows and staff came back and when the register was
last closed, boots the service against it, and checks `/healthz`. It touches
nothing live. Record the result here.

| Date | File | Result | By |
|---|---|---|---|
| 2026-09-04 | a seeded scratch database, not a live backup | RESTORE OK — the scripts work end to end; the first rehearsal against a live backup is still to do | Claude, in the development sandbox |

## Deleting

DPA section 9: backups are deleted no later than 35 days after the data is
deleted from the live service. `tools/backup.sh` enforces that for our copy.
Render's backup retention is Render's; check the number in the dashboard
and record it here: *___ days*. If it is longer than 35, the DPA wording
needs to change, or the plan does.
