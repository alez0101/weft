---
title: Live updates and co-editing
parent: Technical specification
summary: Notices over websockets, the collab server, and the traps in BlockNote.
---
### Live notices (svc)

Database triggers send `NOTIFY weft_events` with `{t, op, id, space}` on messages, items, events, members, table rows and tasks. svc forwards each notice only to sockets of members of that space, refreshes a person's memberships when theirs change, closes sockets whose token has expired, and closes a disabled account's sockets at once (code 4003).

### Co-editing (collab)

A document's name is its item id; the browser sends its Weft token.

- On connect it looks the item up as the person: not a member, refused; viewer, read-only on the server; editor or owner, read-write. Published wiki pages are read-only for everyone.
- A document with no saved state gets its starting blocks built on the server, from its Markdown text.
- Saves happen 2 to 10 seconds after a change, as the last person who changed it, through row-level security, and extract the text for search and the assistant.
- It closes sessions when someone is removed from the space, changes role, is disabled, when a document is deleted or moved where they cannot follow, and when a published page changes.
- Whiteboards use the same server with a Yjs map of Excalidraw elements; the text on a board is extracted on save.

### Traps (read before changing the editor)

1. BlockNote 0.57 ignores a bare `collaboration` option: wrap the options in `withCollaboration()` from `@blocknote/core/yjs`, or the editor quietly edits a private copy.
2. Never let a browser create the starting block. If two browsers each add one before syncing, the document gets two root groups. The app waits for the first sync.
3. `@blocknote/server-util` needs a DOM (jsdom), and `y-prosemirror` must be installed explicitly.
4. A reopened page must start from a fresh copy: reconnecting an old in-browser copy merges it into the server's.
