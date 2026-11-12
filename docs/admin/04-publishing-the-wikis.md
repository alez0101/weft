---
title: Publishing the wikis
parent: Weft admin
summary: How the help and admin wikis are kept in the repo and published.
---
The help wiki and this admin wiki are written as Markdown files in the Weft repo: `docs/help/` and `docs/admin/`. Publishing copies them into Weft.

### Publish

    tools/publish_wikis.sh --live

It reports each page created, updated or removed. Without `--live` it publishes to the test stack. Rebuilding a database (`db/reset.sh`) publishes too.

### What publishing does

- Creates new pages, rewrites changed ones and deletes pages whose file was removed.
- Rebuilds each list of pages: the line `<!-- pages -->` in a page becomes a list of the pages under it, with each file's summary. The index pages of both wikis use it, so they always list every page.
- Closes anyone's open copy of a changed page; it reopens on the new text.
- Search and the assistant read the new text straight away; the meaning index catches up within seconds.

### Rules for the files

- Each file starts with a header between two `---` lines: `title`, `parent` (the title of the page it sits under) and `summary`.
- Files are numbered in tree order, so a parent comes before its pages. Gaps in the numbers are fine.
- **Do not rename a file.** A page's identity comes from its file name, so a rename deletes the page and creates a new one, and links shared in chat to the old page stop working.

### Managed pages

Published pages are read-only in Weft, for everyone: they change only by publishing, so nothing written in Weft is ever overwritten. Anyone who can edit the channel can still add their own pages under them; those are never touched by publishing.
