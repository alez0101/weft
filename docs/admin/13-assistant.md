---
title: The assistant
parent: Technical specification
summary: How a question is answered, search, models and failover, proposals, costs.
---
### A question

1. You post a message in your Weft conversation, or with `@Weft` in a channel or direct message.
2. The app calls `/assistant/ask` with that message. The assistant reads it as you and only accepts your own messages.
3. It mints a 2-minute `weft_assistant` token for you. In a channel the token is scoped to that channel, because the whole channel reads the answer; in your own conversation it is not scoped.
4. It finds material with that token: keyword search over messages, documents, wiki pages, whiteboard text, tables and events, the channel's latest messages when scoped, events when the question is about time, and meaning search (below).
5. The model sees only those numbered items and must cite them. An answer with no valid citation becomes "I couldn't find anything about that in what you can see."
6. The answer is posted as Weft, with its citations, the model that wrote it and any fallback reason.

### Meaning search

The assistant's embedding worker turns every message, page and event into vectors with `nomic-embed-text` on the homelab host's Ollama (768 dimensions, `pgvector` with an HNSW cosine index). It re-embeds anything whose text changed, within seconds. A vector is readable only if its source is, so the same rule applies. Up to 12 nearest matches within a distance limit join the keyword results. If the embedder is down, keyword search answers alone.

### Models

Two slots in Settings, primary and secondary, each Anthropic, OpenAI-compatible or Ollama. Today: Claude Opus 5.5 at low effort as primary, `qwen2.5:3b` on the homelab host's Ollama as fallback. The secondary answers when the primary has no key, is off, has reached its monthly cap, is rate-limited, times out or errors; never when the primary declined a question. Keys are encrypted with AES-256-GCM by the assistant before they are stored and never shown again.

### Proposals

Only the Anthropic primary is offered tools: post a message, create an event, change an event. Each becomes a proposal card that only the asker can confirm or dismiss, within 30 minutes. Confirming runs with the asker's own rights, so the database can still refuse. Created and changed events can be undone for 24 hours. There is no delete tool, and the database refuses deletes from the assistant.

### Costs

Each call is logged in `weft_private.assistant_runs` with tokens, cost and model. An answer on the primary has cost about $0.002, so the $10 monthly cap covers roughly 5,000 questions.
