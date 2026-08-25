#!/usr/bin/env bash
#
# One command that checks everything. Run this before you deploy.
#
#   ./check.sh
#
# Three layers, cheapest first, so it fails fast:
#   1. Every JavaScript file parses — the two front ends and the service
#   2. The database suite — authorisation model and calendar-day compliance
#   3. The HTTP suite — the web tier that replaced PostgREST and GoTrue
#
# Layers 2 and 3 need the PostgreSQL server binaries (Debian/Ubuntu:
# postgresql-16). If they are missing both are skipped with a warning rather
# than a failure, so layer 1 still gives you something on a machine without
# Postgres.
#
# The old first layer compared vercel.json against render.yaml, because the
# security headers were declared twice and could drift. There is one copy now
# — server/index.js — and layer 3 asserts the running server actually sends
# it, which is a stronger check than two files agreeing with each other.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

fail=0
step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

step "JavaScript parses"
node -e "
const fs=require('fs'),vm=require('vm');
for (const f of ['public/index.html','public/checkin.html']) {
  const h=fs.readFileSync(f,'utf8');
  const inline=[...h.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  if (!inline.length) throw new Error(f+' has no inline script — the CSP hashes would be empty');
  inline.forEach((m,i)=>new vm.Script(m[1],{filename:f+':'+i}));
  // The CSP allows script-src 'self' and a list of hashes, nothing else. A
  // <script src> pointing off-origin would be blocked in the browser but
  // would look fine here, so catch it now rather than at the hut.
  for (const m of h.matchAll(/<script[^>]*\bsrc=[\"']([^\"']+)[\"']/g)) {
    if (/^https?:|^\/\//.test(m[1])) throw new Error(f+' loads '+m[1]+' from a third-party origin');
  }
}
new vm.Script(fs.readFileSync('public/app-common.js','utf8'));
console.log('front ends parse and load nothing from a CDN');
" || fail=1

# node --check understands ESM from the file extension and the package type,
# which vm.Script does not.
for f in server/*.js; do
  node --check "$f" || { echo "FAIL: $f does not parse"; fail=1; }
done
[ "$fail" -eq 0 ] && echo "server/*.js parse"

if ls -d /usr/lib/postgresql/*/bin >/dev/null 2>&1 || command -v initdb >/dev/null 2>&1; then
  step "Database suite"
  ./db/tests/run.sh >/tmp/hut-check-suite.log 2>&1
  if [ $? -eq 0 ]; then
    printf 'PASS — %s assertions\n' "$(grep -cE 'NOTICE:.* ok ' /tmp/hut-check-suite.log)"
    grep -E '^   ALLOWED' /tmp/hut-check-suite.log && { echo "FAIL: privilege escalation"; fail=1; }
  else
    echo "FAIL — full output in /tmp/hut-check-suite.log"
    tail -20 /tmp/hut-check-suite.log
    fail=1
  fi

  step "HTTP suite"
  ./db/tests/api.sh >/tmp/hut-check-api.log 2>&1
  if [ $? -eq 0 ]; then
    tail -1 /tmp/hut-check-api.log
  else
    echo "FAIL — full output in /tmp/hut-check-api.log"
    tail -20 /tmp/hut-check-api.log
    fail=1
  fi
else
  step "Database and HTTP suites"
  echo "SKIPPED — PostgreSQL server binaries not found (install postgresql-16)"
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "All checks passed."
else
  echo "CHECKS FAILED — see above." >&2
fi
exit "$fail"
