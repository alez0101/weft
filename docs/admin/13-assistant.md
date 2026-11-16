---
title: The assistant
parent: Technical specification
summary: How a question is answered, search, models and failover, proposals, costs.
---
### A question

1. You post a message in your Weft conversation, or with `@Weft` in a channel or direct message.
2. The app calls `/assistant/ask` with that message. The assistant reads it as you and only accepts your own messages.
3. It mints a 2-minute `weft_assistant` token for you. In a channel the token is scoped to that channel, because the whole channel reads the answer; in your own conversation it is not scoped.
4. It finds material with that token: keyword search over messages, documents, wiki pages, whiteboard text, tables, files and events, the channel's latest messages when scoped, events when the question is about time, and meaning search (below).
5. Rules (069), in order after Weft's own: the space's rules, the project's instructions (when asked in a project chat) and the asker's own rules (style only), all read with the asker's tokens. The project's pinned items come first among the numbered items and are never cut. Instructions guide the answer; they are not sources. In a project chat, the recent messages are that project's, and the answer is posted there.
6. The model sees only those numbered items and must cite them. An answer with no valid citation becomes "I couldn't find anything about that in what you can see."
7. The answer is posted as Weft, with its citations, the model that wrote it and any fallback reason.

### Meaning search

When `EMBED_URL` points at an Ollama server, the assistant's embedding worker turns every message, page and event into vectors with `nomic-embed-text` (768 dimensions, `pgvector` with an HNSW cosine index). It re-embeds anything whose text changed, within seconds. A vector is readable only if its source is, so the same rule applies. Up to 12 nearest matches within a distance limit join the keyword results. If the embedder is down, keyword search answers alone.

### Models

Two slots in Settings, primary and secondary, each Anthropic, OpenAI-compatible or Ollama. A new Weft starts with Claude Opus 5.5 at low effort as primary and an Ollama fallback that is off until configured. If personal keys are allowed and the asker has one, it is tried first, for their own questions only, at the official Anthropic or OpenAI address. The secondary answers when the primary has no key, is off, has reached its monthly cap, is rate-limited, times out or errors; never when the primary declined a question. Keys are encrypted with AES-256-GCM by the assistant before they are stored and never shown again.

### Reading, rounds and memory

With the Anthropic primary, the numbered items share an excerpt budget (`ASSIST_EXCERPT_BUDGET_CHARS`, default
32,000 characters, about 8,000 tokens): items up to `ASSIST_ITEM_WHOLE_CHARS` (8,000) go in whole, longer ones as excerpts marked so. The model
may then call `read_item` (the whole item) and `search` (more numbered items), in up to `ASSIST_MAX_ROUNDS` (5)
rounds, reading at most `ASSIST_READ_BUDGET_CHARS` (400,000) more per question, all with the same scoped token.
The whole question must end within `ASSIST_DEADLINE_MS` (130 s; the web server waits 150 s). Replies may be up to
`ASSIST_MAX_OUTPUT_TOKENS` (16,000). From the second round on the prompt is cached (top-level `cache_control`); single-round questions are not, since a cache write costs 25 % more. The local
fallback still gets short excerpts and no tools. A full page rewrite is proposed only for a page the model saw
whole. Conversation memory: the last `ASSIST_HISTORY_MESSAGES` (12) messages of the person's own Weft
conversation, or of @Weft questions and Weft answers in the same channel or project chat, go along as earlier
turns (old citation numbers stripped). Cost: input $4 per million tokens on claude-opus-5-5: an ordinary question is a few cents, one that
reads a 50-page document roughly $0.10 more; cached rounds cost a tenth. The monthly caps still apply.

### Web search (074)

Settings → Web search (admins; off by default, `weft_private.assistant_settings.web_search`). When on, the
Anthropic model (workspace slots and personal Anthropic keys) also gets Anthropic's server-side
`web_search_20260209` tool, at most `ASSIST_WEB_MAX_USES` (3) searches per question, and an instruction to use it
only for outside facts, Weft first, no private details in queries. Web pages cited in the model's text become
`type: "web"` citations (http/https only), shown as links that open in a new tab; an answer backed only by web
citations is shown. Each search adds `ASSIST_WEB_SEARCH_USD` (0.01) to the run's cost, so the monthly cap covers
it. If the API refuses the tool (web search disabled for the Anthropic organization), the question is answered
without it rather than failing over. `pause_turn` from a long search is continued within the round limit.

### Proposals

Only the Anthropic primary is offered tools: post a message, create an event, change an event, and (073) create a document, wiki page, spreadsheet, table or task list with its content, add to, rewrite or rename a document or wiki page, add rows to a table, add tasks to a task list. Content tools target only spaces where the asker is an owner or editor and that are in scope (in a channel, only that channel); edits only items among the retrieved sources, never managed pages; spreadsheets are offered only while the office engine is up, and existing spreadsheets are never changed. Content proposals run on confirm with the asker's own token (files service for spreadsheets, collab's internal edit port for pages), so the audit shows the person, and undo (24 hours) removes what was made or puts a page's earlier text back. Each becomes a proposal card that only the asker can confirm or dismiss, within 30 minutes. Confirming runs with the asker's own rights, so the database can still refuse. Created and changed events can be undone for 24 hours. There is no delete tool, and the database refuses deletes from the assistant.

### Costs

Each call is logged in `weft_private.assistant_runs` with tokens, cost and model. An answer on the primary has cost about $0.002, so the $10 monthly cap covers roughly 5,000 questions.
