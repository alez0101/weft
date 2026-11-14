-- 026 links: a shared list of useful links in a space.
-- A link list is an item (kind 'linklist'), so it lives in a space and gets everything items have: the
-- one permission rule, moving, deleting, sharing links, the audit log, search and the assistant (through
-- the list's text summary in body_text). Its title is the list's name. Links reach the space through
-- their list, like tasks: members read, editors and owners add, change and delete, viewers read only.
-- Weft stores the address and never fetches the page. Only http and https addresses are kept, so a
-- link cannot run script when clicked. Tags are trimmed, lowercased and de-duplicated here. Who added
-- a link is set here, never by the client.
set client_min_messages = warning;

alter table weft.items drop constraint if exists items_kind_check;
alter table weft.items add constraint items_kind_check check (kind in ('document', 'wiki', 'whiteboard', 'table', 'file', 'tasklist', 'poll', 'form', 'linklist'));

create table if not exists weft.links (
  id         uuid primary key default gen_random_uuid(),
  list_id    uuid not null references weft.items (id) on delete cascade,
  url        text not null check (length(url) <= 2000 and url ~* '^https?://[^[:space:]<>"]+$'),
  title      text not null check (length(btrim(title)) between 1 and 200),
  note       text not null default '' check (length(note) <= 1000),
  tags       text[] not null default '{}' check (cardinality(tags) <= 10),
  position   double precision not null default 0,
  created_by uuid not null default weft_private.uid() references weft.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists links_list_idx on weft.links (list_id, position);
create index if not exists links_created_idx on weft.links (created_at desc);

-- The space of a link list (null if it is not one). security definer: used inside policies.
create or replace function weft_private.linklist_space(p_list uuid) returns uuid
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select space_id from weft.items where id = p_list and kind = 'linklist'
$$;

alter table weft.links enable row level security;
alter table weft.links force row level security;
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'weft' and tablename = 'links' loop
    execute format('drop policy %I on weft.links', p.policyname);
  end loop;
end $$;
create policy links_read on weft.links for select to weft_user, weft_assistant
  using (weft_private.is_member(weft_private.linklist_space(list_id)));
create policy links_insert on weft.links for insert to weft_user
  with check (created_by = weft_private.uid() and weft_private.can_edit(weft_private.linklist_space(list_id)));
create policy links_change on weft.links for update to weft_user
  using (weft_private.can_edit(weft_private.linklist_space(list_id)))
  with check (weft_private.can_edit(weft_private.linklist_space(list_id)));
create policy links_delete on weft.links for delete to weft_user
  using (weft_private.can_edit(weft_private.linklist_space(list_id)));

-- list_id is not updatable: a link does not jump between lists (move the whole list instead).
-- created_by, created_at and updated_at are never granted.
grant select on weft.links to weft_user, weft_assistant;
grant insert (list_id, url, title, note, tags, position),
      update (url, title, note, tags, position), delete on weft.links to weft_user;
grant execute on function weft_private.linklist_space(uuid) to weft_user, weft_assistant;

-- Before a write: tidy the title, note and tags; stamp updated_at.
create or replace function weft_private.link_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare t text;
begin
  new.url := btrim(new.url);
  new.title := btrim(new.title);
  new.note := btrim(coalesce(new.note, ''));
  new.tags := coalesce((select array_agg(x order by first) from (
                select lower(btrim(tag)) as x, min(ord) as first
                  from unnest(coalesce(new.tags, '{}')) with ordinality as u(tag, ord)
                 where length(btrim(tag)) > 0 group by lower(btrim(tag))) d), '{}');
  foreach t in array new.tags loop
    if length(t) > 30 then raise exception 'a tag is at most 30 characters' using errcode = '22023'; end if;
  end loop;
  if tg_op = 'UPDATE' then new.updated_at := now(); new.created_at := old.created_at; end if;
  return new;
end $$;
drop trigger if exists links_guard on weft.links;
create trigger links_guard before insert or update on weft.links for each row execute function weft_private.link_guard();

-- The list's text summary: up to 300 links as "Title <url> [tag, tag]" with the note on the next line.
create or replace function weft_private.refresh_linklist_text(p_list uuid) returns void
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare t text;
begin
  select string_agg(line, E'\n' order by position, created_at) into t from (
    select l.position, l.created_at,
           l.title || ' <' || l.url || '>'
           || case when cardinality(l.tags) > 0 then ' [' || array_to_string(l.tags, ', ') || ']' else '' end
           || case when l.note <> '' then E'\n  ' || replace(l.note, E'\n', ' ') else '' end as line
      from weft.links l where l.list_id = p_list order by l.position, l.created_at limit 300
  ) x;
  update weft.items set body_text = t where id = p_list and body_text is distinct from t;
end $$;

-- After a change: refresh the summary, announce it (to members only, through the notification server),
-- and keep the old row in the audit log.
create or replace function weft_private.link_changed() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare r record; v_space uuid;
begin
  r := coalesce(new, old);
  v_space := weft_private.linklist_space(r.list_id);
  if v_space is null then return null; end if;   -- the list itself is being deleted
  perform weft_private.refresh_linklist_text(r.list_id);
  perform pg_notify('weft_events', json_build_object('t', 'links', 'op', tg_op, 'id', r.id, 'space', v_space, 'list', r.list_id)::text);
  if tg_op in ('UPDATE', 'DELETE') then
    insert into weft.audit (table_name, row_id, space_id, op, actor_id, actor_role, old_row)
    values ('links', old.id, v_space, tg_op, weft_private.uid(),
            coalesce(nullif(current_setting('role', true), 'none'), session_user), to_jsonb(old));
  end if;
  return null;
end $$;
drop trigger if exists links_changed on weft.links;
create trigger links_changed after insert or update or delete on weft.links for each row execute function weft_private.link_changed();

revoke execute on function weft_private.link_guard(), weft_private.refresh_linklist_text(uuid), weft_private.link_changed()
  from public, weft_user, weft_assistant;
grant execute on function weft_private.refresh_linklist_text(uuid) to weft_owner;
