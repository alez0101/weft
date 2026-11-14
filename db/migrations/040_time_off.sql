-- 040 time off: who in a channel is away when (holiday, sick, away for a few days), in whole days.
-- weft.time_off belongs to a channel directly (like bookings and shifts):
--   * a row is one person away from starts_on to ends_on, both days included, with an optional short note.
--   * Members read every row with names, viewers included. Every member, viewers too, adds, changes and
--     removes their own time off (being away is about yourself, like an RSVP). Editors and owners of the
--     channel may also add, change and remove anyone's (someone who phoned in sick). The assistant role
--     only reads.
--   * The person away must be a member of the channel. Only channels have time off. An entry lasts at
--     most 366 days. These checks answer only someone allowed to write the row; anyone else is refused
--     by the policy, learning nothing.
--   * Nothing moves: space_id and user_id are not updatable, created_by is set by the database. Someone
--     who leaves or is removed from a channel loses their time off there (their name never shows where
--     they cannot see); deleting the channel deletes it all.
--   * Changes are announced (ids only) and audited under the channel, through the shared triggers.
--   * Not an item: time off is not in search, meaning search or the assistant's context.
set client_min_messages = warning;

create table if not exists weft.time_off (
  id         uuid primary key default gen_random_uuid(),
  space_id   uuid not null references weft.spaces (id) on delete cascade,
  user_id    uuid not null default weft_private.uid() references weft.users (id) on delete cascade,
  starts_on  date not null,
  ends_on    date not null,
  note       text not null default '' check (length(note) <= 200),
  created_by uuid not null default weft_private.uid() references weft.users (id),
  created_at timestamptz not null default now(),
  check (ends_on >= starts_on),
  check (ends_on - starts_on <= 365)
);
create index if not exists time_off_space_idx on weft.time_off (space_id, starts_on);
create index if not exists time_off_dates_idx on weft.time_off (ends_on, starts_on);
create index if not exists time_off_user_idx on weft.time_off (user_id, space_id);

alter table weft.time_off enable row level security;
alter table weft.time_off force row level security;
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'weft' and tablename = 'time_off' loop
    execute format('drop policy %I on weft.time_off', p.policyname);
  end loop;
end $$;
create policy time_off_read on weft.time_off for select to weft_user, weft_assistant
  using (weft_private.is_member(space_id));
create policy time_off_add on weft.time_off for insert to weft_user
  with check (created_by = weft_private.uid()
              and ((user_id = weft_private.uid() and weft_private.is_member(space_id)) or weft_private.can_edit(space_id)));
create policy time_off_change on weft.time_off for update to weft_user
  using ((user_id = weft_private.uid() and weft_private.is_member(space_id)) or weft_private.can_edit(space_id))
  with check ((user_id = weft_private.uid() and weft_private.is_member(space_id)) or weft_private.can_edit(space_id));
create policy time_off_remove on weft.time_off for delete to weft_user
  using ((user_id = weft_private.uid() and weft_private.is_member(space_id)) or weft_private.can_edit(space_id));

-- space_id and user_id are set on insert only; created_by and created_at are never granted.
grant select on weft.time_off to weft_user, weft_assistant;
grant insert (space_id, user_id, starts_on, ends_on, note), update (starts_on, ends_on, note), delete on weft.time_off to weft_user;

-- Before a write: keep what may not change, tidy the note, give a plain answer to someone allowed to write
-- the row. Row-level security runs after this on insert, so nothing here answers anyone else.
create or replace function weft_private.time_off_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    if not ((new.user_id = weft_private.uid() and weft_private.is_member(new.space_id)) or weft_private.can_edit(new.space_id)) then
      return new;   -- refused by the policy, with the same answer whatever was sent
    end if;
    if not exists (select 1 from weft.spaces s where s.id = new.space_id and s.kind = 'channel') then
      raise exception 'only channels keep time off' using errcode = '22023';
    end if;
    if not exists (select 1 from weft.members m where m.space_id = new.space_id and m.user_id = new.user_id) then
      raise exception 'that person is not a member of this channel' using errcode = '22023';
    end if;
  else
    new.space_id := old.space_id;
    new.user_id := old.user_id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  if new.ends_on < new.starts_on then
    raise exception 'time off must end on or after the day it starts' using errcode = '22023';
  end if;
  if new.ends_on - new.starts_on > 365 then
    raise exception 'time off can last at most 366 days; add another entry for longer' using errcode = '22023';
  end if;
  new.note := btrim(coalesce(new.note, ''));
  return new;
end $$;
drop trigger if exists time_off_guard on weft.time_off;
create trigger time_off_guard before insert or update on weft.time_off
  for each row execute function weft_private.time_off_guard();

-- Live notices and the audit log: the shared triggers from 006 and 004 (id and space_id).
drop trigger if exists announce_time_off on weft.time_off;
create trigger announce_time_off after insert or update or delete on weft.time_off
  for each row execute function weft_private.announce();
drop trigger if exists audit_time_off on weft.time_off;
create trigger audit_time_off after update or delete on weft.time_off
  for each row execute function weft_private.audit_row();

-- Someone left or was removed from a channel: their time off there goes (recorded under that channel).
create or replace function weft_private.time_off_member_left() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  delete from weft.time_off where space_id = old.space_id and user_id = old.user_id;
  return null;
end $$;
drop trigger if exists members_time_off_left on weft.members;
create trigger members_time_off_left after delete on weft.members for each row execute function weft_private.time_off_member_left();

revoke execute on function weft_private.time_off_guard(), weft_private.time_off_member_left() from public, weft_user, weft_assistant;
