# Phase 6: the full assistant

Built 2026-11-12; this completes version 1. `tests/run.sh` passes 190 checks from a clean rebuild
(95 permission, 20 live, 52 assistant, 23 collab); `tests/proposals-browser.cjs` checks the cards.

## Reading

- Retrieval spans **messages, documents and wiki pages, and calendar events**, all through PostgREST with
  the assistant token minted for the asker, so RLS and the channel-scope claim bound it exactly as in 3b.
- Documents contribute an excerpt (the paragraphs that mention the question's words). Events contribute
  title, space, start, end and location, with times written in the asker's time zone (sent by the browser).
- Questions about time ("when", "schedule", "move" ...) also pull upcoming events in scope.
- Citations carry a type; in the UI a message chip jumps to the message, a document chip opens Documents
  or Wiki, an event chip opens the Calendar on that event.
- Full-text search only. Semantic search (pgvector + nomic-embed-text on a LAN Ollama) is a possible follow-up.

## Acting (governed)

- Only the Anthropic slot is offered tools, both strict: `send_message` (channel from an enum: in a channel
  only that channel, in your Weft conversation the channels you are in) and `change_event` (an event from
  the sources; title, location, start, end). There is no delete tool, and the assistant role cannot delete.
- A tool call is stored as a **proposal** (`weft_private.proposals`, not exposed) and shown as a card under
  the answer. Nothing happens until the **asker** confirms; others see who decides. Proposals expire after
  30 minutes; confirm is atomic, so a double confirm does nothing.
- Confirming executes through PostgREST as the assistant acting for the asker, with the original scope, so
  the database still decides: a viewer who confirms an event change gets "Not allowed", and the event is
  untouched. The change is audited with `actor_role = weft_assistant` and the asker as actor.
- **Undo** (event changes, within 24 hours) restores the values captured before the change. Sent messages
  cannot be unsent by the assistant (that would be a delete).
- The fallback model is called without tools, so it can only answer.

## Added after the owner's first real try (2026-11-12)

- "Can you schedule an event?" got a correct but unhelpful no (only change and send existed), and
  "actions available?" got "couldn't find anything" (the cite-or-NOT_FOUND rule covered questions about
  Weft itself). Fixes:
  - A third tool, `create_event` (`011_assistant_create.sql`): offered only for spaces where the asker is
    an owner or editor, inside the token's scope (in a channel: that channel; in the Weft conversation:
    their editable channels and personal space). Confirmed through PostgREST under a new assistant insert
    policy. **Undo removes the event with the asker's own token**, so the assistant still never deletes.
  - The instructions let Weft describe what it can do without citations, and stop it saying "sources".

## The help wiki (2026-11-12)

Weft's own documentation lives in Weft: the **help** channel's wiki ("Weft help" with pages on what Weft
can do, how to ask it, who can see what, and assistant settings). The source is `docs/help/*.md`
(front matter: title, parent); `tools/seed_help.py` turns it into wiki pages, on every reset and safely
on the live database (it never overwrites a page that exists, so edits made in Weft survive). The channel
is flagged `everyone` (`012_everyone_spaces.sql`): each sign-in adds the person as a viewer; admins own it.
Weft can answer "how do I..." from these pages in your Weft conversation; in other channels it cannot, by
the channel rule. To publish a change made in Weft back to the repo, copy the page text into the file.

## Changing the stand-in models

`services/assistant/test/assistant.mjs` serves both formats from one process: OpenAI-compatible at `/primary`
and `/secondary`, Anthropic Messages at `/anthropic` (the real SDK is exercised, tools included). It records
every request, which is how the suite proves what never reached a model and which tools were offered.
