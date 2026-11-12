---
title: Accounts and access
parent: Weft admin
summary: Inviting people, password resets, admins, disabling an account, sign-in methods.
---
### Letting someone new in

1. In **Settings**, **People**, type their email under **Invite someone** and press **Make invite link**.
2. Send them the link privately (it is shown only once). It works once and expires after three days.
3. They open it, choose their name and a password of at least 12 characters, and are signed in. Their account comes with a personal space, their own Weft conversation, and the help channel.
4. Add them to channels from each channel's people panel (owners only).

**Links not used yet** lists open links; **Cancel link** stops one. Making a new link for the same email replaces the old one.

### Forgotten passwords

Press **Reset link** on the person's row and send them the link. Using it sets a new password and signs them out everywhere else. People who know their password can change it from the menu on their initial, top right; that also signs out their other browsers.

### The first admin

A new Weft has no accounts. On the server, run

    python3 -I tools/weft_admin.py link you@example.org --url https://your-weft-address

and open the link it prints. If that email is `BOOTSTRAP_ADMIN_EMAIL` in the stack's `.env`, the account is made admin. The same tool makes reset links (`--reset`), for example if every admin is locked out.

### Admins

- **Settings** lists every account with its channels, last sign-in and whether a password is set.
- The **Admin** switch lets someone open Settings and puts them in this channel. Being an admin does not let anyone see spaces they are not in.
- You cannot change your own account in Settings, so Weft always keeps at least one admin.
- Changes are recorded in `weft_private.admin_log`.

### Disabling an account

**Disable** signs the person out everywhere at once: their sessions end, their live connection and open documents close, and the database treats them as a member of nothing, even with a sign-in that has not expired. They cannot sign in again until you press **Enable**. Their channels are kept, so enabling restores everything.

### How sign-in is protected

- Passwords are stored only as scrypt hashes. Invite and reset links, and sessions, are stored only as hashes of their secrets.
- Eight wrong passwords for one email, or 30 attempts from one address, lock that email or address out for 15 minutes. nginx also limits how fast any address can reach sign-in.
- A browser stays signed in through a session cookie that scripts cannot read and other sites cannot send. Its secret changes every time it is used; if an old secret is ever presented again, the session ends.
- Sessions last 30 days without use (`SESSION_DAYS`).

### Sign-in methods

`AUTH_METHODS` in the stack's `.env` chooses how people sign in: `password` (Weft accounts, the default), `cloudflare` (Cloudflare Access in front of Weft, which then needs `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`), or both. With Cloudflare, people are let in by the Access policy and their account is created on first sign-in.

### Test accounts

The four `@example.com` accounts (Alex test admin, Olive, Vic, Pat) are sample data. They sign in through the test door on the server itself (`127.0.0.1:3011`), never from outside.
