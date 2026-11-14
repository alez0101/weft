# Testing

**Tests never touch the live stack.** Everything runs against `weft-test`: a separate compose project
built from the same code (`stacks/weft/compose.yaml` plus `stacks/weft-test/compose.test.yaml`), with its
own database volume, its own secrets (`stacks/weft-test/.env`, git-ignored) and its own ports, all on
127.0.0.1:

| | live (`weft-core`) | test (`weft-test`) |
| --- | --- | --- |
| Postgres | 127.0.0.1:55434 | 127.0.0.1:55444 |
| PostgREST | 127.0.0.1:3100 | 127.0.0.1:3200 |
| Web, the app | `WEFT_BIND`:`WEFT_PORT` (default 127.0.0.1:3010) | 127.0.0.1:3210 |
| Web, test sign-in | 127.0.0.1:3011 | 127.0.0.1:3211 |

## Commands

    tests/run.sh            rebuild the test stack, run all seven suites (1576 checks); makes the test .env on first run, remove the test stack
    tests/run.sh --keep     same, but leave the test stack up (for the browser checks)
    db/reset.sh             rebuild the test stack's database only
    db/reset.sh --live --yes-wipe-live   rebuild the LIVE database: destroys real accounts, keys and edits

Browser checks (`tests/*-browser.cjs`, `tests/two-browsers.cjs`) need Playwright (run them from a folder
where `npm install playwright` was done) and target the test stack's 3211 by default; set `WEFT_BASE` to point elsewhere.
`tools/mint_token.py` signs with the test stack's secret unless `WEFT_ENV_FILE` names another .env.

## Suites

- `tests/permissions.py`: row-level security, every user, table and action, accounts, channels, the wikis, search, tasks, polls, forms, links, announcements, boards, meetings, RSVPs, bookings, shifts, contacts, profiles, decisions, Q and A, checklists, expenses, inventory, time off, goals, retros, glossary, ideas, kudos, journal, timeline, plus the teeth check (1244).
- `services/svc/test/live.mjs`: live notices reach members only (25).
- `services/svc/test/accounts.mjs`: Weft accounts: links, passwords, lockouts, sessions (43).
- `services/assistant/test/assistant.mjs`: retrieval scoping, citations, settings, failover, proposals, meaning search, files, personal keys, search by meaning, glossaries, ideas boards (116).
- `services/collab/test/collab.mjs`: co-editing access and live saves (47).
- `services/files/test/files.mjs`: uploads, downloads, text extraction, safe types (30).
- `services/mcp/test/mcp.mjs`: the connector for AI apps: OAuth sign-in, permissions through the tools, writes, revoking (68).
