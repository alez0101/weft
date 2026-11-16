# Weft

A small, self-hosted collaboration suite in one browser tab. Apps open as tabs from an iPad-like home
screen, next to a Teams-like chat rail, and an AI assistant answers only from what the person asking is
allowed to see, with links to where each answer came from.

**What's in it**

- **Write and plan:** documents, a wiki, whiteboards, spreadsheets (formulas, charts, Excel and CSV files, edited together), tables, meeting notes (decisions go to a decision log in one press), decisions, a glossary
- **Organise work:** task lists with repeating tasks, comments and boards, checklists, goals with key results (typed, or counted from a task list), retrospectives (starting from the last one's actions), a timeline
- **Coordinate people:** a calendar with repeating events and RSVPs, bookings of shared things (weekly, skipping the weeks that clash), shift sign-ups (a day or a week copied on in one go), time off (with "away then" notes where people are picked),
  contacts, profiles (who knows what: find people by skill or by channel; recent kudos on each card)
- **Ask and decide together:** polls and forms (that can close by themselves at a set time), Q and A, ideas boards (planned ideas become tasks, declined ones say why), announcements (with a Got it button and a count of who has seen them), kudos
- **Keep track:** files, link lists, shared expenses with who owes whom (pay-backs recorded in one press), an inventory with check out and
  check in (with back-by dates, overdue in red), a private journal
- **Around it all:** chat, search across everything, Home widgets, plain downloads (CSV, .ics, vCard) made in the browser, and a connector for AI apps (MCP)
- **Projects:** a channel (or your personal space) holds projects, each with its own chat, instructions for the assistant and pinned documents; the assistant follows Weft's rules, then the channel's, then the project's, then each person's own

One rule decides who sees what (you see something only if you are a member of its space), and
Postgres enforces it with row-level security on every path: the API, live updates, co-editing,
search and the assistant. Outside AI agents (connected apps and personal agents) read what their person can see, except
channels closed to them, and the database lets them change things only in that person's personal space. More than 1,500 automated checks prove it, including that restricted content
never reaches the model for someone who cannot see it.

Status: a working prototype for small teams. Not hardened for large or hostile multi-tenant use.

## What's inside

| | |
| --- | --- |
| Data and permissions | Postgres 17 with pgvector, row-level security, PostgREST |
| Sign-in | Weft accounts (passwords, invite links), or Cloudflare Access |
| Co-editing | Hocuspocus and Yjs; BlockNote documents, Excalidraw whiteboards |
| Tables and calendar | AG Grid Community, FullCalendar |
| Spreadsheets (optional) | OnlyOffice Docs Community (AGPL v3), run unmodified from its official image as its own container; about 600 MB of memory |
| Files | stored in Postgres; text read from PDF (pdf.js), Word (mammoth) and text files |
| Assistant | Claude through the Anthropic API, with an optional Ollama fallback, meaning search, optional personal keys, and personal agents (someone's own OpenAI-compatible agent, such as Hermes Agent, with its own conversations) |
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
tests/run.sh          # builds a separate test stack, runs nine suites (2378 checks), removes it
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
