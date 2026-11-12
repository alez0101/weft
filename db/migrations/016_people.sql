-- 016 people: account status for admins, and guards for channel management.
--
-- - A disabled account loses everything at once: member_role() returns nothing for it, so every
--   policy (chat, documents, tables, calendar, search, the assistant acting for it) refuses it, and
--   sign-in is refused. Its memberships are kept, so enabling it again restores them.
-- - Admins list accounts and change admin / disabled through two functions. An admin cannot change
--   their own account, and Weft always keeps at least one active admin.
-- - A channel always keeps an owner: the last owner cannot leave, be removed or be demoted (deleting
--   the whole channel is still allowed).
set client_min_messages = warning;

alter table weft.users add column if not exists disabled boolean not null default false;
alter table weft.users add column if not exists created_at timestamptz not null default now();
alter table weft.users add column if not exists last_seen_at timestamptz;

-- Co-members may read who someone is and whether they are an admin or disabled, not when they were last
-- seen (that is in admin_users() only).
revoke select on weft.users from weft_user, weft_assistant;
grant select (id, email, display_name, is_assistant, is_admin, disabled) on weft.users to weft_user, weft_assistant;

-- ---------- a disabled account is a member of nothing ----------
create or replace function weft_private.member_role(s uuid) returns text
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select m.role
  from weft.members m
  join weft.users u on u.id = m.user_id and not u.disabled
  where m.space_id = s
    and m.user_id = weft_private.uid()
    and (weft_private.scope_space() is null or s = weft_private.scope_space())
$$;

create or replace function weft_private.memberships(p_user uuid) returns setof uuid
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select m.space_id from weft.members m join weft.users u on u.id = m.user_id and not u.disabled
  where m.user_id = p_user
$$;

create or replace function weft_private.assist_is_admin(p_user uuid) returns boolean
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select coalesce((select is_admin and not disabled from weft.users where id = p_user), false)
$$;

-- Sign-in: refused for a disabled account; records when someone was last seen.
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
    select s.id, v_id, 'owner' from weft.spaces s where s.kind = 'channel'
    on conflict (space_id, user_id) do update set role = 'owner';
  end if;
  return query select u.id, u.display_name from weft.users u where u.id = v_id;
end $$;

create or replace function weft_private.test_user(p_email text)
returns table (id uuid, display_name text)
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  if exists (select 1 from weft.users u where lower(u.email) = lower(p_email) and u.disabled) then
    raise exception 'account disabled' using errcode = 'WD001';
  end if;
  update weft.users u set last_seen_at = now()
   where lower(u.email) = lower(p_email) and u.email like '%@example.com' and not u.is_assistant;
  return query select u.id, u.display_name from weft.users u
  where lower(u.email) = lower(p_email) and u.email like '%@example.com' and not u.is_assistant;
end $$;

-- ---------- admins: accounts ----------
create or replace function weft.admin_users()
returns table (id uuid, email text, display_name text, is_admin boolean, disabled boolean,
               created_at timestamptz, last_seen_at timestamptz, spaces bigint)
language plpgsql stable security definer set search_path = weft, weft_private, pg_temp as $$
begin
  if not weft_private.assist_is_admin(weft_private.uid()) or weft_private.scope_space() is not null then
    raise exception 'admins only' using errcode = '42501';
  end if;
  return query
    select u.id, u.email, u.display_name, u.is_admin, u.disabled, u.created_at, u.last_seen_at,
           (select count(*) from weft.members m join weft.spaces s on s.id = m.space_id
             where m.user_id = u.id and s.kind = 'channel')
    from weft.users u where not u.is_assistant order by lower(u.display_name);
end $$;

-- Change one account. Null leaves a field as it is. Returns the changed row.
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
  if p_disabled is not null and p_disabled is distinct from target.disabled then
    -- Live sockets and open editing sessions are closed by the services on this notice.
    perform pg_notify('weft_events', json_build_object('t', 'account', 'user', p_user, 'disabled', p_disabled)::text);
  end if;
  insert into weft_private.admin_log (actor_id, user_id, change)
  values (me, p_user, jsonb_strip_nulls(jsonb_build_object('is_admin', p_is_admin, 'disabled', p_disabled)));
  return query select u.id, u.is_admin, u.disabled from weft.users u where u.id = p_user;
end $$;

create table if not exists weft_private.admin_log (
  id bigint generated always as identity primary key,
  actor_id uuid not null, user_id uuid not null, change jsonb not null, at timestamptz not null default now()
);

revoke execute on function weft.admin_users(), weft.admin_set_user(uuid, boolean, boolean) from public;
grant execute on function weft.admin_users(), weft.admin_set_user(uuid, boolean, boolean) to weft_user;

-- ---------- channels keep an owner ----------
create or replace function weft_private.keep_an_owner() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  if old.role <> 'owner' or (tg_op = 'UPDATE' and new.role = 'owner') then return coalesce(new, old); end if;
  -- The whole channel is being deleted: its members go with it.
  if not exists (select 1 from weft.spaces s where s.id = old.space_id and s.kind = 'channel') then return coalesce(new, old); end if;
  if not exists (select 1 from weft.members m where m.space_id = old.space_id and m.role = 'owner' and m.user_id <> old.user_id) then
    raise exception 'a channel needs an owner: make someone else owner first' using errcode = 'WD004';
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists members_keep_owner on weft.members;
create trigger members_keep_owner before update or delete on weft.members
  for each row execute function weft_private.keep_an_owner();

-- Channel names: trimmed, 1 to 60 characters (existing rows already fit).
alter table weft.spaces drop constraint if exists spaces_name_len;
alter table weft.spaces add constraint spaces_name_len check (kind <> 'channel' or length(btrim(name)) between 1 and 60) not valid;

revoke execute on function weft_private.keep_an_owner() from public, weft_user, weft_assistant;

-- ---------- creating a channel ----------
-- An insert cannot return the new row (the creator becomes owner in an after-trigger, so RLS hides the
-- row at RETURNING time), so the app creates channels through this function, which returns the id.
-- A disabled account, the assistant and channel-scoped tokens cannot create channels.
create or replace function weft.create_channel(p_name text) returns uuid
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare v uuid;
begin
  if weft_private.uid() is null or coalesce(current_setting('request.jwt.claims', true)::json ->> 'role', '') <> 'weft_user'
     or weft_private.scope_space() is not null
     or not exists (select 1 from weft.users u where u.id = weft_private.uid() and not u.disabled and not u.is_assistant) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_name, ''))) not between 1 and 60 then
    raise exception 'a channel name is 1 to 60 characters' using errcode = '22023';
  end if;
  insert into weft.spaces (kind, name, created_by) values ('channel', btrim(p_name), weft_private.uid()) returning id into v;
  return v;
end $$;
revoke execute on function weft.create_channel(text) from public;
grant execute on function weft.create_channel(text) to weft_user;

-- The plain insert stays (direct messages use it), but not for a disabled account.
drop policy if exists spaces_create on weft.spaces;
create policy spaces_create on weft.spaces for insert to weft_user
  with check (created_by = weft_private.uid() and kind in ('channel', 'dm')
              and exists (select 1 from weft.users u where u.id = weft_private.uid() and not u.disabled));
