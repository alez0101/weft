-- 012: spaces everyone can read (the help wiki). Every person is a viewer of every "everyone" space:
-- added on each sign-in, so new spaces and new people both get it. Owners are kept as owners.
set client_min_messages = warning;

alter table weft.spaces add column if not exists everyone boolean not null default false;

create or replace function weft_private.provision_user(p_email text, p_name text, p_bootstrap boolean)
returns table (id uuid, display_name text)
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare v_id uuid;
begin
  select u.id into v_id from weft.users u where lower(u.email) = lower(p_email) and not u.is_assistant;
  if v_id is null then
    insert into weft.users (email, display_name) values (lower(p_email), p_name) returning users.id into v_id;
    insert into weft.spaces (kind, name, created_by) values ('personal', 'Personal', v_id);
  end if;
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
