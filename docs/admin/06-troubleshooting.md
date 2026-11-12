---
title: Troubleshooting
parent: Weft admin
summary: Known problems and what fixes them.
---
### Someone cannot sign in

- "That email and password do not match": a wrong password, or no account yet. Make them a reset or invite link.
- "Too many attempts": eight wrong passwords for that email (or 30 attempts from that address) in 15 minutes. Wait, or make them a reset link.
- "This link has expired or was already used": make a new one. Links last three days and work once.
- Weft says the account is disabled: an admin disabled it; **Enable** it in Settings.
- Every admin is locked out: on the server, `python3 -I tools/weft_admin.py link <email> --reset --url <address>`.
- With Cloudflare Access: check the `svc` log. A wrong audience means the Access app's AUD tag changed; update `ACCESS_AUD` in `.env` and restart `svc`.

### The API is down after a restart

PostgREST must start after the database's roles exist. If it started first, Docker's restart backoff can leave it stopped: start it again with `up -d postgrest`.

### The assistant answers "no model is available"

Both slots are off, out of their monthly cap or failing. Open **Settings**, press **Test connection** on each slot, and check the monthly spend. The fallback slot's address is in Settings; if that server is down, only the primary answers.

### The assistant misses things it should find

- In a channel it only reads that channel. Ask in your own Weft conversation to search everything you can open.
- Meaning search needs an Ollama server with `nomic-embed-text` at `EMBED_URL`. If it is unset or down, keyword search still answers, and the `assistant` log says so.

### A document shows the same text twice, or edits do not reach others

Both come from the editor being created in the browser before it synced (see the technical specification, live updates and co-editing). The app waits for the first sync; anything that writes documents directly must add blocks inside the single root block group.

### A wiki page cannot be edited

Published pages are read-only. Change the file in the repo and publish (see Publishing the wikis).
