# Version 1.5: Whiteboard and Tables

Built and deployed 2026-11-12. `tests/run.sh` (test stack only) passes 230 checks: 117 permission,
22 live, 62 assistant, 29 collab. Browser checks: `tests/whiteboard-browser.cjs`, `tests/tables-browser.cjs`.

## Whiteboard (Excalidraw 0.18, MIT)

- A whiteboard is an item (kind `whiteboard`, `013_whiteboards.sql`), so spaces, permissions, sharing,
  moving, deleting and the audit trail work as for documents.
- Co-edited live through the same collab server. The binding is ours (`services/web/src/Board.jsx`): a Yjs
  map `elements` with one entry per Excalidraw element; local changes write elements whose `version` rose,
  remote changes merge keeping the higher version per element. (`y-excalidraw` exists but was last published
  2024-12.) Viewers get Excalidraw's view mode and the server ignores their writes. Images are off.
- Text on the board is extracted on save (top to bottom, left to right) into `body_text`.
- Excalidraw's fonts are bundled and served by Weft (`EXCALIDRAW_ASSET_PATH=/excalidraw/`), not a CDN.

## Tables (AG Grid Community 36, MIT)

- A table is an item (kind `table`) with `table_columns` (text, number, date, checkbox, choice) and
  `table_rows` (`cells` keyed by column id), `014_tables.sql`. RLS reaches the space through the table
  (`weft_private.table_space`): read if you can see the table, change if you can edit its space.
- Cells are written one at a time with `weft.set_cell(row, column, value)` (security invoker, so RLS
  applies): two people editing different cells of one row both keep their change. `updated_at` is stamped
  by a trigger (a SET on it would need a column grant).
- Every change refreshes the table's text summary in `body_text` (header plus up to 300 rows), notifies
  members (`table_rows` / `table_columns` notices name the table) and is audited.
- The grid takes Weft's tokens through `themeQuartz.withParams`, so it follows dark mode. Live notices patch
  the changed row in place, so someone else's edit does not interrupt yours.
- Seeded: Porches and Performers in #festival, a small Budget in #organizers.
- The assistant reads tables like documents (labelled "table", with as much of the table as fits).

## Gotchas

- AG Grid 36's DOM differs from older versions (no `.ag-center-cols-container`); select rows by
  `.ag-row[row-index]` and cells by `[col-id]`.
- Excalidraw keyboard shortcuts need the canvas focused first.
- Deploying to live without a reset: apply the new migrations, then add seed rows selectively (see the
  deploy commands in this session's history: tables were filtered out of `tools/gen_seed.py` output).
