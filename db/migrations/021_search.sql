-- 021 search: one function behind the search box. It runs as the caller (security invoker), so it finds
-- only what row-level security lets them see, and the channel-scope claim applies like everywhere else.
-- Words match as you type (prefix match on every word), titles rank above body text, and each result
-- carries a short snippet with the matches between « and » (the app turns those into highlights; the text
-- itself is never treated as HTML).
set client_min_messages = warning;

create index if not exists messages_fts on weft.messages using gin (to_tsvector('english', body));
create index if not exists items_fts on weft.items using gin (
  (setweight(to_tsvector('english', title), 'A') || setweight(to_tsvector('english', coalesce(body_text, '')), 'B')));
create index if not exists events_fts on weft.events using gin (
  (setweight(to_tsvector('english', title), 'A') || setweight(to_tsvector('english', coalesce(location, '')), 'B')));

-- The query, built from letters and digits only (so nothing the person types can change its meaning).
create or replace function weft_private.search_query(p_q text) returns tsquery
language sql immutable set search_path = pg_catalog as $$
  select case when count(*) = 0 then null
              else to_tsquery('english', string_agg(w || ':*', ' & ')) end
  from (select w from regexp_split_to_table(lower(left(coalesce(p_q, ''), 200)), '[^[:alnum:]]+') w
        where w <> '' limit 8) words
$$;

create or replace function weft.search(p_q text, p_limit int default 6)
returns table (kind text, id uuid, space_id uuid, space_name text, space_kind text, title text, snippet text, at timestamptz, rank real)
language sql stable security invoker set search_path = weft, weft_private, public, pg_temp as $$
  with q as (select weft_private.search_query(p_q) as t, least(greatest(p_limit, 1), 20) as n),
  hl as (select 'MaxWords=16, MinWords=6, MaxFragments=1, StartSel=«, StopSel=», FragmentDelimiter= … ' as opt),
  msg as (
    select m.id, m.space_id, m.body, m.created_at, ts_rank(to_tsvector('english', m.body), q.t) as r
    from weft.messages m, q
    where q.t is not null and to_tsvector('english', m.body) @@ q.t
    order by r desc, m.created_at desc limit (select n from q)),
  itm as (
    select i.id, i.space_id, i.kind, i.title, i.body_text, i.updated_at,
           ts_rank(setweight(to_tsvector('english', i.title), 'A') || setweight(to_tsvector('english', coalesce(i.body_text, '')), 'B'), q.t) as r
    from weft.items i, q
    where q.t is not null
      and (setweight(to_tsvector('english', i.title), 'A') || setweight(to_tsvector('english', coalesce(i.body_text, '')), 'B')) @@ q.t
    order by r desc, i.updated_at desc limit (select n from q)),
  evt as (
    select e.id, e.space_id, e.title, e.location, e.starts_at,
           ts_rank(setweight(to_tsvector('english', e.title), 'A') || setweight(to_tsvector('english', coalesce(e.location, '')), 'B'), q.t) as r
    from weft.events e, q
    where q.t is not null
      and (setweight(to_tsvector('english', e.title), 'A') || setweight(to_tsvector('english', coalesce(e.location, '')), 'B')) @@ q.t
    order by r desc, e.starts_at limit (select n from q))
  select 'message', m.id, m.space_id, s.name, s.kind, null::text,
         ts_headline('english', left(m.body, 4000), q.t, hl.opt), m.created_at, m.r
  from msg m join weft.spaces s on s.id = m.space_id, q, hl
  union all
  select i.kind, i.id, i.space_id, s.name, s.kind, i.title,
         case when coalesce(i.body_text, '') = '' then null
              else ts_headline('english', left(i.body_text, 20000), q.t, hl.opt) end, i.updated_at, i.r
  from itm i join weft.spaces s on s.id = i.space_id, q, hl
  union all
  select 'event', e.id, e.space_id, s.name, s.kind, e.title, e.location, e.starts_at, e.r
  from evt e join weft.spaces s on s.id = e.space_id, q
  union all
  select 'channel', s.id, s.id, s.name, s.kind, s.name, null, s.created_at, 1.0
  from weft.spaces s, q
  where s.kind = 'channel' and length(btrim(coalesce(p_q, ''))) >= 1
    and s.name ilike '%' || replace(replace(replace(btrim(p_q), '\', '\\'), '%', '\%'), '_', '\_') || '%'
  limit 60
$$;

revoke execute on function weft.search(text, int) from public;
grant execute on function weft.search(text, int) to weft_user;
grant execute on function weft_private.search_query(text) to weft_user;
