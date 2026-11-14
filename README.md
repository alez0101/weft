# Weft

A small, self-hosted collaboration suite in one browser tab: chat, documents, a wiki, whiteboards,
tables, task lists and boards, polls, forms, link lists, meeting notes, announcements, bookings of shared things (rooms, vans), shift sign-ups, files and a calendar with RSVPs, opened as tabs from an iPad-like home screen, with a Teams-like chat rail and an
AI assistant that answers only from what the person asking is allowed to see, with links to where
each answer came from.

One rule decides who sees what (you see something only if you are a member of its space), and
Postgres enforces it with row-level security on every path: the API, live updates, co-editing,
search and the assistant. Over 450 automated checks prove it, including that restricted content
never reaches the model for someone who cannot see it.

Status: a working prototype for small teams. Not hardened for large or hostile multi-tenant use.

## What's inside

| | |
| --- | --- |
| Data and permissions | Postgres 17 with pgvector, row-level security, PostgREST |
| Sign-in | Weft accounts (passwords, invite links), or Cloudflare Access |
| Co-editing | Hocuspocus and Yjs; BlockNote documents, Excalidraw whiteboards |
| Tables and calendar | AG Grid Community, FullCalendar |
| Files | stored in Postgres; text read from PDF (pdf.js), Word (mammoth) and text files |
| Assistant | Claude through the Anthropic API, with an optional Ollama fallback, meaning search, and optional personal keys |
| AI apps | an MCP connector at `/mcp` with its own OAuth sign-in, so Claude and other apps work in Weft as the person who connected them |
| App | React and Vite, served by nginx |

Everything runs with Docker Compose. Weft's own docs are inside the app: a help wiki for everyone and
an admin wiki with the technical specification, both written in `docs/help` and `docs/admin`.

## Quick start

You need Docker with Compose, and Python 3 (for the setup scripts).

```sh
git clone <this repo> weft && cd weft
python3 -I tools/make_env.py --admin you@example.org     # creates stacks/weft/.env with fresh secrets
db/reset.sh --live --yes-wipe-live                       # builds and starts Weft on an empty database
python3 -I tools/weft_admin.py link you@example.org      # prints your invite link
```

Open the link (it points at http://localhost:3010), choose a password, and you are Weft's first admin.
From **Settings** you can invite people and add your Anthropic API key for the assistant.

`db/reset.sh --live --yes-wipe-live` wipes the database. Use it only to create Weft, or when you mean
to throw everything away. After that, start and stop with
`docker compose -p weft-core -f stacks/weft/compose.yaml --env-file stacks/weft/.env up -d` (or `down`).

### Try it with sample data

Add `--sample` to the reset (`db/reset.sh --live --yes-wipe-live --sample`) to also load a small
invented festival dataset with four sample accounts. They sign in without a password at
http://localhost:3011, which only answers on the machine itself. Leave it out for a real install.

### Reaching it from other machines

Weft listens on 127.0.0.1 by default. Set `WEFT_BIND=0.0.0.0` in `stacks/weft/.env` to open it to
your network, and put HTTPS in front of it (a reverse proxy or a tunnel) before exposing it to the
internet. `stacks/weft/.env.example` lists every setting: the port, sign-in methods, Cloudflare Access,
session length, and an Ollama server for meaning search.

### Backups

Schedule `tools/backup.sh` nightly (it can also copy each backup to another machine), and practise
`tools/restore.sh <dump> --test` now and then. If you created Weft with `--sample`,
`tools/remove_sample.py` removes the sample data once real people use it. The admin wiki's
Operations page has the details.

## Tests

```sh
tests/run.sh          # builds a separate test stack, runs seven suites (795 checks), removes it
tests/run.sh --keep   # leaves the test stack up for the browser checks in tests/*.cjs
```

The test stack has its own database, secrets and ports, so it never touches a running Weft. The
assistant suite uses stand-ins for the model and the embedder, so tests make no paid API calls.

## Layout

- `stacks/weft` - the Compose stack; `stacks/weft-test` - the test stack's overrides
- `services/` - `svc` (sign-in, live), `assistant`, `collab`, `web`
- `db/migrations` - the whole database, rebuilt in order from nothing
- `docs/help`, `docs/admin` - the wikis published into Weft (`tools/publish_wikis.sh`)
- `docs/adding-an-app.md` - how a new app is built so it keeps the permission promise
- `docs/history` - notes from each build phase
- `data/sample`, `tools/gen_seed.py` - the invented sample data
- `tests/` - the suites and browser checks

## License

MIT. See `LICENSE`.
