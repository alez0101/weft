#!/usr/bin/env bash
# Publish docs/help and docs/admin into Weft's wikis (see tools/sync_wikis.py) and say what changed.
#   tools/publish_wikis.sh          the TEST stack
#   tools/publish_wikis.sh --live   the live Weft behind weft.example.org (safe: only repo-managed pages change)
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
if [ "${1:-}" = "--live" ]; then
  DC=(sudo docker compose -p weft-core -f "$repo/stacks/weft/compose.yaml" --env-file "$repo/stacks/weft/.env"); where=live
else
  DC=(sudo docker compose -p weft-test -f "$repo/stacks/weft/compose.yaml" -f "$repo/stacks/weft-test/compose.test.yaml" --env-file "$repo/stacks/weft-test/.env"); where=test
fi
changes=$(python3 -I "$repo/tools/sync_wikis.py" | "${DC[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -q -At -U weft_owner -d weft \
  | grep -E '^(created|updated|removed): ' | sed 's/|$//' || true)
echo "wikis published to $where: ${changes:+$'\n'}${changes:-no changes}"
