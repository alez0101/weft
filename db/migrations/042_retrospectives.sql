-- 042 retrospectives: what went well, what to improve and the actions for a period, with an option to post
-- anonymously; actions become tasks.
-- A retrospective is an item (kind 'retro'), so it lives in a space and gets everything items have: the one
-- permission rule, moving, deleting, sharing links, the audit log, search and the assistant (through the
-- retro's text summary in body_text). Its title names it ("Sprint 12"). What this adds:
--   * weft.retros: one row per retro, made with the item: the period it looks back on (from and to, both
--     optional) and the task list its actions become tasks in (must be in the retro's own space). Members
--     read; editors and owners change; the assistant role only reads.
--   * weft.retro_notes: the notes, each in one column (went_well, to_improve, action). Every member adds
--     notes, viewers included: a retro is for everyone to take part in, like voting in a poll. You change
--     or delete only your own note; editors and owners delete any (tidying up). The column and the
--     Anonymous choice are fixed when the note is posted.
--   * Anonymous means anonymous to everyone in Weft, owners and the assistant included. The author is kept
--     in created_by, so they can still change or delete their note, but that column is never granted for
--     reading: no request can select, filter, order or embed by it. author_id, which people do read, is the
--     author for a named note and empty for an anonymous one, set here, never by the client. The audit log
--     never stores created_by, and for an anonymous note not the actor either; the text summary names no
--     one. weft.my_retro_notes(retro) tells the caller which notes are their own, and nothing else.
--     (People in the room may still guess from timing or wording; the app says so.)
--   * Actions become tasks: weft.retro_action_to_task makes a real task (022) from an action, in the retro's
--     chosen list, and links it to the note, as the caller (security invoker), so the Tasks rules decide:
--     editors and owners of the space only. The task then shows in Tasks, Boards, the Calendar and on Home.
--   * Moves follow the space: a retro moved to another space keeps its task list and task links only if they
--     are in the new space; the removals are audited and announced under the space it moved from. A task
--     list moved away stops being the target of retros in other spaces, and their links to its tasks go.
set client_min_messages = warning;

alter table weft.items drop constraint if exists items_kind_check;
alter table weft.items add constraint items_kind_check check (kind in ('document', 'wiki', 'whiteboard', 'table', 'file', 'tasklist', 'poll', 'form', 'linklist', 'meeting', 'addressbook', 'decisionlog', 'qa', 'checklist', 'expenselist', 'inventory', 'goalset', 'retro'));

create table if not exists weft.retros (
  id           uuid primary key references weft.items (id) on delete cascade,
  period_from  date,
  period_to    date,
  task_list_id uuid references weft.items (id) on delete set null,
  updated_at   timestamptz not null default now(),
  constraint retros_period_order check (period_from is null or period_to is null or period_to >= period_from)
);
create index if not exists retros_list_idx on weft.retros (task_list_id) where task_list_id is not null;

create table if not exists weft.retro_notes (
  id          uuid primary key default gen_random_uuid(),
  retro_id    uuid not null references weft.items (id) on delete cascade,
  kind        text not null check (kind in ('went_well', 'to_improve', 'action')),
  body        text not null check (length(btrim(body)) between 1 and 1000),
  anonymous   boolean not null default false,
  author_id   uuid references weft.users (id),
  task_id     uuid references weft.tasks (id) on delete set null,
  created_by  uuid not null default weft_private.uid() references weft.users (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint retro_notes_task_is_action check (task_id is null or kind = 'action')
);
create index if not exists retro_notes_retro_idx on weft.retro_notes (retro_id, created_at);
create index if not exists retro_notes_task_idx on weft.retro_notes (task_id) where task_id is not null;
create index if not exists retro_notes_open_actions_idx on weft.retro_notes (created_at desc) where kind = 'action';

-- The space of a retro (null if it is not one). security definer: used inside policies; returns only a space id.
create or replace function weft_private.retro_space(p_retro uuid) returns uuid
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select space_id from weft.items where id = p_retro and kind = 'retro'
$$;
-- The space notices and audit rows go to: the retro's space, or, while a retro is being moved, the space it
-- is moving from (set by retro_moved below for the length of its own clean-up, inside the transaction).
create or replace function weft_private.retro_audit_space(p_retro uuid) returns uuid
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select coalesce(nullif(current_setting('weft_private.retro_from', true), '')::uuid, weft_private.retro_space(p_retro))
$$;

do $$
declare t text; p record;
begin
  foreach t in array array['retros', 'retro_notes'] loop
    execute format('alter table weft.%I enable row level security', t);
    execute format('alter table weft.%I force row level security', t);
    for p in select policyname from pg_policies where schemaname = 'weft' and tablename = t loop
      execute format('drop policy %I on weft.%I', p.policyname, t);
    end loop;
  end loop;
end $$;

-- retros: made with the item by a trigger below (no insert or delete for anyone); members read, editors and
-- owners change.
create policy retros_read on weft.retros for select to weft_user, weft_assistant
  using (weft_private.is_member(weft_private.retro_space(id)));
create policy retros_change on weft.retros for update to weft_user
  using (weft_private.can_edit(weft_private.retro_space(id)))
  with check (weft_private.can_edit(weft_private.retro_space(id)));

-- notes: members read and add (viewers too); the author changes and deletes their own; editors and owners
-- link actions to tasks (the guard lets them change nothing else of someone else's note) and delete any.
create policy retro_notes_read on weft.retro_notes for select to weft_user, weft_assistant
  using (weft_private.is_member(weft_private.retro_space(retro_id)));
create policy retro_notes_insert on weft.retro_notes for insert to weft_user
  with check (created_by = weft_private.uid() and weft_private.is_member(weft_private.retro_space(retro_id)));
create policy retro_notes_change_own on weft.retro_notes for update to weft_user
  using (created_by = weft_private.uid() and weft_private.is_member(weft_private.retro_space(retro_id)))
  with check (created_by = weft_private.uid() and weft_private.is_member(weft_private.retro_space(retro_id)));
create policy retro_notes_change_editor on weft.retro_notes for update to weft_user
  using (weft_private.can_edit(weft_private.retro_space(retro_id)))
  with check (weft_private.can_edit(weft_private.retro_space(retro_id)));
create policy retro_notes_delete on weft.retro_notes for delete to weft_user
  using ((created_by = weft_private.uid() and weft_private.is_member(weft_private.retro_space(retro_id)))
         or weft_private.can_edit(weft_private.retro_space(retro_id)));

-- Reading: every column of a note except created_by, which no request role may read at all.
-- Writing: retro_id, kind and anonymous only on insert; body and task_id on update. author_id, created_by
-- and the times are never granted.
grant select on weft.retros to weft_user, weft_assistant;
grant update (period_from, period_to, task_list_id) on weft.retros to weft_user;
revoke all on weft.retro_notes from weft_user, weft_assistant;
grant select (id, retro_id, kind, body, anonymous, author_id, task_id, created_at, updated_at) on weft.retro_notes to weft_user, weft_assistant;
grant insert (retro_id, kind, body, anonymous), update (body, task_id), delete on weft.retro_notes to weft_user;
revoke execute on function weft_private.retro_space(uuid), weft_private.retro_audit_space(uuid) from public;
grant execute on function weft_private.retro_space(uuid) to weft_user, weft_assistant;

-- A new retro item gets its row.
create or replace function weft_private.retro_created() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  insert into weft.retros (id) values (new.id) on conflict do nothing;
  return null;
end $$;
drop trigger if exists items_retro_created on weft.items;
create trigger items_retro_created after insert on weft.items for each row
  when (new.kind = 'retro') execute function weft_private.retro_created();

-- Before a change to a retro: the task list must be in the retro's own space (one answer for "not there" and
-- "somewhere else"). Only someone who may edit the retro gets this far.
create or replace function weft_private.retro_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  if new.task_list_id is not null and new.task_list_id is distinct from old.task_list_id
     and weft_private.tasklist_space(new.task_list_id) is distinct from weft_private.retro_space(new.id) then
    raise exception 'actions can only become tasks in a task list in the retro''s space' using errcode = '22023';
  end if;
  new.id := old.id;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists retros_guard on weft.retros;
create trigger retros_guard before update on weft.retros for each row execute function weft_private.retro_guard();

-- Before a note is written: trim the text; the author is the caller, shown only if the note is not
-- anonymous; the column, the choice of anonymous, the author and the times stay as they were. Only the
-- author changes the text. Only editors and owners link an action to a task, and only to a task in a list
-- in the retro's own space (row-level security has already filtered out everyone else). Clean-ups made by
-- Weft itself (a move, a deleted task) come from another trigger and are let through.
create or replace function weft_private.retro_note_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare v_space uuid;
begin
  new.body := btrim(new.body, E' \t\r\n');
  if tg_op = 'INSERT' then
    new.created_by := weft_private.uid();
    new.author_id := case when new.anonymous then null else new.created_by end;
    new.task_id := null;
    new.created_at := now(); new.updated_at := now();
    return new;
  end if;
  new.id := old.id; new.retro_id := old.retro_id; new.kind := old.kind; new.anonymous := old.anonymous;
  new.created_by := old.created_by; new.author_id := old.author_id; new.created_at := old.created_at;
  if pg_trigger_depth() > 1 then
    if new.task_id is not null and new.task_id is distinct from old.task_id then
      raise exception 'only Weft''s own clean-ups get here' using errcode = '42501';
    end if;
    return new;
  end if;
  v_space := weft_private.retro_space(old.retro_id);
  if new.body is distinct from old.body then
    if old.created_by is distinct from weft_private.uid() then
      raise exception 'you can only change your own note' using errcode = '42501';
    end if;
    new.updated_at := now();
  end if;
  if new.task_id is distinct from old.task_id then
    if not weft_private.can_edit(v_space) then
      raise exception 'only editors and owners turn actions into tasks' using errcode = '42501';
    end if;
    if new.task_id is not null and (old.kind <> 'action' or not exists (
         select 1 from weft.tasks t where t.id = new.task_id and weft_private.tasklist_space(t.list_id) = v_space)) then
      raise exception 'an action can only become a task in a list in the retro''s space' using errcode = '22023';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists retro_notes_guard on weft.retro_notes;
create trigger retro_notes_guard before insert or update on weft.retro_notes for each row execute function weft_private.retro_note_guard();

-- The retro's text, for search and the assistant: the period, then up to 300 notes by column, actions marked
-- with their task's state. It never names who wrote a note.
create or replace function weft_private.refresh_retro_text(p_retro uuid) returns void
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare t text; v_period text; v_well text; v_improve text; v_actions text;
begin
  select case when r.period_from is not null or r.period_to is not null then
           'Period: ' || coalesce(to_char(r.period_from, 'YYYY-MM-DD'), '…') || ' to ' || coalesce(to_char(r.period_to, 'YYYY-MM-DD'), '…') end
    into v_period from weft.retros r where r.id = p_retro;
  with n as (
    select n.kind, n.created_at,
           '- ' || regexp_replace(n.body, '\s*\n\s*', ' ', 'g')
           || case when n.kind = 'action' and k.id is not null then case when k.done then ' (task, done)' else ' (task, open)' end else '' end as line
      from weft.retro_notes n left join weft.tasks k on k.id = n.task_id
     where n.retro_id = p_retro order by n.created_at limit 300
  )
  select string_agg(line, E'\n' order by created_at) filter (where kind = 'went_well'),
         string_agg(line, E'\n' order by created_at) filter (where kind = 'to_improve'),
         string_agg(line, E'\n' order by created_at) filter (where kind = 'action')
    into v_well, v_improve, v_actions from n;
  t := nullif(concat_ws(E'\n\n', v_period,
         case when v_well is not null then E'Went well:\n' || v_well end,
         case when v_improve is not null then E'To improve:\n' || v_improve end,
         case when v_actions is not null then E'Actions:\n' || v_actions end), '');
  update weft.items set body_text = t where id = p_retro and kind = 'retro' and body_text is distinct from t;
end $$;

-- After a change to a retro: refresh its text, announce it (ids only, to members, through the notification
-- server), and keep the old row in the audit log.
create or replace function weft_private.retro_changed() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare v_space uuid;
begin
  v_space := weft_private.retro_audit_space(new.id);
  if v_space is null then return null; end if;
  perform weft_private.refresh_retro_text(new.id);
  perform pg_notify('weft_events', json_build_object('t', 'retros', 'op', tg_op, 'id', new.id, 'space', v_space, 'retro', new.id)::text);
  insert into weft.audit (table_name, row_id, space_id, op, actor_id, actor_role, old_row)
  values ('retros', old.id, v_space, tg_op, weft_private.uid(),
          coalesce(nullif(current_setting('role', true), 'none'), session_user), to_jsonb(old));
  return null;
end $$;
drop trigger if exists retros_changed on weft.retros;
create trigger retros_changed after update on weft.retros for each row execute function weft_private.retro_changed();

-- After a note changes: the same. The audit row never carries created_by, and for an anonymous note not the
-- actor either (whoever changes an anonymous note is most often its author).
create or replace function weft_private.retro_note_changed() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare r record; v_space uuid;
begin
  r := coalesce(new, old);
  v_space := weft_private.retro_audit_space(r.retro_id);
  if v_space is null then return null; end if;   -- the retro itself is being deleted
  perform weft_private.refresh_retro_text(r.retro_id);
  perform pg_notify('weft_events', json_build_object('t', 'retros', 'op', tg_op, 'id', r.id, 'space', v_space, 'retro', r.retro_id)::text);
  if tg_op in ('UPDATE', 'DELETE') then
    insert into weft.audit (table_name, row_id, space_id, op, actor_id, actor_role, old_row)
    values ('retro_notes', old.id, v_space, tg_op, case when old.anonymous then null else weft_private.uid() end,
            coalesce(nullif(current_setting('role', true), 'none'), session_user), to_jsonb(old) - 'created_by');
  end if;
  return null;
end $$;
drop trigger if exists retro_notes_changed on weft.retro_notes;
create trigger retro_notes_changed after insert or update or delete on weft.retro_notes for each row execute function weft_private.retro_note_changed();

-- A task that came from an action changed (ticked off, renamed): the retro's text follows.
create or replace function weft_private.retro_task_changed() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare v uuid;
begin
  for v in select distinct retro_id from weft.retro_notes where task_id = new.id loop
    perform weft_private.refresh_retro_text(v);
  end loop;
  return null;
end $$;
drop trigger if exists tasks_retro_changed on weft.tasks;
create trigger tasks_retro_changed after update on weft.tasks for each row execute function weft_private.retro_task_changed();

-- A retro moved to another space: its task list stays only if it is in the new space, and links to tasks in
-- other spaces are cleared (the tasks stay in their list). Those removals are audited and announced under
-- the space it moved from, so the new space's members learn nothing about what was there.
create or replace function weft_private.retro_moved() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  perform set_config('weft_private.retro_from', old.space_id::text, true);
  update weft.retros set task_list_id = null
   where id = new.id and task_list_id is not null and weft_private.tasklist_space(task_list_id) is distinct from new.space_id;
  update weft.retro_notes n set task_id = null
    from weft.tasks t
   where n.retro_id = new.id and t.id = n.task_id and weft_private.tasklist_space(t.list_id) is distinct from new.space_id;
  perform set_config('weft_private.retro_from', '', true);
  perform weft_private.refresh_retro_text(new.id);
  return null;
end $$;
drop trigger if exists items_retro_moved on weft.items;
create trigger items_retro_moved after update of space_id on weft.items for each row
  when (new.kind = 'retro' and new.space_id is distinct from old.space_id) execute function weft_private.retro_moved();

-- A task list moved to another space: retros elsewhere stop sending actions to it, and their links to its
-- tasks go (audited under each retro's own space, which already knew of them).
create or replace function weft_private.retro_tasklist_moved() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  update weft.retros set task_list_id = null
   where task_list_id = new.id and weft_private.retro_space(id) is distinct from new.space_id;
  update weft.retro_notes n set task_id = null
    from weft.tasks t
   where t.id = n.task_id and t.list_id = new.id and weft_private.retro_space(n.retro_id) is distinct from new.space_id;
  return null;
end $$;
drop trigger if exists items_tasklist_moved_retros on weft.items;
create trigger items_tasklist_moved_retros after update of space_id on weft.items for each row
  when (new.kind = 'tasklist' and new.space_id is distinct from old.space_id) execute function weft_private.retro_tasklist_moved();

-- Which notes in a retro are the caller's own (so the screen can offer Change and Delete on their anonymous
-- notes). security definer to read created_by, but it answers only about the caller, and only in a retro
-- they can see.
create or replace function weft.my_retro_notes(p_retro uuid) returns setof uuid
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select n.id from weft.retro_notes n
   where n.retro_id = p_retro and n.created_by = weft_private.uid()
     and weft_private.is_member(weft_private.retro_space(p_retro))
$$;
revoke execute on function weft.my_retro_notes(uuid) from public, weft_assistant;
grant execute on function weft.my_retro_notes(uuid) to weft_user;

-- An action becomes a task: a task in the retro's chosen list, linked to the note, in one step. It runs as
-- the caller (security invoker): row-level security decides both writes, exactly as if they were made one
-- after the other through the API.
create or replace function weft.retro_action_to_task(p_note uuid, p_assignee uuid default null, p_due date default null)
returns weft.tasks
language plpgsql security invoker set search_path = weft, pg_temp as $$
declare v_retro uuid; v_kind text; v_task uuid; v_body text; v_list uuid; v_pos double precision; t weft.tasks; n int;
begin
  select retro_id, kind, task_id, body into v_retro, v_kind, v_task, v_body from weft.retro_notes where id = p_note;
  if not found then
    raise exception 'no such note, or you cannot see it' using errcode = '42501';
  end if;
  if v_kind <> 'action' then
    raise exception 'only an action can become a task' using errcode = '22023';
  end if;
  if v_task is not null then
    raise exception 'this action is already a task' using errcode = '22023';
  end if;
  select task_list_id into v_list from weft.retros where id = v_retro;
  if v_list is null then
    raise exception 'choose a task list for this retro''s actions first' using errcode = '22023';
  end if;
  select coalesce(max(position), -1) + 1 into v_pos from weft.tasks where list_id = v_list;
  insert into weft.tasks (list_id, title, assignee_id, due_on, position)
  values (v_list, left(v_body, 300), p_assignee, p_due, v_pos) returning * into t;
  update weft.retro_notes set task_id = t.id where id = p_note;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'only editors and owners turn actions into tasks' using errcode = '42501';
  end if;
  return t;
end $$;
revoke execute on function weft.retro_action_to_task(uuid, uuid, date) from public, weft_assistant;
grant execute on function weft.retro_action_to_task(uuid, uuid, date) to weft_user;

revoke execute on function weft_private.retro_created(), weft_private.retro_guard(), weft_private.retro_note_guard(),
  weft_private.refresh_retro_text(uuid), weft_private.retro_changed(), weft_private.retro_note_changed(),
  weft_private.retro_task_changed(), weft_private.retro_moved(), weft_private.retro_tasklist_moved(),
  weft_private.retro_audit_space(uuid)
  from public, weft_user, weft_assistant;
grant execute on function weft_private.refresh_retro_text(uuid) to weft_owner;
