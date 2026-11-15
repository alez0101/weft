-- 068 spreadsheets. A spreadsheet is an item (kind 'spreadsheet') whose .xlsx bytes live in
-- weft.file_blobs, like a file's. Unlike a file, its bytes change: the spreadsheet engine saves edits back
-- through the files service, which acts as the person who edited, so only people who can edit the space
-- can change them. Its text (every cell, by sheet) goes into body_text for search and the assistant.
set client_min_messages = warning;

alter table weft.items drop constraint if exists items_kind_check;
alter table weft.items add constraint items_kind_check check (kind in ('document', 'wiki', 'whiteboard', 'table', 'file', 'tasklist', 'poll', 'form', 'linklist', 'meeting', 'addressbook', 'decisionlog', 'qa', 'checklist', 'expenselist', 'inventory', 'goalset', 'retro', 'glossary', 'ideaboard', 'spreadsheet'));

-- The space of an item whose bytes are in file_blobs (files and spreadsheets).
create or replace function weft_private.file_space(p_item uuid) returns uuid
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select space_id from weft.items where id = p_item and kind in ('file', 'spreadsheet')
$$;

alter table weft.file_blobs add column if not exists updated_at timestamptz not null default now();
-- Which editing session a spreadsheet is in: the engine keys its sessions on this, so it changes only when a
-- session ends with a final save (not on the periodic saves made while people are still editing).
alter table weft.file_blobs add column if not exists version integer not null default 1;

drop policy if exists file_blobs_update on weft.file_blobs;
create policy file_blobs_update on weft.file_blobs for update to weft_user
  using (weft_private.can_edit(weft_private.file_space(item_id))
         and exists (select 1 from weft.items i where i.id = file_blobs.item_id and i.kind = 'spreadsheet'))
  with check (weft_private.can_edit(weft_private.file_space(item_id)));
grant update (bytes, size, sha256, text_note, updated_at, version) on weft.file_blobs to weft_user;
