---
title: Testing
parent: Technical specification
summary: The four suites, what they prove, and the browser checks.
---
`tests/run.sh` rebuilds the separate test stack from nothing, runs five suites and removes it. On 2026-11-12 it passed 353 checks.

| Suite | Checks | What it proves |
| --- | --- | --- |
| Permissions (`tests/permissions.py`) | 180 | every person against every table and action, the tricky cases, accounts and channels, sub-pages and replies, the wikis and publishing, and a teeth check that a loosened policy is caught |
| Live (`services/svc/test/live.mjs`) | 25 | notices reach members only, carry no content, follow membership changes; bad, expired and disabled tokens get nothing |
| Accounts (`services/svc/test/accounts.mjs`) | 43 | links are admin-only, single-use and expire; passwords, lockouts, session rotation and replay, sign-out, password changes, disabled accounts |
| Assistant (`services/assistant/test/assistant.mjs`) | 74 | with a stand-in model that records every prompt: restricted content never reaches the model for someone who cannot see it, failover, proposals, meaning search |
| Collab (`services/collab/test/collab.mjs`) | 31 | refusals, read-only viewers, live co-editing, sessions closed on losing access |

The assistant suite uses stand-ins for both the model and the embedder, so tests never call Anthropic or any real model server.

Browser checks (`tests/*-browser.cjs`, `tests/two-browsers.cjs`) drive real browsers against the test stack (`tests/run.sh --keep`): chat, documents, the calendar, proposals, whiteboards, tables, people, the wikis and signing in (`tests/accounts-browser.cjs`, on the public door at 3210). Run them from a folder where Playwright is installed (`npm install playwright`).
