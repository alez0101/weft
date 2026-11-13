---
title: Operations
parent: Weft admin
summary: Where Weft runs, deploying, logs, the test stack and backups.
---
### Where it runs

Weft is one Docker compose project, `weft-core`, from `stacks/weft/compose.yaml` in the repo. Settings and secrets are in `stacks/weft/.env` next to it, which is never in git (`tools/make_env.py` creates it; `.env.example` explains every setting). Never paste its contents into a wiki page or chat.

| Port | What | Reachable from |
| --- | --- | --- |
| `WEFT_BIND`:`WEFT_PORT` (default 127.0.0.1:3010) | the app: web, API, sign-in, live, collab, assistant | as configured; put HTTPS in front of it |
| 127.0.0.1:3011 | the test sign-in door | the server only |
| 127.0.0.1:3100 | PostgREST directly | the server only |
| 127.0.0.1:55434 | Postgres | the server only |

Weft speaks plain HTTP. On the internet, put it behind something that adds HTTPS (a reverse proxy or a tunnel); session cookies are marked secure and need it.

The page **This instance**, if your admins wrote one under the Weft admin page, says where this particular Weft runs.

### Deploying a change without a reset

1. Apply any new migration: `docker compose -p weft-core ... exec -T postgres psql -U weft_owner -d weft -f /weft-db/migrations/<file>.sql`, then reload the API's schema with `notify pgrst, 'reload schema'`.
2. Rebuild the services that changed: `docker compose -p weft-core ... up -d --build <services>`.
3. Publish the wikis if `docs/help` or `docs/admin` changed: `tools/publish_wikis.sh --live`.
4. Check that real accounts, the assistant key and messages are intact.

Never run `db/reset.sh --live --yes-wipe-live` unless you mean to destroy every real account, key, message and edit.

### Logs

`docker compose -p weft-core -f stacks/weft/compose.yaml --env-file stacks/weft/.env logs <service>`: `svc` logs sign-in lockouts, password resets and any Cloudflare verification failure; `assistant` notes skipped meaning search or a paused embedder; `collab` notes refused saves.

### The test stack

`tests/run.sh` builds a separate copy (`weft-test`) with its own database, secrets and 127.0.0.1-only ports (3200, 3210, 3211, 55444), runs every suite and removes it. It never touches live. `tests/run.sh --keep` leaves it up for the browser checks.

### Backups

Files are stored in the database, so backups include them and grow with them. Weft does not back itself up on its own: schedule `tools/backup.sh` (cron or a systemd timer, nightly). Each run saves a compressed dump of the database and a copy of `stacks/weft/.env` (its `ASSIST_MASTER_KEY` decrypts the saved model keys), checks that the dump can be read and holds the core tables, keeps 14 days, and exits non-zero on any failure so the scheduler can alert you. Settings: `BACKUP_DIR` (default `~/weft-backups`), `BACKUP_KEEP_DAYS`, and `BACKUP_COPY_TO` (`host:directory`) for a second copy on another machine, which is what protects you if the server's disk dies.

The backups hold everything people wrote, so keep them as private as the server.

### Restoring

    tools/restore.sh <file.dump> --test               a drill: restore into the test stack and look around
    tools/restore.sh <file.dump> --yes-replace-live   replace the real Weft with the backup

On a new machine, first put the `.env` saved with that backup at `stacks/weft/.env`. Restoring rebuilds the database (which creates the database roles a dump does not carry), loads the dump and restarts the services. Run the drill now and then: a backup only counts once it has been restored.

### Removing the sample data

If Weft was created with `--sample` and real people now use it, `python3 -I tools/remove_sample.py | docker compose -p weft-core ... exec -T postgres psql -U weft_owner -d weft` removes the four sample accounts and their channels, direct messages and everything in them, and hands anything they made elsewhere to the first real admin. It refuses unless a real admin exists. Back up first.
