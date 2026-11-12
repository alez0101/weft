#!/usr/bin/env bash
# Rebuild the Weft data layer from nothing: drop the volume, start the stack, run every
# migration in order, seed from data/sample, and make PostgREST reload its schema.
# Destroys all data in the weft-core stack (it is all synthetic).
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
stack="$repo/stacks/weft"
cd "$stack"
set -a; . ./.env; set +a
dc() { sudo docker compose "$@"; }
psql_owner() { dc exec -T postgres psql -v ON_ERROR_STOP=1 -q -U weft_owner -d weft "$@"; }

dc down -v --remove-orphans >/dev/null 2>&1 || true
dc up -d --wait postgres >/dev/null   # PostgREST waits: its login role does not exist yet
for f in "$repo"/db/migrations/*.sql; do
  echo "migrate $(basename "$f")"
  psql_owner -v auth_pw="$AUTHENTICATOR_PASSWORD" -v auth_svc_pw="$AUTH_SVC_PASSWORD" -v notify_svc_pw="$NOTIFY_SVC_PASSWORD" -f "/weft-db/migrations/$(basename "$f")"
done
echo "seed"
python3 -I "$repo/tools/gen_seed.py" | psql_owner
dc up -d --build postgrest svc web >/dev/null
for i in $(seq 1 30); do
  curl -sf -o /dev/null http://127.0.0.1:3100/ -H "Accept: application/openapi+json" && break
  [ "$i" = 30 ] && { echo "PostgREST did not come up"; dc logs postgrest --tail 20; exit 1; }
  sleep 1
done
echo "ready: PostgREST on http://127.0.0.1:3100"
