# Phase 1: Colanode baseline

**Status: dropped 2026-11-12.** The owner signed in and found it a navigable portal rather than the
launch-a-tool suite they have in mind; also a poor agent backend (opaque JSONB, CRDT-only writes,
per-space permissions, stalled upstream). Stack stopped and volumes removed; files kept for reference.
Succeeded by `phase-1b-affine.md`.

Started 2026-11-12 on the Weft server. Stack: `stacks/colanode/` (Colanode 0.4.7, pgvector/pg17, Valkey 8.1).
Data: synthetic set loaded by `tools/colanode-loader/run.sh`. Test logins: `stacks/colanode/test-accounts.txt`
(git-ignored).

## Setup notes and gotchas

- **Every port is bound to 127.0.0.1.** Docker-published ports bypass ufw, so `0.0.0.0` would expose
  Postgres to the LAN whatever the firewall says. Postgres is on host port 55432 for inspection only.
- **The web client needs a secure context** (it stores its local SQLite copy in browser OPFS). Plain
  `http://<lan-ip>:4000` will not work; `http://localhost` or HTTPS will.
- The console warning about missing COOP/COEP headers is harmless: the client uses SQLite's SAH-pool
  VFS, which does not need them.
- **"Add a server" wants the config URL**, `http://localhost:3000/config`, not the base URL.
- The web client shows a "mobile not supported" screen, so phones are out for the web build.
- Upstream's seed script is stale against 0.4.7: register is `POST /client/v1/auth/email/register`,
  workspace update is `PATCH`, and invites take `{users: [{email, role}]}`.
- Building the loader: Ubuntu's npm 9.2 is too old for the monorepo; use `npx -y npm@10 install
  --ignore-scripts --include-workspace-root -w @colanode/scripts -w @colanode/core -w @colanode/crdt`
  in a v0.4.7 checkout (`~/src/colanode`). The loader runs once per fresh stack (it registers accounts);
  reset with `docker compose down -v`.
- Resource use at idle: about 120 MB RAM for the whole stack.

## Access for the week of use

`https://weft.example.org` through a Cloudflare tunnel on another host, behind Cloudflare Access (added 2026-11-12).
Tunnel rules: `^/(config|client)(/|$)` -> `http://192.0.2.10:3000`, everything else ->
`http://192.0.2.10:4000`, on one hostname so the Access cookie covers the API and websockets too.
Web and server are therefore also bound to the server's LAN IP (Postgres is not), and sign-ups are set
to manual approval. In the app, add the server as `https://weft.example.org/config`.
Temporary: remove both tunnel rules and the CNAME when Phase 1 ends (backup and undo notes in the
cloudflared notes on the tunnel host).

## The four questions

1. **Does access control reach individual pages, databases or records?** No. Only spaces (and direct
   chats) carry collaborator lists, with roles admin / editor / collaborator / viewer, inherited down
   the tree. Permissions are per space. Verified in the UI 2026-11-12: Pat Public sees only Festival,
   Vic Volunteer sees Festival + Volunteers, Alex sees all three; Host contacts never appear for Pat or Vic.
   This matches Weft's planned "one coarse predicate: space membership" rule exactly.
2. **Is the same record one object across table, board and calendar views?** Yes: views are separate
   `database_view` nodes over the same `record` nodes. Table and board verified; calendar view loads
   but was not yet inspected on April 2027.
3. **How usable is the web client?** Pending a week of real use. Early notes: clean Notion-like UI,
   relations render as linked titles, select fields as colored chips. The **date field is date-only**, so
   time slots are invisible except in record names, which is a real gap for a schedule.
4. **What do its tables look like in Postgres?** One generic `nodes` table: every space, database,
   view, record, channel and message is a row with a `type` and a JSONB `attributes` blob. Record field
   values are keyed by opaque field IDs, so SQL against it needs the database node to decode field
   names. Access lives in `collaborations` (node_id, collaborator_id, role) on the space. Rich content
   and edit history are in `documents` / `document_updates` / `node_updates` (Yjs CRDT updates).
   Embedding tables (`node_embeddings`, `document_embeddings`, pgvector) exist for AI search.

## Other findings

- **Project activity:** last commit and release (v0.4.7) were 2026-04-03, about seven months before
  this test. Treat it as a reference design, not a dependency to build on.
- **Cross-space relations work** for users who can read both spaces (Vic's shifts show Festival porch
  names). Not yet tested: a user who can read the source space but not the target.
