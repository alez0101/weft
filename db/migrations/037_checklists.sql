-- 037 checklists: reusable checklist templates (opening up, packing, onboarding); each run is a fresh copy
-- you tick through, with a record of past runs.
-- A checklist is an item (kind 'checklist'), so it lives in a space and gets everything items have: the one
-- permission rule, moving, deleting, sharing links, the audit log, search and the assistant (through the
-- checklist's text summary in body_text). Its title is the template's name. Its steps (the template), its
-- runs and each run's own copy of the steps reach the space through the checklist: members read all of it,
-- viewers included; editors and owners change the template, start runs, tick steps, finish, reopen and
-- delete runs; the assistant role only reads. Starting a run copies the template's steps at that moment
-- (here, never by the client), so changing the template later never rewrites a run. Who started, ticked
-- and finished is set here, never by the client. Nothing jumps between checklists or runs (move the whole
-- checklist instead). A finished run's ticks are fixed until someone reopens it.
set client_min_messages = warning;

alter table weft.items drop constraint if exists items_kind_check;
alter table weft.items add constraint items_kind_check check (kind in ('document', 'wiki', 'whiteboard', 'table', 'file', 'tasklist', 'poll', 'form', 'linklist', 'meeting', 'addressbook', 'decisionlog', 'qa', 'checklist'));

create table if not exists weft.checklist_steps (
  id            uuid primary key default gen_random_uuid(),
  checklist_id  uuid not null references weft.items (id) on delete cascade,
  label         text not null check (length(btrim(label)) between 1 and 200),
  position      int not null default 0,
  created_by    uuid not null default weft_private.uid() references weft.users (id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists checklist_steps_checklist_idx on weft.checklist_steps (checklist_id, position);

create table if not exists weft.checklist_runs (
  id            uuid primary key default gen_random_uuid(),
  checklist_id  uuid not null references weft.items (id) on delete cascade,
  label         text not null default '' check (length(label) <= 120),
  started_by    uuid not null default weft_private.uid() references weft.users (id),
  started_at    timestamptz not null default now(),
  finished      boolean not null default false,
  finished_by   uuid references weft.users (id),
  finished_at   timestamptz
);
create index if not exists checklist_runs_checklist_idx on weft.checklist_runs (checklist_id, started_at desc);
create index if not exists checklist_runs_open_idx on weft.checklist_runs (started_at desc) where not finished;

create table if not exists weft.checklist_run_steps (
  id        uuid primary key default gen_random_uuid(),
  run_id    uuid not null references weft.checklist_runs (id) on delete cascade,
  position  int not null,
  label     text not null,
  done      boolean not null default false,
  done_by   uuid references weft.users (id),
  done_at   timestamptz
);
create index if not exists checklist_run_steps_run_idx on weft.checklist_run_steps (run_id, position);

-- The space of a checklist and of a run (null if there is none). security definer: used inside policies;
-- each returns only a space id.
create or replace function weft_private.checklist_space(p_checklist uuid) returns uuid
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select space_id from weft.items where id = p_checklist and kind = 'checklist'
$$;
create or replace function weft_private.checklist_run_space(p_run uuid) returns uuid
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select i.space_id from weft.checklist_runs r join weft.items i on i.id = r.checklist_id and i.kind = 'checklist' where r.id = p_run
$$;

do $$
declare t text; p record;
begin
  foreach t in array array['checklist_steps', 'checklist_runs', 'checklist_run_steps'] loop
    execute format('alter table weft.%I enable row level security', t);
    execute format('alter table weft.%I force row level security', t);
    for p in select policyname from pg_policies where schemaname = 'weft' and tablename = t loop
      execute format('drop policy %I on weft.%I', p.policyname, t);
    end loop;
  end loop;
end $$;

create policy checklist_steps_read on weft.checklist_steps for select to weft_user, weft_assistant
  using (weft_private.is_member(weft_private.checklist_space(checklist_id)));
create policy checklist_steps_add on weft.checklist_steps for insert to weft_user
  with check (created_by = weft_private.uid() and weft_private.can_edit(weft_private.checklist_space(checklist_id)));
create policy checklist_steps_change on weft.checklist_steps for update to weft_user
  using (weft_private.can_edit(weft_private.checklist_space(checklist_id)))
  with check (weft_private.can_edit(weft_private.checklist_space(checklist_id)));
create policy checklist_steps_delete on weft.checklist_steps for delete to weft_user
  using (weft_private.can_edit(weft_private.checklist_space(checklist_id)));

create policy checklist_runs_read on weft.checklist_runs for select to weft_user, weft_assistant
  using (weft_private.is_member(weft_private.checklist_space(checklist_id)));
create policy checklist_runs_start on weft.checklist_runs for insert to weft_user
  with check (started_by = weft_private.uid() and weft_private.can_edit(weft_private.checklist_space(checklist_id)));
create policy checklist_runs_change on weft.checklist_runs for update to weft_user
  using (weft_private.can_edit(weft_private.checklist_space(checklist_id)))
  with check (weft_private.can_edit(weft_private.checklist_space(checklist_id)));
create policy checklist_runs_delete on weft.checklist_runs for delete to weft_user
  using (weft_private.can_edit(weft_private.checklist_space(checklist_id)));

-- A run's steps are only ever made by the database (the copy when a run starts) and deleted with their run;
-- people only tick them.
create policy checklist_run_steps_read on weft.checklist_run_steps for select to weft_user, weft_assistant
  using (weft_private.is_member(weft_private.checklist_run_space(run_id)));
create policy checklist_run_steps_tick on weft.checklist_run_steps for update to weft_user
  using (weft_private.can_edit(weft_private.checklist_run_space(run_id)))
  with check (weft_private.can_edit(weft_private.checklist_run_space(run_id)));

-- checklist_id and run_id are never updatable; created_by, started_by, finished_by, done_by and the times
-- are never granted. A run's steps are never inserted or deleted by a person, and only `done` changes.
grant select on weft.checklist_steps, weft.checklist_runs, weft.checklist_run_steps to weft_user, weft_assistant;
grant insert (checklist_id, label, position), update (label, position), delete on weft.checklist_steps to weft_user;
grant insert (checklist_id, label), update (label, finished), delete on weft.checklist_runs to weft_user;
grant update (done) on weft.checklist_run_steps to weft_user;
revoke execute on function weft_private.checklist_space(uuid), weft_private.checklist_run_space(uuid) from public;
grant execute on function weft_private.checklist_space(uuid), weft_private.checklist_run_space(uuid) to weft_user, weft_assistant;

-- Before a write: trim the text, keep authorship and times, record who started, ticked and finished, and
-- give plain answers. Those answers are only given to editors of the checklist's space (anyone else is
-- refused by row-level security with the same answer whatever the data). Changes the database makes
-- itself (inside another trigger) pass.
create or replace function weft_private.checklist_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare v_space uuid; v_finished boolean;
begin
  if tg_table_name = 'checklist_steps' then
    new.label := btrim(new.label);
    if tg_op = 'INSERT' then
      new.created_at := now(); new.updated_at := now();
      if weft_private.can_edit(weft_private.checklist_space(new.checklist_id))
         and (select count(*) from weft.checklist_steps where checklist_id = new.checklist_id) >= 100 then
        raise exception 'a checklist has at most 100 steps' using errcode = '23514';
      end if;
    else
      new.created_at := old.created_at; new.created_by := old.created_by; new.updated_at := now();
    end if;
    return new;
  end if;

  if tg_table_name = 'checklist_runs' then
    new.label := btrim(coalesce(new.label, ''));
    if tg_op = 'INSERT' then
      new.started_at := now(); new.finished := false; new.finished_by := null; new.finished_at := null;
      v_space := weft_private.checklist_space(new.checklist_id);
      if weft_private.can_edit(v_space) and not exists (select 1 from weft.checklist_steps where checklist_id = new.checklist_id) then
        raise exception 'add a step to the checklist before starting a run' using errcode = '23514';
      end if;
    else
      new.started_at := old.started_at; new.started_by := old.started_by;
      if new.finished and not old.finished then new.finished_by := weft_private.uid(); new.finished_at := now();
      elsif not new.finished then new.finished_by := null; new.finished_at := null;
      else new.finished_by := old.finished_by; new.finished_at := old.finished_at; end if;
    end if;
    return new;
  end if;

  -- checklist_run_steps: only `done` is granted, and only updates reach here.
  new.run_id := old.run_id; new.position := old.position; new.label := old.label;
  if pg_trigger_depth() > 1 then return new; end if;
  if new.done is distinct from old.done then
    select finished into v_finished from weft.checklist_runs where id = old.run_id;
    if v_finished then
      raise exception 'this run is finished; reopen it to change its ticks' using errcode = '23514';
    end if;
    if new.done then new.done_by := weft_private.uid(); new.done_at := now();
    else new.done_by := null; new.done_at := null; end if;
  else
    new.done_by := old.done_by; new.done_at := old.done_at;
  end if;
  return new;
end $$;
drop trigger if exists checklist_steps_guard on weft.checklist_steps;
create trigger checklist_steps_guard before insert or update on weft.checklist_steps for each row execute function weft_private.checklist_guard();
drop trigger if exists checklist_runs_guard on weft.checklist_runs;
create trigger checklist_runs_guard before insert or update on weft.checklist_runs for each row execute function weft_private.checklist_guard();
drop trigger if exists checklist_run_steps_guard on weft.checklist_run_steps;
create trigger checklist_run_steps_guard before update on weft.checklist_run_steps for each row execute function weft_private.checklist_guard();

-- The checklist's text summary, what search and the assistant read: the steps in order, then up to 20
-- runs, newest first, each with who started it, how far it got, who finished it and what is still open.
create or replace function weft_private.refresh_checklist_text(p_checklist uuid) returns void
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare t text; steps text; runs text; n int;
begin
  select count(*), string_agg((rn)::text || '. ' || label, E'\n' order by rn) into n, steps from (
    select label, row_number() over (order by position, created_at) as rn from weft.checklist_steps where checklist_id = p_checklist
  ) s;
  select string_agg(line, E'\n' order by started_at desc) into runs from (
    select r.started_at,
           '- ' || coalesce(nullif(r.label, ''), 'Run') || ', started ' || to_char(r.started_at, 'YYYY-MM-DD')
           || ' by ' || coalesce(us.display_name, 'someone') || ': '
           || (select count(*) filter (where done) from weft.checklist_run_steps where run_id = r.id) || ' of '
           || (select count(*) from weft.checklist_run_steps where run_id = r.id) || ' done'
           || case when r.finished then ', finished ' || to_char(r.finished_at, 'YYYY-MM-DD') || ' by ' || coalesce(uf.display_name, 'someone')
                   else ', in progress' end
           || coalesce(E'\n  Not done: ' || (select string_agg(label, '; ' order by position) from weft.checklist_run_steps where run_id = r.id and not done), '') as line
      from weft.checklist_runs r
      left join weft.users us on us.id = r.started_by
      left join weft.users uf on uf.id = r.finished_by
     where r.checklist_id = p_checklist order by r.started_at desc limit 20
  ) x;
  t := concat_ws(E'\n', 'Checklist, ' || n || case when n = 1 then ' step' else ' steps' end, steps,
                 case when runs is not null then 'Runs, newest first:' || E'\n' || runs end);
  update weft.items set body_text = t where id = p_checklist and body_text is distinct from t;
end $$;

-- After a change: copy the steps into a new run, refresh the summary, announce it (to members only, through
-- the notification server; ids only), and keep the old row in the audit log under the checklist's space.
create or replace function weft_private.checklist_changed() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare r record; v_checklist uuid; v_space uuid; v_id uuid;
begin
  r := coalesce(new, old);
  if tg_table_name = 'checklist_run_steps' then
    if tg_op <> 'UPDATE' then return null; end if;   -- made by the copy below, deleted only with their run
    select checklist_id into v_checklist from weft.checklist_runs where id = r.run_id;
  else
    v_checklist := r.checklist_id;
  end if;
  v_id := r.id;
  v_space := weft_private.checklist_space(v_checklist);
  if v_space is null then return null; end if;   -- the checklist or run is being deleted with its parent
  if tg_table_name = 'checklist_runs' and tg_op = 'INSERT' then
    insert into weft.checklist_run_steps (run_id, position, label)
    select new.id, row_number() over (order by position, created_at), label
      from weft.checklist_steps where checklist_id = new.checklist_id;
  end if;
  perform weft_private.refresh_checklist_text(v_checklist);
  perform pg_notify('weft_events', json_build_object('t', 'checklists', 'op', tg_op, 'id', v_id, 'space', v_space, 'checklist', v_checklist)::text);
  if tg_op in ('UPDATE', 'DELETE') then
    insert into weft.audit (table_name, row_id, space_id, op, actor_id, actor_role, old_row)
    values (tg_table_name, v_id, v_space, tg_op, weft_private.uid(),
            coalesce(nullif(current_setting('role', true), 'none'), session_user), to_jsonb(old));
  end if;
  return null;
end $$;
do $$
declare t text;
begin
  foreach t in array array['checklist_steps', 'checklist_runs', 'checklist_run_steps'] loop
    execute format('drop trigger if exists %1$s_changed on weft.%1$I', t);
    execute format('create trigger %1$s_changed after insert or update or delete on weft.%1$I
                    for each row execute function weft_private.checklist_changed()', t);
  end loop;
end $$;

revoke execute on function weft_private.checklist_guard(), weft_private.refresh_checklist_text(uuid), weft_private.checklist_changed()
  from public, weft_user, weft_assistant;
grant execute on function weft_private.refresh_checklist_text(uuid) to weft_owner;
