#!/usr/bin/env bash
# Rebuild a Weft database from nothing: drop its volume, start the stack, run every migration in order,
# seed from data/sample and docs/help, then start the services and wait until the API answers.
#
#   db/reset.sh                        the TEST stack (compose project weft-test, 127.0.0.1 ports). Default.
#   db/reset.sh --live --yes-wipe-live the LIVE stack behind weft.example.org. Destroys real accounts, keys,
#                                      messages and edits. Only when you mean it.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"

target=test
if [ "${1:-}" = "--live" ]; then
  [ "${2:-}" = "--yes-wipe-live" ] || { echo "Refusing: wiping the live database needs --live --yes-wipe-live" >&2; exit 2; }
  target=live
fi

if [ "$target" = live ]; then
  envfile="$repo/stacks/weft/.env"; api=http://127.0.0.1:3100
  DC=(sudo docker compose -p weft-core -f "$repo/stacks/weft/compose.yaml" --env-file "$envfile")
else
  envfile="$repo/stacks/weft-test/.env"; api=http://127.0.0.1:3200
  DC=(sudo docker compose -p weft-test -f "$repo/stacks/weft/compose.yaml" -f "$repo/stacks/weft-test/compose.test.yaml" --env-file "$envfile")
fi
set -a; . "$envfile"; set +a
dc() { "${DC[@]}" "$@"; }
psql_owner() { dc exec -T postgres psql -v ON_ERROR_STOP=1 -q -U weft_owner -d weft "$@"; }

echo "resetting the $target stack"
dc down -v --remove-orphans >/dev/null 2>&1 || true
dc up -d --wait postgres >/dev/null   # PostgREST waits: its login role does not exist yet
for f in "$repo"/db/migrations/*.sql; do
  echo "migrate $(basename "$f")"
  psql_owner -v auth_pw="$AUTHENTICATOR_PASSWORD" -v auth_svc_pw="$AUTH_SVC_PASSWORD" -v notify_svc_pw="$NOTIFY_SVC_PASSWORD" \
    -v assist_svc_pw="$ASSIST_SVC_PASSWORD" -v collab_svc_pw="$COLLAB_SVC_PASSWORD" -f "/weft-db/migrations/$(basename "$f")"
done
echo "seed"
python3 -I "$repo/tools/gen_seed.py" | psql_owner
python3 -I "$repo/tools/sync_wikis.py" | psql_owner >/dev/null   # the help and admin wikis, from docs/help and docs/admin
dc up -d --build postgrest svc assistant collab web >/dev/null
for i in $(seq 1 60); do
  curl -sf -o /dev/null "$api/" -H "Accept: application/openapi+json" && break
  [ "$i" = 60 ] && { echo "PostgREST did not come up"; dc logs postgrest --tail 20; exit 1; }
  sleep 1
done
echo "ready: $target API on $api"
