# Phase 3b: the assistant, read-only slice, and admin provider settings

Built 2026-11-12. `tests/run.sh` now runs three suites from a clean rebuild: 95 permission checks,
18 live checks, 26 assistant checks. All pass.

## How a question is answered

1. You post a message: in your own **Weft** conversation, or in a channel/DM with `@Weft`.
2. The shell calls `POST /assistant/ask {message_id}` with your token. The service reads the message
   *as you* (RLS decides whether it exists for you) and only accepts your own messages.
3. It mints a 2-minute `weft_assistant` token for you. In a channel the token carries
   `scope_space` = that channel, because the whole channel reads the answer; in your Weft
   conversation it has no scope, so it can use everything you can open.
4. Retrieval through PostgREST with that token: full-text search on the question's words, plus the
   channel's recent messages when scoped. Assistant answers and assistant conversations are excluded.
5. The model sees only those numbered sources and must cite them as `[n]`. An answer with no valid
   citation is replaced by "I couldn't find anything about that in what you can see."
6. The answer is posted as Weft with `meta`: citations (message id, space, label), which slot and
   model answered, and the fallback reason if any. People cannot write `meta`.

## Providers (Settings tile, admins only)

- Two slots, **primary** and **secondary**, each Anthropic, OpenAI-compatible or Ollama, with model,
  effort (Anthropic), base URL, monthly cap and prices for cost tracking. Starting setup:
  `claude-opus-5-5` at low effort ($4 / $20 per million tokens, cap $10 a month, no key yet), and
  Ollama `qwen3:4b` as the fallback (address not yet reachable; see below).
- Anthropic calls use the official SDK (`@anthropic-ai/sdk`) with server-side refusal fallback on
  (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`).
- Failover to the secondary on: no key, slot disabled, monthly cap reached, rate limit, connection
  failure, timeout, server error. **Not** on a refusal: a declined question is not re-asked elsewhere.
- Keys are write-only: encrypted with AES-256-GCM by the assistant service (master key in
  `stacks/weft/.env`) before they reach Postgres; the screen shows only the last four characters;
  no API role can read the table (`weft_private.providers`). Every call is logged in
  `weft_private.assistant_runs` (tokens, cost, model, fallback reason).
- Admin is a flag on the user, referenced by no row-level policy. Tested: an admin Pat still sees
  nothing of Organizers.

## What the suite proves (with a stand-in model that records every prompt)

- A secret planted in #organizers never reaches the model for Pat (channel or her own conversation),
  nor for Olive asking in #festival, even though Olive can read #organizers.
- Positive control: it does reach the model when Olive asks in her own conversation, so the
  absences above are scoping, not a search that simply missed.
- Answers in a channel cite only that channel; answers in a Weft conversation stay private to it.
- Failover on a down primary and on a reached cap, each with the reason recorded; both slots off gives
  a plain "no model is available" message.
- Only admins read or change settings; keys never come back; you cannot ask with someone else's
  message or about one you cannot see; in a channel Weft answers only when mentioned.

## Learned from the real fallback model (qwen2.5:3b)

- It cited sources while saying it found nothing, and later wrote only citation markers. Fixes: an
  exact `NOT_FOUND` reply that Weft turns into its "couldn't find" message, a worked example of the
  answer format in the instructions, and a guard that turns a words-free reply into "Here is what I
  found" over the source chips.
- Earlier @Weft questions were being retrieved as if they were answers; messages that ask @Weft are
  now excluded from sources.
- It still misses questions that need reasoning about authors ("who asked about ..."). Expected for
  a 3B fallback; the primary should handle them.

## Not done yet

- Done 2026-11-12: the Ollama host on the LAN now also listens on its LAN address (for example
  `http://192.0.2.20:11434`), chosen over a tunnel; its existing Docker-network binding stays for the
  other containers there. Ollama has no login, so anything on the LAN can use it. The fallback model is
  `qwen2.5:3b`, because that host keeps at most two models loaded (qwen2.5:3b + nomic-embed-text).
- Done 2026-11-12: the owner entered the Anthropic key in Settings. Test connection 1.0 s; real answers about
  1.7 s and $0.0015 to $0.0023 each (the $10 cap is roughly 5,000 questions). Claude answered correctly the
  author question qwen2.5:3b missed.
- Semantic (vector) search: full-text only in 3b; pgvector embeddings come with Phase 6.
