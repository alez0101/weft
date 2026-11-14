-- 034 profiles: a short profile for each person (role, skills, how to reach them, when they are available),
-- seen by the people they share a space with.
--
-- A profile belongs to a person, not to a space, so it reaches spaces through its owner's memberships:
-- you read a profile if its owner is a member of a space you are a member of, checked with
-- weft_private.is_member() on each of the owner's spaces. That applies the channel-scope claim (a token
-- scoped to #festival sees only #festival members' profiles) and refuses a disabled account, like every
-- other rule. Leaving the last shared space hides the profile again; nothing is copied.
-- Only the person writes their own profile (user_id defaults to the caller and is never granted), and only
-- with an unscoped token; owners, admins and the assistant cannot. The assistant role reads.
-- Live notices go out once per space the person is in (ids only), so only co-members hear of a change.
-- Old rows are audited under the person's personal space, so only they can read the history.
set client_min_messages = warning;

create table if not exists weft.profiles (
  user_id      uuid primary key default weft_private.uid() references weft.users (id) on delete cascade,
  role         text not null default '' check (length(role) <= 80),
  skills       text[] not null default '{}' check (cardinality(skills) <= 12),
  reach        text not null default '' check (length(reach) <= 300),
  availability text not null default '' check (length(availability) <= 300),
  updated_at   timestamptz not null default now()
);

-- A person's personal space (null if they have none). security definer: used inside policies.
create or replace function weft_private.personal_space(p_user uuid) returns uuid
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select id from weft.spaces where kind = 'personal' and created_by = p_user order by created_at limit 1
$$;

alter table weft.profiles enable row level security;
alter table weft.profiles force row level security;
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'weft' and tablename = 'profiles' loop
    execute format('drop policy %I on weft.profiles', p.policyname);
  end loop;
end $$;
-- Read: the owner is in a space you are in. The subquery reads weft.members as the caller, so it already
-- sees only memberships of the caller's spaces; is_member() adds the scope claim and the disabled check.
create policy profiles_read on weft.profiles for select to weft_user, weft_assistant
  using (exists (select 1 from weft.members m where m.user_id = profiles.user_id and weft_private.is_member(m.space_id)));
-- Write: your own row, with an unscoped token, while your account is active (is_member of your own
-- personal space is false for a disabled account).
create policy profiles_insert on weft.profiles for insert to weft_user
  with check (user_id = weft_private.uid() and weft_private.scope_space() is null
              and weft_private.is_member(weft_private.personal_space(user_id)));
create policy profiles_change on weft.profiles for update to weft_user
  using (user_id = weft_private.uid() and weft_private.scope_space() is null
         and weft_private.is_member(weft_private.personal_space(user_id)))
  with check (user_id = weft_private.uid() and weft_private.scope_space() is null
              and weft_private.is_member(weft_private.personal_space(user_id)));
create policy profiles_delete on weft.profiles for delete to weft_user
  using (user_id = weft_private.uid() and weft_private.scope_space() is null
         and weft_private.is_member(weft_private.personal_space(user_id)));

-- user_id and updated_at are never granted.
grant select on weft.profiles to weft_user, weft_assistant;
grant insert (role, skills, reach, availability), update (role, skills, reach, availability), delete on weft.profiles to weft_user;
revoke execute on function weft_private.personal_space(uuid) from public;
grant execute on function weft_private.personal_space(uuid) to weft_user, weft_assistant;

-- Before a write: trim the text, tidy the skills (trimmed, inner spaces collapsed, lowercased, empty and
-- repeated ones dropped, order kept), check them, and stamp updated_at.
create or replace function weft_private.profile_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare s text; tidy text[] := '{}';
begin
  new.role := btrim(coalesce(new.role, ''));
  new.reach := btrim(coalesce(new.reach, ''));
  new.availability := btrim(coalesce(new.availability, ''));
  foreach s in array coalesce(new.skills, '{}') loop
    s := lower(regexp_replace(btrim(coalesce(s, '')), '\s+', ' ', 'g'));
    if s = '' or s = any(tidy) then continue; end if;
    if length(s) > 40 then raise exception 'a skill is at most 40 characters' using errcode = '23514'; end if;
    tidy := tidy || s;
  end loop;
  if cardinality(tidy) > 12 then raise exception 'at most 12 skills' using errcode = '23514'; end if;
  new.skills := tidy;
  new.updated_at := now();
  if tg_op = 'UPDATE' then new.user_id := old.user_id; end if;
  return new;
end $$;
drop trigger if exists profiles_guard on weft.profiles;
create trigger profiles_guard before insert or update on weft.profiles for each row execute function weft_private.profile_guard();

-- After a change: one notice per space the person is in (so the notification server forwards it only to
-- people who share a space with them), and the old row in the audit log under their personal space.
create or replace function weft_private.profile_changed() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare r record; s uuid; v_personal uuid;
begin
  r := coalesce(new, old);
  for s in select weft_private.memberships(r.user_id) loop
    perform pg_notify('weft_events', json_build_object('t', 'profiles', 'op', tg_op, 'id', r.user_id, 'space', s)::text);
  end loop;
  if tg_op in ('UPDATE', 'DELETE') then
    v_personal := weft_private.personal_space(old.user_id);
    if v_personal is not null then   -- null when the whole account is being deleted
      insert into weft.audit (table_name, row_id, space_id, op, actor_id, actor_role, old_row)
      values ('profiles', old.user_id, v_personal, tg_op, weft_private.uid(),
              coalesce(nullif(current_setting('role', true), 'none'), session_user), to_jsonb(old));
    end if;
  end if;
  return null;
end $$;
drop trigger if exists profiles_changed on weft.profiles;
create trigger profiles_changed after insert or update or delete on weft.profiles for each row execute function weft_private.profile_changed();

revoke execute on function weft_private.profile_guard(), weft_private.profile_changed() from public, weft_user, weft_assistant;
