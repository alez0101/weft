# Adding an app to Weft

How a new app (a tile on Home, opening in its own tab) is built so it keeps Weft's one promise: **you
see something only if you are a member of its space, everywhere** (API, live updates, search, the
assistant). Follow this for every app, by hand or by a scheduled build.

## 1. Data: a migration

`db/migrations/NNN_<app>.sql`, the next number. It must run on an existing database without harm
(`create table if not exists`, `create or replace`, `drop policy if exists` before `create policy`).

- **Every row belongs to a space**: a `space_id uuid not null references weft.spaces (id) on delete cascade`
  column, or a parent row that has one (like table rows reach their table's space).
- **Row-level security, always**: `enable` and `force row level security`, then policies built only from
  the helpers in `003_access.sql`: `weft_private.is_member(space)` to read, `weft_private.can_edit(space)`
  to write, `weft_private.is_owner(space)` to manage. They already apply the channel-scope claim and
  disabled accounts. Never write a policy that does not go through them.
- **Column grants, not table grants, for writes**: grant `insert (...)` and `update (...)` on exactly the
  columns people may set. Authorship columns (`created_by`, `author_id`) default to
  `weft_private.uid()` and are never granted, so they cannot be forged.
- **Live updates**: add the table to the `announce` trigger pattern in `006_notify.sql` (a notice carries
  only table, operation, id and space; the browser refetches through the API). The notification server
  forwards notices only to members.
- **Moves between spaces leak by default.** When something moves to another space and a trigger cleans
  up rows that do not belong in the new space (answers, assignees, links), record those removals in the
  audit log and notices under the space it moved **from**, never the new one: the new space's members must
  not learn what was there. Test it: someone only in Organizers acts, the thing moves to #festival, Pat
  sees no trace (and an Organizers member still sees the audit row).
- **Anonymity covers side effects too.** If an app lets people act anonymously, every write it causes on
  their behalf (refreshing an item's `body_text`, counters, summaries) must not record them: the audit
  triggers stamp `weft_private.uid()` on every changed row. Run such system writes without the caller's
  identity (`set_config('request.jwt.claims', '{}', true)`, then restore; an empty string is not valid JSON
  and breaks `uid()`), and test that no audit row anywhere names the anonymous person.
- **The assistant role** (`weft_assistant`) gets `select` only if the assistant should read the app, and
  never `delete`.
- **Search and the assistant** read `weft.items.body_text`. If the app's content is text people will look
  for, either store it as an item (a new `kind`, like files and tables) or keep a text summary in an
  item's `body_text` (like tables do), so search, meaning search and the assistant pick it up for free.
- No new database roles, no `security definer` function that reads across spaces, no new external
  service unless there is no other way.

## 2. Screens

- `services/web/src/<App>.jsx`, added to `APPS` in `App.jsx` (an `id`, a `label`, a `tint` from the
  palette tokens, a 40 by 40 SVG `glyph`, `real: true`) and to the panel switch at the bottom of `App`.
- Data through `api()` (PostgREST, as the person). Live: refetch on `notice` for the app's table.
- Styling only through the tokens in `styles/tokens.css` and the existing classes (`btn`, `slot`,
  `people`, `docs-*`, `widget`). No literal colours or fonts. Every control keeps `:focus-visible`,
  every animation has a `prefers-reduced-motion` fallback, labels are sentence case. It must work in
  light and dark mode.
- Viewers see the app read-only; editors and owners can change things. Show what the database allows,
  and show the database's answer when it says no.
- If the app has a natural Home widget, add it to `Home.jsx`.

## 3. Tests (all must pass)

- `tests/permissions.py`: a function for the app, called from `__main__`, covering at least: Pat (viewer
  in #festival only) cannot read Organizers rows or write in #festival; Olive (editor) can write;
  a channel-scoped token sees only its channel; the assistant role cannot delete; authorship cannot be
  forged; deletes and moves follow the space. Include **positive controls** (something allowed is
  allowed), or a rule that refuses everything passes too.
- `tests/<app>-browser.cjs`: drives the app in a real browser on the test stack (`tests/run.sh --keep`):
  create, see it live in a second browser, a viewer's read-only view; screenshots to `WEFT_SHOTS`.
- `tests/run.sh` must pass in full. It runs only on the separate test stack.

## 4. Words

- A help page `docs/help/NN-<app>.md` (title, `parent: Weft help`, a one-line `summary`) in plain
  words: what it is for, how to use it, who can see what.
- A line in the admin wiki where it belongs (`docs/admin/11-architecture.md`, `12-data-and-permissions.md`,
  `15-testing.md` with the new check counts) and in the README if it changes what Weft is.

## Rules

- Dependencies: MIT, BSD, ISC, Apache-2.0 or MPL-2.0 only; check before adding. No GPL, AGPL or
  commercial licences, and no packages that phone home.
- No calls to outside services from the app or its server code.
- No secrets, server names, private addresses or personal hostnames in the repo.
- One app per change.
