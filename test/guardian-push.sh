#!/usr/bin/env bash
#
# Guardian gap alerts: a throwaway cluster with the real schema, the September
# incident replayed, and the push service stubbed at the web-push boundary.
#
#   ./test/guardian-push.sh

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
# shellcheck source=cluster.sh
source "$HERE/cluster.sh"
start_cluster
echo "==> running guardian gap alert suite"
DATABASE_URL="$DATABASE_URL" node "$REPO/test/guardian-push.test.js"
