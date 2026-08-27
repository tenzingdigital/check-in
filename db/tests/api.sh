#!/usr/bin/env bash
#
# The HTTP suite: build a throwaway cluster with the real schema, boot the
# service against it, and drive it over HTTP the way a browser does.
#
#   ./db/tests/api.sh
#
# The SQL suite next door proves the database refuses what it should refuse.
# This one proves the web tier that replaced PostgREST and GoTrue does not
# offer a way around it. Requires the postgresql server binaries and Node 22+.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

# shellcheck source=cluster.sh
source "$HERE/cluster.sh"
start_cluster

echo "==> running HTTP suite"
# The cookie is Secure in production, which a plain-http test client would
# never send back. This is the one place that flag is turned off.
HUT_ALLOW_INSECURE_COOKIE=1 DATABASE_URL="$DATABASE_URL" node "$REPO/server/test.js"
