#!/usr/bin/env bash
#
# Shared scaffolding: bring up a throwaway PostgreSQL cluster with the real
# schema applied, and tear it down on exit.
#
# Sourced by run.sh (the SQL acceptance suite) and by api.sh (the HTTP suite).
# It exists so the two cannot drift about how the database under test is built
# — they must be testing the same thing for either result to mean anything.
#
# Defines: start_cluster
# Exports: PGHOST, PGPORT, PGUSER, DATABASE_URL, WORK
#
# Requires the postgresql server binaries (Debian/Ubuntu: postgresql-16).

PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"

# Everything cleanup() touches is deliberately a global. It runs from an EXIT
# trap, long after start_cluster has returned, so anything scoped to that
# function would be empty by then — which silently turns `su "$RUNAS" -c
# 'pg_ctl stop'` into `su -c 'pg_ctl stop'`, i.e. a no-op as root, and leaves
# a cluster holding the port so the next run cannot start.
WORK=""
RUNAS=""

cluster_available() {
  [[ -x "$PGBIN/initdb" ]] || command -v initdb >/dev/null 2>&1
}

as_pg() {
  if [[ -n "$RUNAS" ]]; then su "$RUNAS" -c "$1"; else bash -c "$1"; fi
}

cleanup_cluster() {
  [[ -n "$WORK" ]] || return 0
  as_pg "'$PGBIN/pg_ctl' -D '$WORK/data' -m immediate stop" >/dev/null 2>&1 || true
  rm -rf "$WORK"
  WORK=""
}
trap cleanup_cluster EXIT

start_cluster() {
  if [[ ! -x "$PGBIN/initdb" ]]; then
    echo "error: could not find PostgreSQL server binaries." >&2
    echo "       set PGBIN=/path/to/postgresql/bin, or install postgresql-16." >&2
    exit 1
  fi

  local port="${PGPORT_TEST:-54329}"

  # initdb refuses to run as root, which is the normal case inside a container.
  # Fall back to an unprivileged account and run only the server commands as
  # it; psql still connects as root over the trust-auth socket.
  if [[ $EUID -eq 0 ]]; then
    RUNAS="${RUNAS_USER:-pgtest}"
    id "$RUNAS" >/dev/null 2>&1 || useradd -m "$RUNAS"
    # The data directory must sit somewhere $RUNAS can traverse, so use its
    # home rather than a mktemp path under /tmp with restrictive parents.
    WORK="$(su "$RUNAS" -c 'mktemp -d -p "$HOME"')"
  else
    WORK="$(mktemp -d)"
  fi

  echo "==> initialising scratch cluster in $WORK"
  as_pg "'$PGBIN/initdb' -D '$WORK/data' -U postgres --auth=trust" >"$WORK/initdb.log" 2>&1
  if ! as_pg "'$PGBIN/pg_ctl' -D '$WORK/data' -o '-p $port -k $WORK' -l '$WORK/pg.log' -w start" >/dev/null; then
    echo "error: the scratch cluster did not start. Last lines of its log:" >&2
    tail -5 "$WORK/pg.log" >&2 || true
    echo "       if the port is in use, a previous run leaked a cluster:" >&2
    echo "       pkill -f 'postgres .*-p $port'" >&2
    exit 1
  fi

  export PGHOST="$WORK" PGPORT="$port" PGUSER=postgres
  psql -q -c "create database hut;"

  # The socket directory is a path, so it has to go in the host parameter for
  # the node client to reach the same cluster psql is using.
  export DATABASE_URL="postgresql://postgres@localhost/hut?host=$WORK"

  # Both suites apply the schema through the real migration runner rather than
  # piping the SQL files into psql themselves. That is deliberate: it means the
  # runner — ordering, the transaction per file, the tracking table — is
  # exercised on every test run, instead of being the one piece of the deploy
  # path that nothing covers.
  if [[ ! -d "$REPO/server/node_modules" ]]; then
    echo "==> installing server dependencies"
    (cd "$REPO/server" && { npm ci --omit=dev >/dev/null 2>&1 || npm install --omit=dev >/dev/null; })
  fi

  echo "==> applying migrations"
  DATABASE_URL="$DATABASE_URL" node "$REPO/server/migrate.js"
}
