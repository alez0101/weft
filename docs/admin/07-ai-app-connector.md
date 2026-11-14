---
title: Connector for AI apps
parent: Weft admin
summary: Claude and other MCP apps at /mcp: how they sign in, what they can do, the settings, and what to check.
---
Weft is an **MCP server** at `<your address>/mcp`, so Claude (and any app that speaks the Model Context Protocol) can be added as a connector. People connect it themselves from the help page **Using Weft from Claude and other AI apps**; admins do not need to switch anything on.

### How it signs in

The app uses OAuth 2.1 with Weft as its own authorization server: it registers itself (dynamic client registration), sends the person to `/oauth/authorize` (Weft's app, which signs them in and shows a consent screen naming the app and where the answer goes), and trades the one-time code, with PKCE, for tokens. The person chooses **read only** or **read and write**. The app never sees a password or a Weft token.

- Access tokens last an hour; refresh tokens last 30 days and change on every use. If a used refresh token is presented again, that connection ends (someone copied it).
- Approving the same app again replaces its older connection.
- People see and disconnect their own apps under **Connected apps** in the account menu.
- Disabling an account stops its connections at once; enabling it again restores them.
- Codes, tokens and client secrets are stored only as hashes.

### What it can do

Every tool call runs as the person, through the API, so row-level security decides exactly as in the app. Reading tools: who am I, list channels, read messages, search (by words or by meaning), list items, read an item (documents, wiki pages, whiteboard text, table rows, tasks, poll results, file text), list events, list tasks. A **read and write** connection adds: post a message, create a document, wiki page or task list from Markdown, edit a document or wiki page (append or replace, through live co-editing, so people with it open see the change), add and change events, add tasks and tick them off. Nothing deletes, and nothing manages channels, people or settings. A read-only connection's API calls are GET only, whatever it asks for.

### Settings (in `stacks/weft/.env`)

| Setting | What it does |
| --- | --- |
| `WEFT_PUBLIC_URL` | The address people use (for example `https://weft.example.org`). Set it whenever Weft is behind a proxy or tunnel; apps check that the addresses in the sign-in documents match. |
| `MCP_REDIRECT_HOSTS` | Hosts an app may send approvals back to. Default `claude.ai,claude.com`. Loopback addresses (`localhost`, `127.0.0.1`) are always allowed, for desktop and command-line apps. Anyone can register an app, so this list is what stops a look-alike website from collecting approvals. Add a host only for an app you trust. |
| `MCP_SVC_PASSWORD` | The connector's database login (made by `tools/make_env.py`). |

### What to check

- The app must reach `/mcp`, `/oauth/` and `/.well-known/` from the internet. If something in front of Weft (Cloudflare Access, for example) asks for its own sign-in, the app cannot connect.
- `docker compose -p weft-core ... logs mcp` shows registrations, approvals and refused refresh tokens (never tokens or content).
- To end every connection at once, for every person: `update weft_private.mcp_grants set revoked_at = now() where revoked_at is null;` as `weft_owner`.
