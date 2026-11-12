# People: channels, members and accounts

Built 2026-11-12. Migration `db/migrations/016_people.sql`; screens in `services/web/src/People.jsx`.

## What people can do

- **Create a channel:** `weft.create_channel(name)` (the + next to Channels). The creator becomes owner
  (the existing `add_creator` trigger). A function rather than `POST /spaces`, because an insert cannot
  return its row: RLS hides it until the after-trigger has made the creator a member.
- **People panel** (the member count under a channel's name): everyone sees members and roles; owners add
  people (anyone who has signed in), change roles, remove people, rename and delete the channel; anyone can
  leave (the help channel hides the button: sign-in would add them back).
- **A channel always keeps an owner:** `members_keep_owner` refuses removing, demoting or leaving as the
  last owner. Deleting the channel still works (its members go with it).
- The rules themselves are the Phase 2 policies: only owners insert, update or delete members.

## Accounts (admins, Settings)

- `weft.admin_users()` lists every account with channels count and last sign-in; `weft.admin_set_user(user,
  is_admin, disabled)` changes one. Admins only, not with a channel-scoped token, never your own account,
  never the assistant; at least one active admin is kept. Changes go to `weft_private.admin_log`.
- **Disabled** means `member_role()` returns nothing for the account, so every policy refuses it at once
  (even with an unexpired token), as does the assistant acting for it. Sign-in is refused (403), a
  disabled account cannot create spaces, and an `account` notice makes the token service close its live
  sockets (code 4003, the app shows "This account has been disabled") and the collab server close its
  editing sessions. Memberships are kept, so enabling restores everything.
- `last_seen_at` is stamped at sign-in and readable only through `admin_users()`: other people get column
  grants on `users` without it.
- New people still need their email added to the Cloudflare Access policy before their first sign-in.

## Tests

- `tests/permissions.py` `people()`: 38 checks (creating, adding, roles, last owner, leaving, deleting,
  column privacy, admin functions, disabling and enabling).
- `services/svc/test/live.mjs`: disabling closes the socket with 4003, an old token hears nothing, no new token.
- `services/collab/test/collab.mjs`: disabling closes an open document; the old token cannot reopen it.
- `tests/people-browser.cjs`: create a channel, add someone (appears live for them), owner-only controls,
  hand over ownership and leave, delete, and an admin disabling a signed-in account.
