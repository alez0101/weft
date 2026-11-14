-- 032 shifts: time slots with a number of places that members claim and give back (volunteer shifts, a
-- rota). Both tables belong to a channel directly (like bookings):
--   * weft.shifts: a title, a start and end, a number of places (1 to 200) and a note. Members read them,
--     viewers included; editors and owners add, change and delete them. Only channels have shifts.
--   * weft.shift_signups: one person on one shift (once). Its space is copied from the shift by the
--     database and the person is the caller, never sent by the client. Members read every sign-up with
--     names. **Every member signs up, viewers included** (taking part, like a vote or an RSVP), but only
--     themselves; you give back your own place, and editors and owners of the channel can take anyone off.
--     The assistant role only reads.
--   * Never over-filled: the shift row is locked while its places are counted, so two people claiming the
--     last place at once cannot both get it. Places cannot be lowered below the number signed up.
--   * A new shift must end in the future and last at most 7 days. Once a shift has ended it is fixed: its
--     sign-ups do not change and the shift is not changed (it can still be deleted; deleting the shift or
--     the channel removes its sign-ups).
--   * Neither moves: shifts.space_id and shift_signups.shift_id are not updatable, so nothing a channel
--     planned shows in another channel. Someone who leaves or is removed from a channel loses their
--     sign-ups there (so a name never shows where its owner cannot see). Changes are announced (ids only)
--     and audited under the channel.
set client_min_messages = warning;

create table if not exists weft.shifts (
  id         uuid primary key default gen_random_uuid(),
  space_id   uuid not null references weft.spaces (id) on delete cascade,
  title      text not null check (length(btrim(title)) between 1 and 80),
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  places     integer not null check (places between 1 and 200),
  note       text not null default '' check (length(note) <= 500),
  created_by uuid not null default weft_private.uid() references weft.users (id),
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index if not exists shifts_space_idx on weft.shifts (space_id, starts_at);
create index if not exists shifts_ends_idx on weft.shifts (ends_at);

create table if not exists weft.shift_signups (
  id         uuid primary key default gen_random_uuid(),
  shift_id   uuid not null references weft.shifts (id) on delete cascade,
  space_id   uuid not null references weft.spaces (id) on delete cascade,
  user_id    uuid not null default weft_private.uid() references weft.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (shift_id, user_id)
);
create index if not exists shift_signups_user_idx on weft.shift_signups (user_id);
create index if not exists shift_signups_space_idx on weft.shift_signups (space_id, user_id);

alter table weft.shifts enable row level security;
alter table weft.shifts force row level security;
alter table weft.shift_signups enable row level security;
alter table weft.shift_signups force row level security;
do $$
declare p record;
begin
  for p in select policyname, tablename from pg_policies where schemaname = 'weft' and tablename in ('shifts', 'shift_signups') loop
    execute format('drop policy %I on weft.%I', p.policyname, p.tablename);
  end loop;
end $$;
create policy shifts_read on weft.shifts for select to weft_user, weft_assistant
  using (weft_private.is_member(space_id));
create policy shifts_add on weft.shifts for insert to weft_user
  with check (created_by = weft_private.uid() and weft_private.can_edit(space_id));
create policy shifts_change on weft.shifts for update to weft_user
  using (weft_private.can_edit(space_id)) with check (weft_private.can_edit(space_id));
create policy shifts_delete on weft.shifts for delete to weft_user
  using (weft_private.can_edit(space_id));

create policy shift_signups_read on weft.shift_signups for select to weft_user, weft_assistant
  using (weft_private.is_member(space_id));
create policy shift_signups_claim on weft.shift_signups for insert to weft_user
  with check (user_id = weft_private.uid() and weft_private.is_member(space_id));
create policy shift_signups_give_back on weft.shift_signups for delete to weft_user
  using ((user_id = weft_private.uid() and weft_private.is_member(space_id)) or weft_private.can_edit(space_id));

-- shifts.space_id is not updatable; sign-ups are never updated; created_by, user_id, the sign-up's
-- space_id and the creation times are never granted.
grant select on weft.shifts, weft.shift_signups to weft_user, weft_assistant;
grant insert (space_id, title, starts_at, ends_at, places, note), update (title, starts_at, ends_at, places, note), delete on weft.shifts to weft_user;
grant insert (shift_id), delete on weft.shift_signups to weft_user;

-- Before a shift is added or changed: only channels; sensible times; never fewer places than people on it;
-- an ended shift is fixed. Someone who may not edit the channel is refused by the policy, so these checks
-- run only for someone who may (they tell an outsider nothing).
create or replace function weft_private.shift_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare v_taken integer;
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    if not weft_private.can_edit(new.space_id) then return new; end if;
    if not exists (select 1 from weft.spaces s where s.id = new.space_id and s.kind = 'channel') then
      raise exception 'only channels have shifts' using errcode = '22023';
    end if;
    if new.ends_at <= now() then
      raise exception 'a shift must end in the future' using errcode = '22023';
    end if;
  else
    new.space_id := old.space_id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    if old.ends_at <= now() then
      raise exception 'this shift has ended, so it can no longer change' using errcode = '42501';
    end if;
    if new.ends_at < now() - interval '5 minutes' then
      raise exception 'a shift cannot be moved into the past' using errcode = '22023';
    end if;
    select count(*) into v_taken from weft.shift_signups where shift_id = new.id;
    if new.places < v_taken then
      raise exception '% people are signed up for this shift, so it needs at least % places', v_taken, v_taken using errcode = '23514';
    end if;
  end if;
  if new.ends_at <= new.starts_at then
    raise exception 'a shift must end after it starts' using errcode = '22023';
  end if;
  if new.ends_at - new.starts_at > interval '7 days' then
    raise exception 'a shift can last at most 7 days' using errcode = '22023';
  end if;
  new.title := btrim(new.title);
  new.note := btrim(coalesce(new.note, ''));
  return new;
end $$;
drop trigger if exists shifts_guard on weft.shifts;
create trigger shifts_guard before insert or update on weft.shifts
  for each row execute function weft_private.shift_guard();

-- Before a place is claimed or given back. Row-level security runs after this on insert, so every check
-- that could tell something about another channel's shifts (full, ended, there at all) runs only for a
-- member of the shift's channel; anyone else gets the policy's refusal, learning nothing. The shift row is
-- locked before its places are counted, so claims on the same shift wait for each other. Deletes made by
-- the database itself (a shift, channel or person deleted, someone leaving) run inside another trigger and
-- always pass.
create or replace function weft_private.shift_signup_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare v_space uuid; v_places integer; v_ends timestamptz; v_taken integer;
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then return old; end if;
    if exists (select 1 from weft.shifts s where s.id = old.shift_id and s.ends_at <= now()) then
      raise exception 'this shift has ended, so its places can no longer change' using errcode = '42501';
    end if;
    return old;
  end if;
  select space_id into v_space from weft.shifts where id = new.shift_id;
  if v_space is null then   -- no such shift: the same answer as a refusal
    raise exception 'new row violates row-level security policy for table "shift_signups"' using errcode = '42501';
  end if;
  new.space_id := v_space;
  new.created_at := now();
  if not weft_private.is_member(v_space) then return new; end if;
  select places, ends_at into v_places, v_ends from weft.shifts where id = new.shift_id for update;
  if v_ends <= now() then
    raise exception 'this shift has ended, so its places can no longer change' using errcode = '42501';
  end if;
  if exists (select 1 from weft.shift_signups where shift_id = new.shift_id and user_id = weft_private.uid()) then
    raise exception 'you are already on this shift' using errcode = '23505';
  end if;
  select count(*) into v_taken from weft.shift_signups where shift_id = new.shift_id;
  if v_taken >= v_places then
    raise exception 'this shift is full' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists shift_signups_guard on weft.shift_signups;
create trigger shift_signups_guard before insert or delete on weft.shift_signups
  for each row execute function weft_private.shift_signup_guard();

-- Someone left or was removed from a channel: their sign-ups on its shifts go.
create or replace function weft_private.shift_member_left() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  delete from weft.shift_signups where space_id = old.space_id and user_id = old.user_id;
  return null;
end $$;
drop trigger if exists members_shift_left on weft.members;
create trigger members_shift_left after delete on weft.members for each row execute function weft_private.shift_member_left();

-- Live notices and the audit log: the shared triggers from 006 and 004 (both tables have id and space_id).
drop trigger if exists announce_shifts on weft.shifts;
create trigger announce_shifts after insert or update or delete on weft.shifts
  for each row execute function weft_private.announce();
drop trigger if exists audit_shifts on weft.shifts;
create trigger audit_shifts after update or delete on weft.shifts
  for each row execute function weft_private.audit_row();
drop trigger if exists announce_shift_signups on weft.shift_signups;
create trigger announce_shift_signups after insert or delete on weft.shift_signups
  for each row execute function weft_private.announce();
drop trigger if exists audit_shift_signups on weft.shift_signups;
create trigger audit_shift_signups after delete on weft.shift_signups
  for each row execute function weft_private.audit_row();

revoke execute on function weft_private.shift_guard(), weft_private.shift_signup_guard(), weft_private.shift_member_left()
  from public, weft_user, weft_assistant;
