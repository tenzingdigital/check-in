#!/usr/bin/env bash
#
# Restore rehearsal: prove a backup can actually be restored, on a throwaway
# cluster, without touching anything live. Quarterly (ISO 27001 8.13), and
# record the date and result in docs/procedures/BACKUP-AND-RESTORE.md.
#
#   BACKUP_KEY=~/.config/checksteady/backup-key.txt \
#     ./tools/restore-rehearsal.sh backups/checksteady-20260904-030000.dump.age
#
# What it does:
#   1. decrypts the file with your age private key (never written to disk
#      unencrypted — it is piped straight into pg_restore);
#   2. builds the same scratch PostgreSQL cluster the test suites use, but with
#      an EMPTY database rather than one with migrations applied;
#   3. restores into it, then asks the questions that matter: how many
#      residents, how many days of register, when the register was last
#      closed, and whether every migration on disk is in the backup;
#   4. boots the service against the restored database and checks /healthz.
#
# A plain, unencrypted .dump (as pg_dump --format=custom writes) is accepted
# too, so a Render-side export can be rehearsed the same way.
#
# Needs the postgresql-16 server binaries, age, and Node 22 — the same as
# ./check.sh plus age.

set -euo pipefail

FILE="${1:?usage: restore-rehearsal.sh <backup file>}"
[[ -r "$FILE" ]] || { echo "error: cannot read $FILE" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
cd "$REPO"

# shellcheck source=../test/cluster.sh
source "$REPO/test/cluster.sh"

# start_cluster applies the migrations to the "hut" database; the rehearsal
# needs an empty one, so it restores into a second database on the same
# scratch cluster. Restoring on top of applied migrations would only tell you
# that two copies of the schema collide.
start_cluster
PGUSER=postgres psql -q -d postgres -c "create database rehearsal owner hutapp;"
RESTORE_URL="postgresql://hutapp@localhost/rehearsal?host=$WORK"

echo "==> restoring $FILE"
if [[ "$FILE" == *.age ]]; then
  : "${BACKUP_KEY:?set BACKUP_KEY to the path of the age private key}"
  age --decrypt --identity "$BACKUP_KEY" "$FILE" \
    | pg_restore --no-owner --dbname="$RESTORE_URL" --exit-on-error
else
  pg_restore --no-owner --dbname="$RESTORE_URL" --exit-on-error "$FILE"
fi

echo "==> what came back"
psql -X -q -d "$RESTORE_URL" <<'SQL'
select
  (select count(*) from public.residents)                                   as residents,
  (select count(*) from public.residents where status = 'active')           as active,
  (select count(*) from public.daily_compliance)                            as register_rows,
  (select max(compliance_date) from public.daily_compliance where closed_at is not null) as last_closed_day,
  (select count(*) from public.profiles where active)                       as active_staff,
  (select count(*) from public.schema_migrations)                           as migrations_applied;
SQL

# Every migration file on disk should be in the backup. A backup older than
# the newest migration is still restorable — server.js applies the rest at
# boot — but say so, because that is a different situation from "current".
on_disk=$(ls migrations/*.sql | wc -l)
in_backup=$(psql -X -qtA -d "$RESTORE_URL" -c "select count(*) from public.schema_migrations")
if [[ "$on_disk" -ne "$in_backup" ]]; then
  echo "note: $in_backup migrations in the backup, $on_disk on disk — the service will apply the rest on boot"
fi

echo "==> booting the service against the restored database"
PORT="${PORT_REHEARSAL:-3131}"
HUT_ALLOW_INSECURE_COOKIE=1 DATABASE_URL="$RESTORE_URL" PORT="$PORT" node server.js >"$WORK/server.log" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true; cleanup_cluster' EXIT
ok=0
for _ in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null; then ok=1; break; fi
  sleep 0.5
done
if [[ $ok -eq 1 ]]; then
  echo "RESTORE OK — $(date -u +%Y-%m-%d) — $FILE"
  echo "Record this line in docs/procedures/BACKUP-AND-RESTORE.md."
else
  echo "RESTORE FAILED: the service did not become healthy. Last lines of its log:" >&2
  tail -20 "$WORK/server.log" >&2
  exit 1
fi
