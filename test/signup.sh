#!/usr/bin/env bash
#
# The self-serve trial suite: build a throwaway cluster with the real schema,
# boot the service against it, and drive a sign-up the way a browser does —
# form post, email, link, provisioning, password, sign-in.
#
#   ./test/signup.sh
#
# Separate from test/api.sh because it provisions tenant schemas as it goes and
# leaves a very different database behind; running it in the same process as
# the HTTP suite would make both harder to read when one fails.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

# shellcheck source=cluster.sh
source "$HERE/cluster.sh"
start_cluster

echo "==> running self-serve trial suite"
HUT_ALLOW_INSECURE_COOKIE=1 DATABASE_URL="$DATABASE_URL" node "$REPO/test/signup.test.js"
