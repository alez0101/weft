-- 019 files and Home widgets.
--
-- Files: a file is an item (kind 'file'), so it lives in a space and gets everything items have: the
-- one permission rule, moving, deleting, sharing links, the audit log, keyword search, meaning search
-- and the assistant, all through its extracted text in body_text. The bytes live in weft.file_blobs,
-- reachable only through their item (same rule). Uploads and downloads go through the files service,
-- which acts as the person (role weft_user with their claims), so row-level security decides.
--
-- Widgets: each person's Home layout (which widgets, in what order) in weft.user_prefs, readable and
-- writable only by that person. The widgets themselves read existing data through the API.
set client_min_messages = warning;

alter table weft.items drop constraint if exists items_kind_check;
alter table weft.items add constraint items_kind_check check (kind in ('document', 'wiki', 'whiteboard', 'table', 'file'));

create table if not exists weft.file_blobs (
  item_id    uuid primary key references weft.items (id) on delete cascade,
  bytes      bytea not null,
  mime       text not null,
  size       bigint not null check (size >= 0),
  sha256     text not null,
  text_note  text,                 -- why no text was extracted, if none was (shown in the app)
  created_at timestamptz not null default now()
);

-- The space of a file item (null if the item is not a file). security definer: used inside policies.
create or replace function weft_private.file_space(p_item uuid) returns uuid
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select space_id from weft.items where id = p_item and kind = 'file'
$$;

alter table weft.file_blobs enable row level security;
alter table weft.file_blobs force row level security;
drop policy if exists file_blobs_read on weft.file_blobs;
drop policy if exists file_blobs_insert on weft.file_blobs;
create policy file_blobs_read on weft.file_blobs for select to weft_user
  using (weft_private.is_member(weft_private.file_space(item_id)));
create policy file_blobs_insert on weft.file_blobs for insert to weft_user
  with check (weft_private.can_edit(weft_private.file_space(item_id))
              and exists (select 1 from weft.items i where i.id = file_blobs.item_id and i.created_by = weft_private.uid()));
-- No update: a file's bytes never change (upload a new file instead). Deleting the item deletes them.
grant select, insert on weft.file_blobs to weft_user;
grant execute on function weft_private.file_space(uuid) to weft_user, weft_assistant;

-- What the app lists about a file, without the bytes (the assistant reads the text through items).
create or replace view weft.file_info with (security_invoker = true) as
  select b.item_id, b.mime, b.size, b.text_note, b.created_at from weft.file_blobs b;
grant select on weft.file_info to weft_user;

-- The files service's login: it can only become weft_user (like the collab server).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'weft_files') then
    create role weft_files login noinherit;
  end if;
end $$;
alter role weft_files password :'files_svc_pw';
grant weft_user to weft_files;
grant usage on schema weft, weft_private to weft_files;

-- ---------- Home widgets ----------
create table if not exists weft.user_prefs (
  user_id    uuid primary key default weft_private.uid() references weft.users (id) on delete cascade,
  home       jsonb not null default '{}'::jsonb,   -- {"widgets": ["upcoming", "unread", ...]}
  updated_at timestamptz not null default now()
);
alter table weft.user_prefs enable row level security;
alter table weft.user_prefs force row level security;
drop policy if exists user_prefs_own on weft.user_prefs;
create policy user_prefs_own on weft.user_prefs for all to weft_user
  using (user_id = weft_private.uid() and weft_private.scope_space() is null)
  with check (user_id = weft_private.uid() and weft_private.scope_space() is null);
grant select, insert (home), update (home) on weft.user_prefs to weft_user;
drop trigger if exists user_prefs_touch on weft.user_prefs;
create trigger user_prefs_touch before update on weft.user_prefs for each row execute function weft_private.touch_updated_at();
