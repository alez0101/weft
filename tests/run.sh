#!/usr/bin/env bash
# Exit check, against the TEST stack only (compose project weft-test, its own database, secrets and
# 127.0.0.1 ports). A live Weft on the same machine is never touched.
# Rebuilds the test stack from nothing, runs the permission suite (with the teeth check), the
# live-channel, assistant and collab suites, then tears the test stack down. --keep leaves it up.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
. "$repo/tools/docker.sh"
DC=("${DOCKER[@]}" compose -p weft-test -f "$repo/stacks/weft/compose.yaml" -f "$repo/stacks/weft-test/compose.test.yaml" --env-file "$repo/stacks/weft-test/.env")
[ -f "$repo/stacks/weft-test/.env" ] || python3 -I "$repo/tools/make_env.py" --test   # first run: test secrets
"$repo/db/reset.sh"
python3 -I "$repo/tests/permissions.py" --teeth
"${DC[@]}" run --rm --no-deps -T -v "$repo/services/svc/test:/app/test:ro" svc node test/live.mjs
"${DC[@]}" run --rm --no-deps -T -v "$repo/services/svc/test:/app/test:ro" svc node test/accounts.mjs
"${DC[@]}" run --rm --no-deps -T --name weft-assist-test -v "$repo/services/assistant/test:/app/test:ro" assistant node test/assistant.mjs
"${DC[@]}" run --rm --no-deps -T -v "$repo/services/collab/test:/app/test:ro" collab node test/collab.mjs
"${DC[@]}" run --rm --no-deps -T --name weft-files-test -v "$repo/services/files/test:/app/test:ro" files node test/files.mjs
if [ "${1:-}" != "--keep" ]; then "${DC[@]}" down -v >/dev/null 2>&1; echo "test stack removed"; fi
