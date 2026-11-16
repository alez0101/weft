-- 075 later options:
--  1. Assistant limits set in Settings (how much it reads, rounds, memory, reply length, web searches), as a JSON
--     object of overrides; the service keeps the defaults and the allowed ranges.
--  2. A connector key for a personal agent: an admin gives the agent its own grant for its OWNER, the same kind
--     of grant Claude gets from the consent screen (always an AI-app token: Personal-only writes, no deletes),
--     with one long-lived access token and no refresh token. The owner sees it under Connected apps and can
--     disconnect it; removing the agent revokes it.
set client_min_messages = warning;

alter table weft_private.assistant_settings add column if not exists limits jsonb not null default '{}'::jsonb;

create or replace function weft_private.limits_get() returns jsonb
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select coalesce((select limits from weft_private.assistant_settings), '{}'::jsonb)
$$;

create or replace function weft_private.limits_save(p_by uuid, p_limits jsonb) returns void
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  if not weft_private.assist_is_admin(p_by) then raise exception 'admins only' using errcode = '42501'; end if;
  if jsonb_typeof(p_limits) <> 'object' then raise exception 'limits must be an object' using errcode = '22023'; end if;
  update weft_private.assistant_settings set limits = p_limits, updated_at = now(), updated_by = p_by;
end $$;

alter table weft_private.agents add column if not exists mcp_grant_id uuid references weft_private.mcp_grants (id) on delete set null;

-- Give an agent a connector key: a client row for it (no redirect addresses: it never signs in through the
-- consent screen), a write grant for its owner and one access token (stored hashed). An earlier key is revoked.
create or replace function weft_private.agent_connect(p_by uuid, p_agent uuid, p_token_hash text, p_days int)
returns uuid language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare a record; g uuid; cid text;
begin
  if not weft_private.assist_is_admin(p_by) then raise exception 'admins only' using errcode = '42501'; end if;
  select ag.id, ag.owner_id, ag.mcp_grant_id, u.display_name into a
    from weft_private.agents ag join weft.users u on u.id = ag.id where ag.id = p_agent;
  if a.id is null then raise exception 'no such agent' using errcode = '22023'; end if;
  if a.mcp_grant_id is not null then update weft_private.mcp_grants set revoked_at = now() where id = a.mcp_grant_id and revoked_at is null; end if;
  cid := 'agent-' || p_agent::text;
  insert into weft_private.mcp_clients (id, secret_hash, name, redirect_uris) values (cid, null, a.display_name, '{}')
    on conflict (id) do update set name = excluded.name;
  insert into weft_private.mcp_grants (user_id, client_id, access) values (a.owner_id, cid, 'write') returning id into g;
  insert into weft_private.mcp_tokens (token_hash, grant_id, kind, expires_at) values (p_token_hash, g, 'access', now() + make_interval(days => greatest(1, least(p_days, 730))));
  update weft_private.agents set mcp_grant_id = g where id = p_agent;
  return g;
end $$;

create or replace function weft_private.agent_disconnect(p_by uuid, p_agent uuid) returns void
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  if not weft_private.assist_is_admin(p_by) then raise exception 'admins only' using errcode = '42501'; end if;
  update weft_private.mcp_grants set revoked_at = now()
   where id = (select mcp_grant_id from weft_private.agents where id = p_agent) and revoked_at is null;
  update weft_private.agents set mcp_grant_id = null where id = p_agent;
end $$;

-- Removing an agent revokes its key; so does giving it to another owner (the grant acts for the old one).
create or replace function weft_private.agent_delete(p_id uuid) returns void
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  update weft_private.mcp_grants set revoked_at = now()
   where id = (select mcp_grant_id from weft_private.agents where id = p_id) and revoked_at is null;
  delete from weft.spaces where agent_id = p_id;
  delete from weft_private.agents where id = p_id;
  if not found then raise exception 'no such agent' using errcode = 'WD005'; end if;
  update weft.users set display_name = display_name || ' (removed)' where id = p_id and is_assistant and display_name not like '% (removed)';
end $$;

create or replace function weft_private.agent_owner_changed() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  if new.owner_id is distinct from old.owner_id and old.mcp_grant_id is not null then
    update weft_private.mcp_grants set revoked_at = now() where id = old.mcp_grant_id and revoked_at is null;
    new.mcp_grant_id := null;
  end if;
  return new;
end $$;
drop trigger if exists agent_owner_changed on weft_private.agents;
create trigger agent_owner_changed before update of owner_id on weft_private.agents for each row execute function weft_private.agent_owner_changed();

-- Whether each agent's key is live, and until when (for the admin screen).
create or replace function weft_private.agent_connections()
returns table (agent_id uuid, connected boolean, expires_at timestamptz, last_used_at timestamptz)
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select ag.id, g.id is not null and g.revoked_at is null and exists (select 1 from weft_private.mcp_tokens t where t.grant_id = g.id and t.kind = 'access' and t.expires_at > now()),
         (select max(t.expires_at) from weft_private.mcp_tokens t where t.grant_id = g.id and t.kind = 'access'), g.last_used_at
    from weft_private.agents ag left join weft_private.mcp_grants g on g.id = ag.mcp_grant_id
$$;

revoke execute on function weft_private.limits_get(), weft_private.limits_save(uuid, jsonb),
  weft_private.agent_connect(uuid, uuid, text, int), weft_private.agent_disconnect(uuid, uuid), weft_private.agent_connections()
  from public, weft_user, weft_assistant;
grant execute on function weft_private.limits_get(), weft_private.limits_save(uuid, jsonb),
  weft_private.agent_connect(uuid, uuid, text, int), weft_private.agent_disconnect(uuid, uuid), weft_private.agent_connections()
  to weft_assist;

-- 3. @Weft may propose changing an existing spreadsheet (add rows, set cells): proposal kind edit_sheet.
alter table weft_private.proposals drop constraint if exists proposals_kind_check;
alter table weft_private.proposals add constraint proposals_kind_check
  check (kind in ('send', 'change', 'create', 'create_item', 'edit_page', 'add_rows', 'add_tasks', 'edit_sheet'));
create or replace function weft_private.proposal_statuses(p_asker uuid, p_ids uuid[])
returns table (id uuid, status text, result text, kind text, item_id uuid)
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select p.id, p.status, p.result, p.kind,
         case when p.status = 'done' and p.kind in ('create_item', 'edit_page', 'add_rows', 'add_tasks', 'edit_sheet')
              then coalesce(p.before ->> 'item_id', p.payload ->> 'item_id')::uuid end
    from weft_private.proposals p where p.asker = p_asker and p.id = any (p_ids)
$$;

-- Connected apps also lists an agent's key (it has a long-lived access token and no refresh token).
create or replace function weft_private.mcp_grants_of(p_user uuid)
returns table (id uuid, client_name text, access text, created_at timestamptz, last_used_at timestamptz)
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select g.id, c.name, g.access, g.created_at, g.last_used_at
  from weft_private.mcp_grants g join weft_private.mcp_clients c on c.id = g.client_id
  where g.user_id = p_user and g.revoked_at is null
    and (exists (select 1 from weft_private.mcp_tokens t where t.grant_id = g.id and t.kind = 'refresh' and t.used_at is null and t.expires_at > now())
      or (c.id like 'agent-%' and exists (select 1 from weft_private.mcp_tokens t where t.grant_id = g.id and t.kind = 'access' and t.expires_at > now())))
  order by g.created_at desc
$$;
