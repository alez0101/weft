-- 018 accounts: Weft's own sign-in (email and password), so Cloudflare Access becomes optional.
--
-- - Passwords are hashed by the sign-in service (scrypt); the database stores only the hash.
-- - Invite and reset links are single-use and expire. The database stores only a hash of each link's
--   secret, so a database copy cannot be used to sign in.
-- - Sessions: the browser keeps a long-lived refresh secret in an HttpOnly cookie; it is stored hashed,
--   rotated on every use, revoked on sign-out, on a password change, and when an account is disabled.
-- Only the sign-in service's login (weft_auth) can call these functions; nothing is exposed to the API.
set client_min_messages = warning;

-- Weft's own account (the assistant's author id). It was only made by the sample data before, so a
-- real install without samples had no assistant to post answers.
insert into weft.users (id, email, display_name, is_assistant)
values (weft_private.assistant_id(), 'weft@example.com', 'Weft', true)
on conflict (id) do nothing;

create table if not exists weft_private.credentials (
  user_id    uuid primary key references weft.users (id) on delete cascade,
  hash       text not null,
  updated_at timestamptz not null default now()
);

create table if not exists weft_private.auth_links (
  id          bigint generated always as identity primary key,
  token_hash  text not null unique,
  email       text not null,
  purpose     text not null check (purpose in ('invite', 'reset')),
  created_by  uuid references weft.users (id) on delete set null,   -- null: made on the server (tools/weft_admin.py)
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  revoked_at  timestamptz
);
create index if not exists auth_links_email_idx on weft_private.auth_links (lower(email));

create table if not exists weft_private.sessions (
  id           bigint generated always as identity primary key,
  token_hash   text not null unique,
  user_id      uuid not null references weft.users (id) on delete cascade,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  user_agent   text
);
create index if not exists sessions_user_idx on weft_private.sessions (user_id);

-- ---------- password sign-in ----------
-- The account and its hash for an email (null hash: no password set yet). Disabled accounts included,
-- so the service can say so only after the password checks out.
create or replace function weft_private.auth_lookup(p_email text)
returns table (user_id uuid, display_name text, hash text, disabled boolean)
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select u.id, u.display_name, c.hash, u.disabled
  from weft.users u left join weft_private.credentials c on c.user_id = u.id
  where lower(u.email) = lower(p_email) and not u.is_assistant
$$;

create or replace function weft_private.auth_signed_in(p_user uuid) returns void
language sql security definer set search_path = weft, weft_private, pg_temp as $$
  update weft.users set last_seen_at = now() where id = p_user;
  select weft_private.sync_admin_spaces(p_user);
$$;

-- ---------- links ----------
create or replace function weft_private.auth_link_create(p_hash text, p_email text, p_purpose text, p_by uuid, p_hours int)
returns table (email text, purpose text, expires_at timestamptz)
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare v_exists boolean;
begin
  if p_by is not null and not weft_private.assist_is_admin(p_by) then
    raise exception 'admins only' using errcode = '42501';
  end if;
  if p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'that is not an email address' using errcode = '22023'; end if;
  select true into v_exists from weft.users u where lower(u.email) = lower(p_email) and not u.is_assistant;
  if p_purpose = 'reset' and v_exists is null then raise exception 'no account with that email' using errcode = 'WD005'; end if;
  if p_purpose = 'invite' and v_exists then raise exception 'that person already has an account; make a reset link instead' using errcode = 'WD009'; end if;
  -- One open link per email and purpose: a new one replaces the old.
  update weft_private.auth_links l set revoked_at = now()
   where lower(l.email) = lower(p_email) and l.purpose = p_purpose and l.used_at is null and l.revoked_at is null;
  return query insert into weft_private.auth_links (token_hash, email, purpose, created_by, expires_at)
    values (p_hash, lower(p_email), p_purpose, p_by, now() + make_interval(hours => least(greatest(p_hours, 1), 168)))
    returning auth_links.email, auth_links.purpose, auth_links.expires_at;
end $$;

-- What a link is for, if it is still good (does not use it up).
create or replace function weft_private.auth_link_peek(p_hash text)
returns table (email text, purpose text, display_name text)
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select l.email, l.purpose, u.display_name
  from weft_private.auth_links l left join weft.users u on lower(u.email) = l.email and not u.is_assistant
  where l.token_hash = p_hash and l.used_at is null and l.revoked_at is null and l.expires_at > now()
$$;

-- Use a link: set the password (creating the account for an invite) and end every old session.
create or replace function weft_private.auth_link_redeem(p_hash text, p_password_hash text, p_name text, p_bootstrap_email text)
returns table (user_id uuid, display_name text)
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare l weft_private.auth_links; v_id uuid; v_name text;
begin
  select * into l from weft_private.auth_links a
   where a.token_hash = p_hash and a.used_at is null and a.revoked_at is null and a.expires_at > now() for update;
  if l.id is null then raise exception 'this link is no longer valid' using errcode = 'WD010'; end if;
  update weft_private.auth_links set used_at = now() where id = l.id;
  v_name := nullif(btrim(coalesce(p_name, '')), '');
  select p.id into v_id from weft_private.provision_user(l.email, coalesce(v_name, split_part(l.email, '@', 1)),
                                                         p_bootstrap_email <> '' and lower(l.email) = lower(p_bootstrap_email)) p;
  if v_name is not null and l.purpose = 'invite' then update weft.users set display_name = left(v_name, 80) where id = v_id; end if;
  insert into weft_private.credentials as c (user_id, hash) values (v_id, p_password_hash)
  on conflict on constraint credentials_pkey do update set hash = excluded.hash, updated_at = now();
  update weft_private.sessions s set revoked_at = now() where s.user_id = v_id and s.revoked_at is null;
  return query select u.id, u.display_name from weft.users u where u.id = v_id;
end $$;

-- Change your own password (the service has checked the current one).
create or replace function weft_private.auth_set_password(p_user uuid, p_hash text, p_keep_session text)
returns void language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  insert into weft_private.credentials (user_id, hash) values (p_user, p_hash)
  on conflict (user_id) do update set hash = excluded.hash, updated_at = now();
  update weft_private.sessions set revoked_at = now()
   where user_id = p_user and revoked_at is null and token_hash is distinct from p_keep_session;
end $$;

-- ---------- sessions ----------
create or replace function weft_private.auth_session_create(p_hash text, p_user uuid, p_days int, p_agent text)
returns void language sql security definer set search_path = weft, weft_private, pg_temp as $$
  insert into weft_private.sessions (token_hash, user_id, expires_at, user_agent)
  values (p_hash, p_user, now() + make_interval(days => p_days), left(p_agent, 200));
$$;

-- Swap a session's secret for a new one. Nothing if it is unknown, revoked, expired or the account is
-- disabled. A secret that was already swapped is a sign it was copied: the whole session is ended.
create or replace function weft_private.auth_session_rotate(p_old text, p_new text)
returns table (user_id uuid, display_name text)
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare s weft_private.sessions;
begin
  select * into s from weft_private.sessions where token_hash = p_old for update;
  if s.id is null or s.revoked_at is not null or s.expires_at < now() then return; end if;
  if exists (select 1 from weft.users u where u.id = s.user_id and u.disabled) then return; end if;
  update weft_private.sessions set token_hash = p_new, last_used_at = now() where id = s.id;
  insert into weft_private.session_history (session_id, old_hash) values (s.id, p_old);
  return query select u.id, u.display_name from weft.users u where u.id = s.user_id;
end $$;

-- Old secrets of each session, so a replayed one can end the session (see auth_session_replayed).
create table if not exists weft_private.session_history (
  session_id bigint not null references weft_private.sessions (id) on delete cascade,
  old_hash   text not null unique,
  at         timestamptz not null default now()
);
create or replace function weft_private.auth_session_replayed(p_old text) returns boolean
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare v bigint;
begin
  select session_id into v from weft_private.session_history where old_hash = p_old;
  if v is null then return false; end if;
  update weft_private.sessions set revoked_at = now() where id = v and revoked_at is null;
  return true;
end $$;

create or replace function weft_private.auth_session_revoke(p_hash text) returns void
language sql security definer set search_path = weft, weft_private, pg_temp as $$
  update weft_private.sessions set revoked_at = now() where token_hash = p_hash and revoked_at is null;
$$;

-- Admins: open links, and ending someone's sessions. Through the sign-in service, which checks the token.
create or replace function weft_private.auth_links_open(p_by uuid)
returns table (id bigint, email text, purpose text, expires_at timestamptz, created_at timestamptz)
language plpgsql stable security definer set search_path = weft, weft_private, pg_temp as $$
begin
  if not weft_private.assist_is_admin(p_by) then raise exception 'admins only' using errcode = '42501'; end if;
  return query select l.id, l.email, l.purpose, l.expires_at, l.created_at from weft_private.auth_links l
    where l.used_at is null and l.revoked_at is null and l.expires_at > now() order by l.created_at desc;
end $$;

create or replace function weft_private.auth_link_revoke(p_by uuid, p_id bigint) returns void
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  if not weft_private.assist_is_admin(p_by) then raise exception 'admins only' using errcode = '42501'; end if;
  update weft_private.auth_links set revoked_at = now() where id = p_id and used_at is null and revoked_at is null;
end $$;

-- Disabling an account also ends its sessions (enabling does not bring them back).
create or replace function weft_private.end_sessions_on_disable() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  if new.disabled and not old.disabled then
    update weft_private.sessions set revoked_at = now() where user_id = new.id and revoked_at is null;
  end if;
  return null;
end $$;
drop trigger if exists users_end_sessions on weft.users;
create trigger users_end_sessions after update of disabled on weft.users
  for each row execute function weft_private.end_sessions_on_disable();

-- Admins see who has a password set (not the hash).
drop function if exists weft.admin_users();
create or replace function weft.admin_users()
returns table (id uuid, email text, display_name text, is_admin boolean, disabled boolean,
               created_at timestamptz, last_seen_at timestamptz, spaces bigint, has_password boolean)
language plpgsql stable security definer set search_path = weft, weft_private, pg_temp as $$
begin
  if not weft_private.assist_is_admin(weft_private.uid()) or weft_private.scope_space() is not null then
    raise exception 'admins only' using errcode = '42501';
  end if;
  return query
    select u.id, u.email, u.display_name, u.is_admin, u.disabled, u.created_at, u.last_seen_at,
           (select count(*) from weft.members m join weft.spaces s on s.id = m.space_id
             where m.user_id = u.id and s.kind = 'channel'),
           exists (select 1 from weft_private.credentials c where c.user_id = u.id)
    from weft.users u where not u.is_assistant order by lower(u.display_name);
end $$;

revoke execute on function weft.admin_users() from public;
grant execute on function weft.admin_users() to weft_user;

create or replace function weft_private.auth_lookup_id(p_user uuid)
returns table (user_id uuid, display_name text, hash text, disabled boolean)
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select u.id, u.display_name, c.hash, u.disabled
  from weft.users u left join weft_private.credentials c on c.user_id = u.id
  where u.id = p_user and not u.is_assistant
$$;

revoke all on weft_private.credentials, weft_private.auth_links, weft_private.sessions, weft_private.session_history
  from public, weft_user, weft_assistant;
do $$
declare f text;
begin
  foreach f in array array[
    'weft_private.auth_lookup(text)', 'weft_private.auth_lookup_id(uuid)', 'weft_private.auth_signed_in(uuid)',
    'weft_private.auth_link_create(text, text, text, uuid, int)', 'weft_private.auth_link_peek(text)',
    'weft_private.auth_link_redeem(text, text, text, text)', 'weft_private.auth_set_password(uuid, text, text)',
    'weft_private.auth_session_create(text, uuid, int, text)', 'weft_private.auth_session_rotate(text, text)',
    'weft_private.auth_session_replayed(text)', 'weft_private.auth_session_revoke(text)',
    'weft_private.auth_links_open(uuid)', 'weft_private.auth_link_revoke(uuid, bigint)'] loop
    execute format('revoke execute on function %s from public, weft_user, weft_assistant', f);
    execute format('grant execute on function %s to weft_auth', f);
  end loop;
end $$;
revoke execute on function weft_private.end_sessions_on_disable() from public, weft_user, weft_assistant;
-- The sign-in service also checks admin rights for the admin endpoints.
grant execute on function weft_private.assist_is_admin(uuid) to weft_auth;
