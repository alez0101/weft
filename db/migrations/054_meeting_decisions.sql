-- 054 meeting decisions to the log: each line in a meeting's Decisions section (029) can be sent with one
-- press to a decision log (035) in the same space, and the decision links back to the meeting.
--   * The decision is an ordinary row in weft.decisions, so the log, its text summary, search and the
--     assistant pick it up as they do any decision. It is dated the day the meeting was held and "decided
--     by" the meeting's name.
--   * weft.meeting_decisions: which decisions came from which meeting, and from which line (so the meeting
--     shows which lines are already in a log). Like meeting_actions (029): it reaches its space through the
--     meeting; members read, viewers included; editors and owners add and remove; the assistant role only
--     reads. A link must join a meeting and a decision in the same space. A line is sent once per meeting;
--     deleting the decision removes the link, so the line can be sent again. created_by defaults to
--     weft_private.uid() and is never granted; nothing is updated (remove the link and send again).
--   * weft.send_meeting_decision makes the decision and the link together, as the caller (security
--     invoker): row-level security decides both inserts, exactly as if they were made one after the other.
--   * Moves: when the meeting or the decision log moves to another space, links that would now cross spaces
--     are removed (the decision stays in its log). The removal is recorded in the audit log and announced
--     under the space it moved FROM, never the new one.
--   * Live: a 'meeting_decisions' notice (ids only, with the meeting and the decision log) to members.
set client_min_messages = warning;

create table if not exists weft.meeting_decisions (
  decision_id uuid primary key references weft.decisions (id) on delete cascade,
  meeting_id  uuid not null references weft.items (id) on delete cascade,
  line        text not null check (length(line) between 1 and 1000),
  created_by  uuid not null default weft_private.uid() references weft.users (id),
  created_at  timestamptz not null default now(),
  constraint meeting_decisions_line_once unique (meeting_id, line)
);

alter table weft.meeting_decisions enable row level security;
alter table weft.meeting_decisions force row level security;
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'weft' and tablename = 'meeting_decisions' loop
    execute format('drop policy %I on weft.meeting_decisions', p.policyname);
  end loop;
end $$;
create policy meeting_decisions_read on weft.meeting_decisions for select to weft_user, weft_assistant
  using (weft_private.is_member(weft_private.meeting_space(meeting_id)));
create policy meeting_decisions_insert on weft.meeting_decisions for insert to weft_user
  with check (created_by = weft_private.uid() and weft_private.can_edit(weft_private.meeting_space(meeting_id)));
create policy meeting_decisions_delete on weft.meeting_decisions for delete to weft_user
  using (weft_private.can_edit(weft_private.meeting_space(meeting_id)));

grant select on weft.meeting_decisions to weft_user, weft_assistant;
grant insert (decision_id, meeting_id, line), delete on weft.meeting_decisions to weft_user;

-- Before a new link: tidy the line, stamp the time, and the decision must be in a log in the meeting's own
-- space (one answer for "not there" and "somewhere else"). Someone who may not edit the meeting is refused
-- by the policy, so this check tells them nothing.
create or replace function weft_private.meeting_decision_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  new.line := btrim(coalesce(new.line, ''), E' \t\r\n');
  new.created_at := now();
  if weft_private.can_edit(weft_private.meeting_space(new.meeting_id))
     and not exists (select 1 from weft.decisions d where d.id = new.decision_id
                      and weft_private.decisionlog_space(d.log_id) = weft_private.meeting_space(new.meeting_id)) then
    raise exception 'a meeting''s decision must go to a decision log in the meeting''s space' using errcode = '22023';
  end if;
  return new;
end $$;
drop trigger if exists meeting_decisions_guard on weft.meeting_decisions;
create trigger meeting_decisions_guard before insert on weft.meeting_decisions for each row execute function weft_private.meeting_decision_guard();

-- After a link is added or removed: announce it (ids only) and keep a removed link in the audit log. A
-- removal caused by a move is recorded and announced under the space the meeting or log moved from.
create or replace function weft_private.meeting_decision_changed() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare r record; v_space uuid; v_log uuid;
begin
  r := coalesce(new, old);
  v_space := coalesce(nullif(current_setting('weft.meeting_decisions_moving_from', true), '')::uuid,
                      weft_private.meeting_space(r.meeting_id));
  if v_space is null then return null; end if;   -- the meeting itself is being deleted
  select log_id into v_log from weft.decisions where id = r.decision_id;
  perform pg_notify('weft_events', json_build_object('t', 'meeting_decisions', 'op', tg_op, 'id', r.decision_id,
                    'space', v_space, 'meeting', r.meeting_id, 'log', v_log)::text);
  if tg_op = 'DELETE' then
    insert into weft.audit (table_name, row_id, space_id, op, actor_id, actor_role, old_row)
    values ('meeting_decisions', old.decision_id, v_space, tg_op, weft_private.uid(),
            coalesce(nullif(current_setting('role', true), 'none'), session_user), to_jsonb(old));
  end if;
  return null;
end $$;
drop trigger if exists meeting_decisions_changed on weft.meeting_decisions;
create trigger meeting_decisions_changed after insert or delete on weft.meeting_decisions
  for each row execute function weft_private.meeting_decision_changed();

-- A meeting moved to another space: its links to decisions in logs elsewhere go.
create or replace function weft_private.meeting_decisions_meeting_moved() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  perform set_config('weft.meeting_decisions_moving_from', old.space_id::text, true);   -- see meeting_decision_changed
  delete from weft.meeting_decisions md using weft.decisions d
   where md.meeting_id = new.id and d.id = md.decision_id
     and weft_private.decisionlog_space(d.log_id) is distinct from new.space_id;
  perform set_config('weft.meeting_decisions_moving_from', '', true);
  return null;
end $$;
drop trigger if exists items_meeting_decisions_meeting_moved on weft.items;
create trigger items_meeting_decisions_meeting_moved after update of space_id on weft.items for each row
  when (new.kind = 'meeting' and new.space_id is distinct from old.space_id) execute function weft_private.meeting_decisions_meeting_moved();

-- A decision log moved to another space: its decisions stop linking to meetings elsewhere.
create or replace function weft_private.meeting_decisions_log_moved() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  perform set_config('weft.meeting_decisions_moving_from', old.space_id::text, true);
  delete from weft.meeting_decisions md using weft.decisions d
   where d.log_id = new.id and md.decision_id = d.id
     and weft_private.meeting_space(md.meeting_id) is distinct from new.space_id;
  perform set_config('weft.meeting_decisions_moving_from', '', true);
  return null;
end $$;
drop trigger if exists items_meeting_decisions_log_moved on weft.items;
create trigger items_meeting_decisions_log_moved after update of space_id on weft.items for each row
  when (new.kind = 'decisionlog' and new.space_id is distinct from old.space_id) execute function weft_private.meeting_decisions_log_moved();

-- Send one line of a meeting's decisions to a decision log in the same space, in one step, as the caller.
-- p_on is the day the meeting was held in the sender's own time zone (else the day in UTC, else today).
create or replace function weft.send_meeting_decision(p_meeting uuid, p_log uuid, p_line text, p_on date default null)
returns weft.decisions
language plpgsql security invoker set search_path = weft, pg_temp as $$
declare v_title text; v_held timestamptz; v_space uuid; v_line text; d weft.decisions;
begin
  select i.title, m.held_at, i.space_id into v_title, v_held, v_space
    from weft.meetings m join weft.items i on i.id = m.id where m.id = p_meeting;
  if not found then
    raise exception 'no such meeting, or you cannot see it' using errcode = '42501';
  end if;
  if not exists (select 1 from weft.items where id = p_log and kind = 'decisionlog' and space_id = v_space) then
    raise exception 'choose a decision log in the meeting''s space' using errcode = '22023';
  end if;
  v_line := btrim(coalesce(p_line, ''), E' \t\r\n');
  if v_line = '' or length(v_line) > 1000 then
    raise exception 'a decision line must be 1 to 1000 characters' using errcode = '22023';
  end if;
  if exists (select 1 from weft.meeting_decisions where meeting_id = p_meeting and line = v_line) then
    raise exception 'that line is already in a decision log' using errcode = '23505';
  end if;
  insert into weft.decisions (log_id, title, context, decided_by, decided_on)
  values (p_log,
          case when length(v_line) > 200 then left(v_line, 199) || '…' else v_line end,
          case when length(v_line) > 200 then v_line else '' end,
          left(coalesce(v_title, ''), 120),
          coalesce(p_on, (v_held at time zone 'UTC')::date, current_date))
  returning * into d;
  insert into weft.meeting_decisions (decision_id, meeting_id, line) values (d.id, p_meeting, v_line);
  return d;
end $$;
revoke execute on function weft.send_meeting_decision(uuid, uuid, text, date) from public, weft_assistant;
grant execute on function weft.send_meeting_decision(uuid, uuid, text, date) to weft_user;

revoke execute on function weft_private.meeting_decision_guard(), weft_private.meeting_decision_changed(),
  weft_private.meeting_decisions_meeting_moved(), weft_private.meeting_decisions_log_moved()
  from public, weft_user, weft_assistant;
