#!/usr/bin/env bash
#
# Drive the offline path in a real browser. Optional — see offline.e2e.test.js.
#
#   ./test/e2e.sh
#
# Builds the same throwaway cluster the other suites use, seeds one guard and
# the demo residents, boots the service on a spare port, and runs the
# Playwright script against it. Needs `npm install --no-save playwright` and
# a Chromium it can find (PLAYWRIGHT_BROWSERS_PATH, or the default download).

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
cd "$REPO"

if ! node -e "require.resolve('playwright')" >/dev/null 2>&1; then
  echo "playwright is not installed. Run:  npm install --no-save playwright" >&2
  exit 2
fi

# shellcheck source=cluster.sh
source "$HERE/cluster.sh"
start_cluster

DATABASE_URL="$DATABASE_URL" node -e "
const db=require('./database'); const fs=require('fs');
db.withOwner(async c=>{
  await c.query('select auth.create_user(\$1,\$2,\$3,\$4)',['gina@hut.example','correct-horse-battery','Gina Guard','guard']);
  await c.query(fs.readFileSync('seed.sql','utf8'));
}).then(()=>db.closePool());
"

PORT="${PORT_E2E:-3111}"
HUT_ALLOW_INSECURE_COOKIE=1 DATABASE_URL="$DATABASE_URL" PORT="$PORT" node server.js >"$WORK/server.log" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true; cleanup_cluster' EXIT

for _ in $(seq 1 40); do
  curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null && break
  sleep 0.5
done

echo "==> running browser suite"
BASE="http://127.0.0.1:$PORT" node "$HERE/offline.e2e.test.js"
