---
title: Using Weft from Claude and other AI apps
parent: Weft help
summary: Connect Claude (or another app that speaks MCP) to your Weft account, so it can search, read and, if you allow it, write in Weft as you.
---
You can connect an AI app such as **Claude** to your Weft account. Then you can ask it things like "what did the festival channel decide about rain plans?" or "draft a packing list from the camp project", and it works in Weft as you.

It reads **only what you can see**: the channels you are in, except channels whose owners turned off **Allow AI agents to read this channel**. If you cannot open something in Weft, neither can the app.

It **changes things only in your Personal space**. It can draft a document, a task list or a note there (also inside one of your personal projects), and you move it into a channel or project when it is ready. It cannot post, edit or tick things off in a channel, even where you could.

### Connecting Claude

1. In Claude, open **Settings**, then **Connectors**, and choose **Add custom connector**.
2. Give it a name (Weft) and this address: your Weft address followed by `/mcp` (for example `https://weft.example.org/mcp`). Your account menu in Weft shows the exact address under **Connected apps**.
3. Claude opens Weft. Sign in if you are asked to, then choose what Claude may do:
   - **Read only**: search and read messages, documents, the wiki, tables, tasks, polls, files and the calendar.
   - **Read and write**: also, in your Personal space, post notes, create and edit documents and wiki pages, add and change calendar events, add tasks and tick them off.
4. Press **Allow**. You go back to Claude, and Weft is connected.

Other apps that support MCP connectors (Claude Desktop, Claude Code and others) connect the same way, with the same address.

### What it can and cannot do

- Anything it writes appears **under your name**, in your Personal space. When you move it into a channel, people there see it as yours.
- It can read a project's instructions and pinned documents, so it can follow them when it drafts something for that project, and list one project's events.
- It **cannot delete** anything, manage channels or people, or change settings.
- Pages from Weft's own help and admin wikis cannot be edited.
- When it edits one of your documents while you have it open, you see the change appear, just like another person editing.

### Disconnecting

Open your account menu (your initial, top right) and choose **Connected apps**. Each app shows what it may do and when it was last used. Press **Disconnect** and it stops working at once. You can connect it again later.

If an admin disables your account, every app connected to it stops too.
