# Phase 4: Documents and Wiki

Built 2026-11-12. BlockNote documents and wiki pages, co-edited live through Hocuspocus, saved in
Postgres under row-level security. `tests/run.sh` now runs four suites from a clean rebuild
(95 permission, 18 live, 26 assistant, 17 collab checks); `tests/docs-browser.cjs` is the two-browser
check. All pass.

## How it fits together

- **collab** service (`services/collab`, Hocuspocus 4.8 + Yjs 13, on `/collab` through nginx). A
  document's name is its item id; the client sends its Weft token.
  - `onAuthenticate` looks the item up *as the person* (role `weft_user` with their claims inside a
    transaction), so RLS decides: not a member of its space, refused; viewer, read-only on the server;
    editor or owner, read-write.
  - `onLoadDocument` loads the Yjs state the same way. A document with no Yjs state yet gets its
    starting blocks built on the server (text-only documents are converted from Markdown; new ones get
    one empty paragraph). Never in a browser: see gotchas.
  - `onStoreDocument` (2 s debounce, at most 10 s) saves as the last person who changed it, through RLS,
    and extracts the text as Markdown into `body_text` for search and the assistant.
  - Listens for membership changes and closes the sessions of anyone removed from a space (and on role
    changes, so the reconnect re-reads the role). Expired tokens are closed too.
  - DB login `weft_collab` is NOINHERIT and can only switch to `weft_user`.
- **Web**: Documents and Wiki tabs share one component (list grouped by space; the wiki nests pages under
  their parent). New items go into a space you can edit (default: personal). Titles rename through the
  API. "Share to a channel" posts a `weft://item/<id>` link; it grants nothing, and people outside the
  document's space get a "You don't have access" page.
- **Audit** (`009_collab`): item audit rows drop the Yjs blob, skip saves that changed nothing a person
  would see, and keep one old value per person per two minutes, so live editing doesn't flood the log.

## Gotchas found (worth knowing before touching this again)

1. **BlockNote 0.57 ignores a bare `collaboration` option.** Wrap the options in `withCollaboration()`
   from `@blocknote/core/yjs` (Yjs 13; `@blocknote/core/y` is the newer Yjs). Without it the editor runs
   on a private document: it says "Editing live", frames flow, and nobody sees anybody's edits.
2. **Never let a browser create the starting block.** If an editor mounts before the first sync it
   inserts its own empty block group; merged with the server's, the document has two root groups and each
   browser renders a different one. The web waits for `synced` before creating the editor, and the server
   seeds every new document.
3. **`@blocknote/server-util` needs a DOM**: `ServerBlockNoteEditor.create(undefined, getDocument())` with
   `getDocument` from `@blocknote/server-util/dom` (jsdom).
4. **`y-prosemirror` is a peer dependency** of `@blocknote/core` and must be installed explicitly.
5. A BlockNote document is one root `blockGroup` holding `blockContainer`s. Anything that writes Yjs
   directly must add blocks inside that group; a second root group is ignored when reading.

## Not done yet

- Deleting documents and pages from the UI.
- Moving a document between spaces from the UI (the API and RLS already allow it within your spaces).
- The assistant reading documents: Phase 6 (the text is already extracted into `body_text`).
