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
| svc | `services/svc` (Node) | sign-in (Cloudflare Access to a Weft token) and live notices over websockets |
| assistant | `services/assistant` (Node, Anthropic SDK) | answers, proposals, provider settings, the embedding worker |
| collab | `services/collab` (Hocuspocus 4.8, Yjs 13) | live co-editing of documents, wiki pages and whiteboards |
| web | `services/web` (nginx, React 19, Vite) | the app, and the one entry point for everything above |

### A request

1. The browser asks `/auth/session`. svc checks Cloudflare's `Cf-Access-Jwt-Assertion` (team `yourteam.cloudflareaccess.com`, the Weft app's AUD tag), creates the account on first sign-in, and returns a Weft token (HS256, 15 minutes, renewed before it expires).
2. Every API call sends that token to PostgREST at `/api/`. PostgREST switches to the database role in the token (`weft_user`), and row-level security decides every row.
3. The browser keeps one websocket at `/live`. svc listens to Postgres notices and forwards each one only to members of its space. A notice carries the table, operation, id and space, never content; the browser fetches the row through the API, so the database still decides.
4. Documents open a second websocket at `/collab`. The collab server checks and loads each document as the person, through row-level security.
5. Questions go to `/assistant/ask`. The assistant reads and searches with a short-lived token minted for the asker, so it can never see more than they can.

### Front doors

- **3010**: the public app, the tunnel's target. The test sign-in returns 404 here.
- **3011**: test sign-in for the `@example.com` accounts, the Weft server only.

### Libraries

BlockNote 0.57 (documents and wiki), Excalidraw 0.18 with Weft's own Yjs binding (whiteboards), AG Grid Community 36 (tables), FullCalendar 7 (calendar), `@anthropic-ai/sdk` (Claude). All open source under MIT, MPL-2.0 or PostgreSQL licences; none of BlockNote's GPL or commercial packages are used.
