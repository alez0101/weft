# Shell mockup

Clickable mockup of the Weft shell, built 2026-11-12 after the owner described the target:
an iPad-like home screen of apps, each opening in its own tab inside the page, and a persistent
Teams-like chat rail on the left with the AI assistant as a chat participant.

- Files: `mockup/` (static HTML, CSS, JS; no build step). Served by `stacks/mockup/` (nginx) on
  the server's port 3010, so `https://weft.example.org` (Cloudflare Access) shows it with no tunnel change.
- Sample data only, taken from `data/sample/`. Nothing saves; tab and chat state live in the URL.
- Try: click "Schedule sheet, row 18" in the Weft chat (opens Sheets with the row highlighted),
  open apps from Home, switch channels, type `@Weft` in a channel, reload (tabs survive).
- The chat rail collapses to an icon strip or widens (buttons in its header; kept in the URL as `chat=`).
- The assistant's replies to new messages are canned: it says it is a mockup.
- Design pass: Hallmark, app scope, Dose theme; lint clean (0 FAIL).
