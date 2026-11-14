---
title: What Weft can do
parent: Weft help
summary: The assistant's actions, and what it will never do.
---
Weft can answer questions and propose three actions. It never acts on its own: every action waits for the person who asked to confirm it.

### Answer questions

Weft reads the chat messages, documents, wiki pages, tables, task lists, polls (the question and the vote counts), forms (the questions and how many answered; answers only for people who may read them), link lists (each link's title, address, tags and note), address books (each contact's name, organisation, phone, email and notes), decision logs (each decision with its date, who decided, the context and what it replaces), meetings (agenda, notes, decisions and action items), files (PDF, Word and text), the text on whiteboards and the calendar events you can open, and answers with numbered links you can click to check its answer. A message link jumps to the message; a document link opens it in Documents, Wiki, Sheets or Whiteboard; an event link opens it in the Calendar. If it cannot find the answer, it says so instead of guessing. It searches by meaning as well as by words, so asking about "electricity" also finds a message about a dead outlet.

### Propose an action

When you ask Weft to do something, it shows a card with what it would do, and **Confirm** and **Dismiss** buttons.

- **Post a message** in a channel.
- **Add an event** to the calendar of a channel, or to your personal calendar.
- **Change an event**: its title, time or location.

### How confirming works

- **Only the person who asked can confirm.** Everyone else in the channel sees "Waiting for (name) to confirm."
- **Confirming uses your own permissions.** If you can only view a channel, Weft cannot change its events for you, even after you confirm. The card then says "Not allowed".
- **Proposals expire after 30 minutes.** Ask again if one expires.
- **Undo**: after confirming a new or changed event, the card shows **Undo** for 24 hours. Undoing a new event removes it, and that removal is done as you, not as Weft.
- Posted messages cannot be unsent by Weft.

### What Weft will never do

- **Delete anything.** There is no delete action, and the database refuses deletes from the assistant.
- **Reach outside what you can see.** It works with your permissions, never more.
- **Act without a confirmation.**

### When the fallback model answers

If the main model is unavailable, a smaller local model answers instead and the note under the answer names it. The fallback model can only answer; it cannot propose actions.
