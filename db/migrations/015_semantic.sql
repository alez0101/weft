-- 015 semantic search: embeddings for messages, items (documents, wiki pages, whiteboards, tables) and
-- events, searched with pgvector. No new permission rule: an embedding row is visible only if its source
-- row is (the policy asks the source table, under the caller's own row-level security), so spaces and the
-- channel-scope claim carry through. Deleting a source deletes its embeddings.
-- Embeddings are written by the assistant service's worker (role weft_assist) through the functions below.
set client_min_messages = warning;

create table if not exists weft.embeddings (
  source_type text not null check (source_type in ('message', 'item', 'event')),
  source_id   uuid not null,
  chunk       int not null default 0,
  content     text not null,          -- the text that was embedded (protected by the same policy)
  embedding   vector(768) not null,   -- nomic-embed-text
  model       text not null,
  updated_at  timestamptz not null default now(),
  primary key (source_type, source_id, chunk)
);
create index if not exists embeddings_hnsw on weft.embeddings using hnsw (embedding vector_cosine_ops);

-- What was embedded, by content hash, so unchanged sources are skipped.
create table if not exists weft_private.embed_state (
  source_type text not null, source_id uuid not null, hash text not null, model text not null,
  updated_at timestamptz not null default now(), primary key (source_type, source_id)
);

alter table weft.embeddings enable row level security;
alter table weft.embeddings force row level security;
drop policy if exists embeddings_read on weft.embeddings;
create policy embeddings_read on weft.embeddings for select to weft_user, weft_assistant using (
  case source_type
    when 'message' then exists (select 1 from weft.messages m where m.id = source_id)
    when 'item'    then exists (select 1 from weft.items i where i.id = source_id)
    when 'event'   then exists (select 1 from weft.events e where e.id = source_id)
  end);
grant select on weft.embeddings to weft_user, weft_assistant;

-- Nearest neighbours of a query vector, as the caller (security invoker: RLS applies). The filter runs
-- after the index scan, so iterative scanning keeps going until enough visible rows are found.
create or replace function weft.semantic_search(p_query vector, p_limit int default 12)
returns table (source_type text, source_id uuid, chunk int, content text, distance double precision)
language sql stable security invoker set search_path = weft, public, pg_temp set hnsw.iterative_scan = 'relaxed_order' as $$
  select e.source_type, e.source_id, e.chunk, e.content, e.embedding <=> p_query
  from weft.embeddings e
  order by e.embedding <=> p_query
  limit least(greatest(p_limit, 1), 50)
$$;
revoke execute on function weft.semantic_search(vector, int) from public;
grant execute on function weft.semantic_search(vector, int) to weft_user, weft_assistant;

-- ---------- for the worker ----------
-- The text of every source as it should be embedded now, with a hash; only sources whose hash changed.
-- Assistant answers are skipped (retrieval ignores them too).
create or replace function weft_private.embed_pending(p_limit int, p_model text)
returns table (source_type text, source_id uuid, body text, hash text)
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  with src as (
    select 'message'::text t, m.id, m.body b from weft.messages m join weft.users u on u.id = m.author_id where not u.is_assistant
    union all
    select 'item', i.id, i.title || E'\n' || coalesce(i.body_text, '') from weft.items i
    union all
    select 'event', e.id, e.title || coalesce(', at ' || e.location, '') || ', ' || to_char(e.starts_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC'
    from weft.events e
  )
  select s.t, s.id, s.b, md5(s.b) from src s
  left join weft_private.embed_state st on st.source_type = s.t and st.source_id = s.id
  where st.hash is distinct from md5(s.b) or st.model is distinct from p_model
  limit p_limit
$$;

-- Replace a source's embeddings with new chunks: [{"content": "...", "embedding": "[...]"}].
create or replace function weft_private.embed_store(p_type text, p_id uuid, p_hash text, p_model text, p_chunks jsonb)
returns void language plpgsql security definer set search_path = weft, weft_private, public, pg_temp as $$
begin
  delete from weft.embeddings where source_type = p_type and source_id = p_id;
  insert into weft.embeddings (source_type, source_id, chunk, content, embedding, model)
  select p_type, p_id, (c.ord - 1)::int, c.value ->> 'content', (c.value ->> 'embedding')::vector, p_model
  from jsonb_array_elements(p_chunks) with ordinality as c(value, ord);
  insert into weft_private.embed_state (source_type, source_id, hash, model) values (p_type, p_id, p_hash, p_model)
  on conflict (source_type, source_id) do update set hash = excluded.hash, model = excluded.model, updated_at = now();
end $$;

create or replace function weft_private.embed_count() returns table (sources bigint, chunks bigint)
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select (select count(*) from weft_private.embed_state), (select count(*) from weft.embeddings)
$$;

-- A deleted source takes its embeddings with it.
create or replace function weft_private.embed_forget() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare t text := case tg_table_name when 'messages' then 'message' when 'items' then 'item' else 'event' end;
begin
  delete from weft.embeddings where source_type = t and source_id = old.id;
  delete from weft_private.embed_state where source_type = t and source_id = old.id;
  return null;
end $$;
do $$
declare t text;
begin
  foreach t in array array['messages', 'items', 'events'] loop
    execute format('drop trigger if exists embed_forget_%1$s on weft.%1$I', t);
    execute format('create trigger embed_forget_%1$s after delete on weft.%1$I for each row execute function weft_private.embed_forget()', t);
  end loop;
end $$;

revoke execute on function weft_private.embed_pending(int, text), weft_private.embed_store(text, uuid, text, text, jsonb),
  weft_private.embed_count(), weft_private.embed_forget() from public, weft_user, weft_assistant;
grant execute on function weft_private.embed_pending(int, text), weft_private.embed_store(text, uuid, text, text, jsonb),
  weft_private.embed_count() to weft_assist;
