#!/usr/bin/env bash
# Phase 2 exit check: rebuild the data layer from nothing, then run the whole permission suite,
# including the teeth check. Exit code 0 only if every check passes.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
"$repo/db/reset.sh"
python3 -I "$repo/tests/permissions.py" --teeth
