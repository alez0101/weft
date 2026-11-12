#!/usr/bin/env bash
# Exit check: rebuild everything from nothing, then run the permission suite (with the teeth
# check) and the live-channel suite. Exit code 0 only if every check passes.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
"$repo/db/reset.sh"
python3 -I "$repo/tests/permissions.py" --teeth
cd "$repo/stacks/weft"
sudo docker compose run --rm --no-deps -T -v "$repo/services/svc/test:/app/test:ro" svc node test/live.mjs
