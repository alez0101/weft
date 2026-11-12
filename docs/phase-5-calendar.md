# Phase 5: Calendar (plus moving and deleting documents)

Built 2026-11-12. `tests/run.sh` passes 164 checks from a clean rebuild (95 permission, 20 live,
26 assistant, 23 collab); `tests/calendar-browser.cjs` is the browser check (run in Pacific time).

## Calendar

- FullCalendar **7** (MIT) inside the React shell. Events from every space you can see, read through
  PostgREST, so row-level security decides; each space has its own tint and a show/hide checkbox.
- Opens on the week of the next upcoming event, so the far-off sample schedule is not hidden behind
  an empty "this week".
- Editors drag across the grid to create (title, space, location), and drag or resize to move; a failed
  change reverts. Viewers see "View only" and no Delete. Overlapping events stack three wide with a
  "+N more" link that opens the day.
- Live: an `events` notice refetches the visible range (the browser check saw a new event arrive in
  about 0.15 s). Notices reach only members of the event's space (live suite).
- Sharing posts `weft://event/<id>` into a channel; chat shows "Open in Calendar", which jumps to the
  date and opens the event, or says you have no access.
- The classic theme's palette variables are mapped onto Weft tokens, so the calendar follows dark mode.

## Documents and Wiki additions

- **Move to** another space you can edit (the API and RLS check both spaces), and **Delete** with a
  confirmation naming who loses it. Wiki sub-pages of a deleted page move to the top level.
- The collab server closes open sessions when a document is deleted, or moves to a space the editor is
  not in; reconnecting re-checks access against the new space (collab suite).

## Gotchas (FullCalendar 7)

- Plugins come from `@fullcalendar/react/<plugin>` subpaths. Don't install the v6 plugin packages
  (`@fullcalendar/daygrid` etc. are still tagged `latest` at 6.x on npm).
- An event's CSS class is `className` (a string); v6's `classNames` array is silently ignored.
- Its own CSS class names are hashed (`fc-classic-wsy`), so style events through classes you add.
