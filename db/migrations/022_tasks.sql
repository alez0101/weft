-- 022 tasks: to-do lists in a space.
-- A task list is an item (kind 'tasklist'), so it lives in a space and gets everything items have: the
-- one permission rule, moving, deleting, sharing links, the audit log, search and the assistant (through
-- the list's text summary in body_text). Tasks reach the space through their list, like table rows: you
-- see them only if you can see the list, and change them only if you can edit its space. Viewers read.
-- A task can be assigned only to a member of the list's space. Who made a task, and when it was done,
-- are set here, never by the client. The person a task is assigned to may tick it off (or reopen it)
-- even as a viewer, and change nothing else about it (Alex, 2026-11-13).
set client_min_messages = warning;

alter table weft.items drop constraint if exists items_kind_check;
alter table weft.items add constraint items_kind_check check (kind in ('document', 'wiki', 'whiteboard', 'table', 'file', 'tasklist'));

create table if not exists weft.tasks (
  id          uuid primary key default gen_random_uuid(),
  list_id     uuid not null references weft.items (id) on delete cascade,
  title       text not null check (length(btrim(title)) between 1 and 300),
  assignee_id uuid references weft.users (id) on delete set null,
  due_on      date,
  done        boolean not null default false,
  done_at     timestamptz,
  position    double precision not null default 0,
  created_by  uuid not null default weft_private.uid() references weft.users (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists tasks_list_idx on weft.tasks (list_id, position);
create index if not exists tasks_due_idx on weft.tasks (due_on) where not done and due_on is not null;

-- The space of a task list (null if it is not one). security definer: used inside policies.
create or replace function weft_private.tasklist_space(p_list uuid) returns uuid
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select space_id from weft.items where id = p_list and kind = 'tasklist'
$$;

alter table weft.tasks enable row level security;
alter table weft.tasks force row level security;
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'weft' and tablename = 'tasks' loop
    execute format('drop policy %I on weft.tasks', p.policyname);
  end loop;
end $$;
create policy tasks_read on weft.tasks for select to weft_user, weft_assistant
  using (weft_private.is_member(weft_private.tasklist_space(list_id)));
create policy tasks_insert on weft.tasks for insert to weft_user
  with check (created_by = weft_private.uid() and weft_private.can_edit(weft_private.tasklist_space(list_id)));
create policy tasks_change on weft.tasks for update to weft_user
  using (weft_private.can_edit(weft_private.tasklist_space(list_id)))
  with check (weft_private.can_edit(weft_private.tasklist_space(list_id)));
-- The assignee, editor or not, may update their own task; task_guard below lets a non-editor change only done.
create policy tasks_assignee_done on weft.tasks for update to weft_user
  using (assignee_id = weft_private.uid() and weft_private.is_member(weft_private.tasklist_space(list_id)))
  with check (assignee_id = weft_private.uid() and weft_private.is_member(weft_private.tasklist_space(list_id)));
create policy tasks_delete on weft.tasks for delete to weft_user
  using (weft_private.can_edit(weft_private.tasklist_space(list_id)));

-- list_id is not updatable: a task does not jump between lists (move the whole list instead).
grant select on weft.tasks to weft_user, weft_assistant;
grant insert (list_id, title, assignee_id, due_on, done, position),
      update (title, assignee_id, due_on, done, position), delete on weft.tasks to weft_user;
grant execute on function weft_private.tasklist_space(uuid) to weft_user, weft_assistant;

-- Before a write: the assignee must be a member of the list's space; done_at follows done.
create or replace function weft_private.task_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  if new.assignee_id is not null and (tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id)
     and not exists (select 1 from weft.members m where m.space_id = weft_private.tasklist_space(new.list_id) and m.user_id = new.assignee_id) then
    raise exception 'a task can only be assigned to someone in its space' using errcode = '22023';
  end if;
  -- Someone who cannot edit the space got here only as the task's assignee: they may change done, nothing else.
  if tg_op = 'UPDATE' and not weft_private.can_edit(weft_private.tasklist_space(old.list_id))
     and (new.title, new.assignee_id, new.due_on, new.position, new.list_id)
         is distinct from (old.title, old.assignee_id, old.due_on, old.position, old.list_id) then
    raise exception 'you can only tick off a task assigned to you' using errcode = '42501';
  end if;
  new.title := btrim(new.title);
  if tg_op = 'INSERT' then
    new.done_at := case when new.done then now() end;
  else
    new.updated_at := now();
    if new.done is distinct from old.done then new.done_at := case when new.done then now() end;
    else new.done_at := old.done_at; end if;
  end if;
  return new;
end $$;
drop trigger if exists tasks_guard on weft.tasks;
create trigger tasks_guard before insert or update on weft.tasks for each row execute function weft_private.task_guard();

-- The list's text summary: up to 300 tasks, open first, as "[ ] Title (Who, due 2026-11-20)".
create or replace function weft_private.refresh_tasklist_text(p_list uuid) returns void
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare t text;
begin
  select string_agg(line, E'\n' order by done, position) into t from (
    select k.done, k.position,
           case when k.done then '[x] ' else '[ ] ' end || k.title
           || case when u.display_name is not null or k.due_on is not null then
                ' (' || concat_ws(', ', u.display_name, 'due ' || k.due_on::text) || ')' else '' end as line
      from weft.tasks k left join weft.users u on u.id = k.assignee_id
     where k.list_id = p_list order by k.done, k.position limit 300
  ) x;
  update weft.items set body_text = t where id = p_list and body_text is distinct from t;
end $$;

-- After a change: refresh the summary, announce it (to members only, through the notification server),
-- and keep the old row in the audit log.
create or replace function weft_private.task_changed() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare r record; v_space uuid;
begin
  r := coalesce(new, old);
  v_space := weft_private.tasklist_space(r.list_id);
  if v_space is null then return null; end if;   -- the list itself is being deleted
  perform weft_private.refresh_tasklist_text(r.list_id);
  perform pg_notify('weft_events', json_build_object('t', 'tasks', 'op', tg_op, 'id', r.id, 'space', v_space, 'list', r.list_id)::text);
  if tg_op in ('UPDATE', 'DELETE') then
    insert into weft.audit (table_name, row_id, space_id, op, actor_id, actor_role, old_row)
    values ('tasks', old.id, v_space, tg_op, weft_private.uid(),
            coalesce(nullif(current_setting('role', true), 'none'), session_user), to_jsonb(old));
  end if;
  return null;
end $$;
drop trigger if exists tasks_changed on weft.tasks;
create trigger tasks_changed after insert or update or delete on weft.tasks for each row execute function weft_private.task_changed();

-- A list moved to another space: tasks assigned to someone who is not in the new space lose their
-- assignee (so no name travels into a space that person is not in), and the summary is rebuilt.
create or replace function weft_private.tasklist_moved() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  update weft.tasks k set assignee_id = null
   where k.list_id = new.id and k.assignee_id is not null
     and not exists (select 1 from weft.members m where m.space_id = new.space_id and m.user_id = k.assignee_id);
  perform weft_private.refresh_tasklist_text(new.id);
  return null;
end $$;
drop trigger if exists items_tasklist_moved on weft.items;
create trigger items_tasklist_moved after update of space_id on weft.items for each row
  when (new.kind = 'tasklist' and new.space_id is distinct from old.space_id) execute function weft_private.tasklist_moved();

revoke execute on function weft_private.task_guard(), weft_private.refresh_tasklist_text(uuid), weft_private.task_changed(), weft_private.tasklist_moved()
  from public, weft_user, weft_assistant;
grant execute on function weft_private.refresh_tasklist_text(uuid) to weft_owner;
