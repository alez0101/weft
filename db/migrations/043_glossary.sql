-- 043 glossary: the words a space uses (abbreviations, nicknames, jargon) and what each means, so
-- newcomers learn the language; Weft reads it when answering.
-- A glossary is an item (kind 'glossary'), so it lives in a space and gets everything items have: the one
-- permission rule, moving, deleting, sharing links, the audit log, search and the assistant (through the
-- glossary's text summary in body_text, one "Term: definition" line per term). Its title is its name.
-- Terms reach the space through their glossary, like contacts: members read, viewers included; editors and
-- owners add, change and delete; the assistant role only reads. A term appears once per glossary, whatever
-- its case. A term never moves between glossaries (move the whole glossary instead, and its terms go with
-- it). Who added a term is set here, never by the client.
set client_min_messages = warning;

alter table weft.items drop constraint if exists items_kind_check;
alter table weft.items add constraint items_kind_check check (kind in ('document', 'wiki', 'whiteboard', 'table', 'file', 'tasklist', 'poll', 'form', 'linklist', 'meeting', 'addressbook', 'decisionlog', 'qa', 'checklist', 'expenselist', 'inventory', 'goalset', 'retro', 'glossary'));

create table if not exists weft.glossary_terms (
  id           uuid primary key default gen_random_uuid(),
  glossary_id  uuid not null references weft.items (id) on delete cascade,
  term         text not null check (length(btrim(term)) between 1 and 80 and term !~ '[\n\r]'),
  definition   text not null check (length(btrim(definition)) between 1 and 2000),
  created_by   uuid not null default weft_private.uid() references weft.users (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index if not exists glossary_terms_unique_idx on weft.glossary_terms (glossary_id, lower(term));
create index if not exists glossary_terms_created_idx on weft.glossary_terms (created_at desc);

-- The space of a glossary (null if it is not one). security definer: used inside policies; returns only a space id.
create or replace function weft_private.glossary_space(p_glossary uuid) returns uuid
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select space_id from weft.items where id = p_glossary and kind = 'glossary'
$$;

alter table weft.glossary_terms enable row level security;
alter table weft.glossary_terms force row level security;
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'weft' and tablename = 'glossary_terms' loop
    execute format('drop policy %I on weft.glossary_terms', p.policyname);
  end loop;
end $$;
create policy glossary_terms_read on weft.glossary_terms for select to weft_user, weft_assistant
  using (weft_private.is_member(weft_private.glossary_space(glossary_id)));
create policy glossary_terms_insert on weft.glossary_terms for insert to weft_user
  with check (created_by = weft_private.uid() and weft_private.can_edit(weft_private.glossary_space(glossary_id)));
create policy glossary_terms_change on weft.glossary_terms for update to weft_user
  using (weft_private.can_edit(weft_private.glossary_space(glossary_id)))
  with check (weft_private.can_edit(weft_private.glossary_space(glossary_id)));
create policy glossary_terms_delete on weft.glossary_terms for delete to weft_user
  using (weft_private.can_edit(weft_private.glossary_space(glossary_id)));

-- glossary_id is not updatable: a term does not jump between glossaries. created_by, created_at and
-- updated_at are never granted.
grant select on weft.glossary_terms to weft_user, weft_assistant;
grant insert (glossary_id, term, definition), update (term, definition), delete on weft.glossary_terms to weft_user;
grant execute on function weft_private.glossary_space(uuid) to weft_user, weft_assistant;

-- Before a write: trim both fields and squeeze runs of spaces in the term; stamp the times and keep the
-- author. A term that is already in the glossary (any case) gets a plain answer instead of the index name.
create or replace function weft_private.glossary_term_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  new.term := regexp_replace(btrim(new.term), '\s+', ' ', 'g');
  new.definition := btrim(new.definition);
  if tg_op = 'UPDATE' then new.updated_at := now(); new.created_at := old.created_at; new.created_by := old.created_by;
  else new.created_at := now(); new.updated_at := now(); end if;
  -- Only checked once the caller may write here (the policies run after this trigger, so look first):
  -- otherwise the answer would tell an outsider which terms a glossary they cannot read contains.
  if weft_private.can_edit(weft_private.glossary_space(new.glossary_id))
     and exists (select 1 from weft.glossary_terms t where t.glossary_id = new.glossary_id and lower(t.term) = lower(new.term)
                   and t.id is distinct from new.id) then
    raise exception '"%" is already in this glossary. Edit it there instead.', new.term using errcode = '23505';
  end if;
  return new;
end $$;
drop trigger if exists glossary_terms_guard on weft.glossary_terms;
create trigger glossary_terms_guard before insert or update on weft.glossary_terms for each row execute function weft_private.glossary_term_guard();

-- The glossary's text summary: up to 1000 terms, A to Z, as "Term: definition" (one line each).
create or replace function weft_private.refresh_glossary_text(p_glossary uuid) returns void
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare t text;
begin
  select string_agg(line, E'\n' order by k) into t from (
    select lower(g.term) as k, g.term || ': ' || regexp_replace(g.definition, '\s*\n\s*', ' ', 'g') as line
      from weft.glossary_terms g where g.glossary_id = p_glossary order by lower(g.term) limit 1000
  ) x;
  update weft.items set body_text = t where id = p_glossary and body_text is distinct from t;
end $$;

-- After a change: refresh the summary, announce it (to members only, through the notification server),
-- and keep the old row in the audit log under the glossary's space.
create or replace function weft_private.glossary_term_changed() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare r record; v_space uuid;
begin
  r := coalesce(new, old);
  v_space := weft_private.glossary_space(r.glossary_id);
  if v_space is null then return null; end if;   -- the glossary itself is being deleted
  perform weft_private.refresh_glossary_text(r.glossary_id);
  perform pg_notify('weft_events', json_build_object('t', 'glossary', 'op', tg_op, 'id', r.id, 'space', v_space, 'glossary', r.glossary_id)::text);
  if tg_op in ('UPDATE', 'DELETE') then
    insert into weft.audit (table_name, row_id, space_id, op, actor_id, actor_role, old_row)
    values ('glossary_terms', old.id, v_space, tg_op, weft_private.uid(),
            coalesce(nullif(current_setting('role', true), 'none'), session_user), to_jsonb(old));
  end if;
  return null;
end $$;
drop trigger if exists glossary_terms_changed on weft.glossary_terms;
create trigger glossary_terms_changed after insert or update or delete on weft.glossary_terms for each row execute function weft_private.glossary_term_changed();

revoke execute on function weft_private.glossary_term_guard(), weft_private.refresh_glossary_text(uuid), weft_private.glossary_term_changed()
  from public, weft_user, weft_assistant;
grant execute on function weft_private.refresh_glossary_text(uuid) to weft_owner;
