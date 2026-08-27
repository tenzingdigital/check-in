#!/usr/bin/env bash
#
# Spin up a throwaway PostgreSQL cluster, apply the migrations, and run the
# acceptance suite.
#
# This exists because the security model of this app lives almost entirely in
# row-level security policies, and RLS fails quietly: a policy that blocks too
# much returns zero rows rather than an error, and a policy that blocks too
# little returns data nobody notices. Both are invisible in the browser.
#
#   ./test/sql.sh
#
# Requires the postgresql server binaries (Debian/Ubuntu: postgresql-16).
# Nothing here touches the deployed database.
#
# Note that the cluster this builds is the production schema, not an
# approximation of it: the same migration runner Render boots with applies the
# same numbered files. When this suite says a guard cannot read a date of
# birth, it is saying it about the real auth.uid() and the real role grants.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

# shellcheck source=cluster.sh
source "$HERE/cluster.sh"
start_cluster

echo "==> running acceptance suite"
psql -q -v ON_ERROR_STOP=1 \
     -v seed_path="$REPO/seed.sql" \
     -d hut -f "$HERE/acceptance.sql" | tee "$WORK/out.txt"

echo "==> running compliance suite"
psql -q -v ON_ERROR_STOP=1 \
     -d hut -f "$HERE/compliance.sql" | tee -a "$WORK/out.txt"

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
