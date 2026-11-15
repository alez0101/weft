-- 053 comments on tasks: a short comment thread under each task (in Tasks, and on its card in Boards), so
-- questions and updates about a task stay with it instead of in chat.
--   * weft.task_comments: one row per comment (task, body of 1 to 1000 characters, author, time). A comment
--     reaches its space through its task's list (022), like the task itself: no space column of its own.
--   * Members of the list's space read the comments, viewers included. Editors and owners post; so does the
--     person the task is assigned to, even as a viewer (the same rule that lets them tick it off, 022).
--     You delete your own comment while you are a member; owners of the space delete any (tidying up).
--     Comments are not edited (post again, or delete and post). The assistant role only reads.
--   * author_id defaults to weft_private.uid() and is never granted, so it cannot be forged; created_at is
--     set here. Nothing jumps between tasks (task_id is not updatable).
--   * Search and the assistant: the list's text summary (050) gains, under each task, its three latest
--     comments ("  Comment by Olive: ...", each shortened to 300 characters).
--   * Moves: a comment stays with its task when the list moves to another space. Like a task's assignee
--     (022), a comment whose author is not a member of the new space loses its author (shown as "Someone not
--     in this space"), so no identity travels into a space that person is not in. That change is recorded
--     in the audit log under the space the list moved FROM, never the new one, and announced nowhere.
--   * Deleting a task deletes its comments; deleting the list deletes both.
--   * Live: a 'task_comments' notice (ids only, with the list and task) to members of the space.
set client_min_messages = warning;

create table if not exists weft.task_comments (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references weft.tasks (id) on delete cascade,
  body        text not null check (length(body) between 1 and 1000),
  author_id   uuid default weft_private.uid() references weft.users (id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists task_comments_task_idx on weft.task_comments (task_id, created_at);
create index if not exists task_comments_author_idx on weft.task_comments (author_id);

-- The space of a task, through its list (null if there is none). security definer: used inside policies;
-- returns only a space id.
create or replace function weft_private.task_space(p_task uuid) returns uuid
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select i.space_id from weft.tasks k join weft.items i on i.id = k.list_id and i.kind = 'tasklist' where k.id = p_task
$$;
-- Is the caller the person this task is assigned to? security definer so the policy does not depend on
-- the tasks policies; answers only for the caller.
create or replace function weft_private.is_task_assignee(p_task uuid) returns boolean
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select exists (select 1 from weft.tasks k where k.id = p_task and k.assignee_id = weft_private.uid())
$$;

alter table weft.task_comments enable row level security;
alter table weft.task_comments force row level security;
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'weft' and tablename = 'task_comments' loop
    execute format('drop policy %I on weft.task_comments', p.policyname);
  end loop;
end $$;
create policy task_comments_read on weft.task_comments for select to weft_user, weft_assistant
  using (weft_private.is_member(weft_private.task_space(task_id)));
create policy task_comments_post on weft.task_comments for insert to weft_user
  with check (author_id = weft_private.uid()
              and (weft_private.can_edit(weft_private.task_space(task_id))
                   or (weft_private.is_task_assignee(task_id) and weft_private.is_member(weft_private.task_space(task_id)))));
create policy task_comments_delete on weft.task_comments for delete to weft_user
  using ((author_id = weft_private.uid() and weft_private.is_member(weft_private.task_space(task_id)))
         or weft_private.is_owner(weft_private.task_space(task_id)));

grant select on weft.task_comments to weft_user, weft_assistant;
grant insert (task_id, body), delete on weft.task_comments to weft_user;
revoke execute on function weft_private.task_space(uuid), weft_private.is_task_assignee(uuid) from public;
grant execute on function weft_private.task_space(uuid), weft_private.is_task_assignee(uuid) to weft_user, weft_assistant;

-- Before a new comment: trim it and stamp the time.
create or replace function weft_private.task_comment_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  new.body := btrim(coalesce(new.body, ''), E' \t\r\n');
  new.created_at := now();
  return new;
end $$;
drop trigger if exists task_comments_guard on weft.task_comments;
create trigger task_comments_guard before insert on weft.task_comments for each row execute function weft_private.task_comment_guard();

-- The list's text summary (022, 028, 050), now with each task's three latest comments under it.
create or replace function weft_private.refresh_tasklist_text(p_list uuid) returns void
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare t text;
begin
  select string_agg(line, E'\n' order by done, position) into t from (
    select k.done, k.position,
           case when k.done then '[x] ' else '[ ] ' end || k.title
           || case when u.display_name is not null or k.due_on is not null or k.repeats is not null then
                ' (' || concat_ws(', ', u.display_name, 'due ' || k.due_on::text,
                                  case k.repeats when 'daily' then 'every day' when 'weekly' then 'every week' when 'monthly' then 'every month' end)
                || ')' else '' end
           || case when not k.done and c.name is not null then ' in ' || c.name else '' end
           || coalesce((select string_agg(E'\n  Comment by ' || coalesce(a.display_name, 'someone') || ': '
                                          || left(regexp_replace(x.body, '\s+', ' ', 'g'), 300), '' order by x.created_at)
                          from (select * from weft.task_comments tc where tc.task_id = k.id order by tc.created_at desc limit 3) x
                          left join weft.users a on a.id = x.author_id), '') as line
      from weft.tasks k left join weft.users u on u.id = k.assignee_id
                        left join weft.board_columns c on c.id = k.column_id
     where k.list_id = p_list order by k.done, k.position limit 300
  ) x;
  update weft.items set body_text = t where id = p_list and body_text is distinct from t;
end $$;

-- After a change: refresh the summary, announce it (to members only, through the notification server; ids
-- only), and keep the old row in the audit log. An update only ever comes from task_comments_moved below:
-- it is recorded under the space the list moved from and not announced.
create or replace function weft_private.task_comment_changed() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare r record; v_list uuid; v_space uuid; v_from uuid;
begin
  r := coalesce(new, old);
  select k.list_id into v_list from weft.tasks k where k.id = r.task_id;
  v_space := weft_private.tasklist_space(v_list);
  if v_space is null then return null; end if;   -- the task or list is being deleted with its comments
  perform weft_private.refresh_tasklist_text(v_list);
  if tg_op = 'UPDATE' then
    v_from := coalesce(nullif(current_setting('weft.task_comments_moving_from', true), '')::uuid, v_space);
    insert into weft.audit (table_name, row_id, space_id, op, actor_id, actor_role, old_row)
    values ('task_comments', old.id, v_from, tg_op, weft_private.uid(),
            coalesce(nullif(current_setting('role', true), 'none'), session_user), to_jsonb(old));
    return null;
  end if;
  perform pg_notify('weft_events', json_build_object('t', 'task_comments', 'op', tg_op, 'id', r.id, 'space', v_space, 'list', v_list, 'task', r.task_id)::text);
  if tg_op = 'DELETE' then
    insert into weft.audit (table_name, row_id, space_id, op, actor_id, actor_role, old_row)
    values ('task_comments', old.id, v_space, tg_op, weft_private.uid(),
            coalesce(nullif(current_setting('role', true), 'none'), session_user), to_jsonb(old));
  end if;
  return null;
end $$;
drop trigger if exists task_comments_changed on weft.task_comments;
create trigger task_comments_changed after insert or update or delete on weft.task_comments
  for each row execute function weft_private.task_comment_changed();

-- A task list moved to another space: comments by people who are not members there lose their author.
create or replace function weft_private.task_comments_moved() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  perform set_config('weft.task_comments_moving_from', old.space_id::text, true);   -- see task_comment_changed
  update weft.task_comments tc set author_id = null
    from weft.tasks k
   where k.id = tc.task_id and k.list_id = new.id and tc.author_id is not null
     and not exists (select 1 from weft.members m where m.space_id = new.space_id and m.user_id = tc.author_id);
  perform set_config('weft.task_comments_moving_from', '', true);
  return null;
end $$;
drop trigger if exists items_task_comments_moved on weft.items;
create trigger items_task_comments_moved after update of space_id on weft.items for each row
  when (new.kind = 'tasklist' and new.space_id is distinct from old.space_id) execute function weft_private.task_comments_moved();

revoke execute on function weft_private.task_comment_guard(), weft_private.task_comment_changed(), weft_private.task_comments_moved()
  from public, weft_user, weft_assistant;
revoke execute on function weft_private.refresh_tasklist_text(uuid) from public, weft_user, weft_assistant;
grant execute on function weft_private.refresh_tasklist_text(uuid) to weft_owner;
