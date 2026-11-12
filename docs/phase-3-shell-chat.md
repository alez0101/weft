# Phase 3: real shell and chat

Built 2026-11-12. The mockup is now a React app with live chat on the Phase 2 data layer.
Exit check: `tests/run.sh` (rebuild from nothing; 88 permission checks with teeth; 18 live checks),
plus `tests/two-browsers.cjs` (two signed-in browsers chatting). All pass.

## What runs (stack `stacks/weft`, project weft-core)

| Service | What | Reachable at |
| --- | --- | --- |
| postgres | data, row-level security, LISTEN/NOTIFY | 127.0.0.1:55434 |
| postgrest | the API | 127.0.0.1:3100, and `/api/` through web |
| svc | sign-in and live notifications (Node) | only through web |
| web | nginx + the React shell (built in Docker) | 3010 (localhost + LAN, the tunnel target) and 127.0.0.1:3011 |

## Two front doors

- **3010, public** (`https://weft.example.org` through the homelab host's tunnel and Cloudflare Access). `/auth/session`
  verifies the `Cf-Access-Jwt-Assertion` header against the team's published keys, issuer
  `https://yourteam.cloudflareaccess.com` and the app's AUD tag, then issues a 15-minute Weft token.
  First sign-in creates the person and a personal space; the address in `BOOTSTRAP_ADMIN_EMAIL`
  (stacks/weft/.env) is also made owner of every channel so it can see the sample data.
  `/auth/test-login` returns 404 here.
- **3011, test** (127.0.0.1 only; not reachable from the LAN or the homelab host, verified). `/auth/test-login`
  signs in the seeded `@example.com` accounts only; any other address is refused by the database.
  Use an SSH tunnel to reach it from a laptop: `ssh -L 3011:127.0.0.1:3011 user@weft-server`.

## Live

Triggers `NOTIFY weft_events` with `{t, op, id, space}` (never content). weft-svc forwards each notice
only to sockets of members of that space, refreshing a user's memberships when their membership
changes; the browser then fetches the row through PostgREST. Sockets need a valid Weft user token;
expired sockets are closed and the client reconnects with a fresh token.

## Database additions

- `005_chat`: `reads` (last-read marker per person per space) and the `unread` view
  (security_invoker, so RLS applies) with unread and @mention counts.
- `006_notify`: the announce trigger on messages, items, events and members.
- `007_services`: logins `weft_auth` (may only call `provision_user` and `test_user`) and
  `weft_notify` (may only call `memberships`).

## Verified

- 2026-11-12: Alex signed in through Cloudflare Access at `https://weft.example.org` and chatted. No
  verification failures in the svc log (AUD tag confirmed); his account was created on first sign-in.
  If a future sign-in fails, `docker compose logs svc` names the reason (audience, issuer or signature).
