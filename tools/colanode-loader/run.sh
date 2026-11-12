#!/usr/bin/env bash
# Load the synthetic dataset into the local Colanode stack.
# Needs a Colanode v0.4.7 checkout with deps installed (see README). Run once on a fresh stack:
# it registers accounts, so a second run fails with "email already exists".
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
COLANODE_SRC="${COLANODE_SRC:-$HOME/src/colanode}"
mkdir -p "$COLANODE_SRC/scripts/src/weft"
cp "$here/load.ts" "$COLANODE_SRC/scripts/src/weft/load.ts"
cd "$COLANODE_SRC/scripts"
DATA_DIR="$repo/data/sample" ACCOUNTS_FILE="$repo/stacks/colanode/test-accounts.txt" \
  npx -y tsx src/weft/load.ts
