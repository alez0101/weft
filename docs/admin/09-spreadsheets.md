---
title: Spreadsheets
parent: Weft admin
summary: The spreadsheet engine (OnlyOffice Docs): turning it on, what it costs, how it is secured, and what to do when a sheet will not open.
---
The Spreadsheets app is a real spreadsheet (formulas, formatting, charts, several sheets, people editing at the same time) made by an engine that runs next to Weft: **OnlyOffice Docs Community** 9.4, from its official image, unmodified. Tables stay as they are; they are a different thing (typed columns and rows Weft understands).

### Turning it on or off

- On: `COMPOSE_PROFILES=office` and an `OFFICE_JWT_SECRET` in `stacks/weft/.env` (`tools/make_env.py` writes both for new installs). Then `up -d` as usual; the first start pulls a 4.3 GB image.
- Off: remove `COMPOSE_PROFILES=office` and stop the `office` container. Spreadsheets stay in the database; the app says they are not set up, and the files can still be downloaded. Leave `OFFICE_JWT_SECRET` empty to hide the app's actions entirely.
- Cost: about 600 MB of memory while idle, a little more per open sheet; about a minute to start. While it starts, Spreadsheets shows "the spreadsheet engine is starting" and opens the sheet by itself when it is ready.

### How it is secured

- The engine accepts nothing that is not signed with `OFFICE_JWT_SECRET`: not an editor configuration, not a command, not a conversion. Change the secret by editing `.env` and recreating both `files` and `office`.
- The files service signs each editor configuration for one person and one sheet, with edit or view decided by row-level security (can they edit the sheet's space?). It is good for ten minutes, so someone who loses access cannot reopen a sheet with an old one.
- The engine fetches the sheet from the files service and posts saves back to it directly, on the stack's private network, each with its own Weft token. The front door never serves those addresses.
- A save is written as the most recent editor in the session who can still edit, through row-level security; if nobody can, it is refused (and logged).
- The engine's plugins, including its AI assistant, are switched off, so nothing in a sheet is sent anywhere.
- The engine keeps no data of its own beyond open sessions. Sheets live in `file_blobs`, so the nightly backup has them.

### Saving

The engine saves to Weft when the last person closes a sheet (about ten seconds later), and every `OFFICE_FORCESAVE_MINUTES` (default 5) while people are still editing, so restarting the engine loses at most those minutes. The files service logs each save: `office save` (final) or `office save (session goes on)`.

### When a sheet will not open

- "The spreadsheet engine is starting" for more than a few minutes: `docker compose ... logs office`, and `docker compose ... exec office curl -s http://localhost/healthcheck` (should say `true`).
- "Spreadsheets are not set up": the files service has no `OFFICE_JWT_SECRET`.
- The editor shows an error about a token: `files` and `office` disagree on the secret; recreate both.
- Opening a file as a spreadsheet failed: the engine could not convert it (a damaged file, or a format it does not read). The original file is untouched.

### Licence

OnlyOffice Docs Community is AGPL v3 with attribution terms: its logo stays in the editor. Weft (MIT) does not include or change its code; it runs the official image as a separate service.
