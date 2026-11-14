-- 031 bookings: shared things a channel can book (a room, a van, a projector) in time slots, never twice
-- for the same time. Both tables belong to a channel directly (like announcements):
--   * weft.resources: the things. Members read them, viewers included; editors and owners add and rename
--     them; only owners delete one (its bookings go with it). Only channels have them.
--   * weft.bookings: a thing booked from starts_at to ends_at (a half-open range: 10:00 to 11:00 and 11:00
--     to 12:00 do not clash). Its space is copied from the thing by the database, never sent by the client.
--     Members read every booking with the booker's name; editors and owners book; a booking is changed or
--     cancelled by the person who made it, or by an owner of the channel. The assistant role only reads.
--   * No double booking: an exclusion constraint on (thing, time range), so two people booking the same
--     slot at the same moment cannot both win. A trigger checks first, to give a plain answer.
--   * A new booking must end in the future and last at most 31 days. Once a booking has ended it is fixed
--     (nobody changes or cancels it); deleting the thing or the channel still removes it.
--   * Neither moves: resources.space_id and bookings.resource_id are not updatable, so nothing a channel
--     booked ever shows in another channel. Changes are announced (ids only) and audited under the channel.
set client_min_messages = warning;
create extension if not exists btree_gist;

create table if not exists weft.resources (
  id         uuid primary key default gen_random_uuid(),
  space_id   uuid not null references weft.spaces (id) on delete cascade,
  name       text not null check (length(btrim(name)) between 1 and 80),
  note       text not null default '' check (length(note) <= 500),
  created_by uuid not null default weft_private.uid() references weft.users (id),
  created_at timestamptz not null default now()
);
create index if not exists resources_space_idx on weft.resources (space_id, name);

create table if not exists weft.bookings (
  id          uuid primary key default gen_random_uuid(),
  resource_id uuid not null references weft.resources (id) on delete cascade,
  space_id    uuid not null references weft.spaces (id) on delete cascade,
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  note        text not null default '' check (length(note) <= 200),
  booked_by   uuid not null default weft_private.uid() references weft.users (id),
  created_at  timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index if not exists bookings_space_idx on weft.bookings (space_id, starts_at);
create index if not exists bookings_by_idx on weft.bookings (booked_by, ends_at);
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'bookings_no_overlap') then
    alter table weft.bookings add constraint bookings_no_overlap
      exclude using gist (resource_id with =, tstzrange(starts_at, ends_at, '[)') with &&);
  end if;
end $$;

alter table weft.resources enable row level security;
alter table weft.resources force row level security;
alter table weft.bookings enable row level security;
alter table weft.bookings force row level security;
do $$
declare p record;
begin
  for p in select policyname, tablename from pg_policies where schemaname = 'weft' and tablename in ('resources', 'bookings') loop
    execute format('drop policy %I on weft.%I', p.policyname, p.tablename);
  end loop;
end $$;
create policy resources_read on weft.resources for select to weft_user, weft_assistant
  using (weft_private.is_member(space_id));
create policy resources_add on weft.resources for insert to weft_user
  with check (created_by = weft_private.uid() and weft_private.can_edit(space_id));
create policy resources_change on weft.resources for update to weft_user
  using (weft_private.can_edit(space_id)) with check (weft_private.can_edit(space_id));
create policy resources_delete on weft.resources for delete to weft_user
  using (weft_private.is_owner(space_id));

create policy bookings_read on weft.bookings for select to weft_user, weft_assistant
  using (weft_private.is_member(space_id));
create policy bookings_book on weft.bookings for insert to weft_user
  with check (booked_by = weft_private.uid() and weft_private.can_edit(space_id));
create policy bookings_change on weft.bookings for update to weft_user
  using ((booked_by = weft_private.uid() and weft_private.can_edit(space_id)) or weft_private.is_owner(space_id))
  with check ((booked_by = weft_private.uid() and weft_private.can_edit(space_id)) or weft_private.is_owner(space_id));
create policy bookings_cancel on weft.bookings for delete to weft_user
  using ((booked_by = weft_private.uid() and weft_private.can_edit(space_id)) or weft_private.is_owner(space_id));

-- resources.space_id and bookings.resource_id are not updatable; bookings.space_id, booked_by, created_by
-- and created_at are never granted.
grant select on weft.resources, weft.bookings to weft_user, weft_assistant;
grant insert (space_id, name, note), update (name, note), delete on weft.resources to weft_user;
grant insert (resource_id, starts_at, ends_at, note), update (starts_at, ends_at, note), delete on weft.bookings to weft_user;

-- Before a write to a thing: only channels; tidy the text; keep the creation time.
create or replace function weft_private.resource_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    -- Someone who may not add things here is refused by the policy, so this check says nothing to them.
    if weft_private.can_edit(new.space_id)
       and not exists (select 1 from weft.spaces s where s.id = new.space_id and s.kind = 'channel') then
      raise exception 'only channels have things to book' using errcode = '22023';
    end if;
    new.created_at := now();
  else
    new.created_at := old.created_at;
  end if;
  new.name := btrim(new.name);
  new.note := btrim(coalesce(new.note, ''));
  return new;
end $$;
drop trigger if exists resources_guard on weft.resources;
create trigger resources_guard before insert or update on weft.resources
  for each row execute function weft_private.resource_guard();

-- Before a booking is made, changed or cancelled. Row-level security runs after this on insert, so every
-- check that could tell something about another channel's bookings runs only for someone who may book the
-- thing; anyone else is refused by the policy, learning nothing. Deletes made by the database itself
-- (a thing or channel deleted) run inside another trigger and always pass.
create or replace function weft_private.booking_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare v_space uuid;
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then return old; end if;
    if old.ends_at <= now() then
      raise exception 'this booking has ended, so it can no longer be cancelled' using errcode = '42501';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    select space_id into v_space from weft.resources where id = new.resource_id;
    if v_space is null then   -- no such thing: the same answer as a refusal
      raise exception 'new row violates row-level security policy for table "bookings"' using errcode = '42501';
    end if;
    new.space_id := v_space;
    new.created_at := now();
    if not weft_private.can_edit(v_space) then return new; end if;
    if new.ends_at <= now() then
      raise exception 'a booking must end in the future' using errcode = '22023';
    end if;
  else
    new.space_id := old.space_id;
    new.resource_id := old.resource_id;
    new.booked_by := old.booked_by;
    new.created_at := old.created_at;
    if old.ends_at <= now() then
      raise exception 'this booking has ended, so it can no longer change' using errcode = '42501';
    end if;
    if new.ends_at < now() - interval '5 minutes' then
      raise exception 'a booking cannot be moved into the past' using errcode = '22023';
    end if;
  end if;
  if new.ends_at <= new.starts_at then
    raise exception 'a booking must end after it starts' using errcode = '22023';
  end if;
  if new.ends_at - new.starts_at > interval '31 days' then
    raise exception 'a booking can last at most 31 days' using errcode = '22023';
  end if;
  new.note := btrim(coalesce(new.note, ''));
  if exists (select 1 from weft.bookings b
              where b.resource_id = new.resource_id and b.id <> new.id
                and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(new.starts_at, new.ends_at, '[)')) then
    raise exception 'that time overlaps another booking of this thing' using errcode = '23P01';
  end if;
  return new;
end $$;
drop trigger if exists bookings_guard on weft.bookings;
create trigger bookings_guard before insert or update or delete on weft.bookings
  for each row execute function weft_private.booking_guard();

-- Live notices and the audit log: the shared triggers from 006 and 004 (both tables have id and space_id).
drop trigger if exists announce_resources on weft.resources;
create trigger announce_resources after insert or update or delete on weft.resources
  for each row execute function weft_private.announce();
drop trigger if exists audit_resources on weft.resources;
create trigger audit_resources after update or delete on weft.resources
  for each row execute function weft_private.audit_row();
drop trigger if exists announce_bookings on weft.bookings;
create trigger announce_bookings after insert or update or delete on weft.bookings
  for each row execute function weft_private.announce();
drop trigger if exists audit_bookings on weft.bookings;
create trigger audit_bookings after update or delete on weft.bookings
  for each row execute function weft_private.audit_row();

revoke execute on function weft_private.resource_guard(), weft_private.booking_guard() from public, weft_user, weft_assistant;
