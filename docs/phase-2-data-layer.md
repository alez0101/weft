# Phase 2: data layer and permissions

Done 2026-11-12. One rule, enforced by Postgres row-level security: you see an item only if you
are a member of its space. Exit check: `tests/run.sh` (rebuild from nothing, then 88 checks,
including the teeth check). It passed on a fresh rebuild.

## Run it

    tests/run.sh                         # rebuild + full suite (destroys all data; it is synthetic)
    db/reset.sh                          # rebuild only
    python3 -I tests/permissions.py      # suite only (after a reset: the write tests change data)
    python3 -I tools/mint_token.py u-pub [--assistant] [--scope festival]   # a test token

Stack `stacks/weft/` (project `weft-core`): Postgres 17 + pgvector 0.8.7 on `127.0.0.1:55434`,
PostgREST v16.5 on `127.0.0.1:3100`. Neither is reachable from the LAN or the tunnel. Secrets in
`stacks/weft/.env` (git-ignored).

## Design

- **Schemas:** `weft` (the only one PostgREST exposes: users, spaces, members, messages, items,
  events, audit) and `weft_private` (helpers, not exposed).
- **Roles:** `authenticator` (PostgREST's login, can only switch roles), `weft_anon` (nothing),
  `weft_user` (every person; the user is the token's `sub`), `weft_assistant` (the assistant acting
  for `sub`; may read, post messages as Weft, and change events; never delete, never edit documents).
- **One function decides:** `weft_private.member_role(space)` returns your role in a space, or
  nothing; it also applies the optional `scope_space` claim, so a channel-scoped token sees only
  that channel with no extra policy code. `is_member`, `can_edit` (owner/editor) and `is_owner`
  build on it.
- **Roles in a space:** viewer reads and chats; editor also creates and changes documents, wiki pages
  and events; owner also manages the space and its members.
- **Authorship can't be forged:** column-level grants leave `author_id` / `created_by` out of what
  `weft_user` may write; they default to the token's user.
- **Moving items:** an update must pass the edit check in both the old and the new space, so an
  item can't be moved into a space you are not in. Thread replies and wiki parents must be in the
  same space.
- **Audit:** triggers keep the old row on every update and delete of messages, items and events,
  with the actor and role. Readable only by members of the space the row belonged to; nobody can
  write or delete audit rows through the API. The space is copied, not joined, because a deleted
  row has nothing left to join to.
- **Spaces:** creating a channel makes you its owner (trigger). Personal spaces are created by the
  seed only and can't be deleted.

## What the suite covers

Every user (Alex owner, Olive editor, Vic, Pat) against every table for reads, with explicit
filters into spaces they are not in; writes allowed and refused by role; forged authors; thread
replies across spaces; moving documents into other spaces; updates and deletes of invisible rows
(verified unchanged in the database afterwards); adding members; the assistant (no delete, no
document edits, posts only as Weft, sees only what the user sees); scoped tokens; the audit log;
missing, wrongly signed and expired tokens. The teeth check adds a permissive policy, confirms
Pat would then see Host contacts, and removes it.

## Gotcha found

PostgREST must start after the migrations: started first, its login fails (the role doesn't exist
yet) and Docker's restart backoff leaves it down. `db/reset.sh` starts Postgres alone, migrates and
seeds, then starts PostgREST and waits until it answers.
