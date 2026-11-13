---
title: Testing
parent: Technical specification
summary: The four suites, what they prove, and the browser checks.
---
`tests/run.sh` rebuilds the separate test stack from nothing, runs six suites and removes it. On 2026-11-13 it passed 439 checks.

| Suite | Checks | What it proves |
| --- | --- | --- |
| Permissions (`tests/permissions.py`) | 201 | every person against every table and action, the tricky cases, accounts and channels, sub-pages and replies, the wikis and publishing, widget layouts and file bytes, search, and a teeth check that a loosened policy is caught |
| Live (`services/svc/test/live.mjs`) | 25 | notices reach members only, carry no content, follow membership changes; bad, expired and disabled tokens get nothing |
| Accounts (`services/svc/test/accounts.mjs`) | 43 | links are admin-only, single-use and expire; passwords, lockouts, session rotation and replay, sign-out, password changes, disabled accounts |
| Assistant (`services/assistant/test/assistant.mjs`) | 108 | with a stand-in model that records every prompt: restricted content never reaches the model for someone who cannot see it, failover, proposals, meaning search, files, personal keys (which key each call used), search by meaning |
| Collab (`services/collab/test/collab.mjs`) | 32 | refusals, read-only viewers, live co-editing, sessions closed on losing access |
| Files (`services/files/test/files.mjs`) | 30 | who may upload and download, text from PDF / Word / text, types read from the bytes, risky types never open in place, size limits, deleting |

The assistant suite uses stand-ins for both the model and the embedder, so tests never call Anthropic or any real model server.

Browser checks (`tests/*-browser.cjs`, `tests/two-browsers.cjs`) drive real browsers against the test stack (`tests/run.sh --keep`): chat, documents, the calendar, proposals, whiteboards, tables, people, the wikis, signing in, files and widgets (`tests/files-widgets-browser.cjs`), search (`tests/search-browser.cjs`) (`tests/accounts-browser.cjs`, on the public door at 3210). Run them from a folder where Playwright is installed (`npm install playwright`).
