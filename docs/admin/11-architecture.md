---
title: Architecture
parent: Technical specification
summary: The services, how a request flows, and the two front doors.
---
### Services (Docker compose project `weft-core`)

| Service | Built from | What it does |
| --- | --- | --- |
| postgres | `pgvector/pgvector:0.8.7-pg17` | all data, row-level security, LISTEN/NOTIFY, vectors |
| postgrest | `postgrest/postgrest:v16.5` | the API, generated from the `weft` schema |
| svc | `services/svc` (Node) | sign-in (Weft accounts, optionally Cloudflare Access) and live notices over websockets |
| assistant | `services/assistant` (Node, Anthropic SDK) | answers, proposals, provider settings, the embedding worker |
| collab | `services/collab` (Hocuspocus 4.8, Yjs 13) | live co-editing of documents, wiki pages and whiteboards |
| files | `services/files` (Node, pdf.js, mammoth) | uploads, text extraction from PDF, Word and text files, downloads, all as the person |
| mcp | `services/mcp` (Node, MCP SDK) | the connector for AI apps: MCP tools at `/mcp` and its own OAuth sign-in, acting as the person |
| web | `services/web` (nginx, React 19, Vite) | the app, and the one entry point for everything above |

### A request

1. The browser signs in at `/auth/`: with an email and password, an invite or reset link, or (if configured) Cloudflare Access's signed header. svc returns a Weft token (HS256, 15 minutes) and, for Weft accounts, sets a session cookie that renews the token before it expires.
2. Every API call sends that token to PostgREST at `/api/`. PostgREST switches to the database role in the token (`weft_user`), and row-level security decides every row.
3. The browser keeps one websocket at `/live`. svc listens to Postgres notices and forwards each one only to members of its space. A notice carries the table, operation, id and space, never content (task and board-column notices add the list's id, poll notices the poll's, form notices the form's, link notices the list's); the browser fetches the row through the API, so the database still decides.
4. Documents open a second websocket at `/collab`. The collab server checks and loads each document as the person, through row-level security.
5. Files go to `/files` (upload, at most `FILE_MAX_MB`, default 25) and come back from `/files/<id>`; the files service does every database step as the person, so row-level security decides. The type is read from the bytes, not trusted from the name, and anything that could run scripts (HTML, SVG, unknown types) always downloads rather than opening.
6. The search box calls `weft.search` through the API (word matches, as the person) and `/assistant/search/related` (matches by meaning, with the person's own token).
7. Questions go to `/assistant/ask`. The assistant reads and searches with a short-lived token minted for the asker, so it can never see more than they can.
8. AI apps (Claude, for one) call `/mcp` with an OAuth token from `/oauth/token`. The connector turns it into a five-minute Weft token for the person who approved the app and calls the API, the meaning search and, for page edits, the collab server's internal edit port (1235, never routed by nginx), so the database decides here too. See **Connector for AI apps**.

### Front doors

- **The app port** (`WEFT_BIND`:`WEFT_PORT`): everything people use. The test sign-in returns 404 here.
- **127.0.0.1:3011**: test sign-in for the `@example.com` accounts, from the server only.

### Libraries

BlockNote 0.57 (documents and wiki), Excalidraw 0.18 with Weft's own Yjs binding (whiteboards), AG Grid Community 36 (tables), FullCalendar 7 (calendar, including tasks due, bookings and time off), plain React (task lists, boards with native drag and drop, polls, forms, link lists, address books, decision logs, Q and A boards, checklists, expense lists, inventories, announcements, meetings, RSVPs, bookings, shifts, time off, profiles), `@anthropic-ai/sdk` (Claude), `@modelcontextprotocol/sdk` (the connector). All open source under MIT, MPL-2.0 or PostgreSQL licences; none of BlockNote's GPL or commercial packages are used.
