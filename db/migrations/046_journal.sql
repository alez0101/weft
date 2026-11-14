-- 046 journal: private dated entries in your personal space, one page per day, readable only by you.
-- weft.journal_entries holds one page per person per day (the day and up to 20,000 characters of text).
--   * A page always lives in its writer's personal space and is written by them: space_id and author_id
--     are set by the database (never granted), so neither can be forged or changed.
--   * Only the writer reads, writes and deletes it. Every policy needs author_id = the caller, the row in the
--     caller's own personal space, and weft_private.is_member / can_edit of that space, so the channel-scope
--     claim (a token scoped to a channel sees no pages) and disabled accounts apply as everywhere. Someone
--     the owner adds to their personal space, channel owners and admins see nothing.
--   * The assistant role gets no grant at all: a journal is not read by Weft. Pages are not items, so they
--     are not in search, meaning search or the assistant's context; the app searches your own pages itself.
--   * Changes are announced through the shared announce trigger (table, operation, id and space only).
--     The audit log records that a page changed or was deleted, under the personal space, without its text
--     (id, day, times and length), so deleting a page removes its words.
--   * Deleting the account (or its personal space) deletes its pages.
set client_min_messages = warning;

create table if not exists weft.journal_entries (
  id          uuid primary key default gen_random_uuid(),
  space_id    uuid not null default weft_private.personal_space(weft_private.uid()) references weft.spaces (id) on delete cascade,
  author_id   uuid not null default weft_private.uid() references weft.users (id) on delete cascade,
  day         date not null,
  body        text not null check (length(btrim(body)) between 1 and 20000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (author_id, day)
);
create index if not exists journal_entries_space_idx on weft.journal_entries (space_id, day desc);

alter table weft.journal_entries enable row level security;
alter table weft.journal_entries force row level security;
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'weft' and tablename = 'journal_entries' loop
    execute format('drop policy %I on weft.journal_entries', p.policyname);
  end loop;
end $$;
-- Yours, in your own personal space, and you are (still) a member of it within the token's scope.
create policy journal_read on weft.journal_entries for select to weft_user
  using (author_id = weft_private.uid() and space_id = weft_private.personal_space(weft_private.uid())
         and weft_private.is_member(space_id));
create policy journal_write on weft.journal_entries for insert to weft_user
  with check (author_id = weft_private.uid() and space_id = weft_private.personal_space(weft_private.uid())
              and weft_private.can_edit(space_id));
create policy journal_change on weft.journal_entries for update to weft_user
  using (author_id = weft_private.uid() and space_id = weft_private.personal_space(weft_private.uid())
         and weft_private.can_edit(space_id))
  with check (author_id = weft_private.uid() and space_id = weft_private.personal_space(weft_private.uid())
              and weft_private.can_edit(space_id));
create policy journal_delete on weft.journal_entries for delete to weft_user
  using (author_id = weft_private.uid() and space_id = weft_private.personal_space(weft_private.uid())
         and weft_private.can_edit(space_id));

-- day is set when the page is made and never moves; space_id, author_id and the times are never granted.
revoke all on weft.journal_entries from weft_assistant;
grant select on weft.journal_entries to weft_user;
grant insert (day, body), update (body), delete on weft.journal_entries to weft_user;

-- Before a write: tidy the text, keep authorship, space and times, and keep the day sensible (not more than a
-- day ahead, which covers every time zone, and not before 1900). The day check answers only the writer.
create or replace function weft_private.journal_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  new.body := rtrim(ltrim(new.body, E'\r\n'), E' \t\r\n');
  if tg_op = 'INSERT' then
    new.author_id := weft_private.uid();
    new.space_id := weft_private.personal_space(weft_private.uid());
    new.created_at := now(); new.updated_at := now();
    if new.day > current_date + 1 or new.day < date '1900-01-01' then
      raise exception 'a journal page is for a day between 1900 and today' using errcode = '22023';
    end if;
  else
    new.author_id := old.author_id; new.space_id := old.space_id; new.day := old.day;
    new.created_at := old.created_at; new.updated_at := now();
  end if;
  return new;
end $$;
drop trigger if exists journal_guard on weft.journal_entries;
create trigger journal_guard before insert or update on weft.journal_entries
  for each row execute function weft_private.journal_guard();

-- After a change or delete: an audit row under the personal space with no text in it.
create or replace function weft_private.journal_audit() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  insert into weft.audit (table_name, row_id, space_id, op, actor_id, actor_role, old_row)
  values (tg_table_name, old.id, old.space_id, tg_op, weft_private.uid(),
          coalesce(nullif(current_setting('role', true), 'none'), session_user),
          jsonb_build_object('id', old.id, 'space_id', old.space_id, 'author_id', old.author_id, 'day', old.day,
                             'length', length(old.body), 'created_at', old.created_at, 'updated_at', old.updated_at));
  return null;
end $$;

-- Live notices: the shared trigger from 006 (table, operation, id and the personal space).
drop trigger if exists announce_journal_entries on weft.journal_entries;
create trigger announce_journal_entries after insert or update or delete on weft.journal_entries
  for each row execute function weft_private.announce();
drop trigger if exists audit_journal_entries on weft.journal_entries;
create trigger audit_journal_entries after update or delete on weft.journal_entries
  for each row execute function weft_private.journal_audit();

revoke execute on function weft_private.journal_guard(), weft_private.journal_audit() from public, weft_user, weft_assistant;
