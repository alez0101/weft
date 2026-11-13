---
title: Data and permissions
parent: Technical specification
summary: Schemas, roles, the one rule, the channel-scope claim, audit and migrations.
---
### Schemas

- `weft`: what the API exposes. Users, spaces, members, messages, items (documents, wiki pages, whiteboards, tables, files), events, table columns and rows, file bytes (`file_blobs`), embeddings, audit, read markers and each person's Home layout (`user_prefs`, readable only by them).
- `weft_private`: helpers, provider settings and keys, personal keys (`personal_providers`, encrypted, readable only by the assistant service), run logs, assistant proposals, embedding state, the admin log, and sign-in (password hashes, link and session hashes). Not exposed.

### Spaces: the permission unit

Everything belongs to one **space**: a channel, a direct message, a personal space or a Weft conversation. You see something only if you are a member of its space. Roles in a space: **viewer** (read and chat), **editor** (also create and change content), **owner** (also manage the space and its people). Sharing an item into another channel posts a link only; it grants nothing.

Two kinds of channel are kept by Weft itself: the help channel (`everyone`: every account is a viewer) and this admin channel (`admins_only`: exactly the active admins). Neither can be renamed or deleted from the app, and the admin channel's members cannot be changed by hand.

### The one rule

`weft_private.member_role(space)` returns your role in a space, or nothing. Every policy builds on it (`is_member`, `can_edit`, `is_owner`). It reads the token's user, applies the optional `scope_space` claim (so a channel-scoped token sees only that channel), and returns nothing for a disabled account.

### Database roles

- `authenticator`: PostgREST's login; can only switch roles.
- `weft_anon`: nothing at all.
- `weft_user`: every person.
- `weft_assistant`: the assistant acting for a person. Reads what they can, posts as Weft, changes and creates events. Never deletes, never edits documents.
- Service logins, each allowed one narrow job: `weft_auth` (sign-in), `weft_notify` (memberships for live notices), `weft_assist` (assistant settings and embeddings), `weft_collab` (switches to `weft_user` only).

### Details that matter

- Column grants keep authorship honest: `author_id` and `created_by` cannot be written; they default to the token's user. Other people's last sign-in is not readable.
- Moving an item needs edit rights in both spaces. Thread replies and wiki parents must be in the same space.
- Audit triggers keep the old row of every change and delete, with who did it, readable only by members of that space.
- A table's rows also become a text summary on the table, so search and the assistant can read them.
- Search is one function, `weft.search`, run as the caller: prefix matching on every word, titles ranked above text, snippets with the matches marked, over messages, items, events and channel names, with text indexes behind it. Only letters and digits from the search reach the query.
- Published wiki pages are `managed` and read-only in the app.
- A file is an item whose `body_text` is its extracted text; its bytes are in `file_blobs`, readable only through the item (same rule) and never changed in place. The assistant role reads the text, never the bytes. The collab server refuses to open files and tables as documents.

### Migrations

`db/migrations/001` to `021` rebuild the database from nothing, in order: roles, schema, access rules, triggers, chat reads, notices, service logins, assistant, collab, proposals, assistant events, everyone spaces, whiteboards, tables, semantic search, people, wikis, accounts, files and widgets, personal keys, search.
