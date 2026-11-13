#!/usr/bin/env bash
# Restore a Weft from a tools/backup.sh dump. Rebuilds the stack's database first (that creates the
# database roles, which a dump does not carry), then loads the dump over it and restarts the services.
#
#   tools/restore.sh <file.dump> --test                  into the test stack (safe; a good restore drill)
#   tools/restore.sh <file.dump> --yes-replace-live      into the real Weft: everything now in it is replaced
#
# For the real Weft, put the .env saved with that backup at stacks/weft/.env first if this is a new
# machine: its ASSIST_MASTER_KEY is what decrypts the saved model keys.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
. "$repo/tools/docker.sh"
dump="${1:-}"; mode="${2:-}"
[ -f "$dump" ] || { echo "usage: tools/restore.sh <file.dump> --test | --yes-replace-live" >&2; exit 2; }
case "$mode" in
  --test) envfile="$repo/stacks/weft-test/.env"
          DC=("${DOCKER[@]}" compose -p weft-test -f "$repo/stacks/weft/compose.yaml" -f "$repo/stacks/weft-test/compose.test.yaml" --env-file "$envfile")
          [ -f "$envfile" ] || python3 -I "$repo/tools/make_env.py" --test
          "$repo/db/reset.sh" ;;
  --yes-replace-live) envfile="$repo/stacks/weft/.env"
          project=$(sed -n 's/^WEFT_PROJECT=//p' "$envfile" | tail -1)
          DC=("${DOCKER[@]}" compose -p "${project:-weft-core}" -f "$repo/stacks/weft/compose.yaml" --env-file "$envfile")
          "$repo/db/reset.sh" --live --yes-wipe-live ;;
  *) echo "Refusing: say --test, or --yes-replace-live to replace the real Weft" >&2; exit 2 ;;
esac
"${DC[@]}" exec -T postgres pg_restore -U weft_owner -d weft --clean --if-exists --exit-on-error < "$dump"
"${DC[@]}" exec -T postgres psql -qU weft_owner -d weft -c "notify pgrst, 'reload schema'"
"${DC[@]}" restart svc assistant collab >/dev/null
echo "restored $(basename "$dump")"
