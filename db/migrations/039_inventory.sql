-- 039 inventory: the things a group owns, where they are kept, and who has them now, with check out and
-- check in.
-- An inventory is an item (kind 'inventory'), so it lives in a space and gets everything items have: the one
-- permission rule, moving, deleting, sharing links, the audit log, search and the assistant (through the
-- inventory's text summary in body_text). Its title is the inventory's name. Its things and the record of
-- check outs and check ins reach the space through the inventory: members read all of it, viewers included.
-- Editors and owners add, change and delete things, and check a thing out to anyone in the space or back in
-- from anyone. Every member, viewers included, may check out a thing that is in to themselves and check in
-- what they have (borrowing the tent should not need edit rights); nothing else. The assistant role only
-- reads. Whoever has a thing must be a member of the space when it is checked out to them; someone who later
-- leaves keeps it until it is checked in. Who checked out or in and when are written here, never by the
-- client. Nothing jumps between inventories (move the whole inventory instead).
set client_min_messages = warning;

alter table weft.items drop constraint if exists items_kind_check;
alter table weft.items add constraint items_kind_check check (kind in ('document', 'wiki', 'whiteboard', 'table', 'file', 'tasklist', 'poll', 'form', 'linklist', 'meeting', 'addressbook', 'decisionlog', 'qa', 'checklist', 'expenselist', 'inventory'));

create table if not exists weft.inventory_things (
  id            uuid primary key default gen_random_uuid(),
  inventory_id  uuid not null references weft.items (id) on delete cascade,
  name          text not null check (length(btrim(name)) between 1 and 200),
  location      text not null default '' check (length(location) <= 200),
  note          text not null default '' check (length(note) <= 1000),
  holder_id     uuid references weft.users (id),
  held_since    timestamptz,
  created_by    uuid not null default weft_private.uid() references weft.users (id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists inventory_things_inventory_idx on weft.inventory_things (inventory_id, location, name);
create index if not exists inventory_things_holder_idx on weft.inventory_things (holder_id) where holder_id is not null;

-- The record: one row per check out or check in, written only by the trigger below.
create table if not exists weft.inventory_moves (
  id            uuid primary key default gen_random_uuid(),
  thing_id      uuid not null references weft.inventory_things (id) on delete cascade,
  inventory_id  uuid not null references weft.items (id) on delete cascade,
  action        text not null check (action in ('out', 'in')),
  holder_id     uuid not null references weft.users (id),
  by_id         uuid references weft.users (id),
  at            timestamptz not null default clock_timestamp()
);
create index if not exists inventory_moves_thing_idx on weft.inventory_moves (thing_id, at desc);
create index if not exists inventory_moves_inventory_idx on weft.inventory_moves (inventory_id, at desc);

-- The space of an inventory (null if there is none). security definer: used inside policies; it returns
-- only a space id.
create or replace function weft_private.inventory_space(p_inventory uuid) returns uuid
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select space_id from weft.items where id = p_inventory and kind = 'inventory'
$$;

do $$
declare t text; p record;
begin
  foreach t in array array['inventory_things', 'inventory_moves'] loop
    execute format('alter table weft.%I enable row level security', t);
    execute format('alter table weft.%I force row level security', t);
    for p in select policyname from pg_policies where schemaname = 'weft' and tablename = t loop
      execute format('drop policy %I on weft.%I', p.policyname, t);
    end loop;
  end loop;
end $$;

create policy inventory_things_read on weft.inventory_things for select to weft_user, weft_assistant
  using (weft_private.is_member(weft_private.inventory_space(inventory_id)));
create policy inventory_things_add on weft.inventory_things for insert to weft_user
  with check (created_by = weft_private.uid() and weft_private.can_edit(weft_private.inventory_space(inventory_id)));
create policy inventory_things_change on weft.inventory_things for update to weft_user
  using (weft_private.can_edit(weft_private.inventory_space(inventory_id)))
  with check (weft_private.can_edit(weft_private.inventory_space(inventory_id)));
-- Any member: a thing that is in, or that they have, and it ends up in or with them. Which columns may
-- change this way (only who has it) is checked by the guard trigger.
create policy inventory_things_borrow on weft.inventory_things for update to weft_user
  using (weft_private.is_member(weft_private.inventory_space(inventory_id)) and (holder_id is null or holder_id = weft_private.uid()))
  with check (weft_private.is_member(weft_private.inventory_space(inventory_id)) and (holder_id is null or holder_id = weft_private.uid()));
create policy inventory_things_delete on weft.inventory_things for delete to weft_user
  using (weft_private.can_edit(weft_private.inventory_space(inventory_id)));

create policy inventory_moves_read on weft.inventory_moves for select to weft_user, weft_assistant
  using (weft_private.is_member(weft_private.inventory_space(inventory_id)));

-- inventory_id is never updatable; created_by, held_since and the times are never granted; the record is
-- never written by a person.
grant select on weft.inventory_things, weft.inventory_moves to weft_user, weft_assistant;
grant insert (inventory_id, name, location, note, holder_id), update (name, location, note, holder_id), delete on weft.inventory_things to weft_user;
revoke execute on function weft_private.inventory_space(uuid) from public;
grant execute on function weft_private.inventory_space(uuid) to weft_user, weft_assistant;

-- Before a write: tidy the text, keep authorship and times, set held_since, and check who has it. Someone
-- who may only borrow changes nothing but who has it, and only between nobody and themselves (the policy
-- already keeps them to such rows; this keeps them to that column). A new holder must be a member of the
-- space; that answer is given only to members (anyone else is refused by row-level security, whatever the
-- data).
create or replace function weft_private.inventory_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare v_space uuid; v_me uuid := weft_private.uid();
begin
  v_space := weft_private.inventory_space(new.inventory_id);
  new.name := btrim(new.name);
  new.location := btrim(coalesce(new.location, ''));
  new.note := btrim(coalesce(new.note, ''));
  if tg_op = 'INSERT' then
    new.created_at := now(); new.updated_at := now();
    new.held_since := case when new.holder_id is not null then now() end;
  else
    new.inventory_id := old.inventory_id; new.created_by := old.created_by; new.created_at := old.created_at; new.updated_at := now();
    new.held_since := case when new.holder_id is null then null
                           when new.holder_id is distinct from old.holder_id then now() else old.held_since end;
    if not weft_private.can_edit(v_space) then
      if new.name is distinct from old.name or new.location is distinct from old.location or new.note is distinct from old.note then
        raise exception 'only editors can change a thing; you can check it out to yourself or check in what you have' using errcode = '42501';
      end if;
      if new.holder_id is distinct from old.holder_id
         and not ((old.holder_id is null and new.holder_id = v_me) or (old.holder_id = v_me and new.holder_id is null)) then
        raise exception 'you can check things out only to yourself, and check in only what you have' using errcode = '42501';
      end if;
    end if;
  end if;
  if weft_private.is_member(v_space) and new.holder_id is not null
     and (tg_op = 'INSERT' or new.holder_id is distinct from old.holder_id)
     and not exists (select 1 from weft.members where space_id = v_space and user_id = new.holder_id) then
    raise exception 'things can be checked out only to members of this space' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists inventory_things_guard on weft.inventory_things;
create trigger inventory_things_guard before insert or update on weft.inventory_things
  for each row execute function weft_private.inventory_guard();

-- The inventory's text summary, what search and the assistant read: how many things and how many are out,
-- then each thing (by where it is kept, up to 300) with who has it.
create or replace function weft_private.refresh_inventory_text(p_inventory uuid) returns void
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare t text; n int; out_n int; lines text;
begin
  select count(*), count(holder_id) into n, out_n from weft.inventory_things where inventory_id = p_inventory;
  select string_agg(line, E'\n' order by loc, nm) into lines from (
    select lower(th.location) as loc, lower(th.name) as nm,
           '- ' || th.name
           || case when th.location <> '' then ', kept in ' || th.location else '' end
           || case when th.holder_id is null then ', in its place'
                   else ', checked out to ' || coalesce(u.display_name, 'someone') || ' since ' || to_char(th.held_since, 'YYYY-MM-DD') end
           || case when th.note <> '' then '. ' || th.note else '' end as line
      from weft.inventory_things th left join weft.users u on u.id = th.holder_id
     where th.inventory_id = p_inventory order by lower(th.location), lower(th.name) limit 300
  ) x;
  t := concat_ws(E'\n', 'Inventory, ' || n || case when n = 1 then ' thing' else ' things' end || ', ' || out_n || ' checked out',
                 case when lines is not null then 'Things, by where they are kept:' || E'\n' || lines end);
  update weft.items set body_text = t where id = p_inventory and body_text is distinct from t;
end $$;

-- After a change: write the record when who has it changes, refresh the summary, announce it (to members
-- only, through the notification server; ids only), and keep the old row in the audit log under the
-- inventory's space.
create or replace function weft_private.inventory_changed() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare r record; v_space uuid;
begin
  r := coalesce(new, old);
  v_space := weft_private.inventory_space(r.inventory_id);
  if v_space is null then return null; end if;   -- the inventory is being deleted
  if tg_op = 'UPDATE' and new.holder_id is distinct from old.holder_id then
    if old.holder_id is not null then
      insert into weft.inventory_moves (thing_id, inventory_id, action, holder_id, by_id) values (new.id, new.inventory_id, 'in', old.holder_id, weft_private.uid());
    end if;
    if new.holder_id is not null then
      insert into weft.inventory_moves (thing_id, inventory_id, action, holder_id, by_id) values (new.id, new.inventory_id, 'out', new.holder_id, weft_private.uid());
    end if;
  elsif tg_op = 'INSERT' and new.holder_id is not null then
    insert into weft.inventory_moves (thing_id, inventory_id, action, holder_id, by_id) values (new.id, new.inventory_id, 'out', new.holder_id, weft_private.uid());
  end if;
  perform weft_private.refresh_inventory_text(r.inventory_id);
  perform pg_notify('weft_events', json_build_object('t', 'inventory', 'op', tg_op, 'id', r.id, 'space', v_space, 'list', r.inventory_id)::text);
  if tg_op in ('UPDATE', 'DELETE') then
    insert into weft.audit (table_name, row_id, space_id, op, actor_id, actor_role, old_row)
    values (tg_table_name, r.id, v_space, tg_op, weft_private.uid(),
            coalesce(nullif(current_setting('role', true), 'none'), session_user), to_jsonb(old));
  end if;
  return null;
end $$;
drop trigger if exists inventory_things_changed on weft.inventory_things;
create trigger inventory_things_changed after insert or update or delete on weft.inventory_things
  for each row execute function weft_private.inventory_changed();

revoke execute on function weft_private.inventory_guard(), weft_private.refresh_inventory_text(uuid), weft_private.inventory_changed()
  from public, weft_user, weft_assistant;
grant execute on function weft_private.refresh_inventory_text(uuid) to weft_owner;
