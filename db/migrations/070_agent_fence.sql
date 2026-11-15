-- 070 agent fence: outside AI agents read, people move.
--
--   * A token minted for an outside agent (the connector for AI apps, or the assistant service fetching context
--     for someone's personal agent) carries the claim agent = true.
--   * Such a token never writes outside the person's personal space: PostgREST runs weft_private.pre_request()
--     before every request, and it refuses any write (anything but GET or HEAD) from an agent token unless the
--     token is also scoped (scope_space) to that person's own personal space. The scope claim then narrows every
--     policy to that space, as it does for @Weft in a channel. So the fence does not depend on the agent, or on
--     the connector, behaving: the database refuses.
--   * Owners can close a channel to agents (space_rules.agents_may_read = false, from 069). For an agent token,
--     member_role() then returns nothing for that space, so it is invisible on every path, like a space the
--     person is not in.
--   * A personal agent's replies (written by the assistant service as the agent) are allowed only in the owner's
--     personal space and in conversations with the agent; never in a channel or direct message.
set client_min_messages = warning;

create or replace function weft_private.via_agent() returns boolean
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'agent', '') = 'true'
$$;

-- The one rule, plus: an agent token is a member of nothing that is closed to agents.
create or replace function weft_private.member_role(s uuid) returns text
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select m.role
  from weft.members m
  join weft.users u on u.id = m.user_id and not u.disabled
  where m.space_id = s
    and m.user_id = weft_private.uid()
    and (weft_private.scope_space() is null or s = weft_private.scope_space())
    and (not weft_private.via_agent()
         or not exists (select 1 from weft.space_rules r where r.space_id = s and not r.agents_may_read))
$$;

-- Is the token scoped to the caller's own personal space?
create or replace function weft_private.agent_write_ok() returns boolean
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select weft_private.scope_space() is not null and exists (
    select 1 from weft.spaces s join weft.members m on m.space_id = s.id
    where s.id = weft_private.scope_space() and s.kind = 'personal'
      and m.user_id = weft_private.uid() and m.role = 'owner')
$$;

create or replace function weft_private.pre_request() returns void
language plpgsql stable as $$
begin
  if weft_private.via_agent()
     and coalesce(current_setting('request.method', true), 'GET') not in ('GET', 'HEAD')
     -- the two search functions only read, but are called with POST (a query vector is long)
     and coalesce(current_setting('request.path', true), '') not in ('/rpc/search', '/rpc/semantic_search')
     and not weft_private.agent_write_ok() then
    raise exception 'AI apps can only make changes in your personal space; move things into a channel yourself'
      using errcode = '42501';
  end if;
end $$;

-- PostgREST runs pre_request() for requests without a token too (as weft_anon), so weft_anon needs to reach
-- this one function. Usage on the schema lets it look names up; PostgREST still exposes only schema weft, so
-- anonymous callers can call nothing here.
grant usage on schema weft_private to weft_anon;
revoke execute on function weft_private.agent_write_ok(), weft_private.pre_request() from public;
grant execute on function weft_private.via_agent(), weft_private.agent_write_ok(), weft_private.pre_request()
  to weft_user, weft_assistant, weft_anon;

-- A personal agent answers only in private places.
drop policy if exists messages_post_agent on weft.messages;
create policy messages_post_agent on weft.messages for insert to weft_assistant
  with check (
    author_id <> weft_private.assistant_id()
    and weft_private.is_my_agent(author_id)
    and weft_private.is_member(space_id)
    and exists (select 1 from weft.spaces s where s.id = messages.space_id and s.kind in ('personal', 'agent'))
    and (thread_root_id is null or exists (
      select 1 from weft.messages r where r.id = messages.thread_root_id and r.space_id = messages.space_id))
  );
