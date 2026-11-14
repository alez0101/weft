-- 029 meetings: a page for a meeting with its agenda, notes and decisions.
-- A meeting is an item (kind 'meeting'), so it lives in a space and gets everything items have: the one
-- permission rule, moving, deleting, sharing links, the audit log, search and the assistant (through the
-- meeting's text in body_text). Its title is the meeting's name. What this adds:
--   * weft.meetings: one row per meeting, made with the item: when it is held, the agenda, notes and
--     decisions (plain text), and optionally the calendar event it belongs to and the task list its action
--     items go to. Both links must be in the meeting's own space. Members read, viewers included; editors
--     and owners change; the assistant role only reads.
--   * weft.meeting_actions: which tasks were made as this meeting's action items. The action items are real
--     tasks (022) in the chosen list, so they show in Tasks, Boards, the Calendar and the Home widget like
--     any other, and the Tasks rules apply to them (the assignee may tick theirs off, even as a viewer).
--     weft.add_meeting_action makes the task and the link together, as the caller (security invoker).
--   * Moves follow the space: when a meeting, its task list or its event moves to another space, every link
--     that would now cross spaces is cleared. Deleting a meeting keeps its tasks in their list.
set client_min_messages = warning;

alter table weft.items drop constraint if exists items_kind_check;
alter table weft.items add constraint items_kind_check check (kind in ('document', 'wiki', 'whiteboard', 'table', 'file', 'tasklist', 'poll', 'form', 'linklist', 'meeting'));

create table if not exists weft.meetings (
  id           uuid primary key references weft.items (id) on delete cascade,
  held_at      timestamptz default now(),
  agenda       text not null default '' check (length(agenda) <= 20000),
  notes        text not null default '' check (length(notes) <= 20000),
  decisions    text not null default '' check (length(decisions) <= 20000),
  event_id     uuid references weft.events (id) on delete set null,
  task_list_id uuid references weft.items (id) on delete set null,
  updated_at   timestamptz not null default now()
);
create index if not exists meetings_event_idx on weft.meetings (event_id) where event_id is not null;
create index if not exists meetings_list_idx on weft.meetings (task_list_id) where task_list_id is not null;

create table if not exists weft.meeting_actions (
  task_id    uuid primary key references weft.tasks (id) on delete cascade,
  meeting_id uuid not null references weft.items (id) on delete cascade,
  created_by uuid not null default weft_private.uid() references weft.users (id),
  created_at timestamptz not null default now()
);
create index if not exists meeting_actions_meeting_idx on weft.meeting_actions (meeting_id);

-- The space of a meeting (null if it is not one). security definer: used inside policies.
create or replace function weft_private.meeting_space(p_meeting uuid) returns uuid
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select space_id from weft.items where id = p_meeting and kind = 'meeting'
$$;

do $$
declare t text; p record;
begin
  foreach t in array array['meetings', 'meeting_actions'] loop
    execute format('alter table weft.%I enable row level security', t);
    execute format('alter table weft.%I force row level security', t);
    for p in select policyname from pg_policies where schemaname = 'weft' and tablename = t loop
      execute format('drop policy %I on weft.%I', p.policyname, t);
    end loop;
  end loop;
end $$;

-- meetings: made with the item by a trigger below (no insert or delete for anyone); members read,
-- editors and owners change.
create policy meetings_read on weft.meetings for select to weft_user, weft_assistant
  using (weft_private.is_member(weft_private.meeting_space(id)));
create policy meetings_change on weft.meetings for update to weft_user
  using (weft_private.can_edit(weft_private.meeting_space(id)))
  with check (weft_private.can_edit(weft_private.meeting_space(id)));

-- action item links: members read; editors and owners add and remove.
create policy meeting_actions_read on weft.meeting_actions for select to weft_user, weft_assistant
  using (weft_private.is_member(weft_private.meeting_space(meeting_id)));
create policy meeting_actions_insert on weft.meeting_actions for insert to weft_user
  with check (created_by = weft_private.uid() and weft_private.can_edit(weft_private.meeting_space(meeting_id)));
create policy meeting_actions_delete on weft.meeting_actions for delete to weft_user
  using (weft_private.can_edit(weft_private.meeting_space(meeting_id)));

-- id, updated_at and created_by are never granted; a link is never updated (remove it and add another).
grant select on weft.meetings, weft.meeting_actions to weft_user, weft_assistant;
grant update (held_at, agenda, notes, decisions, event_id, task_list_id) on weft.meetings to weft_user;
grant insert (task_id, meeting_id), delete on weft.meeting_actions to weft_user;
grant execute on function weft_private.meeting_space(uuid) to weft_user, weft_assistant;

-- A new meeting item gets its row.
create or replace function weft_private.meeting_created() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  insert into weft.meetings (id) values (new.id) on conflict do nothing;
  return null;
end $$;
drop trigger if exists items_meeting_created on weft.items;
create trigger items_meeting_created after insert on weft.items for each row
  when (new.kind = 'meeting') execute function weft_private.meeting_created();

-- Before a change: the event and the task list must be in the meeting's own space (one answer for "not
-- there" and "somewhere else", so nothing is learned about other spaces); tidy the text; stamp updated_at.
-- Only someone who may edit the meeting gets this far (row-level security filters the row first).
create or replace function weft_private.meeting_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare v_space uuid;
begin
  v_space := weft_private.meeting_space(new.id);
  if new.event_id is not null and new.event_id is distinct from old.event_id
     and not exists (select 1 from weft.events e where e.id = new.event_id and e.space_id = v_space) then
    raise exception 'a meeting can only link to a calendar event in its own space' using errcode = '22023';
  end if;
  if new.task_list_id is not null and new.task_list_id is distinct from old.task_list_id
     and not exists (select 1 from weft.items i where i.id = new.task_list_id and i.kind = 'tasklist' and i.space_id = v_space) then
    raise exception 'action items can only go to a task list in the meeting''s space' using errcode = '22023';
  end if;
  new.agenda := btrim(coalesce(new.agenda, ''), E' \t\r\n');
  new.notes := btrim(coalesce(new.notes, ''), E' \t\r\n');
  new.decisions := btrim(coalesce(new.decisions, ''), E' \t\r\n');
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists meetings_guard on weft.meetings;
create trigger meetings_guard before update on weft.meetings for each row execute function weft_private.meeting_guard();

-- Before adding an action item: the task must be in a list in the meeting's space. Someone who may not edit
-- the meeting is refused by the policy, so this check says nothing to them.
create or replace function weft_private.meeting_action_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  if weft_private.can_edit(weft_private.meeting_space(new.meeting_id))
     and not exists (select 1 from weft.tasks t where t.id = new.task_id
                      and weft_private.tasklist_space(t.list_id) = weft_private.meeting_space(new.meeting_id)) then
    raise exception 'an action item must be a task in the meeting''s space' using errcode = '22023';
  end if;
  return new;
end $$;
drop trigger if exists meeting_actions_guard on weft.meeting_actions;
create trigger meeting_actions_guard before insert on weft.meeting_actions for each row execute function weft_private.meeting_action_guard();

-- The meeting's text, for search and the assistant: when, the event, agenda, notes, decisions and up to
-- 200 action items as "[ ] Title (Who, due 2026-11-20)".
create or replace function weft_private.refresh_meeting_text(p_meeting uuid) returns void
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare t text; v_actions text;
begin
  select string_agg(line, E'\n' order by done, created_at) into v_actions from (
    select k.done, a.created_at,
           case when k.done then '[x] ' else '[ ] ' end || k.title
           || case when u.display_name is not null or k.due_on is not null then
                ' (' || concat_ws(', ', u.display_name, 'due ' || k.due_on::text) || ')' else '' end as line
      from weft.meeting_actions a join weft.tasks k on k.id = a.task_id
      left join weft.users u on u.id = k.assignee_id
     where a.meeting_id = p_meeting order by k.done, a.created_at limit 200
  ) x;
  select nullif(concat_ws(E'\n\n',
           case when m.held_at is not null then 'When: ' || to_char(m.held_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC' end,
           case when e.title is not null then 'Calendar event: ' || e.title end,
           case when m.agenda <> '' then E'Agenda:\n' || m.agenda end,
           case when m.notes <> '' then E'Notes:\n' || m.notes end,
           case when m.decisions <> '' then E'Decisions:\n' || m.decisions end,
           case when v_actions is not null then E'Action items:\n' || v_actions end), '')
    into t
    from weft.meetings m left join weft.events e on e.id = m.event_id
   where m.id = p_meeting;
  update weft.items set body_text = t where id = p_meeting and kind = 'meeting' and body_text is distinct from t;
end $$;

-- After a change to a meeting: refresh its text, announce it (ids only, to members, through the notification
-- server), and keep the old row in the audit log.
create or replace function weft_private.meeting_changed() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare v_space uuid;
begin
  v_space := weft_private.meeting_space(new.id);
  if v_space is null then return null; end if;   -- the meeting itself is being deleted
  perform weft_private.refresh_meeting_text(new.id);
  perform pg_notify('weft_events', json_build_object('t', 'meetings', 'op', tg_op, 'id', new.id, 'space', v_space)::text);
  insert into weft.audit (table_name, row_id, space_id, op, actor_id, actor_role, old_row)
  values ('meetings', old.id, v_space, tg_op, weft_private.uid(),
          coalesce(nullif(current_setting('role', true), 'none'), session_user), to_jsonb(old));
  return null;
end $$;
drop trigger if exists meetings_changed on weft.meetings;
create trigger meetings_changed after update on weft.meetings for each row execute function weft_private.meeting_changed();

-- After an action item is added or removed: the same.
create or replace function weft_private.meeting_action_changed() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare r record; v_space uuid;
begin
  r := coalesce(new, old);
  v_space := weft_private.meeting_space(r.meeting_id);
  if v_space is null then return null; end if;   -- the meeting itself is being deleted
  perform weft_private.refresh_meeting_text(r.meeting_id);
  perform pg_notify('weft_events', json_build_object('t', 'meeting_actions', 'op', tg_op, 'id', r.task_id, 'space', v_space, 'meeting', r.meeting_id)::text);
  if tg_op = 'DELETE' then
    insert into weft.audit (table_name, row_id, space_id, op, actor_id, actor_role, old_row)
    values ('meeting_actions', old.task_id, v_space, tg_op, weft_private.uid(),
            coalesce(nullif(current_setting('role', true), 'none'), session_user), to_jsonb(old));
  end if;
  return null;
end $$;
drop trigger if exists meeting_actions_changed on weft.meeting_actions;
create trigger meeting_actions_changed after insert or delete on weft.meeting_actions for each row execute function weft_private.meeting_action_changed();

-- A task that is an action item changed (ticked off, renamed, reassigned): the meeting's text follows.
create or replace function weft_private.meeting_task_changed() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare m uuid;
begin
  for m in select meeting_id from weft.meeting_actions where task_id = new.id loop
    perform weft_private.refresh_meeting_text(m);
  end loop;
  return null;
end $$;
drop trigger if exists tasks_meeting_changed on weft.tasks;
create trigger tasks_meeting_changed after update on weft.tasks for each row execute function weft_private.meeting_task_changed();

-- A meeting moved to another space: its event and task list stay only if they are in the new space, and
-- action items whose task is in another space are unlinked (the tasks themselves stay in their list).
create or replace function weft_private.meeting_moved() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  update weft.meetings m set
         event_id = case when exists (select 1 from weft.events e where e.id = m.event_id and e.space_id = new.space_id) then m.event_id end,
         task_list_id = case when weft_private.tasklist_space(m.task_list_id) = new.space_id then m.task_list_id end
   where m.id = new.id and (m.event_id is not null or m.task_list_id is not null);
  delete from weft.meeting_actions a using weft.tasks t
   where a.meeting_id = new.id and t.id = a.task_id and weft_private.tasklist_space(t.list_id) is distinct from new.space_id;
  perform weft_private.refresh_meeting_text(new.id);
  return null;
end $$;
drop trigger if exists items_meeting_moved on weft.items;
create trigger items_meeting_moved after update of space_id on weft.items for each row
  when (new.kind = 'meeting' and new.space_id is distinct from old.space_id) execute function weft_private.meeting_moved();

-- A task list moved to another space: meetings elsewhere stop sending action items to it, and its tasks
-- stop being action items of meetings in other spaces.
create or replace function weft_private.meeting_tasklist_moved() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  update weft.meetings set task_list_id = null
   where task_list_id = new.id and weft_private.meeting_space(id) is distinct from new.space_id;
  delete from weft.meeting_actions a using weft.tasks t
   where t.id = a.task_id and t.list_id = new.id and weft_private.meeting_space(a.meeting_id) is distinct from new.space_id;
  return null;
end $$;
drop trigger if exists items_tasklist_moved_meetings on weft.items;
create trigger items_tasklist_moved_meetings after update of space_id on weft.items for each row
  when (new.kind = 'tasklist' and new.space_id is distinct from old.space_id) execute function weft_private.meeting_tasklist_moved();

-- An event moved to another space: meetings elsewhere lose the link to it.
create or replace function weft_private.meeting_event_moved() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  update weft.meetings set event_id = null
   where event_id = new.id and weft_private.meeting_space(id) is distinct from new.space_id;
  return null;
end $$;
drop trigger if exists events_meeting_moved on weft.events;
create trigger events_meeting_moved after update of space_id on weft.events for each row
  when (new.space_id is distinct from old.space_id) execute function weft_private.meeting_event_moved();

-- An event renamed: meetings linked to it name it in their text.
create or replace function weft_private.meeting_event_renamed() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare m uuid;
begin
  for m in select id from weft.meetings where event_id = new.id loop
    perform weft_private.refresh_meeting_text(m);
  end loop;
  return null;
end $$;
drop trigger if exists events_meeting_renamed on weft.events;
create trigger events_meeting_renamed after update of title on weft.events for each row
  when (new.title is distinct from old.title) execute function weft_private.meeting_event_renamed();

-- Add an action item: a task in the meeting's chosen list, linked to the meeting, in one step. It runs as
-- the caller (security invoker): row-level security decides both inserts, exactly as if they were made
-- one after the other through the API.
create or replace function weft.add_meeting_action(p_meeting uuid, p_title text, p_assignee uuid default null, p_due date default null)
returns weft.tasks
language plpgsql security invoker set search_path = weft, pg_temp as $$
declare v_list uuid; v_pos double precision; t weft.tasks;
begin
  select task_list_id into v_list from weft.meetings where id = p_meeting;
  if not found then
    raise exception 'no such meeting, or you cannot see it' using errcode = '42501';
  end if;
  if v_list is null then
    raise exception 'choose a task list for this meeting''s action items first' using errcode = '22023';
  end if;
  select coalesce(max(position), -1) + 1 into v_pos from weft.tasks where list_id = v_list;
  insert into weft.tasks (list_id, title, assignee_id, due_on, position)
  values (v_list, p_title, p_assignee, p_due, v_pos) returning * into t;
  insert into weft.meeting_actions (task_id, meeting_id) values (t.id, p_meeting);
  return t;
end $$;
revoke execute on function weft.add_meeting_action(uuid, text, uuid, date) from public, weft_assistant;
grant execute on function weft.add_meeting_action(uuid, text, uuid, date) to weft_user;

revoke execute on function weft_private.meeting_created(), weft_private.meeting_guard(), weft_private.meeting_action_guard(),
  weft_private.refresh_meeting_text(uuid), weft_private.meeting_changed(), weft_private.meeting_action_changed(),
  weft_private.meeting_task_changed(), weft_private.meeting_moved(), weft_private.meeting_tasklist_moved(),
  weft_private.meeting_event_moved(), weft_private.meeting_event_renamed()
  from public, weft_user, weft_assistant;
grant execute on function weft_private.refresh_meeting_text(uuid) to weft_owner;
