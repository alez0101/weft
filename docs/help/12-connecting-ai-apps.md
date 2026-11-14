---
title: Using Weft from Claude and other AI apps
parent: Weft help
summary: Connect Claude (or another app that speaks MCP) to your Weft account, so it can search, read and, if you allow it, write in Weft as you.
---
You can connect an AI app such as **Claude** to your Weft account. Then you can ask it things like "what did the festival channel decide about rain plans?" or "turn this into a wiki page in Volunteers", and it works in Weft as you.

It sees **only what you can see**: the channels you are in, with your role in each. If you cannot open something in Weft, neither can the app.

### Connecting Claude

1. In Claude, open **Settings**, then **Connectors**, and choose **Add custom connector**.
2. Give it a name (Weft) and this address: your Weft address followed by `/mcp` (for example `https://weft.example.org/mcp`). Your account menu in Weft shows the exact address under **Connected apps**.
3. Claude opens Weft. Sign in if you are asked to, then choose what Claude may do:
   - **Read only**: search and read messages, documents, the wiki, tables, tasks, polls, files and the calendar.
   - **Read and write**: also post messages, create and edit documents and wiki pages, add and change calendar events, add tasks and tick them off.
4. Press **Allow**. You go back to Claude, and Weft is connected.

Other apps that support MCP connectors (Claude Desktop, Claude Code and others) connect the same way, with the same address.

### What it can and cannot do

- Anything it writes appears **under your name**, the same as if you had typed it. People in the channel see it as yours.
- It can only change things where you can: editors and owners change documents and events; viewers can read, chat and tick off tasks assigned to them.
- It **cannot delete** anything, manage channels or people, or change settings.
- Pages from Weft's own help and admin wikis cannot be edited.
- When it edits a document someone has open, they see the change appear, just like another person editing.

### Disconnecting

Open your account menu (your initial, top right) and choose **Connected apps**. Each app shows what it may do and when it was last used. Press **Disconnect** and it stops working at once. You can connect it again later.

If an admin disables your account, every app connected to it stops too.
