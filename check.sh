#!/usr/bin/env bash
#
# One command that checks everything. Run this before you deploy.
#
#   ./check.sh
#
# Four layers, cheapest first, so it fails fast:
#   1. Deploy configs agree about security headers across both hosts
#   2. Both front ends and the shared JS parse
#   3. The database suite — authorisation model and calendar-day compliance
#   4. The same suite again on plain PostgreSQL, via supabase/portable-auth.sql
#
# Layer 4 is what keeps the exit route open. The portable shim is not the
# deployed path today, so nothing else would notice it rotting; by the time it
# mattered — mid-migration — it would be too late to find out.
#
# Layers 3 and 4 need the PostgreSQL server binaries (Debian/Ubuntu:
# postgresql-16). If they are missing both are skipped with a warning rather
# than a failure, so the first two layers still give you something on a machine
# without Postgres.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

fail=0
step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

step "Deploy configs (vercel.json vs render.yaml)"
python3 scripts/check-deploy-headers.py || fail=1

step "Front ends parse"
node -e "
const fs=require('fs'),vm=require('vm');
for (const f of ['public/index.html','public/checkin.html']) {
  const h=fs.readFileSync(f,'utf8');
  [...h.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .forEach((m,i)=>new vm.Script(m[1],{filename:f+':'+i}));
}
new vm.Script(fs.readFileSync('public/app-common.js','utf8'));
JSON.parse(fs.readFileSync('vercel.json','utf8'));
console.log('public/index.html, public/checkin.html, public/app-common.js parse; vercel.json valid');
" || fail=1

suite() {   # suite <log> [flag...]
  local log="$1"; shift
  ./supabase/tests/run.sh "$@" >"$log" 2>&1
  if [ $? -eq 0 ]; then
    printf 'PASS — %s assertions\n' "$(grep -cE 'NOTICE:.* ok ' "$log")"
    grep -E '^   ALLOWED' "$log" && { echo "FAIL: privilege escalation"; fail=1; }
  else
    echo "FAIL — full output in $log"
    tail -20 "$log"
    fail=1
  fi
}

if ls -d /usr/lib/postgresql/*/bin >/dev/null 2>&1 || command -v initdb >/dev/null 2>&1; then
  step "Database suite (Supabase)"
  suite /tmp/hut-check-suite.log

  step "Database suite (plain PostgreSQL, via supabase/portable-auth.sql)"
  suite /tmp/hut-check-portable.log --portable
else
  step "Database suite"
  echo "SKIPPED — PostgreSQL server binaries not found (install postgresql-16)"
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "All checks passed."
else
  echo "CHECKS FAILED — see above." >&2
fi
exit "$fail"
