#!/usr/bin/env bash
#
# Spin up a throwaway PostgreSQL cluster, apply schema.sql against a stubbed
# Supabase auth surface, and run the acceptance suite.
#
# This exists because the security model of this app lives almost entirely in
# row-level security policies, and RLS fails quietly: a policy that blocks too
# much returns zero rows rather than an error, and a policy that blocks too
# little returns data nobody notices. Both are invisible in the browser.
#
#   ./supabase/tests/run.sh
#
# Requires the postgresql server binaries (Debian/Ubuntu: postgresql-16).
# Nothing here touches a real Supabase project.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
if [[ ! -x "$PGBIN/initdb" ]]; then
  echo "error: could not find PostgreSQL server binaries." >&2
  echo "       set PGBIN=/path/to/postgresql/bin, or install postgresql-16." >&2
  exit 1
fi

PORT="${PGPORT_TEST:-54329}"

# initdb refuses to run as root, which is the normal case inside a container.
# Fall back to an unprivileged account and run only the server commands as it;
# psql still connects as root over the trust-auth socket.
if [[ $EUID -eq 0 ]]; then
  RUNAS="${RUNAS_USER:-pgtest}"
  id "$RUNAS" >/dev/null 2>&1 || useradd -m "$RUNAS"
  # The data directory must sit somewhere $RUNAS can traverse, so use its home
  # rather than a mktemp path under /tmp that may have restrictive parents.
  WORK="$(su "$RUNAS" -c 'mktemp -d -p "$HOME"')"
  as_pg() { su "$RUNAS" -c "$1"; }
else
  WORK="$(mktemp -d)"
  as_pg() { bash -c "$1"; }
fi

cleanup() {
  as_pg "'$PGBIN/pg_ctl' -D '$WORK/data' -m immediate stop" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "==> initialising scratch cluster in $WORK"
as_pg "'$PGBIN/initdb' -D '$WORK/data' -U postgres --auth=trust" >"$WORK/initdb.log" 2>&1
as_pg "'$PGBIN/pg_ctl' -D '$WORK/data' -o '-p $PORT -k $WORK' -l '$WORK/pg.log' -w start" >/dev/null

export PGHOST="$WORK" PGPORT="$PORT" PGUSER=postgres
psql -q -c "create database hut;"

echo "==> applying the Supabase stub (auth.users, auth.uid, role grants)"
psql -q -v ON_ERROR_STOP=1 -d hut -f "$HERE/00_supabase_stub.sql"

echo "==> applying schema.sql"
psql -q -v ON_ERROR_STOP=1 -d hut -f "$REPO/supabase/schema.sql"

echo "==> running acceptance suite"
psql -q -v ON_ERROR_STOP=1 \
     -v seed_path="$REPO/supabase/seed.sql" \
     -d hut -f "$HERE/01_acceptance.sql" | tee "$WORK/out.txt"

echo "==> running compliance suite"
psql -q -v ON_ERROR_STOP=1 \
     -d hut -f "$HERE/02_compliance.sql" | tee -a "$WORK/out.txt"

echo
echo "==> authorisation summary"
grep -E "^   (blocked|no-op|ALLOWED)" "$WORK/out.txt" || true

# Any ALLOWED line in the authorisation section is a privilege escalation.
if grep -qE "^   ALLOWED" "$WORK/out.txt"; then
  echo
  echo "FAIL: an operation that should have been denied was allowed." >&2
  exit 1
fi

echo
echo "PASS: every privileged operation was denied to the roles that should not have it."
