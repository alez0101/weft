# Semantic search

The assistant finds things by meaning as well as by words: "which stages have no electricity" finds a
table column called "Needs power" and a message about a dead outlet. It adds no new permission rule.

## How it works

- **Embedder:** `nomic-embed-text` (768 dimensions) on the homelab host's Ollama, `http://192.0.2.20:11434/api/embed`.
  Documents are embedded as `search_document: ...` and questions as `search_query: ...` (nomic's prefixes).
  Settings: `EMBED_URL`, `EMBED_MODEL`, `EMBED_DIM`, `SEMANTIC_MAX_DISTANCE` (default 0.7, cosine) on the
  assistant service.
- **Storage:** `weft.embeddings` (pgvector, HNSW cosine index), `db/migrations/015_semantic.sql`. One row per
  chunk: messages are one chunk, items (documents, wiki pages, whiteboard text, table summaries) are split
  into about 1000-character chunks (up to 40), events are "title, at location, time UTC".
- **Worker:** inside the assistant service. Every 5 seconds it asks `weft_private.embed_pending` for sources
  whose text hash or model changed, embeds them in batches of 24 and stores them with `embed_store`. Weft's
  own answers are not embedded. If Ollama is down it backs off to 30 seconds and logs once per 12 failures;
  keyword search keeps working.
- **Deletes:** a trigger on messages, items and events deletes their embeddings.
- **Search:** `weft.semantic_search(vector, limit)` is `security invoker`, so it runs as the caller under RLS.
  The `embeddings_read` policy shows a chunk only if the caller can see its source row, so spaces and the
  channel `scope_space` claim apply unchanged. `hnsw.iterative_scan = relaxed_order` keeps the index scan
  going until enough visible rows are found.
- **Retrieval:** the assistant runs keyword search first, then adds up to 12 nearest chunks within the
  distance limit, fetched again by id with the same assistant token.
- **Progress (admins):** `GET /assistant/admin/providers/embeddings` returns `{model, url, sources, chunks, paused}`.

## Tests

The test stack points `EMBED_URL` at a stand-in inside the assistant suite (hashed bag of words with a small
synonym map), never at the homelab host. The checks:

- the worker embeds new messages;
- Pat cannot read the embedding of an Organizers message, and her vector search never returns one;
- a festival-scoped assistant token never returns Organizers content;
- a paraphrase finds a message in a personal conversation (no recent-channel context, so only search can);
- Olive in #festival gets no Organizers content; in her own conversation she does (positive control);
- deleting a message deletes its embedding;
- only admins see progress.

## Live

Deployed 2026-11-12 without a reset: applied 015, reloaded PostgREST, rebuilt the assistant. The backfill
took under a minute: 91 sources, 103 chunks.
