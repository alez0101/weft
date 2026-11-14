-- 041 goals: objectives with measurable key results and progress, updated by hand, with a simple progress
-- view per space.
-- A goal set is an item (kind 'goalset'), so it lives in a space and gets everything items have: the one
-- permission rule, moving, deleting, sharing links, the audit log, search and the assistant (through the
-- set's text summary in body_text). Its title is the set's name ("Goals for spring"). Its goals and their
-- key results reach the space through it: members read, viewers included; editors and owners add, change,
-- delete and update the numbers; the assistant role only reads. Nothing jumps between sets or goals (move
-- the whole set instead). Who added a goal or key result, and who last updated a key result's value and
-- when, are written here, never by the client.
-- A key result runs from a start value to a target value (the target may be lower, as in "cut waste from
-- 500 kg to 300 kg"); its progress is how far the current value has come, kept between 0 and 1, and is a
-- generated column so every reader computes it the same way. A goal's progress is the average of its key
-- results; the set's is the average of its goals that have key results.
set client_min_messages = warning;

alter table weft.items drop constraint if exists items_kind_check;
alter table weft.items add constraint items_kind_check check (kind in ('document', 'wiki', 'whiteboard', 'table', 'file', 'tasklist', 'poll', 'form', 'linklist', 'meeting', 'addressbook', 'decisionlog', 'qa', 'checklist', 'expenselist', 'inventory', 'goalset'));

create table if not exists weft.goals (
  id          uuid primary key default gen_random_uuid(),
  set_id      uuid not null references weft.items (id) on delete cascade,
  title       text not null check (length(btrim(title)) between 1 and 200),
  note        text not null default '' check (length(note) <= 2000),
  due_on      date,
  position    integer not null default 0 check (position between 0 and 10000),
  created_by  uuid not null default weft_private.uid() references weft.users (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists goals_set_idx on weft.goals (set_id, position, created_at);

create table if not exists weft.key_results (
  id                uuid primary key default gen_random_uuid(),
  goal_id           uuid not null references weft.goals (id) on delete cascade,
  title             text not null check (length(btrim(title)) between 1 and 200),
  start_value       numeric not null default 0 check (abs(start_value) < 1e12),
  target_value      numeric not null check (abs(target_value) < 1e12),
  current_value     numeric not null default 0 check (abs(current_value) < 1e12),
  unit              text not null default '' check (length(unit) <= 20),
  position          integer not null default 0 check (position between 0 and 10000),
  progress          numeric generated always as
                      (least(1, greatest(0, (current_value - start_value) / nullif(target_value - start_value, 0)))) stored,
  created_by        uuid not null default weft_private.uid() references weft.users (id),
  created_at        timestamptz not null default now(),
  value_updated_by  uuid references weft.users (id),
  value_updated_at  timestamptz,
  constraint key_results_target_differs check (target_value <> start_value)
);
create index if not exists key_results_goal_idx on weft.key_results (goal_id, position, created_at);

-- The space of a goal set, and of a goal (null if there is none). security definer: used inside policies;
-- they return only a space id.
create or replace function weft_private.goalset_space(p_set uuid) returns uuid
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select space_id from weft.items where id = p_set and kind = 'goalset'
$$;
create or replace function weft_private.goal_space(p_goal uuid) returns uuid
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select i.space_id from weft.goals g join weft.items i on i.id = g.set_id and i.kind = 'goalset' where g.id = p_goal
$$;

do $$
declare t text; p record;
begin
  foreach t in array array['goals', 'key_results'] loop
    execute format('alter table weft.%I enable row level security', t);
    execute format('alter table weft.%I force row level security', t);
    for p in select policyname from pg_policies where schemaname = 'weft' and tablename = t loop
      execute format('drop policy %I on weft.%I', p.policyname, t);
    end loop;
  end loop;
end $$;

create policy goals_read on weft.goals for select to weft_user, weft_assistant
  using (weft_private.is_member(weft_private.goalset_space(set_id)));
create policy goals_insert on weft.goals for insert to weft_user
  with check (created_by = weft_private.uid() and weft_private.can_edit(weft_private.goalset_space(set_id)));
create policy goals_change on weft.goals for update to weft_user
  using (weft_private.can_edit(weft_private.goalset_space(set_id)))
  with check (weft_private.can_edit(weft_private.goalset_space(set_id)));
create policy goals_delete on weft.goals for delete to weft_user
  using (weft_private.can_edit(weft_private.goalset_space(set_id)));

create policy key_results_read on weft.key_results for select to weft_user, weft_assistant
  using (weft_private.is_member(weft_private.goal_space(goal_id)));
create policy key_results_insert on weft.key_results for insert to weft_user
  with check (created_by = weft_private.uid() and weft_private.can_edit(weft_private.goal_space(goal_id)));
create policy key_results_change on weft.key_results for update to weft_user
  using (weft_private.can_edit(weft_private.goal_space(goal_id)))
  with check (weft_private.can_edit(weft_private.goal_space(goal_id)));
create policy key_results_delete on weft.key_results for delete to weft_user
  using (weft_private.can_edit(weft_private.goal_space(goal_id)));

-- set_id and goal_id are not updatable: nothing jumps between sets or goals. created_by, created_at,
-- updated_at, progress and the value stamps are never granted.
grant select on weft.goals, weft.key_results to weft_user, weft_assistant;
grant insert (set_id, title, note, due_on, position),
      update (title, note, due_on, position), delete on weft.goals to weft_user;
grant insert (goal_id, title, start_value, target_value, current_value, unit, position),
      update (title, start_value, target_value, current_value, unit, position), delete on weft.key_results to weft_user;
revoke execute on function weft_private.goalset_space(uuid), weft_private.goal_space(uuid) from public;
grant execute on function weft_private.goalset_space(uuid), weft_private.goal_space(uuid) to weft_user, weft_assistant;

-- Before a write: trim the text and keep the authorship and times. A key result's value stamp moves only
-- when its current value changes (or on insert), and always to the caller.
create or replace function weft_private.goal_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  new.title := btrim(new.title);
  new.note := btrim(coalesce(new.note, ''), E' \t\r\n');
  if tg_op = 'UPDATE' then new.updated_at := now(); new.created_at := old.created_at; new.created_by := old.created_by;
  else new.created_at := now(); new.updated_at := now(); end if;
  return new;
end $$;
drop trigger if exists goals_guard on weft.goals;
create trigger goals_guard before insert or update on weft.goals for each row execute function weft_private.goal_guard();

create or replace function weft_private.key_result_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  new.title := btrim(new.title);
  new.unit := btrim(coalesce(new.unit, ''));
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
drop trigger if exists key_results_guard on weft.key_results;
create trigger key_results_guard before insert or update on weft.key_results for each row execute function weft_private.key_result_guard();

-- The set's text summary: up to 100 goals in order, each with its progress and due date, then each key
-- result as "title: current of target unit (from start), NN%".
create or replace function weft_private.goal_num(n numeric) returns text
language sql immutable set search_path = pg_temp as $$
  select case when n = trunc(n) then trunc(n)::text else rtrim(rtrim(round(n, 4)::text, '0'), '.') end
$$;
create or replace function weft_private.refresh_goalset_text(p_set uuid) returns void
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare t text;
begin
  select string_agg(line, E'\n' order by position, created_at) into t from (
    select g.position, g.created_at,
           g.title
           || coalesce(' (' || round(100 * (select avg(k.progress) from weft.key_results k where k.goal_id = g.id)) || '% done)', '')
           || case when g.due_on is not null then ', due ' || to_char(g.due_on, 'YYYY-MM-DD') else '' end
           || case when g.note <> '' then E'\n  ' || regexp_replace(g.note, '\s*\n\s*', ' ', 'g') else '' end
           || coalesce((select string_agg(E'\n  - ' || k.title || ': ' || goal_num(k.current_value) || ' of ' || goal_num(k.target_value)
                                          || case when k.unit <> '' then ' ' || k.unit else '' end
                                          || ' (from ' || goal_num(k.start_value) || '), ' || round(100 * k.progress) || '%', '' order by k.position, k.created_at)
                          from weft.key_results k where k.goal_id = g.id), '') as line
      from weft.goals g where g.set_id = p_set order by g.position, g.created_at limit 100
  ) x;
  update weft.items set body_text = t where id = p_set and body_text is distinct from t;
end $$;

-- After a change: refresh the summary, announce it (to members only, through the notification server),
-- and keep the old row in the audit log under the set's space.
create or replace function weft_private.goal_changed() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare r record; v_space uuid;
begin
  r := coalesce(new, old);
  v_space := weft_private.goalset_space(r.set_id);
  if v_space is null then return null; end if;   -- the set itself is being deleted
  perform weft_private.refresh_goalset_text(r.set_id);
  perform pg_notify('weft_events', json_build_object('t', 'goals', 'op', tg_op, 'id', r.id, 'space', v_space, 'set', r.set_id)::text);
  if tg_op in ('UPDATE', 'DELETE') then
    insert into weft.audit (table_name, row_id, space_id, op, actor_id, actor_role, old_row)
    values ('goals', old.id, v_space, tg_op, weft_private.uid(),
            coalesce(nullif(current_setting('role', true), 'none'), session_user), to_jsonb(old));
  end if;
  return null;
end $$;
drop trigger if exists goals_changed on weft.goals;
create trigger goals_changed after insert or update or delete on weft.goals for each row execute function weft_private.goal_changed();

create or replace function weft_private.key_result_changed() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare r record; v_set uuid; v_space uuid;
begin
  r := coalesce(new, old);
  select g.set_id, i.space_id into v_set, v_space
    from weft.goals g join weft.items i on i.id = g.set_id and i.kind = 'goalset' where g.id = r.goal_id;
  if v_space is null then return null; end if;   -- the goal or the set is being deleted
  perform weft_private.refresh_goalset_text(v_set);
  perform pg_notify('weft_events', json_build_object('t', 'goals', 'op', tg_op, 'id', r.id, 'space', v_space, 'set', v_set)::text);
  if tg_op in ('UPDATE', 'DELETE') then
    insert into weft.audit (table_name, row_id, space_id, op, actor_id, actor_role, old_row)
    values ('key_results', old.id, v_space, tg_op, weft_private.uid(),
            coalesce(nullif(current_setting('role', true), 'none'), session_user), to_jsonb(old));
  end if;
  return null;
end $$;
drop trigger if exists key_results_changed on weft.key_results;
create trigger key_results_changed after insert or update or delete on weft.key_results for each row execute function weft_private.key_result_changed();

revoke execute on function weft_private.goal_guard(), weft_private.key_result_guard(), weft_private.refresh_goalset_text(uuid),
  weft_private.goal_changed(), weft_private.key_result_changed(), weft_private.goal_num(numeric) from public, weft_user, weft_assistant;
grant execute on function weft_private.refresh_goalset_text(uuid) to weft_owner;
