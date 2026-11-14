-- 027 announcements: short notices pinned to a channel, shown at the top of the channel and in a Home
-- widget until they end. An announcement belongs to its channel directly (like an event): members read
-- it, viewers included; editors and owners post, change, end early and delete; the assistant role only
-- reads. Only channels have announcements (not personal spaces, direct messages or the assistant
-- space). A notice cannot move to another channel. Who posted it is set here, never by the client.
-- A new notice must end in the future, at most a year ahead. Changes are announced (ids only, through
-- the shared announce trigger) and the old row is kept in the audit log (the shared audit trigger).
set client_min_messages = warning;

create table if not exists weft.announcements (
  id         uuid primary key default gen_random_uuid(),
  space_id   uuid not null references weft.spaces (id) on delete cascade,
  title      text not null check (length(btrim(title)) between 1 and 120),
  body       text not null default '' check (length(body) <= 1000),
  expires_at timestamptz not null default now() + interval '7 days',
  created_by uuid not null default weft_private.uid() references weft.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists announcements_space_idx on weft.announcements (space_id, expires_at desc);
create index if not exists announcements_expires_idx on weft.announcements (expires_at);

alter table weft.announcements enable row level security;
alter table weft.announcements force row level security;
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'weft' and tablename = 'announcements' loop
    execute format('drop policy %I on weft.announcements', p.policyname);
  end loop;
end $$;
create policy announcements_read on weft.announcements for select to weft_user, weft_assistant
  using (weft_private.is_member(space_id));
create policy announcements_post on weft.announcements for insert to weft_user
  with check (created_by = weft_private.uid() and weft_private.can_edit(space_id));
create policy announcements_change on weft.announcements for update to weft_user
  using (weft_private.can_edit(space_id)) with check (weft_private.can_edit(space_id));
create policy announcements_delete on weft.announcements for delete to weft_user
  using (weft_private.can_edit(space_id));

-- space_id is not updatable: a notice does not jump between channels.
-- created_by, created_at and updated_at are never granted.
grant select on weft.announcements to weft_user, weft_assistant;
grant insert (space_id, title, body, expires_at),
      update (title, body, expires_at), delete on weft.announcements to weft_user;

-- Before a write: only channels; tidy the text; keep the end time sensible; stamp updated_at.
create or replace function weft_private.announcement_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    -- Someone who may not post here is refused by the policy, so this check says nothing to them.
    if weft_private.can_edit(new.space_id)
       and not exists (select 1 from weft.spaces s where s.id = new.space_id and s.kind = 'channel') then
      raise exception 'announcements can only be pinned to a channel' using errcode = '22023';
    end if;
    if new.expires_at <= now() then
      raise exception 'an announcement must end in the future' using errcode = '22023';
    end if;
    if new.expires_at > now() + interval '366 days' then
      raise exception 'an announcement can be shown for at most a year' using errcode = '22023';
    end if;
  else
    new.created_at := old.created_at;
    new.updated_at := now();
    if new.expires_at is distinct from old.expires_at then
      -- Ending early (now, or any time after it was posted) is fine; a new end is at most a year ahead.
      if new.expires_at < old.created_at then
        raise exception 'an announcement cannot end before it was posted' using errcode = '22023';
      end if;
      if new.expires_at > now() + interval '366 days' then
        raise exception 'an announcement can be shown for at most a year' using errcode = '22023';
      end if;
    end if;
  end if;
  new.title := btrim(new.title);
  new.body := btrim(coalesce(new.body, ''));
  return new;
end $$;
drop trigger if exists announcements_guard on weft.announcements;
create trigger announcements_guard before insert or update on weft.announcements
  for each row execute function weft_private.announcement_guard();

-- Live notices and the audit log: the shared triggers from 006 and 004 (the table has id and space_id).
drop trigger if exists announce_announcements on weft.announcements;
create trigger announce_announcements after insert or update or delete on weft.announcements
  for each row execute function weft_private.announce();
drop trigger if exists audit_announcements on weft.announcements;
create trigger audit_announcements after update or delete on weft.announcements
  for each row execute function weft_private.audit_row();

revoke execute on function weft_private.announcement_guard() from public, weft_user, weft_assistant;
