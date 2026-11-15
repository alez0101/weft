-- 059 key results from tasks: a key result in Goals (041) can follow a task list (022) in the same space, counting
-- its done tasks out of all of them, so its progress moves without anyone typing a number.
--   * One column, weft.key_results.tasklist_id (optional; the list's deletion clears it). No new table: the key
--     result already reaches its space through its goal and set, so 041's policies decide who sees the link
--     (members) and who sets or clears it (editors and owners), unchanged. The assistant only reads.
--   * Only a task list in the goal set's own space can be chosen; any other id (another space, not a task list,
--     nothing at all) is refused with the same message.
--   * While linked, the database keeps the numbers: start 0, target the number of tasks in the list, current the
--     number done, unit "tasks". Whatever a client sends for them is replaced. Each task added, ticked off,
--     reopened or deleted brings every key result following its list up to date at once, and the usual
--     key-result notice reloads Goals. The value stamp names whoever changed the task (an assignee who is a
--     viewer may tick off their own task, 022; the stamp then names them, in the same space).
--   * An empty list is 0 of 0, so 0 %: a linked key result may have target = start; a typed one still may not.
--   * Clearing the link keeps the last numbers as typed ones (a target of 0 becomes 1, so the 041 rule holds).
--   * Moves: if the goal set or the task list moves to another space, the link is cleared. When the set moved,
--     the audit row and notice for that go under the space it moved FROM, so the new space learns nothing
--     about a list it cannot see (the numbers themselves are the key result's own and move with it, as in 041).
set client_min_messages = warning;

alter table weft.key_results add column if not exists tasklist_id uuid references weft.items (id) on delete set null;
create index if not exists key_results_tasklist_idx on weft.key_results (tasklist_id) where tasklist_id is not null;

alter table weft.key_results drop constraint if exists key_results_target_differs;
alter table weft.key_results add constraint key_results_target_differs check (target_value <> start_value or tasklist_id is not null);

-- Column grants: 041's plus tasklist_id. created_by, the value stamps and progress are still never granted.
grant insert (tasklist_id), update (tasklist_id) on weft.key_results to weft_user;

-- 041's guard, plus the link: check it, then fill in the numbers from the list.
create or replace function weft_private.key_result_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare v_done integer; v_all integer;
begin
  new.title := btrim(new.title);
  new.unit := btrim(coalesce(new.unit, ''));
  if new.tasklist_id is not null then
    -- Checked only for someone who may edit the goal's space; row-level security refuses everyone else after
    -- this, without saying anything about where the list is.
    if (tg_op = 'INSERT' or new.tasklist_id is distinct from old.tasklist_id)
       and weft_private.can_edit(weft_private.goal_space(new.goal_id))
       and weft_private.tasklist_space(new.tasklist_id) is distinct from weft_private.goal_space(new.goal_id) then
      raise exception 'choose a task list in the same space as the goals' using errcode = '22023';
    end if;
    select count(*) filter (where done), count(*) into v_done, v_all from weft.tasks where list_id = new.tasklist_id;
    new.start_value := 0; new.current_value := v_done; new.target_value := v_all; new.unit := 'tasks';
  elsif tg_op = 'UPDATE' and old.tasklist_id is not null and new.target_value = new.start_value then
    new.target_value := new.start_value + 1;   -- unlinked from an empty list: keep a valid typed key result
  end if;
  if tg_op = 'UPDATE' then
    new.created_at := old.created_at; new.created_by := old.created_by;
    if new.current_value is distinct from old.current_value then
      new.value_updated_by := weft_private.uid(); new.value_updated_at := now();
    else
      new.value_updated_by := old.value_updated_by; new.value_updated_at := old.value_updated_at;
    end if;
  else
    new.created_at := now(); new.value_updated_by := weft_private.uid(); new.value_updated_at := now();
  end if;
  return new;
end $$;

-- 041's after-change trigger, with one difference: while a moved goal set's links are being cleared, the audit
-- row and the notice go under the space it moved from.
create or replace function weft_private.key_result_changed() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare r record; v_set uuid; v_space uuid;
begin
  r := coalesce(new, old);
  select g.set_id, i.space_id into v_set, v_space
    from weft.goals g join weft.items i on i.id = g.set_id and i.kind = 'goalset' where g.id = r.goal_id;
  if v_space is null then return null; end if;   -- the goal or the set is being deleted
  perform weft_private.refresh_goalset_text(v_set);
  v_space := coalesce(nullif(current_setting('weft.key_results_moving_from', true), '')::uuid, v_space);
  perform pg_notify('weft_events', json_build_object('t', 'goals', 'op', tg_op, 'id', r.id, 'space', v_space, 'set', v_set)::text);
  if tg_op in ('UPDATE', 'DELETE') then
    insert into weft.audit (table_name, row_id, space_id, op, actor_id, actor_role, old_row)
    values ('key_results', old.id, v_space, tg_op, weft_private.uid(),
            coalesce(nullif(current_setting('role', true), 'none'), session_user), to_jsonb(old));
  end if;
  return null;
end $$;

-- A task changed: every key result following its list (old and new list) is brought up to date, as the caller,
-- only where the numbers really differ. The guard above does the counting.
create or replace function weft_private.task_key_results() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare v_list uuid; v_done integer; v_all integer;
begin
  for v_list in select distinct x from unnest(array[case when tg_op <> 'INSERT' then old.list_id end,
                                                    case when tg_op <> 'DELETE' then new.list_id end]) x where x is not null loop
    continue when weft_private.tasklist_space(v_list) is null;   -- the list itself is being deleted
    continue when not exists (select 1 from weft.key_results where tasklist_id = v_list);
    select count(*) filter (where done), count(*) into v_done, v_all from weft.tasks where list_id = v_list;
    update weft.key_results k set tasklist_id = k.tasklist_id
     where k.tasklist_id = v_list
       and (k.current_value <> v_done or k.target_value <> v_all or k.start_value <> 0);
  end loop;
  return null;
end $$;
drop trigger if exists tasks_key_results on weft.tasks;
create trigger tasks_key_results after insert or delete or update of done, list_id on weft.tasks
  for each row execute function weft_private.task_key_results();

-- A goal set or a task list moved to another space: links that now cross spaces are cleared.
create or replace function weft_private.key_results_link_moved() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  if new.kind = 'goalset' then
    perform set_config('weft.key_results_moving_from', old.space_id::text, true);   -- see key_result_changed
    update weft.key_results k set tasklist_id = null
      from weft.goals g
     where g.id = k.goal_id and g.set_id = new.id and k.tasklist_id is not null
       and weft_private.tasklist_space(k.tasklist_id) is distinct from new.space_id;
    perform set_config('weft.key_results_moving_from', '', true);
  else
    update weft.key_results k set tasklist_id = null
     where k.tasklist_id = new.id and weft_private.goal_space(k.goal_id) is distinct from new.space_id;
  end if;
  return null;
end $$;
drop trigger if exists items_key_results_link_moved on weft.items;
create trigger items_key_results_link_moved after update of space_id on weft.items for each row
  when (new.kind in ('goalset', 'tasklist') and new.space_id is distinct from old.space_id)
  execute function weft_private.key_results_link_moved();

revoke execute on function weft_private.key_result_guard(), weft_private.key_result_changed(), weft_private.task_key_results(),
  weft_private.key_results_link_moved() from public, weft_user, weft_assistant;
