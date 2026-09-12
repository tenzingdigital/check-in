#!/usr/bin/env bash
#
# Off-provider backup: a pg_dump of the live database, encrypted, kept for 35
# days and then deleted — the promise in section 9 of the DPA.
#
#   DATABASE_URL='postgresql://…' ./tools/backup.sh
#
# Render keeps its own daily backups (Annex II), but if the Render relationship
# ends, or the account is lost, the register must not end with it. This gives
# you a copy under your own control. Run it from a machine in the EU that you
# control, on a schedule (cron, or a laptop that is on every morning), with
# the EXTERNAL connection string from the Render dashboard — the internal one
# only resolves inside Render's network.
#
# Encryption: age (https://age-encryption.org), a small modern tool with no
# configuration. Generate a key pair once:
#
#   age-keygen -o ~/.config/checksteady/backup-key.txt
#
# and keep the PRIVATE key somewhere that survives losing this machine (a
# password manager). The public key (age1…) goes in BACKUP_RECIPIENT below.
# A backup you cannot decrypt is not a backup.
#
# Environment:
#   DATABASE_URL       required — the external connection string
#   BACKUP_RECIPIENT   required — the age public key (age1…)
#   BACKUP_DIR         default ./backups
#   BACKUP_KEEP_DAYS   default 35 (DPA section 9)
#
# Restore: ./tools/restore-rehearsal.sh <file> — see that script and
# docs/procedures/BACKUP-AND-RESTORE.md.

set -euo pipefail

: "${DATABASE_URL:?set DATABASE_URL to the external connection string}"
: "${BACKUP_RECIPIENT:?set BACKUP_RECIPIENT to the age public key (age1…)}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP="${BACKUP_KEEP_DAYS:-35}"

for tool in pg_dump age; do
  command -v "$tool" >/dev/null || { echo "error: $tool is not installed" >&2; exit 1; }
done

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
stamp="$(date -u +%Y%m%d-%H%M%S)"
out="$BACKUP_DIR/checksteady-$stamp.dump.age"
tmp="$out.partial"

# Custom format: compressed, restorable table by table, and pg_restore can
# list its contents without touching a database. --no-owner because the
# restore target's role is never called exactly what Render's was.
echo "==> dumping to $out"
pg_dump --format=custom --no-owner --dbname="$DATABASE_URL" \
  | age --recipient "$BACKUP_RECIPIENT" --output "$tmp"
mv "$tmp" "$out"
chmod 600 "$out"
sha256sum "$out" > "$out.sha256"

# Prove the file is a dump and not an empty stream: age cannot be listed
# without the private key, so record the encrypted size instead and refuse a
# suspiciously small one.
size=$(stat -c %s "$out")
if [[ "$size" -lt 4096 ]]; then
  echo "error: $out is only $size bytes — the dump is not credible; keeping it for inspection" >&2
  exit 1
fi
echo "==> $size bytes, sha256 in $out.sha256"

# DPA section 9: backups are deleted no later than 35 days after the data.
deleted=$(find "$BACKUP_DIR" -maxdepth 1 -name 'checksteady-*.dump.age*' -mtime +"$KEEP" -print -delete | wc -l)
echo "==> kept $KEEP days; removed $deleted expired file(s)"
