-- 007 service logins, each allowed exactly one or two functions.
-- weft_auth:   the token service. Turns a verified email into a Weft user (creating the person
--              and their personal space on first sign-in) and looks up seeded test users.
-- weft_notify: the notification server. LISTENs, and asks which spaces a user is in.
-- Run with: psql -v auth_svc_pw=... -v notify_svc_pw=...
set client_min_messages = warning;

do $$
begin
  if not exists (select from pg_roles where rolname = 'weft_auth') then
    create role weft_auth login;
  end if;
  if not exists (select from pg_roles where rolname = 'weft_notify') then
    create role weft_notify login;
  end if;
end $$;
alter role weft_auth password :'auth_svc_pw';
alter role weft_notify password :'notify_svc_pw';

-- First sign-in creates the person and a personal space. If bootstrap is true (the email matches
-- the configured admin), they are also made owner of every existing channel, so the real admin
-- can see the sample channels. Never called for anyone Cloudflare Access did not verify.
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
  if p_bootstrap then
    insert into weft.members (space_id, user_id, role)
    select s.id, v_id, 'owner' from weft.spaces s where s.kind = 'channel'
    on conflict (space_id, user_id) do update set role = 'owner';
  end if;
  return query select u.id, u.display_name from weft.users u where u.id = v_id;
end $$;

-- Test sign-in: only the seeded example.com accounts, never a real address, never the assistant.
create or replace function weft_private.test_user(p_email text)
returns table (id uuid, display_name text)
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select u.id, u.display_name from weft.users u
  where lower(u.email) = lower(p_email) and u.email like '%@example.com' and not u.is_assistant
$$;

create or replace function weft_private.memberships(p_user uuid) returns setof uuid
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select m.space_id from weft.members m where m.user_id = p_user
$$;

revoke execute on function weft_private.provision_user(text, text, boolean), weft_private.test_user(text),
  weft_private.memberships(uuid) from public, weft_user, weft_assistant;
grant usage on schema weft_private to weft_auth, weft_notify;
grant execute on function weft_private.provision_user(text, text, boolean), weft_private.test_user(text) to weft_auth;
grant execute on function weft_private.memberships(uuid) to weft_notify;
