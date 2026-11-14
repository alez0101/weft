-- 045 kudos: a wall of thank-yous for a channel, newest first, with a Home widget of recent ones.
-- A kudos belongs to its channel directly (like an announcement): it names who it is for (a member of the
-- channel) and says thank you in up to 500 characters. Members read the wall, viewers included; editors
-- and owners give kudos. You reword or delete only your own; owners of the channel may also delete any
-- (tidying up). Nobody thanks themselves. Only channels have a wall (not personal spaces, direct messages
-- or the assistant space). A kudos never moves to another channel and never changes who it is for. Who gave
-- it is set here, never by the client. The assistant role only reads. Changes are announced (ids only,
-- through the shared announce trigger) and the old row is kept in the audit log (the shared audit trigger).
set client_min_messages = warning;

create table if not exists weft.kudos (
  id          uuid primary key default gen_random_uuid(),
  space_id    uuid not null references weft.spaces (id) on delete cascade,
  to_user     uuid not null references weft.users (id) on delete cascade,
  message     text not null check (length(btrim(message)) between 1 and 500),
  created_by  uuid not null default weft_private.uid() references weft.users (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists kudos_space_idx on weft.kudos (space_id, created_at desc);
create index if not exists kudos_created_idx on weft.kudos (created_at desc);
create index if not exists kudos_to_idx on weft.kudos (to_user);

alter table weft.kudos enable row level security;
alter table weft.kudos force row level security;
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'weft' and tablename = 'kudos' loop
    execute format('drop policy %I on weft.kudos', p.policyname);
  end loop;
end $$;
create policy kudos_read on weft.kudos for select to weft_user, weft_assistant
  using (weft_private.is_member(space_id));
create policy kudos_give on weft.kudos for insert to weft_user
  with check (created_by = weft_private.uid() and weft_private.can_edit(space_id));
-- Rewording: only your own, while you may still write in the channel.
create policy kudos_reword on weft.kudos for update to weft_user
  using (created_by = weft_private.uid() and weft_private.can_edit(space_id))
  with check (created_by = weft_private.uid() and weft_private.can_edit(space_id));
-- Deleting: your own (while you may write there), or any as an owner of the channel.
create policy kudos_delete on weft.kudos for delete to weft_user
  using ((created_by = weft_private.uid() and weft_private.can_edit(space_id)) or weft_private.is_owner(space_id));

-- space_id and to_user are not updatable: a kudos does not jump between channels or people.
-- created_by, created_at and updated_at are never granted.
grant select on weft.kudos to weft_user, weft_assistant;
grant insert (space_id, to_user, message), update (message), delete on weft.kudos to weft_user;

-- Before a write: only channels, only for a member of the channel and not yourself; tidy the text; keep
-- authorship and times. Each answer is given only once the caller may write in the channel (the policies
-- run after this trigger), so an outsider learns nothing about a channel or its members from it.
create or replace function weft_private.kudos_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  new.message := btrim(new.message, E' \t\r\n');
  if tg_op = 'INSERT' then
    new.created_at := now(); new.updated_at := now();
    if weft_private.can_edit(new.space_id) then
      if not exists (select 1 from weft.spaces s where s.id = new.space_id and s.kind = 'channel') then
        raise exception 'kudos can only be given in a channel' using errcode = '22023';
      end if;
      if new.to_user = weft_private.uid() then
        raise exception 'kudos are for someone else: you cannot thank yourself' using errcode = '22023';
      end if;
      if not exists (select 1 from weft.members m where m.space_id = new.space_id and m.user_id = new.to_user) then
        raise exception 'kudos can only be given to a member of this channel' using errcode = '22023';
      end if;
    end if;
  else
    new.created_at := old.created_at; new.created_by := old.created_by; new.updated_at := now();
  end if;
  return new;
end $$;
drop trigger if exists kudos_guard on weft.kudos;
create trigger kudos_guard before insert or update on weft.kudos
  for each row execute function weft_private.kudos_guard();

-- Live notices and the audit log: the shared triggers from 006 and 004 (the table has id and space_id).
drop trigger if exists announce_kudos on weft.kudos;
create trigger announce_kudos after insert or update or delete on weft.kudos
  for each row execute function weft_private.announce();
drop trigger if exists audit_kudos on weft.kudos;
create trigger audit_kudos after update or delete on weft.kudos
  for each row execute function weft_private.audit_row();

revoke execute on function weft_private.kudos_guard() from public, weft_user, weft_assistant;
