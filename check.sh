#!/usr/bin/env bash
#
# One command that checks everything. Run this before you deploy.
#
#   ./check.sh
#
# Three layers, cheapest first, so it fails fast:
#   1. Deploy configs agree about security headers across both hosts
#   2. Both front ends and the shared JS parse
#   3. The database suite — authorisation model and calendar-day compliance
#
# Layer 3 needs the PostgreSQL server binaries (Debian/Ubuntu: postgresql-16).
# If they are missing it is skipped with a warning rather than a failure, so
# the first two layers still give you something on a machine without Postgres.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

fail=0
step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

step "Deploy configs (vercel.json vs render.yaml)"
python3 scripts/check-deploy-headers.py || fail=1

step "Front ends parse"
node -e "
const fs=require('fs'),vm=require('vm');
for (const f of ['index.html','checkin.html']) {
  const h=fs.readFileSync(f,'utf8');
  [...h.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .forEach((m,i)=>new vm.Script(m[1],{filename:f+':'+i}));
}
new vm.Script(fs.readFileSync('app-common.js','utf8'));
JSON.parse(fs.readFileSync('vercel.json','utf8'));
console.log('index.html, checkin.html, app-common.js parse; vercel.json valid');
" || fail=1

step "Database suite"
if ls -d /usr/lib/postgresql/*/bin >/dev/null 2>&1 || command -v initdb >/dev/null 2>&1; then
  ./supabase/tests/run.sh >/tmp/hut-check-suite.log 2>&1
  if [ $? -eq 0 ]; then
    printf 'PASS — %s assertions\n' "$(grep -cE 'NOTICE:.* ok ' /tmp/hut-check-suite.log)"
    grep -E '^   ALLOWED' /tmp/hut-check-suite.log && { echo "FAIL: privilege escalation"; fail=1; }
  else
    echo "FAIL — full output in /tmp/hut-check-suite.log"
    tail -20 /tmp/hut-check-suite.log
    fail=1
  fi
else
  echo "SKIPPED — PostgreSQL server binaries not found (install postgresql-16)"
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "All checks passed."
else
  echo "CHECKS FAILED — see above." >&2
fi
exit "$fail"
