---
title: Operations
parent: Weft admin
summary: Where Weft runs, deploying, logs, the test stack and backups.
---
### Where it runs

Weft runs on **the Weft server** (192.0.2.10) as the Docker compose project `weft-core`, from `~/work/weft/stacks/weft/compose.yaml`. The homelab host's Cloudflare Tunnel sends `weft.example.org` to the Weft server port 3010, with Cloudflare Access in front.

| Port | What | Reachable from |
| --- | --- | --- |
| 3010 | the app (nginx: web, API, sign-in, live, collab, assistant) | the Weft server and the LAN; the tunnel's target |
| 3011 | the test sign-in door | the Weft server only |
| 3100 | PostgREST directly | the Weft server only |
| 55434 | Postgres | the Weft server only |

Secrets (database passwords, the token secret, the key-encryption master key) are in `stacks/weft/.env` on the Weft server, which is not in git. Never paste them into a wiki page or chat.

### Deploying a change without a reset

1. Apply any new migration: `docker compose -p weft-core ... exec -T postgres psql -U weft_owner -d weft -f /weft-db/migrations/<file>.sql`, then reload the API's schema with `notify pgrst, 'reload schema'`.
2. Rebuild the services that changed: `docker compose -p weft-core ... up -d --build <services>`.
3. Publish the wikis if `docs/help` or `docs/admin` changed: `tools/publish_wikis.sh --live`.
4. Check that real accounts, the assistant key and messages are intact.

Never run `db/reset.sh --live --yes-wipe-live` unless you mean to destroy every real account, key, message and edit.

### Logs

`docker compose -p weft-core -f stacks/weft/compose.yaml --env-file stacks/weft/.env logs <service>`: `svc` names any sign-in failure (audience, issuer or signature); `assistant` notes skipped semantic search or a paused embedder; `collab` notes refused saves.

### The test stack

`tests/run.sh` builds a separate copy (`weft-test`) with its own database, secrets and 127.0.0.1-only ports (3200, 3210, 3211, 55444), runs every suite and removes it. It never touches live. `tests/run.sh --keep` leaves it up for the browser checks.

### Backups

⚠️ No backup of Weft's database is configured (checked 2026-11-12: no cron job or timer on the Weft server). Everything lives in the `weft-core_pg_data` Docker volume on the Weft server. Until a backup exists, a lost volume means lost messages, documents and keys. The repo holds the code, the migrations and the wiki sources, but no content.
