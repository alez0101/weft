-- 076 agent keys: anyone can connect their own AI agent (any MCP client: Claude Code, Hermes Agent, OpenClaw...)
-- with a key, from Connected apps, without an admin and without the consent-screen sign-in that not every agent
-- can do. A key is a grant like Claude's (always an AI-app token: reads what the person can see, writes only in
-- their Personal space, never deletes) with one long-lived access token and no refresh token. It is shown once
-- and stored hashed; the person disconnects it from Connected apps.
set client_min_messages = warning;

create or replace function weft_private.mcp_key_create(p_user uuid, p_name text, p_access text, p_hash text, p_days int)
returns uuid language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare cid text := 'key-' || gen_random_uuid()::text; g uuid;
begin
  if p_access not in ('read', 'write') then raise exception 'access must be read or write' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_name, ''))) not between 1 and 60 then raise exception 'name it in 1 to 60 characters' using errcode = '22023'; end if;
  if exists (select 1 from weft.users where id = p_user and disabled) then raise exception 'account disabled' using errcode = '42501'; end if;
  if (select count(*) from weft_private.mcp_grants g join weft_private.mcp_clients c on c.id = g.client_id
       where g.user_id = p_user and g.revoked_at is null and c.id like 'key-%') >= 20 then
    raise exception 'You already have 20 keys. Disconnect one first.' using errcode = '54000';
  end if;
  insert into weft_private.mcp_clients (id, secret_hash, name, redirect_uris) values (cid, null, btrim(p_name), '{}');
  insert into weft_private.mcp_grants (user_id, client_id, access) values (p_user, cid, p_access) returning id into g;
  insert into weft_private.mcp_tokens (token_hash, grant_id, kind, expires_at)
    values (p_hash, g, 'access', now() + make_interval(days => greatest(1, least(p_days, 365))));
  return g;
end $$;

-- Connected apps lists keys too (agent-% from 075, key-% here): a live access token, no refresh token.
create or replace function weft_private.mcp_grants_of(p_user uuid)
returns table (id uuid, client_name text, access text, created_at timestamptz, last_used_at timestamptz)
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select g.id, c.name, g.access, g.created_at, g.last_used_at
  from weft_private.mcp_grants g join weft_private.mcp_clients c on c.id = g.client_id
  where g.user_id = p_user and g.revoked_at is null
    and (exists (select 1 from weft_private.mcp_tokens t where t.grant_id = g.id and t.kind = 'refresh' and t.used_at is null and t.expires_at > now())
      or ((c.id like 'agent-%' or c.id like 'key-%') and exists (select 1 from weft_private.mcp_tokens t where t.grant_id = g.id and t.kind = 'access' and t.expires_at > now())))
  order by g.created_at desc
$$;

revoke execute on function weft_private.mcp_key_create(uuid, text, text, text, int) from public, weft_user, weft_assistant;
grant execute on function weft_private.mcp_key_create(uuid, text, text, text, int) to weft_mcp;
