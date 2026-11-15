-- 050 repeating tasks: a task in Tasks can repeat every day, week or month. Ticking it off makes the next one.
--   * weft.tasks.repeats: null (does not repeat), 'daily', 'weekly' or 'monthly'. Editors and owners set and
--     clear it, like the other columns of a task; the assignee who may only tick a task off (022) cannot.
--   * Ticking off a repeating task (done false -> true, however it happens: Tasks, Boards, the connector)
--     makes the next task in the same list: same title, assignee and repeat, not done, at the same place
--     in the list, due on the next date of its schedule after today (stepping from its due date, so a
--     Monday task stays on Mondays even when ticked late; with no due date, stepping from today).
--     Monthly from the 31st lands on the last day of a shorter month, and goes on from there.
--   * The ticked task stays done and stops repeating (the guard clears repeats on any done task), so
--     unticking and ticking it again never makes a second copy, and a done task never repeats.
--   * The next task is in the same list, so in the same space: nothing crosses spaces. If the assignee is no
--     longer a member of the space it is made unassigned (instead of refusing the tick). It is written by a
--     security definer trigger so that a viewer ticking off their own task still gets the next one; it reads
--     and writes only that list. created_by is the person who ticked (weft_private.uid(), never the client).
--     The insert goes through the usual task triggers: the list summary, a live notice to members, audit.
--   * The list's text summary says how a task repeats ("every week"), so search and the assistant see it.
--   * The assistant role still only reads tasks.
set client_min_messages = warning;

alter table weft.tasks add column if not exists repeats text;
alter table weft.tasks drop constraint if exists tasks_repeats_check;
alter table weft.tasks add constraint tasks_repeats_check check (repeats in ('daily', 'weekly', 'monthly'));

grant insert (repeats), update (repeats) on weft.tasks to weft_user;

-- The next due date of a schedule strictly after p_today, stepping from p_due (or from p_today without one).
create or replace function weft_private.next_due(p_due date, p_repeats text, p_today date) returns date
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare v_base date := coalesce(p_due, p_today); v_days int; n int;
begin
  if p_repeats in ('daily', 'weekly') then
    v_days := case p_repeats when 'daily' then 1 else 7 end;
    n := greatest(1, (p_today - v_base) / v_days + 1);
    return v_base + v_days * n;
  elsif p_repeats = 'monthly' then
    n := greatest(1, ((extract(year from p_today) - extract(year from v_base)) * 12
                      + extract(month from p_today) - extract(month from v_base))::int);
    while (v_base + make_interval(months => n))::date <= p_today loop n := n + 1; end loop;
    return (v_base + make_interval(months => n))::date;
  end if;
  return null;
end $$;

-- The Tasks guard (022, 028), extended: the assignee who may only tick a task off cannot change its repeat
-- either, and a done task does not repeat.
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
     and (new.title, new.assignee_id, new.due_on, new.position, new.list_id, new.column_id, new.repeats)
         is distinct from (old.title, old.assignee_id, old.due_on, old.position, old.list_id, old.column_id, old.repeats) then
    raise exception 'you can only tick off a task assigned to you' using errcode = '42501';
  end if;
  new.title := btrim(new.title);
  if new.done then new.repeats := null; end if;   -- a done task does not repeat (its next one does)
  if tg_op = 'INSERT' then
    new.done_at := case when new.done then now() end;
  else
    new.updated_at := now();
    if new.done is distinct from old.done then new.done_at := case when new.done then now() end;
    else new.done_at := old.done_at; end if;
  end if;
  return new;
end $$;

-- After a repeating task is ticked off: make the next one in the same list.
create or replace function weft_private.task_repeat() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare v_space uuid; v_who uuid;
begin
  v_space := weft_private.tasklist_space(new.list_id);
  if v_space is null then return null; end if;
  v_who := new.assignee_id;
  if v_who is not null and not exists (select 1 from weft.members m where m.space_id = v_space and m.user_id = v_who) then
    v_who := null;
  end if;
  insert into weft.tasks (list_id, title, assignee_id, due_on, position, repeats)
  values (new.list_id, new.title, v_who, weft_private.next_due(old.due_on, old.repeats, current_date), new.position, old.repeats);
  return null;
end $$;
drop trigger if exists tasks_repeat on weft.tasks;
create trigger tasks_repeat after update of done on weft.tasks for each row
  when (old.repeats is not null and new.done and not old.done) execute function weft_private.task_repeat();

-- The list's text summary (022, 028), now with how a task repeats: "[ ] Title (Who, due 2026-11-20, every week)".
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
           || case when not k.done and c.name is not null then ' in ' || c.name else '' end as line
      from weft.tasks k left join weft.users u on u.id = k.assignee_id
                        left join weft.board_columns c on c.id = k.column_id
     where k.list_id = p_list order by k.done, k.position limit 300
  ) x;
  update weft.items set body_text = t where id = p_list and body_text is distinct from t;
end $$;

revoke execute on function weft_private.task_guard(), weft_private.task_repeat() from public, weft_user, weft_assistant;
revoke execute on function weft_private.next_due(date, text, date) from public, weft_user, weft_assistant;
