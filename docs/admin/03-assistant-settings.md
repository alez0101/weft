---
title: Assistant settings
parent: Weft admin
summary: Primary and fallback models, keys, monthly caps and personal keys.
---
Admins see a **Settings** app on Home. It controls which models the assistant uses. Being an admin does not let you see spaces you are not in.

### Primary and secondary

Weft asks the **primary** model first and falls back to the **secondary** when the primary has no key, reaches its monthly cap, times out or errors. It never re-asks a question the primary declined. Every answer names the model that wrote it.

- A new Weft starts with Claude Opus 5.5 (Anthropic, no key yet) as primary, and an Ollama fallback that is off until you give it an address (for example `http://ollama-host:11434`) and turn it on.
- Only the primary (an Anthropic model) can propose actions. The fallback only answers.

### Keys

Paste a key under **API key** and press **Save key**. Keys are encrypted before they are stored, and the screen only ever shows the last four characters. Use **Test connection** to check a slot.

### Spending

Each slot has a **monthly cap** and per-token prices, and shows what it has spent this month. When the primary reaches its cap, the fallback answers until the month ends.

### Personal keys

The **Personal keys** switch (off by default) lets each person add their own Anthropic or OpenAI key from the menu on their initial. A personal key answers only that person's questions, before the primary and secondary, and falls back to them if it fails. It is billed to that person and tracked separately from the slots' monthly caps.

- Nobody else can see or use a personal key, admins included: Settings shows only how many people have one.
- Personal keys only reach Anthropic and OpenAI at their official addresses. Nobody can point one at another server (so a personal setting can never reach machines on Weft's own network). The server's `PERSONAL_ANTHROPIC_URL` and `PERSONAL_OPENAI_URL` settings change those addresses; only the tests use them.
- Turning the switch off stops every personal key from being used at once; the keys stay saved, and each person can still delete theirs.
