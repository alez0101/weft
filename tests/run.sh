#!/usr/bin/env bash
# Exit check: rebuild everything from nothing, then run the permission suite (with the teeth
# check) and the live-channel suite. Exit code 0 only if every check passes.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
"$repo/db/reset.sh"
python3 -I "$repo/tests/permissions.py" --teeth
cd "$repo/stacks/weft"
sudo docker compose run --rm --no-deps -T -v "$repo/services/svc/test:/app/test:ro" svc node test/live.mjs
sudo docker compose run --rm --no-deps -T --name weft-assist-test -v "$repo/services/assistant/test:/app/test:ro" assistant node test/assistant.mjs
sudo docker compose run --rm --no-deps -T -v "$repo/services/collab/test:/app/test:ro" collab node test/collab.mjs
# The suites change data and provider settings; leave a clean database behind.
"$repo/db/reset.sh" >/dev/null
echo "clean database restored"
