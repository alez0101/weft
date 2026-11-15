-- 060 next steps for ideas: a planned idea in Ideas (044) can become a task in a task list (022) in the same
-- space in one press, and a declined idea can carry a short reason, shown under it.
--   * Two columns on weft.ideas, no new table, so 044's policies decide who sees them (every member, viewers
--     included) and the guard decides who changes them: owners of the space only, the same people who set
--     the status. Editors and viewers cannot; the assistant only reads.
--   * decline_reason: up to 300 characters, kept on one line by the database. It goes only with a declined
--     idea: setting one on any other idea is refused, and an idea that leaves Declined loses its reason.
--   * task_id: the task the idea became (cleared if the task is deleted). Only a planned idea links, and only
--     to a task in a list in the board's own space (one answer for "elsewhere" and "nothing"). The task is an
--     ordinary task: Tasks, Boards, the Calendar and Home show it as any other.
--   * weft.idea_to_task(idea, list) makes the task (titled like the idea) and the link together, as the caller
--     (security invoker): row-level security and both guards decide, exactly as if the two writes were made
--     one after the other through the API. It refuses an idea that is already a task.
--   * The board's text (search, the assistant) says whether an idea's task is open or done and gives the
--     reason a declined idea was declined; ticking off or renaming the task refreshes it and reloads the board.
--   * Moves: if the board or the task list moves to another space, links that would cross spaces are cleared.
--     For a moved board the audit row and notice for that go under the space it moved FROM, so the new
--     space's members learn nothing about a task they cannot see. A reason is the idea's own and moves with it.
set client_min_messages = warning;

alter table weft.ideas add column if not exists task_id uuid references weft.tasks (id) on delete set null;
alter table weft.ideas add column if not exists decline_reason text not null default '';
alter table weft.ideas drop constraint if exists ideas_decline_reason_len;
alter table weft.ideas add constraint ideas_decline_reason_len check (length(decline_reason) <= 300);
create index if not exists ideas_task_idx on weft.ideas (task_id) where task_id is not null;

-- Column grants: 044's plus these two, for update only (a new idea has neither). created_by stays ungranted.
grant update (decline_reason, task_id) on weft.ideas to weft_user;

-- 044's guard, plus the reason and the task link.
create or replace function weft_private.ideas_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  if tg_table_name = 'idea_votes' then
    if not weft_private.is_member(weft_private.idea_space(new.idea_id)) then return new; end if;   -- row-level security refuses
    if exists (select 1 from weft.ideas d where d.id = new.idea_id and d.status in ('done', 'declined')) then
      raise exception 'voting is closed: this idea is already done or declined' using errcode = '42501';
    end if;
    new.created_at := now();
    return new;
  end if;
  new.title := regexp_replace(btrim(new.title), '\s+', ' ', 'g');
  new.details := btrim(coalesce(new.details, ''), E' \t\r\n');
  new.decline_reason := regexp_replace(btrim(coalesce(new.decline_reason, '')), '\s+', ' ', 'g');
  if tg_op = 'INSERT' then
    new.created_at := now(); new.updated_at := now(); new.status := 'new';
    new.decline_reason := ''; new.task_id := null;
    return new;
  end if;
  new.created_at := old.created_at; new.created_by := old.created_by; new.updated_at := now();
  if pg_trigger_depth() > 1 then
    -- Weft's own clean-ups (a deleted task, a move) only ever clear a link.
    if new.task_id is not null and new.task_id is distinct from old.task_id then
      raise exception 'only Weft''s own clean-ups get here' using errcode = '42501';
    end if;
    if new.status <> 'declined' then new.decline_reason := ''; end if;
    return new;
  end if;
  if (new.title is distinct from old.title or new.details is distinct from old.details) and old.created_by is distinct from weft_private.uid() then
    raise exception 'only the person who suggested it can change the idea' using errcode = '42501';
  end if;
  if new.status is distinct from old.status and not weft_private.is_owner(weft_private.ideas_space(old.board_id)) then
    raise exception 'only an owner of the space can change the status of an idea' using errcode = '42501';
  end if;
  if new.decline_reason is distinct from old.decline_reason and not weft_private.is_owner(weft_private.ideas_space(old.board_id)) then
    raise exception 'only an owner of the space can give the reason an idea was declined' using errcode = '42501';
  end if;
  if new.status <> 'declined' then
    if new.decline_reason <> '' and new.decline_reason is distinct from old.decline_reason then
      raise exception 'a reason can only be given for a declined idea' using errcode = '22023';
    end if;
    new.decline_reason := '';   -- leaving Declined drops the reason
  end if;
  if new.task_id is distinct from old.task_id then
    if not weft_private.is_owner(weft_private.ideas_space(old.board_id)) then
      raise exception 'only an owner of the space can add an idea to a task list' using errcode = '42501';
    end if;
    if new.task_id is not null and new.status <> 'planned' then
      raise exception 'only a planned idea can become a task' using errcode = '22023';
    end if;
    if new.task_id is not null and not exists (
         select 1 from weft.tasks t where t.id = new.task_id
            and weft_private.tasklist_space(t.list_id) = weft_private.ideas_space(old.board_id)) then
      raise exception 'an idea can only become a task in a list in the same space' using errcode = '22023';
    end if;
  end if;
  return new;
end $$;

-- 044's board summary, plus each idea's task (open or done) and a declined idea's reason.
create or replace function weft_private.refresh_ideas_text(p_board uuid) returns void
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare t text; n int;
begin
  select count(*) into n from weft.ideas where board_id = p_board;
  select concat_ws(E'\n', 'Ideas, ' || n || case when n = 1 then ' idea' else ' ideas' end,
                   string_agg(line, E'\n' order by rank, votes desc, created_at desc)) into t from (
    select array_position(array['planned', 'new', 'done', 'declined'], d.status) as rank, d.created_at, v.votes,
           'Idea: ' || d.title || ' (' || d.status || ', ' || v.votes || case when v.votes = 1 then ' vote' else ' votes' end
           || ', suggested by ' || coalesce(u.display_name, 'someone')
           || case when k.id is not null then ', task ' || case when k.done then 'done' else 'open' end else '' end || ')'
           || case when d.details <> '' then E'\n  ' || left(regexp_replace(d.details, '\s*\n\s*', ' ', 'g'), 800) else '' end
           || case when d.status = 'declined' and d.decline_reason <> '' then E'\n  Declined because: ' || d.decline_reason else '' end as line
      from weft.ideas d
      left join weft.users u on u.id = d.created_by
      left join weft.tasks k on k.id = d.task_id
      cross join lateral (select count(*) as votes from weft.idea_votes x where x.idea_id = d.id) v
     where d.board_id = p_board
     order by 1, 3 desc, 2 desc limit 300
  ) x;
  update weft.items set body_text = t where id = p_board and body_text is distinct from t;
end $$;

-- 044's after-change trigger, with one difference: while a moved board's links are being cleared, the audit
-- row and the notice go under the space it moved from.
create or replace function weft_private.ideas_changed() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare r record; v_board uuid; v_space uuid; v_id uuid;
begin
  r := coalesce(new, old);
  if tg_table_name = 'ideas' then v_board := r.board_id; v_id := r.id;
  else select board_id into v_board from weft.ideas where id = r.idea_id;
       v_id := r.idea_id;   -- a vote has no id of its own: its notice and audit row use the idea
  end if;
  v_space := weft_private.ideas_space(v_board);
  if v_space is null then return null; end if;   -- the board or idea is being deleted with its parent
  perform weft_private.refresh_ideas_text(v_board);
  v_space := coalesce(nullif(current_setting('weft.ideas_moving_from', true), '')::uuid, v_space);
  perform pg_notify('weft_events', json_build_object('t', 'ideas', 'op', tg_op, 'id', v_id, 'space', v_space, 'board', v_board)::text);
  if tg_op in ('UPDATE', 'DELETE') then
    insert into weft.audit (table_name, row_id, space_id, op, actor_id, actor_role, old_row)
    values (tg_table_name, v_id, v_space, tg_op, weft_private.uid(),
            coalesce(nullif(current_setting('role', true), 'none'), session_user), to_jsonb(old));
  end if;
  return null;
end $$;

-- A task that came from an idea was ticked off, reopened or renamed: the board's text follows, and the board
-- is told to reload (ids only, to the board's space, which is the task's space).
create or replace function weft_private.ideas_task_changed() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare d record; v_space uuid;
begin
  for d in select distinct board_id from weft.ideas where task_id = new.id loop
    v_space := weft_private.ideas_space(d.board_id);
    continue when v_space is null;
    perform weft_private.refresh_ideas_text(d.board_id);
    perform pg_notify('weft_events', json_build_object('t', 'ideas', 'op', 'UPDATE', 'id', new.id, 'space', v_space, 'board', d.board_id)::text);
  end loop;
  return null;
end $$;
drop trigger if exists tasks_ideas_changed on weft.tasks;
create trigger tasks_ideas_changed after update of done, title on weft.tasks for each row execute function weft_private.ideas_task_changed();

-- A board or a task list moved to another space: links that now cross spaces are cleared (the tasks stay).
create or replace function weft_private.ideas_task_link_moved() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  if new.kind = 'ideaboard' then
    perform set_config('weft.ideas_moving_from', old.space_id::text, true);   -- see ideas_changed
    update weft.ideas d set task_id = null
      from weft.tasks t
     where d.board_id = new.id and t.id = d.task_id
       and weft_private.tasklist_space(t.list_id) is distinct from new.space_id;
    perform set_config('weft.ideas_moving_from', '', true);
  else
    update weft.ideas d set task_id = null
      from weft.tasks t
     where t.list_id = new.id and d.task_id = t.id
       and weft_private.ideas_space(d.board_id) is distinct from new.space_id;
  end if;
  return null;
end $$;
drop trigger if exists items_ideas_task_link_moved on weft.items;
create trigger items_ideas_task_link_moved after update of space_id on weft.items for each row
  when (new.kind in ('ideaboard', 'tasklist') and new.space_id is distinct from old.space_id)
  execute function weft_private.ideas_task_link_moved();

-- A planned idea becomes a task: a task titled like the idea, at the end of the chosen list in the board's
-- space, linked to the idea, in one step. It runs as the caller (security invoker): row-level security and
-- the guards decide both writes; if either is refused, neither happens.
create or replace function weft.idea_to_task(p_idea uuid, p_list uuid)
returns weft.tasks
language plpgsql security invoker set search_path = weft, pg_temp as $$
declare d weft.ideas; v_space uuid; v_pos double precision; t weft.tasks; n int;
begin
  select * into d from weft.ideas where id = p_idea;
  if not found then
    raise exception 'no such idea, or you cannot see it' using errcode = '42501';
  end if;
  if d.task_id is not null then
    raise exception 'this idea is already a task' using errcode = '22023';
  end if;
  if d.status <> 'planned' then
    raise exception 'only a planned idea can become a task' using errcode = '22023';
  end if;
  select space_id into v_space from weft.items where id = d.board_id;
  if not exists (select 1 from weft.items where id = p_list and kind = 'tasklist' and space_id = v_space) then
    raise exception 'choose a task list in the same space as the ideas' using errcode = '22023';
  end if;
  select coalesce(max(position), -1) + 1 into v_pos from weft.tasks where list_id = p_list;
  insert into weft.tasks (list_id, title, position) values (p_list, d.title, v_pos) returning * into t;
  update weft.ideas set task_id = t.id where id = p_idea;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'only an owner of the space can add an idea to a task list' using errcode = '42501';
  end if;
  return t;
end $$;
revoke execute on function weft.idea_to_task(uuid, uuid) from public, weft_assistant;
grant execute on function weft.idea_to_task(uuid, uuid) to weft_user;

revoke execute on function weft_private.ideas_guard(), weft_private.refresh_ideas_text(uuid), weft_private.ideas_changed(),
  weft_private.ideas_task_changed(), weft_private.ideas_task_link_moved()
  from public, weft_user, weft_assistant;
grant execute on function weft_private.refresh_ideas_text(uuid) to weft_owner;
