-- 077 task from a message: any chat message can become a task in a task list of the same space, with a link back
-- to the message it came from.
--   * One column, weft.tasks.message_id: the message the task came from (cleared if the message is deleted). No
--     new table, so the Tasks rules (022, 028, 050) decide who sees the task and who changes it.
--   * The link is set only when the task is made: insert is granted on it, update is not, so nobody re-points a
--     task at another message. It must be a message in the list's own space; "in another space" and "no such
--     message" get the same answer, and only someone who can edit the list's space hears it (anyone else is
--     refused by row-level security as before). Repeats (050) start without a link.
--   * Viewers cannot make tasks (022). The assistant role reads the column with the task and writes nothing.
--   * Search and the assistant: the list's text summary is unchanged (the task's title is the message text).
--   * Moves: a list moved to another space clears links to messages that stayed behind. That clean-up is
--     recorded in the audit log under the space the list moved FROM and announced nowhere, so the new space's
--     members learn nothing about a message they cannot read.
set client_min_messages = warning;

alter table weft.tasks add column if not exists message_id uuid references weft.messages (id) on delete set null;
create index if not exists tasks_message_idx on weft.tasks (message_id) where message_id is not null;

grant insert (message_id) on weft.tasks to weft_user;

-- Before a write: a new link must point to a message in the list's space; an existing link can only be cleared
-- (by Weft's own clean-ups: a deleted message, a moved list).
create or replace function weft_private.task_message_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare v_space uuid;
begin
  if new.message_id is null then return new; end if;
  if tg_op = 'UPDATE' then
    if new.message_id is distinct from old.message_id then
      raise exception 'a task''s message link is set only when the task is made' using errcode = '42501';
    end if;
    return new;
  end if;
  v_space := weft_private.tasklist_space(new.list_id);
  if not weft_private.can_edit(v_space) then return new; end if;   -- row-level security refuses it
  if not exists (select 1 from weft.messages m where m.id = new.message_id and m.space_id = v_space) then
    raise exception 'a task can only link to a message in its own space' using errcode = '22023';
  end if;
  return new;
end $$;
drop trigger if exists tasks_message_guard on weft.tasks;
create trigger tasks_message_guard before insert or update of message_id on weft.tasks
  for each row execute function weft_private.task_message_guard();

-- 022's after-change trigger, with one difference: while a moved list's message links are being cleared, the
-- audit row goes under the space it moved from and nothing is announced.
create or replace function weft_private.task_changed() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare r record; v_space uuid; v_from uuid;
begin
  r := coalesce(new, old);
  v_space := weft_private.tasklist_space(r.list_id);
  if v_space is null then return null; end if;   -- the list itself is being deleted
  perform weft_private.refresh_tasklist_text(r.list_id);
  v_from := nullif(current_setting('weft.task_messages_moving_from', true), '')::uuid;
  if v_from is null then
    perform pg_notify('weft_events', json_build_object('t', 'tasks', 'op', tg_op, 'id', r.id, 'space', v_space, 'list', r.list_id)::text);
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    insert into weft.audit (table_name, row_id, space_id, op, actor_id, actor_role, old_row)
    values ('tasks', old.id, coalesce(v_from, v_space), tg_op, weft_private.uid(),
            coalesce(nullif(current_setting('role', true), 'none'), session_user), to_jsonb(old));
  end if;
  return null;
end $$;

-- A task list moved to another space: tasks keep their place, but links to messages left behind are cleared.
create or replace function weft_private.task_messages_moved() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  perform set_config('weft.task_messages_moving_from', old.space_id::text, true);   -- see task_changed
  update weft.tasks k set message_id = null
    from weft.messages m
   where k.list_id = new.id and m.id = k.message_id and m.space_id is distinct from new.space_id;
  perform set_config('weft.task_messages_moving_from', '', true);
  return null;
end $$;
drop trigger if exists items_task_messages_moved on weft.items;
create trigger items_task_messages_moved after update of space_id on weft.items for each row
  when (new.kind = 'tasklist' and new.space_id is distinct from old.space_id) execute function weft_private.task_messages_moved();

revoke execute on function weft_private.task_message_guard(), weft_private.task_changed(), weft_private.task_messages_moved()
  from public, weft_user, weft_assistant;
