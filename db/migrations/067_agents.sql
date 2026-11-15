-- 067 personal agents: bring someone's own AI agent (any OpenAI-compatible chat endpoint, such as a
-- self-hosted Hermes Agent) into Weft and talk to it.
--   * An admin adds an agent and says whose it is. Only admins set its address, so nobody else can make
--     Weft call an address of their choosing (the same rule as the model settings).
--   * The agent has a user row (is_assistant = true), so its replies have an author with a name, and every
--     existing rule about the assistant applies to it: it cannot sign in, is not in people lists, and its
--     messages are not indexed for search by meaning.
--   * Its owner talks to it in conversations of their own: spaces of kind 'agent', one person (the owner)
--     as owner member, as many as they like. Each conversation is its own thread on the agent's side.
--   * The owner can also @mention it in a channel or direct message they are in; it answers there.
--   * Only the owner can start a conversation with it or ask it anything. Its replies are written by the
--     assistant service with a token for the owner, and a policy checks the author really is the owner's
--     agent, so nobody can post as somebody else's agent.
--   * The address and key live in weft_private (never exposed through the API); the key is encrypted by the
--     assistant service, like model keys.
set client_min_messages = warning;

-- ---------- conversations ----------
alter table weft.spaces add column if not exists agent_id uuid references weft.users (id) on delete cascade;
alter table weft.spaces drop constraint if exists spaces_kind_check;
alter table weft.spaces add constraint spaces_kind_check check (kind in ('channel', 'dm', 'personal', 'assistant', 'agent'));
alter table weft.spaces drop constraint if exists spaces_agent_kind;
alter table weft.spaces add constraint spaces_agent_kind check ((kind = 'agent') = (agent_id is not null));
alter table weft.spaces drop constraint if exists spaces_agent_name_len;
alter table weft.spaces add constraint spaces_agent_name_len check (kind <> 'agent' or length(btrim(name)) between 1 and 80);
create index if not exists spaces_agent_idx on weft.spaces (agent_id) where agent_id is not null;
grant select (agent_id) on weft.spaces to weft_user, weft_assistant;
-- Renaming and deleting a conversation go through the existing owner policies (spaces_rename, spaces_delete).

-- ---------- the agents ----------
create table if not exists weft_private.agents (
  id              uuid primary key references weft.users (id) on delete cascade,  -- the agent's user row
  owner_id        uuid not null references weft.users (id) on delete cascade,
  handle          text not null unique check (handle ~ '^[a-z][a-z0-9-]{1,29}$' and handle <> 'weft'),
  base_url        text not null check (base_url ~ '^https?://[^\s/]+'),
  model           text not null default 'hermes-agent' check (length(model) between 1 and 200),
  key_ciphertext  text,          -- AES-256-GCM, encrypted by the assistant service
  key_hint        text,
  enabled         boolean not null default true,
  last_used_at    timestamptz,
  last_error      text,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists agents_owner_idx on weft_private.agents (owner_id);

-- Is p the caller's own enabled agent? (Used by the reply policy below.)
create or replace function weft_private.is_my_agent(p uuid) returns boolean
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select exists (select 1 from weft_private.agents a join weft.users o on o.id = a.owner_id
                 where a.id = p and a.owner_id = weft_private.uid() and a.enabled and not o.disabled)
$$;
revoke execute on function weft_private.is_my_agent(uuid) from public;
grant execute on function weft_private.is_my_agent(uuid) to weft_user, weft_assistant;

-- The agent's reply: written with a weft_assistant token for the owner, in a space the owner is a member
-- of (is_member applies the channel scope and disabled accounts).
drop policy if exists messages_post_agent on weft.messages;
create policy messages_post_agent on weft.messages for insert to weft_assistant
  with check (
    author_id <> weft_private.assistant_id()
    and weft_private.is_my_agent(author_id)
    and weft_private.is_member(space_id)
    and (thread_root_id is null or exists (
      select 1 from weft.messages r where r.id = messages.thread_root_id and r.space_id = messages.space_id))
  );

-- ---------- what the owner sees ----------
-- Their own agents: name, handle (for @mentions) and whether it is on. Never the address or key.
create or replace function weft.my_agents() returns table (id uuid, display_name text, handle text, enabled boolean)
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select a.id, u.display_name, a.handle, a.enabled
  from weft_private.agents a join weft.users u on u.id = a.id
  where a.owner_id = weft_private.uid()
    and coalesce(current_setting('request.jwt.claims', true)::json ->> 'role', '') = 'weft_user'
  order by lower(u.display_name)
$$;
revoke execute on function weft.my_agents() from public;
grant execute on function weft.my_agents() to weft_user;

-- A new conversation with one of your agents. Returns its id (an insert could not: the creator becomes
-- owner in an after-trigger, so RLS hides the row at RETURNING time).
create or replace function weft.create_agent_conversation(p_agent uuid, p_name text default null) returns uuid
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare v uuid; v_name text := left(btrim(coalesce(nullif(btrim(coalesce(p_name, '')), ''), 'New conversation')), 80);
begin
  if weft_private.uid() is null or coalesce(current_setting('request.jwt.claims', true)::json ->> 'role', '') <> 'weft_user'
     or weft_private.scope_space() is not null
     or not exists (select 1 from weft.users u where u.id = weft_private.uid() and not u.disabled and not u.is_assistant) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not weft_private.is_my_agent(p_agent) then
    raise exception 'that is not one of your agents' using errcode = '42501';
  end if;
  insert into weft.spaces (kind, name, created_by, agent_id) values ('agent', v_name, weft_private.uid(), p_agent) returning id into v;
  return v;
end $$;
revoke execute on function weft.create_agent_conversation(uuid, text) from public;
grant execute on function weft.create_agent_conversation(uuid, text) to weft_user;

-- ---------- for the assistant service (admin screen and asking) ----------
-- Add or change an agent. p_id null = new: makes its user row. Returns the agent id.
create or replace function weft_private.agent_save(p_id uuid, p_owner uuid, p_name text, p_handle text, p_base_url text,
  p_model text, p_enabled boolean, p_by uuid) returns uuid
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare v uuid := p_id;
begin
  if not exists (select 1 from weft.users u where u.id = p_owner and not u.is_assistant) then
    raise exception 'no such person' using errcode = 'WD005';
  end if;
  if length(btrim(coalesce(p_name, ''))) not between 1 and 60 then
    raise exception 'a name is 1 to 60 characters' using errcode = '22023';
  end if;
  if v is null then
    v := gen_random_uuid();
    insert into weft.users (id, email, display_name, is_assistant) values (v, 'agent-' || v || '@agents.invalid', btrim(p_name), true);
    insert into weft_private.agents (id, owner_id, handle, base_url, model, enabled, created_by)
      values (v, p_owner, lower(btrim(p_handle)), btrim(p_base_url), coalesce(nullif(btrim(p_model), ''), 'hermes-agent'), coalesce(p_enabled, true), p_by);
  else
    update weft_private.agents set owner_id = p_owner, handle = lower(btrim(p_handle)), base_url = btrim(p_base_url),
      model = coalesce(nullif(btrim(p_model), ''), 'hermes-agent'), enabled = coalesce(p_enabled, true), updated_at = now()
      where id = v;
    if not found then raise exception 'no such agent' using errcode = 'WD005'; end if;
    update weft.users set display_name = btrim(p_name) where id = v and is_assistant;
    -- A new owner does not inherit the old owner's conversations: those are removed.
    delete from weft.spaces s where s.agent_id = v and s.created_by <> p_owner;
  end if;
  return v;
end $$;

-- Remove an agent: its conversations go with it. Replies it left in channels stay, under its name.
create or replace function weft_private.agent_delete(p_id uuid) returns void
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  delete from weft.spaces where agent_id = p_id;
  delete from weft_private.agents where id = p_id;
  if not found then raise exception 'no such agent' using errcode = 'WD005'; end if;
  update weft.users set display_name = display_name || ' (removed)' where id = p_id and is_assistant and display_name not like '% (removed)';
end $$;

-- Every agent with its owner and name, for the admin screen and for asking (the key stays ciphertext).
create or replace function weft_private.agents_list() returns table (id uuid, display_name text, handle text, owner_id uuid,
  owner_name text, owner_disabled boolean, base_url text, model text, key_ciphertext text, key_hint text, enabled boolean,
  last_used_at timestamptz, last_error text, updated_at timestamptz)
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select a.id, u.display_name, a.handle, a.owner_id, o.display_name, o.disabled, a.base_url, a.model, a.key_ciphertext,
         a.key_hint, a.enabled, a.last_used_at, a.last_error, a.updated_at
  from weft_private.agents a join weft.users u on u.id = a.id join weft.users o on o.id = a.owner_id
  order by lower(u.display_name)
$$;

revoke execute on function weft_private.agent_save(uuid, uuid, text, text, text, text, boolean, uuid),
  weft_private.agent_delete(uuid), weft_private.agents_list() from public, weft_user, weft_assistant;
grant execute on function weft_private.agent_save(uuid, uuid, text, text, text, text, boolean, uuid),
  weft_private.agent_delete(uuid), weft_private.agents_list() to weft_assist;
grant select, update (key_ciphertext, key_hint, last_used_at, last_error, updated_at) on weft_private.agents to weft_assist;
