-- 003 access: one rule (member of the item's space), enforced by row-level security.
--
-- Roles inside a space:  viewer  read + chat
--                        editor  + create and change documents, wiki pages and events
--                        owner   + manage the space and its members
-- The optional scope_space claim narrows any token to one space; it is applied inside
-- is_member(), so every policy honours it without saying so.

-- ---------- helpers (security definer: they read members without recursing into RLS) ----------
create or replace function weft_private.member_role(s uuid) returns text
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select m.role
  from weft.members m
  where m.space_id = s
    and m.user_id = weft_private.uid()
    and (weft_private.scope_space() is null or s = weft_private.scope_space())
$$;

create or replace function weft_private.is_member(s uuid) returns boolean
language sql stable as $$ select weft_private.member_role(s) is not null $$;

create or replace function weft_private.can_edit(s uuid) returns boolean
language sql stable as $$ select coalesce(weft_private.member_role(s) in ('owner', 'editor'), false) $$;

create or replace function weft_private.is_owner(s uuid) returns boolean
language sql stable as $$ select coalesce(weft_private.member_role(s) = 'owner', false) $$;

-- Another user is visible if you share a space with them (inside the token's scope, if any).
create or replace function weft_private.shares_space(other uuid) returns boolean
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select exists (
    select 1
    from weft.members mine
    join weft.members theirs on theirs.space_id = mine.space_id
    where mine.user_id = weft_private.uid()
      and theirs.user_id = other
      and (weft_private.scope_space() is null or mine.space_id = weft_private.scope_space())
  )
$$;

-- ---------- privileges ----------
revoke all on schema weft_private from public;
revoke execute on all functions in schema weft_private from public;
grant usage on schema weft_private to weft_user, weft_assistant;
grant execute on all functions in schema weft_private to weft_user, weft_assistant;

revoke all on all tables in schema weft from public, weft_anon, weft_user, weft_assistant;
grant usage on schema weft to weft_user, weft_assistant;   -- weft_anon gets nothing at all

grant select on weft.users, weft.spaces, weft.members, weft.messages, weft.items, weft.events, weft.audit
  to weft_user, weft_assistant;

-- People: chat, documents, events, and managing their own spaces.
grant insert (kind, name) on weft.spaces to weft_user;
grant update (name) on weft.spaces to weft_user;
grant delete on weft.spaces to weft_user;
grant insert (space_id, user_id, role), update (role), delete on weft.members to weft_user;
grant insert (space_id, body, thread_root_id) on weft.messages to weft_user;
grant update (body, edited_at) on weft.messages to weft_user;
grant delete on weft.messages to weft_user;
grant insert (space_id, kind, title, parent_id, ydoc, body_text) on weft.items to weft_user;
grant update (space_id, title, parent_id, ydoc, body_text) on weft.items to weft_user;
grant delete on weft.items to weft_user;
grant insert (space_id, title, starts_at, ends_at, location, item_id) on weft.events to weft_user;
grant update (space_id, title, starts_at, ends_at, location, item_id) on weft.events to weft_user;
grant delete on weft.events to weft_user;

-- The assistant: read, send messages, change events. Never delete; never touch documents
-- (a row update would overwrite a live Yjs document). Change and send wait for the user's
-- confirmation in the app; the database bounds what is possible at all.
grant insert (space_id, author_id, body, thread_root_id) on weft.messages to weft_assistant;
grant update (title, starts_at, ends_at, location) on weft.events to weft_assistant;

-- ---------- row-level security ----------
do $$
declare t text;
begin
  foreach t in array array['users', 'spaces', 'members', 'messages', 'items', 'events', 'audit'] loop
    execute format('alter table weft.%I enable row level security', t);
    execute format('alter table weft.%I force row level security', t);
  end loop;
end $$;

-- Drop and recreate so the file can be re-run.
do $$
declare p record;
begin
  for p in select policyname, tablename from pg_policies where schemaname = 'weft' loop
    execute format('drop policy %I on weft.%I', p.policyname, p.tablename);
  end loop;
end $$;

-- users
create policy users_read on weft.users for select to weft_user, weft_assistant
  using (id = weft_private.uid() or is_assistant or weft_private.shares_space(id));

-- spaces
create policy spaces_read on weft.spaces for select to weft_user, weft_assistant
  using (weft_private.is_member(id));
create policy spaces_create on weft.spaces for insert to weft_user
  with check (created_by = weft_private.uid() and kind in ('channel', 'dm'));
create policy spaces_rename on weft.spaces for update to weft_user
  using (weft_private.is_owner(id)) with check (weft_private.is_owner(id));
create policy spaces_delete on weft.spaces for delete to weft_user
  using (weft_private.is_owner(id) and kind <> 'personal');

-- members
create policy members_read on weft.members for select to weft_user, weft_assistant
  using (weft_private.is_member(space_id));
create policy members_add on weft.members for insert to weft_user
  with check (weft_private.is_owner(space_id));
create policy members_change on weft.members for update to weft_user
  using (weft_private.is_owner(space_id)) with check (weft_private.is_owner(space_id));
create policy members_remove on weft.members for delete to weft_user
  using (weft_private.is_owner(space_id) or user_id = weft_private.uid());

-- messages
create policy messages_read on weft.messages for select to weft_user, weft_assistant
  using (weft_private.is_member(space_id));
create policy messages_post on weft.messages for insert to weft_user
  with check (
    author_id = weft_private.uid()
    and weft_private.is_member(space_id)
    and (thread_root_id is null or exists (
      select 1 from weft.messages r where r.id = messages.thread_root_id and r.space_id = messages.space_id))
  );
create policy messages_post_assistant on weft.messages for insert to weft_assistant
  with check (
    author_id = weft_private.assistant_id()
    and weft_private.is_member(space_id)
    and (thread_root_id is null or exists (
      select 1 from weft.messages r where r.id = messages.thread_root_id and r.space_id = messages.space_id))
  );
create policy messages_edit on weft.messages for update to weft_user
  using (author_id = weft_private.uid() and weft_private.is_member(space_id))
  with check (author_id = weft_private.uid() and weft_private.is_member(space_id));
create policy messages_delete on weft.messages for delete to weft_user
  using ((author_id = weft_private.uid() and weft_private.is_member(space_id)) or weft_private.is_owner(space_id));

-- items (documents and wiki pages)
create policy items_read on weft.items for select to weft_user, weft_assistant
  using (weft_private.is_member(space_id));
create policy items_create on weft.items for insert to weft_user
  with check (
    created_by = weft_private.uid()
    and weft_private.can_edit(space_id)
    and (parent_id is null or exists (
      select 1 from weft.items p where p.id = items.parent_id and p.space_id = items.space_id))
  );
create policy items_edit on weft.items for update to weft_user
  using (weft_private.can_edit(space_id))
  with check (
    weft_private.can_edit(space_id)
    and (parent_id is null or exists (
      select 1 from weft.items p where p.id = items.parent_id and p.space_id = items.space_id))
  );
create policy items_delete on weft.items for delete to weft_user
  using (weft_private.can_edit(space_id));

-- events
create policy events_read on weft.events for select to weft_user, weft_assistant
  using (weft_private.is_member(space_id));
create policy events_create on weft.events for insert to weft_user
  with check (created_by = weft_private.uid() and weft_private.can_edit(space_id));
create policy events_edit on weft.events for update to weft_user, weft_assistant
  using (weft_private.can_edit(space_id)) with check (weft_private.can_edit(space_id));
create policy events_delete on weft.events for delete to weft_user
  using (weft_private.can_edit(space_id));

-- audit: read-only, members of the space the row belonged to. Written only by triggers (004).
create policy audit_read on weft.audit for select to weft_user, weft_assistant
  using (weft_private.is_member(space_id));
