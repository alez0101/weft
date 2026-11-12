# Phase 1b: AFFiNE baseline

Started 2026-11-12 after the Colanode baseline was dropped (verdict: a navigable workspace portal,
not the launch-a-tool suite the owner has in mind, and a poor backend for an agent; see
`phase-1-colanode.md`). Stack: `stacks/affine/` (AFFiNE CE 0.27.4, pgvector/pg16, Redis 7.4).

## Access

`https://weft.example.org` (same Cloudflare Access app as before), one tunnel rule ->
`http://192.0.2.10:3010`. First visit goes to `/admin/setup` to create the administrator.
Postgres is on `127.0.0.1:55433` for inspection only.

## Setup notes

- The migration job writes `config/private.key` on first run, so the config mount cannot be read-only.
  The key is git-ignored and chmod 600.
- Upstream compose uses Postgres `trust` auth and the floating `:stable` tag; this stack uses a password
  (`.env`, git-ignored) and pins `0.27.4`.
- Idle memory: about 210 MB for the whole stack.
- **License:** frontend MIT; backend under AFFiNE's Enterprise Edition license with a carve-out for
  what ships as Community Edition. Self-hosting CE and testing are fine; running a *modified* backend
  in production needs a subscription. That limits "extend AFFiNE" as a path for Weft.
- Built in: an AI assistant (Copilot) with bring-your-own-key for OpenAI, Anthropic, Gemini; off by
  default (`copilot.enabled`). A search indexer is enabled.

## What to score

1. Does it feel like the suite: click a button, get a document, wiki page or whiteboard?
2. Can an agent read (and safely write) its content from outside the app? Look at its API and how
   docs are stored in Postgres.
3. Does access control go below the workspace level?
