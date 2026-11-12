-- 017 wikis kept in the repo: the help wiki (everyone reads) and the Weft admin wiki (admins only).
--
-- - Pages that come from the repo (docs/help, docs/admin) are "managed": tools/sync_wikis.py writes them
--   as the database owner, and nobody can change, move or delete them in the app (the repo is the source;
--   publish again to change them). People can still add their own pages under them.
-- - An admins-only space has exactly the active admins as members, kept in step by
--   sync_admin_spaces() whenever someone signs in or an admin changes an account. Nobody can add, remove
--   or re-role members of it by hand, and it has no owner, so nobody can rename or delete it.
-- - Everyone spaces (help) and admins-only spaces cannot be renamed or deleted from the app.
set client_min_messages = warning;

alter table weft.spaces add column if not exists admins_only boolean not null default false;
alter table weft.items  add column if not exists managed boolean not null default false;

-- ---------- managed pages are read-only in the app ----------
create or replace function weft_private.managed_guard() returns trigger
language plpgsql set search_path = weft, weft_private, pg_temp as $$
begin
  if old.managed and current_user in ('weft_user', 'weft_assistant') then
    raise exception 'this page is kept in the Weft repo; change it there and publish' using errcode = 'WD006';
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists items_managed_guard on weft.items;
create trigger items_managed_guard before update or delete on weft.items
  for each row execute function weft_private.managed_guard();

-- ---------- spaces the system keeps ----------
create or replace function weft_private.system_space_guard() returns trigger
language plpgsql set search_path = weft, weft_private, pg_temp as $$
begin
  if (old.everyone or old.admins_only) and current_user in ('weft_user', 'weft_assistant') then
    raise exception 'this channel is kept by Weft and cannot be renamed or deleted' using errcode = 'WD007';
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists spaces_system_guard on weft.spaces;
create trigger spaces_system_guard before update or delete on weft.spaces
  for each row execute function weft_private.system_space_guard();

create or replace function weft_private.admins_only_members_guard() returns trigger
language plpgsql set search_path = weft, weft_private, pg_temp as $$
declare s uuid := coalesce(new.space_id, old.space_id);
begin
  if current_user in ('weft_user', 'weft_assistant')
     and exists (select 1 from weft.spaces where id = s and admins_only) then
    raise exception 'members of this channel follow the admin setting' using errcode = 'WD008';
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists members_admins_only_guard on weft.members;
create trigger members_admins_only_guard before insert or update or delete on weft.members
  for each row execute function weft_private.admins_only_members_guard();

-- The last-owner rule does not apply to spaces Weft keeps itself.
create or replace function weft_private.keep_an_owner() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  if old.role <> 'owner' or (tg_op = 'UPDATE' and new.role = 'owner') then return coalesce(new, old); end if;
  if not exists (select 1 from weft.spaces s where s.id = old.space_id and s.kind = 'channel' and not s.everyone and not s.admins_only) then
    return coalesce(new, old);
  end if;
  if not exists (select 1 from weft.members m where m.space_id = old.space_id and m.role = 'owner' and m.user_id <> old.user_id) then
    raise exception 'a channel needs an owner: make someone else owner first' using errcode = 'WD004';
  end if;
  return coalesce(new, old);
end $$;

-- ---------- admins-only membership follows the admin flag ----------
create or replace function weft_private.sync_admin_spaces(p_user uuid) returns void
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  if exists (select 1 from weft.users u where u.id = p_user and u.is_admin and not u.disabled and not u.is_assistant) then
    insert into weft.members (space_id, user_id, role)
    select s.id, p_user, 'editor' from weft.spaces s where s.admins_only
    on conflict (space_id, user_id) do update set role = 'editor';
  else
    delete from weft.members m using weft.spaces s where s.id = m.space_id and s.admins_only and m.user_id = p_user;
  end if;
end $$;

create or replace function weft_private.provision_user(p_email text, p_name text, p_bootstrap boolean)
returns table (id uuid, display_name text)
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare v_id uuid; v_disabled boolean;
begin
  select u.id, u.disabled into v_id, v_disabled from weft.users u where lower(u.email) = lower(p_email) and not u.is_assistant;
  if v_disabled then raise exception 'account disabled' using errcode = 'WD001'; end if;
  if v_id is null then
    insert into weft.users (email, display_name) values (lower(p_email), p_name) returning users.id into v_id;
    insert into weft.spaces (kind, name, created_by) values ('personal', 'Personal', v_id);
  end if;
  update weft.users set last_seen_at = now() where users.id = v_id;
  perform weft_private.assistant_space(v_id);
  insert into weft.members (space_id, user_id, role)
  select s.id, v_id, 'viewer' from weft.spaces s where s.everyone
  on conflict (space_id, user_id) do nothing;
  if p_bootstrap then
    update weft.users set is_admin = true where users.id = v_id;
    insert into weft.members (space_id, user_id, role)
    select s.id, v_id, 'owner' from weft.spaces s where s.kind = 'channel' and not s.admins_only
    on conflict (space_id, user_id) do update set role = 'owner';
  end if;
  perform weft_private.sync_admin_spaces(v_id);
  return query select u.id, u.display_name from weft.users u where u.id = v_id;
end $$;

create or replace function weft.admin_set_user(p_user uuid, p_is_admin boolean default null, p_disabled boolean default null)
returns table (id uuid, is_admin boolean, disabled boolean)
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare me uuid := weft_private.uid(); target weft.users;
begin
  if not weft_private.assist_is_admin(me) or weft_private.scope_space() is not null then
    raise exception 'admins only' using errcode = '42501';
  end if;
  select * into target from weft.users u where u.id = p_user;
  if target.id is null or target.is_assistant then raise exception 'no such account' using errcode = 'WD005'; end if;
  if target.id = me then raise exception 'you cannot change your own account here' using errcode = 'WD002'; end if;
  if (p_is_admin is false or p_disabled is true) and target.is_admin and not target.disabled
     and (select count(*) from weft.users u where u.is_admin and not u.disabled and not u.is_assistant) <= 1 then
    raise exception 'Weft needs at least one active admin' using errcode = 'WD003';
  end if;
  update weft.users u set is_admin = coalesce(p_is_admin, u.is_admin), disabled = coalesce(p_disabled, u.disabled)
   where u.id = p_user;
  perform weft_private.sync_admin_spaces(p_user);
  if p_disabled is not null and p_disabled is distinct from target.disabled then
    perform pg_notify('weft_events', json_build_object('t', 'account', 'user', p_user, 'disabled', p_disabled)::text);
  end if;
  insert into weft_private.admin_log (actor_id, user_id, change)
  values (me, p_user, jsonb_strip_nulls(jsonb_build_object('is_admin', p_is_admin, 'disabled', p_disabled)));
  return query select u.id, u.is_admin, u.disabled from weft.users u where u.id = p_user;
end $$;

revoke execute on function weft_private.managed_guard(), weft_private.system_space_guard(),
  weft_private.admins_only_members_guard(), weft_private.sync_admin_spaces(uuid) from public, weft_user, weft_assistant;

-- Co-members may read these flags (the app hides controls that would be refused).
grant select (admins_only) on weft.spaces to weft_user, weft_assistant;
grant select (managed) on weft.items to weft_user, weft_assistant;

-- ---------- fix (found 2026-11-12): sub-pages and thread replies were always refused ----------
-- In the parent and thread checks, an unqualified parent_id / thread_root_id resolved to the inner
-- table's own column (p.parent_id, r.thread_root_id), so the check never matched and every sub-page or
-- reply was refused, including allowed ones. 003 is corrected for fresh builds; this fixes existing ones.
drop policy if exists items_create on weft.items;
create policy items_create on weft.items for insert to weft_user
  with check (
    created_by = weft_private.uid()
    and weft_private.can_edit(space_id)
    and (parent_id is null or exists (
      select 1 from weft.items p where p.id = items.parent_id and p.space_id = items.space_id)));
drop policy if exists items_edit on weft.items;
create policy items_edit on weft.items for update to weft_user
  using (weft_private.can_edit(space_id))
  with check (
    weft_private.can_edit(space_id)
    and (parent_id is null or exists (
      select 1 from weft.items p where p.id = items.parent_id and p.space_id = items.space_id)));
drop policy if exists messages_post on weft.messages;
create policy messages_post on weft.messages for insert to weft_user
  with check (
    author_id = weft_private.uid()
    and weft_private.is_member(space_id)
    and (thread_root_id is null or exists (
      select 1 from weft.messages r where r.id = messages.thread_root_id and r.space_id = messages.space_id)));
drop policy if exists messages_post_assistant on weft.messages;
create policy messages_post_assistant on weft.messages for insert to weft_assistant
  with check (
    author_id = weft_private.assistant_id()
    and weft_private.is_member(space_id)
    and (thread_root_id is null or exists (
      select 1 from weft.messages r where r.id = messages.thread_root_id and r.space_id = messages.space_id)));
