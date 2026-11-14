-- 033 contacts: a shared address book for a space (names, organisation, phone, email and notes).
-- An address book is an item (kind 'addressbook'), so it lives in a space and gets everything items have:
-- the one permission rule, moving, deleting, sharing links, the audit log, search and the assistant
-- (through the book's text summary in body_text). Its title is the book's name. Contacts reach the space
-- through their book, like links and tasks: members read, viewers included; editors and owners add,
-- change and delete; the assistant role only reads. A contact never moves between books (move the whole
-- book instead, and its contacts go with it). Who added a contact is set here, never by the client.
-- Email must look like an address and phone holds only digits, spaces and + - ( ) . / x, so a stored
-- value is safe to use in a mailto: or tel: link.
set client_min_messages = warning;

alter table weft.items drop constraint if exists items_kind_check;
alter table weft.items add constraint items_kind_check check (kind in ('document', 'wiki', 'whiteboard', 'table', 'file', 'tasklist', 'poll', 'form', 'linklist', 'meeting', 'addressbook'));

create table if not exists weft.contacts (
  id           uuid primary key default gen_random_uuid(),
  book_id      uuid not null references weft.items (id) on delete cascade,
  name         text not null check (length(btrim(name)) between 1 and 120),
  organisation text not null default '' check (length(organisation) <= 120),
  phone        text not null default '' check (length(phone) <= 40 and phone ~ '^[0-9 +()./x-]*$'),
  email        text not null default '' check (length(email) <= 200 and (email = '' or email ~ '^[^][:space:]@<>"(),;:?&/\\[]+@[[:alnum:]-]+(\.[[:alnum:]-]+)+$')),
  notes        text not null default '' check (length(notes) <= 2000),
  created_by   uuid not null default weft_private.uid() references weft.users (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists contacts_book_idx on weft.contacts (book_id, lower(name));
create index if not exists contacts_created_idx on weft.contacts (created_at desc);

-- The space of an address book (null if it is not one). security definer: used inside policies.
create or replace function weft_private.addressbook_space(p_book uuid) returns uuid
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select space_id from weft.items where id = p_book and kind = 'addressbook'
$$;

alter table weft.contacts enable row level security;
alter table weft.contacts force row level security;
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'weft' and tablename = 'contacts' loop
    execute format('drop policy %I on weft.contacts', p.policyname);
  end loop;
end $$;
create policy contacts_read on weft.contacts for select to weft_user, weft_assistant
  using (weft_private.is_member(weft_private.addressbook_space(book_id)));
create policy contacts_insert on weft.contacts for insert to weft_user
  with check (created_by = weft_private.uid() and weft_private.can_edit(weft_private.addressbook_space(book_id)));
create policy contacts_change on weft.contacts for update to weft_user
  using (weft_private.can_edit(weft_private.addressbook_space(book_id)))
  with check (weft_private.can_edit(weft_private.addressbook_space(book_id)));
create policy contacts_delete on weft.contacts for delete to weft_user
  using (weft_private.can_edit(weft_private.addressbook_space(book_id)));

-- book_id is not updatable: a contact does not jump between books. created_by, created_at and
-- updated_at are never granted.
grant select on weft.contacts to weft_user, weft_assistant;
grant insert (book_id, name, organisation, phone, email, notes),
      update (name, organisation, phone, email, notes), delete on weft.contacts to weft_user;
grant execute on function weft_private.addressbook_space(uuid) to weft_user, weft_assistant;

-- Before a write: trim every field, lowercase the email; stamp updated_at.
create or replace function weft_private.contact_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  new.name := btrim(new.name);
  new.organisation := btrim(coalesce(new.organisation, ''));
  new.phone := btrim(coalesce(new.phone, ''));
  new.email := lower(btrim(coalesce(new.email, '')));
  new.notes := btrim(coalesce(new.notes, ''));
  if tg_op = 'UPDATE' then new.updated_at := now(); new.created_at := old.created_at; new.created_by := old.created_by;
  else new.created_at := now(); new.updated_at := now(); end if;
  return new;
end $$;
drop trigger if exists contacts_guard on weft.contacts;
create trigger contacts_guard before insert or update on weft.contacts for each row execute function weft_private.contact_guard();

-- The book's text summary: up to 500 contacts, by name, as "Name, Organisation, phone, email" with the
-- notes on the next line.
create or replace function weft_private.refresh_addressbook_text(p_book uuid) returns void
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare t text;
begin
  select string_agg(line, E'\n' order by k, created_at) into t from (
    select lower(c.name) as k, c.created_at,
           concat_ws(', ', c.name, nullif(c.organisation, ''), nullif(c.phone, ''), nullif(c.email, ''))
           || case when c.notes <> '' then E'\n  ' || replace(c.notes, E'\n', ' ') else '' end as line
      from weft.contacts c where c.book_id = p_book order by lower(c.name), c.created_at limit 500
  ) x;
  update weft.items set body_text = t where id = p_book and body_text is distinct from t;
end $$;

-- After a change: refresh the summary, announce it (to members only, through the notification server),
-- and keep the old row in the audit log under the book's space.
create or replace function weft_private.contact_changed() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare r record; v_space uuid;
begin
  r := coalesce(new, old);
  v_space := weft_private.addressbook_space(r.book_id);
  if v_space is null then return null; end if;   -- the book itself is being deleted
  perform weft_private.refresh_addressbook_text(r.book_id);
  perform pg_notify('weft_events', json_build_object('t', 'contacts', 'op', tg_op, 'id', r.id, 'space', v_space, 'book', r.book_id)::text);
  if tg_op in ('UPDATE', 'DELETE') then
    insert into weft.audit (table_name, row_id, space_id, op, actor_id, actor_role, old_row)
    values ('contacts', old.id, v_space, tg_op, weft_private.uid(),
            coalesce(nullif(current_setting('role', true), 'none'), session_user), to_jsonb(old));
  end if;
  return null;
end $$;
drop trigger if exists contacts_changed on weft.contacts;
create trigger contacts_changed after insert or update or delete on weft.contacts for each row execute function weft_private.contact_changed();

revoke execute on function weft_private.contact_guard(), weft_private.refresh_addressbook_text(uuid), weft_private.contact_changed()
  from public, weft_user, weft_assistant;
grant execute on function weft_private.refresh_addressbook_text(uuid) to weft_owner;
