#!/usr/bin/env bash
#
# Regenerate migrations/tenant-template.sql from the real schema.
#
#   ./tools/gen-tenant-template.sh
#
# Builds a throwaway cluster, applies every migration to it, dumps `public`,
# and filters out the shared objects. Run it after any migration that changes
# a per-tenant table, view or function. The HTTP suite fails if you forget:
# it provisions a schema from the template and diffs it against public.
#
# Requires the postgresql server binaries, same as the test suites.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
cd "$REPO"

# shellcheck source=../test/cluster.sh
source "$REPO/test/cluster.sh"
start_cluster

OUT="$REPO/tenant/template.sql"
pg_dump --schema-only --no-owner --no-comments -n public -d hut \
  | node "$HERE/tenant-template.js" > "$OUT"

echo "==> wrote $OUT ($(wc -l < "$OUT") lines)"
