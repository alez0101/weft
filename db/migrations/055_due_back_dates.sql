-- 055 due-back dates for borrowed things: a thing checked out in Inventory (039) can carry a "back by" date.
--   * One column, weft.inventory_things.due_back (a date, optional). No new table: the thing already reaches
--     its space through its inventory, so the 039 policies decide who sees and writes it, unchanged.
--   * Editors and owners set it when they check a thing out, and change or clear it on anything that is out.
--     A member who may only borrow (a viewer) may set or change it only on a thing they have, and nothing
--     else changes (the 039 borrow policy already keeps them to rows that are in or theirs; the guard below
--     keeps them to who has it and its date).
--   * A thing that is in has no date: checking in clears it, here, whatever the client sends. A date that is
--     set or changed may not be in the past (one day of slack for time zones) nor more than five years ahead;
--     a date already set stays, so an overdue thing can still be edited.
--   * The inventory's text summary (search and the assistant) says "back by YYYY-MM-DD" for things that have
--     a date. Live updates, the record of check outs and the audit log are 039's, unchanged.
--   * The assistant role keeps reading only.
set client_min_messages = warning;

alter table weft.inventory_things add column if not exists due_back date;
create index if not exists inventory_things_due_idx on weft.inventory_things (holder_id, due_back) where holder_id is not null;

-- Column grants: 039's plus due_back (still never inventory_id on update, never created_by or held_since).
grant insert (due_back), update (due_back) on weft.inventory_things to weft_user;

-- 039's guard with the date added (the same checks, in the same order, then the date rules).
create or replace function weft_private.inventory_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare v_space uuid; v_me uuid := weft_private.uid(); v_due_changed boolean;
begin
  v_space := weft_private.inventory_space(new.inventory_id);
  new.name := btrim(new.name);
  new.location := btrim(coalesce(new.location, ''));
  new.note := btrim(coalesce(new.note, ''));
  if new.holder_id is null then new.due_back := null; end if;   -- a thing that is in has no date
  if tg_op = 'INSERT' then
    new.created_at := now(); new.updated_at := now();
    new.held_since := case when new.holder_id is not null then now() end;
    v_due_changed := new.due_back is not null;
  else
    new.inventory_id := old.inventory_id; new.created_by := old.created_by; new.created_at := old.created_at; new.updated_at := now();
    new.held_since := case when new.holder_id is null then null
                           when new.holder_id is distinct from old.holder_id then now() else old.held_since end;
    v_due_changed := new.due_back is distinct from old.due_back and new.due_back is not null;
    if not weft_private.can_edit(v_space) then
      if new.name is distinct from old.name or new.location is distinct from old.location or new.note is distinct from old.note then
        raise exception 'only editors can change a thing; you can check it out to yourself or check in what you have' using errcode = '42501';
      end if;
      if new.holder_id is distinct from old.holder_id
         and not ((old.holder_id is null and new.holder_id = v_me) or (old.holder_id = v_me and new.holder_id is null)) then
        raise exception 'you can check things out only to yourself, and check in only what you have' using errcode = '42501';
      end if;
      if new.due_back is distinct from old.due_back and new.holder_id is not null and new.holder_id is distinct from v_me then
        raise exception 'you can set a back by date only on what you have' using errcode = '42501';
      end if;
    end if;
  end if;
  if weft_private.is_member(v_space) and new.holder_id is not null
     and (tg_op = 'INSERT' or new.holder_id is distinct from old.holder_id)
     and not exists (select 1 from weft.members where space_id = v_space and user_id = new.holder_id) then
    raise exception 'things can be checked out only to members of this space' using errcode = '23514';
  end if;
  if v_due_changed and weft_private.is_member(v_space) then
    if new.due_back < current_date - 1 then
      raise exception 'the back by date cannot be in the past' using errcode = '22023';
    elsif new.due_back > current_date + interval '5 years' then
      raise exception 'the back by date must be within five years' using errcode = '22023';
    end if;
  end if;
  return new;
end $$;

-- 039's summary with the date: "..., checked out to Pat Public since 2026-11-15, back by 2026-11-20".
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
                   else ', checked out to ' || coalesce(u.display_name, 'someone') || ' since ' || to_char(th.held_since, 'YYYY-MM-DD')
                        || case when th.due_back is not null then ', back by ' || to_char(th.due_back, 'YYYY-MM-DD') else '' end end
           || case when th.note <> '' then '. ' || th.note else '' end as line
      from weft.inventory_things th left join weft.users u on u.id = th.holder_id
     where th.inventory_id = p_inventory order by lower(th.location), lower(th.name) limit 300
  ) x;
  t := concat_ws(E'\n', 'Inventory, ' || n || case when n = 1 then ' thing' else ' things' end || ', ' || out_n || ' checked out',
                 case when lines is not null then 'Things, by where they are kept:' || E'\n' || lines end);
  update weft.items set body_text = t where id = p_inventory and body_text is distinct from t;
end $$;

revoke execute on function weft_private.inventory_guard(), weft_private.refresh_inventory_text(uuid) from public, weft_user, weft_assistant;
grant execute on function weft_private.refresh_inventory_text(uuid) to weft_owner;
