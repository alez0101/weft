-- 035 decisions: a log of decisions with the context, who decided, the date and what it replaces, so the
-- team can find why something is the way it is.
-- A decision log is an item (kind 'decisionlog'), so it lives in a space and gets everything items have:
-- the one permission rule, moving, deleting, sharing links, the audit log, search and the assistant
-- (through the log's text summary in body_text). Its title is the log's name. Decisions reach the space
-- through their log, like contacts and links: members read, viewers included; editors and owners add,
-- change and delete; the assistant role only reads. A decision never moves between logs (move the whole
-- log instead). Who wrote a decision down is set here, never by the client; "who decided" is free text,
-- because decisions are often made by a group or a meeting.
-- A decision may replace one earlier decision in the same log (a composite foreign key keeps it in the
-- log, so it never points into a space the reader cannot see), never itself, never in a loop, and each
-- decision is replaced by at most one other. Deleting a decision un-links what replaced it.
set client_min_messages = warning;

alter table weft.items drop constraint if exists items_kind_check;
alter table weft.items add constraint items_kind_check check (kind in ('document', 'wiki', 'whiteboard', 'table', 'file', 'tasklist', 'poll', 'form', 'linklist', 'meeting', 'addressbook', 'decisionlog'));

create table if not exists weft.decisions (
  id           uuid primary key default gen_random_uuid(),
  log_id       uuid not null references weft.items (id) on delete cascade,
  title        text not null check (length(btrim(title)) between 1 and 200),
  context      text not null default '' check (length(context) <= 4000),
  decided_by   text not null default '' check (length(decided_by) <= 120),
  decided_on   date not null default current_date,
  replaces_id  uuid,
  created_by   uuid not null default weft_private.uid() references weft.users (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint decisions_log_id_key unique (log_id, id),
  constraint decisions_not_itself check (replaces_id is null or replaces_id <> id),
  constraint decisions_replaces_fkey foreign key (log_id, replaces_id) references weft.decisions (log_id, id) on delete set null (replaces_id)
);
create index if not exists decisions_log_idx on weft.decisions (log_id, decided_on desc);
create index if not exists decisions_created_idx on weft.decisions (created_at desc);
create unique index if not exists decisions_replaced_once on weft.decisions (replaces_id) where replaces_id is not null;

-- The space of a decision log (null if it is not one). security definer: used inside policies.
create or replace function weft_private.decisionlog_space(p_log uuid) returns uuid
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select space_id from weft.items where id = p_log and kind = 'decisionlog'
$$;

alter table weft.decisions enable row level security;
alter table weft.decisions force row level security;
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'weft' and tablename = 'decisions' loop
    execute format('drop policy %I on weft.decisions', p.policyname);
  end loop;
end $$;
create policy decisions_read on weft.decisions for select to weft_user, weft_assistant
  using (weft_private.is_member(weft_private.decisionlog_space(log_id)));
create policy decisions_insert on weft.decisions for insert to weft_user
  with check (created_by = weft_private.uid() and weft_private.can_edit(weft_private.decisionlog_space(log_id)));
create policy decisions_change on weft.decisions for update to weft_user
  using (weft_private.can_edit(weft_private.decisionlog_space(log_id)))
  with check (weft_private.can_edit(weft_private.decisionlog_space(log_id)));
create policy decisions_delete on weft.decisions for delete to weft_user
  using (weft_private.can_edit(weft_private.decisionlog_space(log_id)));

-- log_id is not updatable: a decision does not jump between logs. created_by, created_at and updated_at
-- are never granted.
grant select on weft.decisions to weft_user, weft_assistant;
grant insert (log_id, title, context, decided_by, decided_on, replaces_id),
      update (title, context, decided_by, decided_on, replaces_id), delete on weft.decisions to weft_user;
revoke execute on function weft_private.decisionlog_space(uuid) from public;
grant execute on function weft_private.decisionlog_space(uuid) to weft_user, weft_assistant;

-- Before a write: trim the text, keep the authorship and times, and refuse a loop of replacements
-- (A replaces B replaces A). The walk stays inside the decision's own log (the foreign key keeps every
-- link there), so it reads nothing the writer could not read already.
create or replace function weft_private.decision_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare cur uuid; steps int := 0;
begin
  new.title := btrim(new.title);
  new.context := btrim(coalesce(new.context, ''), E' \t\r\n');
  new.decided_by := btrim(coalesce(new.decided_by, ''));
  if tg_op = 'UPDATE' then new.updated_at := now(); new.created_at := old.created_at; new.created_by := old.created_by;
  else new.created_at := now(); new.updated_at := now(); end if;
  cur := new.replaces_id;
  while cur is not null loop
    if cur = new.id then raise exception 'a decision cannot replace one that replaces it' using errcode = '23514'; end if;
    steps := steps + 1;
    exit when steps > 1000;
    select replaces_id into cur from weft.decisions where id = cur and log_id = new.log_id;
  end loop;
  return new;
end $$;
drop trigger if exists decisions_guard on weft.decisions;
create trigger decisions_guard before insert or update on weft.decisions for each row execute function weft_private.decision_guard();

-- The log's text summary: up to 300 decisions, newest first, as "date: title (decided by …)", then
-- "Replaces: …" / "Replaced by: …" and the context on the next lines.
create or replace function weft_private.refresh_decisionlog_text(p_log uuid) returns void
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare t text;
begin
  select string_agg(line, E'\n' order by decided_on desc, created_at desc) into t from (
    select d.decided_on, d.created_at,
           to_char(d.decided_on, 'YYYY-MM-DD') || ': ' || d.title
           || case when d.decided_by <> '' then ' (decided by ' || d.decided_by || ')' else '' end
           || case when r.id is not null then E'\n  Replaces: ' || r.title else '' end
           || case when n.id is not null then E'\n  Replaced by: ' || n.title else '' end
           || case when d.context <> '' then E'\n  ' || regexp_replace(d.context, '\s*\n\s*', ' ', 'g') else '' end as line
      from weft.decisions d
      left join weft.decisions r on r.id = d.replaces_id
      left join weft.decisions n on n.replaces_id = d.id
     where d.log_id = p_log order by d.decided_on desc, d.created_at desc limit 300
  ) x;
  update weft.items set body_text = t where id = p_log and body_text is distinct from t;
end $$;

-- After a change: refresh the summary, announce it (to members only, through the notification server),
-- and keep the old row in the audit log under the log's space.
create or replace function weft_private.decision_changed() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare r record; v_space uuid;
begin
  r := coalesce(new, old);
  v_space := weft_private.decisionlog_space(r.log_id);
  if v_space is null then return null; end if;   -- the log itself is being deleted
  perform weft_private.refresh_decisionlog_text(r.log_id);
  perform pg_notify('weft_events', json_build_object('t', 'decisions', 'op', tg_op, 'id', r.id, 'space', v_space, 'log', r.log_id)::text);
  if tg_op in ('UPDATE', 'DELETE') then
    insert into weft.audit (table_name, row_id, space_id, op, actor_id, actor_role, old_row)
    values ('decisions', old.id, v_space, tg_op, weft_private.uid(),
            coalesce(nullif(current_setting('role', true), 'none'), session_user), to_jsonb(old));
  end if;
  return null;
end $$;
drop trigger if exists decisions_changed on weft.decisions;
create trigger decisions_changed after insert or update or delete on weft.decisions for each row execute function weft_private.decision_changed();

revoke execute on function weft_private.decision_guard(), weft_private.refresh_decisionlog_text(uuid), weft_private.decision_changed()
  from public, weft_user, weft_assistant;
grant execute on function weft_private.refresh_decisionlog_text(uuid) to weft_owner;
