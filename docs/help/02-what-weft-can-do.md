---
title: What Weft can do
parent: Weft help
summary: The assistant's actions, and what it will never do.
---
Weft can answer questions, and propose actions: messages, events, and new or changed documents, tables, spreadsheets and task lists. It never acts on its own: every action waits for the person who asked to confirm it.

### Answer questions

Weft answers from everything you can open, with numbered links you can click to check its answer:

- **Writing:** chat messages, documents, wiki pages, the text on whiteboards, meetings (agenda, notes,
  decisions and action items), decision logs (each decision with its date, who decided, the context and
  what it replaces), glossaries (so it can explain your group's own words and understand them in your
  questions)
- **Lists and work:** tables, spreadsheets (every cell, sheet by sheet), task lists, checklists (the steps, and recent runs with how far each got and
  who finished it), goal sets (key results, progress and due dates), retros (the period, the notes in each
  column and which actions became tasks; never who wrote a note)
- **Asking and deciding:** polls (the question and the vote counts), forms (the questions and how many
  answered; the answers only for people who may read them), Q and A boards (questions, answers, upvotes
  and the accepted answer), ideas boards (status, votes and who suggested each)
- **Things and people:** link lists (title, address, tags and note), address books (name, organisation,
  phone, email and notes), expense lists (who paid what, balances and who should pay whom), inventories
  (each thing, where it is kept and who has it now)
- **Files and time:** files (PDF, Word and text) and calendar events
- **Notices and plans:** announcements, who is going to an event, things to book and their bookings, shifts
  and who is on them, time off, kudos and timeline milestones, in the channels you are in
- **People and you:** profiles of people you share a space with, and your own journal (only in your Weft
  conversation, never in a channel)

Weft reads short documents whole and long ones in part at first; when it needs more of one, it reads the
whole thing (very large documents, hundreds of pages, included) or searches again before it answers. It
also remembers the conversation: in your Weft conversation (and in your personal space) a follow-up like
"make that a table instead" or "add two more rows" works, and in a channel it remembers earlier @Weft
questions and answers there (not the rest of the chat).

**Web search** (only if your admin has turned it on): for facts that are not in Weft, like a school
district's calendar or a shop's opening hours, Weft can search the web, up to three searches a question. The
pages it used are listed under the answer as links that open in a new tab, and it says when an answer or
something it made relies on the web. It looks in Weft first, and does not put your private details into
searches. The local fallback model never searches.

A message link jumps to the message; a document link opens it in Documents, Wiki, Tables, Spreadsheets or Whiteboard; an event link opens it in the Calendar. If it cannot find the answer, it says so instead of guessing. It searches by meaning as well as by words, so asking about "electricity" also finds a message about a dead outlet.

### Propose an action

When you ask Weft to do something, it shows a card with what it would do, and **Confirm** and **Dismiss** buttons.

- **Post a message** in a channel.
- **Add an event** to the calendar of a channel, or to your personal calendar.
- **Change an event**: its title, time or location.
- **Create a document, wiki page, spreadsheet, table or task list**, with the content already written
  (for example "make me a spreadsheet of this year's school holidays"). Weft writes it from your request,
  what it can see and what it generally knows; if it had to guess something (like exact dates), it says so.
  Spreadsheets need the Spreadsheets app to be running; otherwise Weft offers a table.
- **Add to or rewrite a document or wiki page**, or rename it. People who have it open see the change live.
- **Add rows to a table** and **add tasks to a task list**.

Weft creates and changes things only where you are an editor or owner. In a channel it works only in that
channel; in your Weft conversation it can use your personal space or any channel you edit. Asked in a
project's chat, a new item goes into that project. It cannot change an existing spreadsheet (it can make
a new one), and it never changes Weft's own help pages.

### How confirming works

- **Only the person who asked can confirm.** Everyone else in the channel sees "Waiting for (name) to confirm."
- **Confirming uses your own permissions.** If you can only view a channel, Weft cannot change anything there for you, even after you confirm. The card then says "Not allowed". Anything it creates is created by you.
- **Proposals expire after 30 minutes.** Ask again if one expires.
- **Open**: after confirming, the card shows **Open** to go straight to the new or changed item.
- **Undo**: after confirming a new or changed event, document, table or task list, the card shows **Undo** for 24 hours. Undoing something new removes it, and that removal is done as you, not as Weft. Undoing a page edit puts the earlier text back (formatting the page had may come back simpler).
- Posted messages cannot be unsent by Weft.

### What Weft will never do

- **Delete anything.** There is no delete action, and the database refuses deletes from the assistant. (Undo removes only what Weft just made for you, and runs as you.)
- **Reach outside what you can see.** It works with your permissions, never more.
- **Act without a confirmation.**

### When the fallback model answers

If the main model is unavailable, a smaller local model answers instead and the note under the answer names it. The fallback model can only answer; it cannot propose actions.
