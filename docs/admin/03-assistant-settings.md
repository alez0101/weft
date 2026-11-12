---
title: Assistant settings
parent: Weft admin
summary: Primary and fallback models, keys and monthly caps.
---
Admins see a **Settings** app on Home. It controls which models the assistant uses. Being an admin does not let you see spaces you are not in.

### Primary and secondary

Weft asks the **primary** model first and falls back to the **secondary** when the primary has no key, reaches its monthly cap, times out or errors. It never re-asks a question the primary declined. Every answer names the model that wrote it.

- Current setup: Claude Opus 5.5 (Anthropic) as primary, and qwen2.5:3b on the homelab host's Ollama as the fallback.
- Only the primary (an Anthropic model) can propose actions. The fallback only answers.

### Keys

Paste a key under **API key** and press **Save key**. Keys are encrypted before they are stored, and the screen only ever shows the last four characters. Use **Test connection** to check a slot.

### Spending

Each slot has a **monthly cap** and per-token prices, and shows what it has spent this month. When the primary reaches its cap, the fallback answers until the month ends.
