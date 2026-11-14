-- 025 connector: Weft as an MCP server, so an AI app (Claude, for one) can work in Weft as a person.
--
-- The app signs in with OAuth 2.1 (authorization code + PKCE). The person approves it on Weft's own
-- consent screen, choosing read-only or read-and-write; that approval is a grant. Every tool call then
-- runs as that person through the API, so row-level security decides what the app sees, exactly as
-- for the person. Nothing here widens what anyone can see.
--
-- - Client registrations, codes and tokens are kept only as hashes: a database copy cannot be used to
--   act as anyone.
-- - Codes are single-use and live 5 minutes. Access tokens live 1 hour; refresh tokens rotate on every
--   use and presenting a used one ends that grant (it was copied).
-- - A disabled account's grants stop working at once (checked on every call).
-- - People see and revoke their own grants. Approving the same app again replaces its older grant.
-- Only the connector service's login (weft_mcp) can call these functions; nothing is exposed to the API.
-- Run with: psql -v mcp_svc_pw=...  (optional: without it the login's password is left unchanged)
set client_min_messages = warning;

do $$
begin
  if not exists (select from pg_roles where rolname = 'weft_mcp') then
    create role weft_mcp login noinherit;
  end if;
end $$;
\if :{?mcp_svc_pw}
alter role weft_mcp password :'mcp_svc_pw';
\endif

create table if not exists weft_private.mcp_clients (
  id            text primary key,
  secret_hash   text,                       -- null: a public client (PKCE only)
  name          text not null,
  redirect_uris text[] not null,
  created_at    timestamptz not null default now()
);

create table if not exists weft_private.mcp_grants (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references weft.users (id) on delete cascade,
  client_id    text not null references weft_private.mcp_clients (id) on delete cascade,
  access       text not null check (access in ('read', 'write')),
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
create index if not exists mcp_grants_user_idx on weft_private.mcp_grants (user_id);

create table if not exists weft_private.mcp_codes (
  code_hash      text primary key,
  client_id      text not null references weft_private.mcp_clients (id) on delete cascade,
  user_id        uuid not null references weft.users (id) on delete cascade,
  redirect_uri   text not null,
  code_challenge text not null,
  access         text not null check (access in ('read', 'write')),
  expires_at     timestamptz not null
);

create table if not exists weft_private.mcp_tokens (
  token_hash text primary key,
  grant_id   uuid not null references weft_private.mcp_grants (id) on delete cascade,
  kind       text not null check (kind in ('access', 'refresh')),
  expires_at timestamptz not null,
  used_at    timestamptz                    -- refresh tokens only: set when rotated
);
create index if not exists mcp_tokens_grant_idx on weft_private.mcp_tokens (grant_id);

-- ---------- clients (dynamic registration) ----------
create or replace function weft_private.mcp_client_register(p_id text, p_secret_hash text, p_name text, p_redirects text[])
returns void language sql security definer set search_path = weft, weft_private, pg_temp as $$
  insert into weft_private.mcp_clients (id, secret_hash, name, redirect_uris) values (p_id, p_secret_hash, p_name, p_redirects)
$$;

create or replace function weft_private.mcp_client(p_id text)
returns table (id text, secret_hash text, name text, redirect_uris text[])
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select c.id, c.secret_hash, c.name, c.redirect_uris from weft_private.mcp_clients c where c.id = p_id
$$;

-- ---------- the person's approval -> a single-use code ----------
create or replace function weft_private.mcp_code_create(p_hash text, p_client text, p_user uuid, p_redirect text, p_challenge text, p_access text)
returns void language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  if not exists (select 1 from weft.users u where u.id = p_user and not u.disabled and not u.is_assistant) then
    raise exception 'account not usable' using errcode = 'WD001';
  end if;
  insert into weft_private.mcp_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, access, expires_at)
  values (p_hash, p_client, p_user, p_redirect, p_challenge, p_access, now() + interval '5 minutes');
end $$;

-- Redeem a code (once). The service checks PKCE and the redirect against what comes back, then calls
-- mcp_grant_start. Deleting first means a second try with the same code finds nothing.
create or replace function weft_private.mcp_code_take(p_hash text)
returns table (client_id text, user_id uuid, redirect_uri text, code_challenge text, access text)
language sql security definer set search_path = weft, weft_private, pg_temp as $$
  delete from weft_private.mcp_codes c where c.code_hash = p_hash and c.expires_at > now()
  returning c.client_id, c.user_id, c.redirect_uri, c.code_challenge, c.access
$$;

-- A new grant with its first token pair. Older grants of the same person to the same app end.
create or replace function weft_private.mcp_grant_start(p_user uuid, p_client text, p_access text,
  p_access_hash text, p_refresh_hash text, p_access_ttl int, p_refresh_ttl int)
returns uuid language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare g uuid;
begin
  update weft_private.mcp_grants set revoked_at = now() where user_id = p_user and client_id = p_client and revoked_at is null;
  insert into weft_private.mcp_grants (user_id, client_id, access) values (p_user, p_client, p_access) returning id into g;
  insert into weft_private.mcp_tokens (token_hash, grant_id, kind, expires_at) values
    (p_access_hash, g, 'access', now() + make_interval(secs => p_access_ttl)),
    (p_refresh_hash, g, 'refresh', now() + make_interval(secs => p_refresh_ttl));
  return g;
end $$;

-- ---------- using an access token (every MCP request) ----------
create or replace function weft_private.mcp_token_use(p_hash text)
returns table (grant_id uuid, user_id uuid, access text, client_name text, display_name text)
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  return query
  update weft_private.mcp_grants g set last_used_at = now()
  from weft_private.mcp_tokens t, weft.users u, weft_private.mcp_clients c
  where t.token_hash = p_hash and t.kind = 'access' and t.expires_at > now()
    and g.id = t.grant_id and g.revoked_at is null
    and u.id = g.user_id and not u.disabled
    and c.id = g.client_id
  returning g.id, g.user_id, g.access, c.name, u.display_name;
end $$;

-- ---------- refreshing: rotate, and treat a reused refresh token as stolen ----------
create or replace function weft_private.mcp_refresh(p_old text, p_client text, p_access_hash text, p_refresh_hash text,
  p_access_ttl int, p_refresh_ttl int)
returns table (grant_id uuid, access text, replayed boolean)
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare t record;
begin
  select tk.grant_id, tk.used_at, tk.expires_at, g.access, g.client_id, g.revoked_at, u.disabled
    into t
  from weft_private.mcp_tokens tk join weft_private.mcp_grants g on g.id = tk.grant_id join weft.users u on u.id = g.user_id
  where tk.token_hash = p_old and tk.kind = 'refresh'
  for update of tk;
  if not found or t.client_id <> p_client or t.revoked_at is not null or t.disabled or t.expires_at <= now() then
    return;
  end if;
  if t.used_at is not null then
    update weft_private.mcp_grants x set revoked_at = now() where x.id = t.grant_id;
    return query select t.grant_id, t.access, true;
    return;
  end if;
  update weft_private.mcp_tokens x set used_at = now() where x.token_hash = p_old;
  delete from weft_private.mcp_tokens x where x.grant_id = t.grant_id and x.kind = 'access' and x.expires_at <= now();
  insert into weft_private.mcp_tokens (token_hash, grant_id, kind, expires_at) values
    (p_access_hash, t.grant_id, 'access', now() + make_interval(secs => p_access_ttl)),
    (p_refresh_hash, t.grant_id, 'refresh', now() + make_interval(secs => p_refresh_ttl));
  return query select t.grant_id, t.access, false;
end $$;

-- ---------- the person's own list of connected apps ----------
create or replace function weft_private.mcp_grants_of(p_user uuid)
returns table (id uuid, client_name text, access text, created_at timestamptz, last_used_at timestamptz)
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select g.id, c.name, g.access, g.created_at, g.last_used_at
  from weft_private.mcp_grants g join weft_private.mcp_clients c on c.id = g.client_id
  where g.user_id = p_user and g.revoked_at is null
    and exists (select 1 from weft_private.mcp_tokens t where t.grant_id = g.id and t.kind = 'refresh' and t.used_at is null and t.expires_at > now())
  order by g.created_at desc
$$;

create or replace function weft_private.mcp_grant_revoke(p_user uuid, p_grant uuid) returns boolean
language sql security definer set search_path = weft, weft_private, pg_temp as $$
  with r as (
    update weft_private.mcp_grants set revoked_at = now()
    where id = p_grant and user_id = p_user and revoked_at is null returning 1
  ) select exists (select 1 from r)
$$;

-- Housekeeping, run hourly by the service: expired codes and tokens, and registrations nobody ever used.
create or replace function weft_private.mcp_cleanup() returns void
language sql security definer set search_path = weft, weft_private, pg_temp as $$
  delete from weft_private.mcp_codes where expires_at < now();
  delete from weft_private.mcp_tokens where expires_at < now() - interval '1 day';
  delete from weft_private.mcp_clients c where c.created_at < now() - interval '1 day'
    and not exists (select 1 from weft_private.mcp_grants g where g.client_id = c.id);
$$;

revoke all on weft_private.mcp_clients, weft_private.mcp_grants, weft_private.mcp_codes, weft_private.mcp_tokens from public;
revoke execute on function
  weft_private.mcp_client_register(text, text, text, text[]), weft_private.mcp_client(text),
  weft_private.mcp_code_create(text, text, uuid, text, text, text), weft_private.mcp_code_take(text),
  weft_private.mcp_grant_start(uuid, text, text, text, text, int, int), weft_private.mcp_token_use(text),
  weft_private.mcp_refresh(text, text, text, text, int, int), weft_private.mcp_grants_of(uuid),
  weft_private.mcp_grant_revoke(uuid, uuid), weft_private.mcp_cleanup()
  from public;
grant usage on schema weft_private to weft_mcp;
grant execute on function
  weft_private.mcp_client_register(text, text, text, text[]), weft_private.mcp_client(text),
  weft_private.mcp_code_create(text, text, uuid, text, text, text), weft_private.mcp_code_take(text),
  weft_private.mcp_grant_start(uuid, text, text, text, text, int, int), weft_private.mcp_token_use(text),
  weft_private.mcp_refresh(text, text, text, text, int, int), weft_private.mcp_grants_of(uuid),
  weft_private.mcp_grant_revoke(uuid, uuid), weft_private.mcp_cleanup()
  to weft_mcp;
