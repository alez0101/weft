---
title: Accounts and access
parent: Weft admin
summary: Letting someone in, admins, disabling an account.
---
### Letting someone new in

1. Add their email to the Cloudflare Access policy for `weft.example.org` (in Cloudflare Zero Trust, the Access application for that hostname). Until then Cloudflare stops them before they reach Weft.
2. They open `https://weft.example.org` and sign in with the code Cloudflare emails them.
3. Weft creates their account on that first sign-in, with a personal space, their own Weft conversation, and viewer access to the help channel.
4. Add them to channels from each channel's people panel (owners only).

There is no sign-up page and no password in Weft itself.

### Admins

- **Settings** lists every account with its channels and last sign-in.
- The **Admin** switch lets someone open Settings and puts them in this channel. Being an admin does not let anyone see spaces they are not in.
- You cannot change your own account in Settings, so Weft always keeps at least one admin.
- The first admin comes from `BOOTSTRAP_ADMIN_EMAIL` in the stack's environment file: that address is made admin, and owner of every channel, each time it signs in.
- Changes are recorded in `weft_private.admin_log`.

### Disabling an account

**Disable** signs the person out everywhere at once: their live connection and open documents close, and the database treats them as a member of nothing, even with a sign-in that has not expired. They cannot sign in again until you press **Enable**. Their channels are kept, so enabling restores everything. To stop someone for good, also remove them from the Access policy.

### Test accounts

The four `@example.com` accounts (Alex test admin, Olive, Vic, Pat) are sample data. They can only sign in through the test door on the Weft server itself (`127.0.0.1:3011`), never through Cloudflare.
