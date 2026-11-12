-- 002 schema
-- `weft` is the only schema PostgREST exposes. `weft_private` holds helpers it must not expose.
create extension if not exists vector;
create extension if not exists pgcrypto;

create schema if not exists weft;
create schema if not exists weft_private;

-- ---------- identity from the request token ----------
-- PostgREST puts the verified token's claims in request.jwt.claims for each request.
create or replace function weft_private.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::json ->> 'sub', '')::uuid
$$;

-- Optional claim that narrows a token to one space (used for @Weft inside a channel).
create or replace function weft_private.scope_space() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::json ->> 'scope_space', '')::uuid
$$;

-- The assistant's own user row, so its messages have an author.
create or replace function weft_private.assistant_id() returns uuid
language sql immutable as $$ select '00000000-0000-4000-8000-00000000a001'::uuid $$;

-- ---------- tables ----------
create table if not exists weft.users (
  id           uuid primary key default gen_random_uuid(),
  email        text not null unique,
  display_name text not null,
  is_assistant boolean not null default false
);

create table if not exists weft.spaces (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('channel', 'dm', 'personal')),
  name       text not null,
  created_by uuid not null default weft_private.uid() references weft.users (id),
  created_at timestamptz not null default now()
);

create table if not exists weft.members (
  space_id uuid not null references weft.spaces (id) on delete cascade,
  user_id  uuid not null references weft.users (id) on delete cascade,
  role     text not null check (role in ('owner', 'editor', 'viewer')),
  added_at timestamptz not null default now(),
  primary key (space_id, user_id)
);
create index if not exists members_user_idx on weft.members (user_id);

create table if not exists weft.messages (
  id             uuid primary key default gen_random_uuid(),
  space_id       uuid not null references weft.spaces (id) on delete cascade,
  author_id      uuid not null default weft_private.uid() references weft.users (id),
  body           text not null check (length(body) between 1 and 20000),
  thread_root_id uuid references weft.messages (id) on delete cascade,
  created_at     timestamptz not null default now(),
  edited_at      timestamptz
);
create index if not exists messages_space_idx on weft.messages (space_id, created_at);

create table if not exists weft.items (
  id         uuid primary key default gen_random_uuid(),
  space_id   uuid not null references weft.spaces (id) on delete cascade,
  kind       text not null check (kind in ('document', 'wiki')),
  title      text not null,
  parent_id  uuid references weft.items (id) on delete set null, -- wiki page tree
  ydoc       bytea,  -- Yjs document state (Phase 4)
  body_text  text,   -- plain text extracted on save, for search and the assistant
  created_by uuid not null default weft_private.uid() references weft.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists items_space_idx on weft.items (space_id);

create table if not exists weft.events (
  id         uuid primary key default gen_random_uuid(),
  space_id   uuid not null references weft.spaces (id) on delete cascade,
  title      text not null,
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  location   text,
  item_id    uuid references weft.items (id) on delete set null,
  created_by uuid not null default weft_private.uid() references weft.users (id),
  check (ends_at >= starts_at)
);
create index if not exists events_space_idx on weft.events (space_id, starts_at);

-- Old values of every change. Holds restricted content, so it carries the space the row
-- belonged to at the time and is readable only by that space's members (004).
-- The space is copied, not joined: a deleted row has nothing left to join to.
create table if not exists weft.audit (
  id         bigint generated always as identity primary key,
  table_name text not null,
  row_id     uuid not null,
  space_id   uuid not null,
  op         text not null check (op in ('UPDATE', 'DELETE')),
  actor_id   uuid,
  actor_role text not null,
  old_row    jsonb not null,
  at         timestamptz not null default now()
);
create index if not exists audit_space_idx on weft.audit (space_id, at);
