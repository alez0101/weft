-- 028 boards: a Kanban view of a task list.
-- A board is not a new item: it is a task list (022) seen as columns, and its cards are the list's tasks,
-- the very same rows the Tasks app, the Calendar and the Home widget show. What this adds:
--   * weft.board_columns: a list's open stages ("To do", "Doing", or your own), in order. Columns reach the
--     space through their list, like tasks: members read, editors and owners add, rename, reorder and
--     delete, viewers read only. Every new task list starts with "To do" and "Doing"; existing lists get
--     them here.
--   * tasks.column_id: which open column a card sits in. Null, or a column that was deleted, means the
--     first column. A card can only be put in a column of its own list.
--   * The last column, Done, is built in: it is the tasks with done = true. Ticking a task in Tasks moves its
--     card to Done; dragging a card to Done ticks it. Its column_id is kept, so reopening puts it back.
-- The Tasks rule still holds: the person a task is assigned to may tick it off even as a viewer, and change
-- nothing else about it, which now includes its column.
set client_min_messages = warning;

create table if not exists weft.board_columns (
  id         uuid primary key default gen_random_uuid(),
  list_id    uuid not null references weft.items (id) on delete cascade,
  name       text not null check (length(btrim(name)) between 1 and 40),
  position   double precision not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists board_columns_list_idx on weft.board_columns (list_id, position);

alter table weft.tasks add column if not exists column_id uuid references weft.board_columns (id) on delete set null;
create index if not exists tasks_column_idx on weft.tasks (column_id) where column_id is not null;

alter table weft.board_columns enable row level security;
alter table weft.board_columns force row level security;
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'weft' and tablename = 'board_columns' loop
    execute format('drop policy %I on weft.board_columns', p.policyname);
  end loop;
end $$;
create policy board_columns_read on weft.board_columns for select to weft_user, weft_assistant
  using (weft_private.is_member(weft_private.tasklist_space(list_id)));
create policy board_columns_insert on weft.board_columns for insert to weft_user
  with check (weft_private.can_edit(weft_private.tasklist_space(list_id)));
create policy board_columns_change on weft.board_columns for update to weft_user
  using (weft_private.can_edit(weft_private.tasklist_space(list_id)))
  with check (weft_private.can_edit(weft_private.tasklist_space(list_id)));
create policy board_columns_delete on weft.board_columns for delete to weft_user
  using (weft_private.can_edit(weft_private.tasklist_space(list_id)));

-- list_id is not updatable: a column does not jump between lists.
grant select on weft.board_columns to weft_user, weft_assistant;
grant insert (list_id, name, position), update (name, position), delete on weft.board_columns to weft_user;
grant insert (column_id), update (column_id) on weft.tasks to weft_user;

-- Before a column write: tidy the name; at most 10 open columns in a list.
create or replace function weft_private.board_column_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  new.name := btrim(new.name);
  if tg_op = 'INSERT' and (select count(*) from weft.board_columns where list_id = new.list_id) >= 10 then
    raise exception 'a board has at most 10 columns besides Done' using errcode = '22023';
  end if;
  if tg_op = 'UPDATE' then new.created_at := old.created_at; end if;
  return new;
end $$;
drop trigger if exists board_columns_guard on weft.board_columns;
create trigger board_columns_guard before insert or update on weft.board_columns for each row execute function weft_private.board_column_guard();

-- The Tasks guard (022), extended: a card's column must belong to its own list, and someone who got here
-- only as the task's assignee may not move it between columns either. When the list itself is being
-- deleted, the columns' "set null" on its tasks passes through untouched.
create or replace function weft_private.task_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare v_space uuid;
begin
  v_space := weft_private.tasklist_space(coalesce(old.list_id, new.list_id));
  if tg_op = 'UPDATE' and v_space is null then return new; end if;   -- the list is being deleted
  if new.assignee_id is not null and (tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id)
     and not exists (select 1 from weft.members m where m.space_id = weft_private.tasklist_space(new.list_id) and m.user_id = new.assignee_id) then
    raise exception 'a task can only be assigned to someone in its space' using errcode = '22023';
  end if;
  if new.column_id is not null and (tg_op = 'INSERT' or new.column_id is distinct from old.column_id)
     and not exists (select 1 from weft.board_columns c where c.id = new.column_id and c.list_id = new.list_id) then
    raise exception 'a card can only go in a column of its own board' using errcode = '22023';
  end if;
  -- Someone who cannot edit the space got here only as the task's assignee: they may change done, nothing else.
  if tg_op = 'UPDATE' and not weft_private.can_edit(v_space)
     and (new.title, new.assignee_id, new.due_on, new.position, new.list_id, new.column_id)
         is distinct from (old.title, old.assignee_id, old.due_on, old.position, old.list_id, old.column_id) then
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

-- The list's text summary (022), now with the stage of open cards: "[ ] Title (Who, due 2026-11-20) in Doing".
create or replace function weft_private.refresh_tasklist_text(p_list uuid) returns void
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare t text;
begin
  select string_agg(line, E'\n' order by done, position) into t from (
    select k.done, k.position,
           case when k.done then '[x] ' else '[ ] ' end || k.title
           || case when u.display_name is not null or k.due_on is not null then
                ' (' || concat_ws(', ', u.display_name, 'due ' || k.due_on::text) || ')' else '' end
           || case when not k.done and c.name is not null then ' in ' || c.name else '' end as line
      from weft.tasks k left join weft.users u on u.id = k.assignee_id
                        left join weft.board_columns c on c.id = k.column_id
     where k.list_id = p_list order by k.done, k.position limit 300
  ) x;
  update weft.items set body_text = t where id = p_list and body_text is distinct from t;
end $$;

-- After a column change: refresh the summary (a rename shows there), announce it to members only, and keep
-- the old row in the audit log.
create or replace function weft_private.board_column_changed() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare r record; v_space uuid;
begin
  r := coalesce(new, old);
  v_space := weft_private.tasklist_space(r.list_id);
  if v_space is null then return null; end if;   -- the list itself is being deleted
  if tg_op = 'UPDATE' and new.name is distinct from old.name then perform weft_private.refresh_tasklist_text(r.list_id); end if;
  perform pg_notify('weft_events', json_build_object('t', 'board_columns', 'op', tg_op, 'id', r.id, 'space', v_space, 'list', r.list_id)::text);
  if tg_op in ('UPDATE', 'DELETE') then
    insert into weft.audit (table_name, row_id, space_id, op, actor_id, actor_role, old_row)
    values ('board_columns', old.id, v_space, tg_op, weft_private.uid(),
            coalesce(nullif(current_setting('role', true), 'none'), session_user), to_jsonb(old));
  end if;
  return null;
end $$;
drop trigger if exists board_columns_changed on weft.board_columns;
create trigger board_columns_changed after insert or update or delete on weft.board_columns for each row execute function weft_private.board_column_changed();

-- Every task list starts with "To do" and "Doing" (Done is built in). Only for the list just made.
create or replace function weft_private.tasklist_columns() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  insert into weft.board_columns (list_id, name, position) values (new.id, 'To do', 0), (new.id, 'Doing', 1);
  return null;
end $$;
drop trigger if exists items_tasklist_columns on weft.items;
create trigger items_tasklist_columns after insert on weft.items for each row
  when (new.kind = 'tasklist') execute function weft_private.tasklist_columns();

-- Existing lists without columns get the same two.
insert into weft.board_columns (list_id, name, position)
select i.id, c.name, c.position from weft.items i
 cross join (values ('To do', 0), ('Doing', 1)) as c(name, position)
 where i.kind = 'tasklist' and not exists (select 1 from weft.board_columns b where b.list_id = i.id);

revoke execute on function weft_private.board_column_guard(), weft_private.board_column_changed(), weft_private.tasklist_columns(),
  weft_private.task_guard(), weft_private.refresh_tasklist_text(uuid) from public, weft_user, weft_assistant;
grant execute on function weft_private.refresh_tasklist_text(uuid) to weft_owner;
