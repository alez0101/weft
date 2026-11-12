---
title: Troubleshooting
parent: Weft admin
summary: Known problems and what fixes them.
---
### Someone cannot sign in

- Cloudflare's page never lets them through: their email is not in the Access policy.
- Weft says the account is disabled: an admin disabled it; **Enable** it in Settings.
- Weft says the Cloudflare session was not accepted: check the `svc` log. Wrong audience means the Access app's AUD tag changed; update `ACCESS_AUD` in the environment file and restart `svc`.

### The API is down after a restart

PostgREST must start after the database's roles exist. If it started first, Docker's restart backoff can leave it stopped: start it again with `up -d postgrest`.

### The assistant answers "no model is available"

Both slots are off, out of their monthly cap or failing. Open **Settings**, press **Test connection** on each slot, and check the monthly spend. The fallback runs on the homelab host's Ollama at `192.0.2.20:11434`; if the homelab host is down, only the primary answers.

### The assistant misses things it should find

- In a channel it only reads that channel. Ask in your own Weft conversation to search everything you can open.
- Meaning search needs the homelab host's Ollama (`nomic-embed-text`). If it is down, keyword search still answers, and the `assistant` log says embedding is paused.

### A document shows the same text twice, or edits do not reach others

Both come from the editor being created in the browser before it synced (see the technical specification, live updates and co-editing). The app waits for the first sync; anything that writes documents directly must add blocks inside the single root block group.

### A wiki page cannot be edited

Published pages are read-only. Change the file in the repo and publish (see Publishing the wikis).
