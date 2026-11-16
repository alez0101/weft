-- 072 search knows projects: weft.search (048's, unchanged otherwise) also returns the project a message, item or
-- event is in (project_id, project_name; null for everything else), so a result can say "#festival › Scouting for
-- Food" and open the project's own chat. It still runs as the caller: the project name comes through the projects
-- table's own policy, which is the same space rule.
set client_min_messages = warning;

drop function if exists weft.search(text, int);
create function weft.search(p_q text, p_limit int default 6)
returns table (kind text, id uuid, space_id uuid, space_name text, space_kind text, title text, snippet text, at timestamptz, rank real, ref text, project_id uuid, project_name text)
language sql stable security invoker set search_path = weft, weft_private, public, pg_temp as $$
  with q as (select weft_private.search_query(p_q) as t, least(greatest(p_limit, 1), 20) as n),
  hl as (select 'MaxWords=16, MinWords=6, MaxFragments=1, StartSel=«, StopSel=», FragmentDelimiter= … ' as opt),
  msg as (
    select m.id, m.space_id, m.project_id, m.body, m.created_at, ts_rank(to_tsvector('english', m.body), q.t) as r
    from weft.messages m, q
    where q.t is not null and to_tsvector('english', m.body) @@ q.t
    order by r desc, m.created_at desc limit (select n from q)),
  itm as (
    select i.id, i.space_id, i.project_id, i.kind, i.title, i.body_text, i.updated_at,
           ts_rank(setweight(to_tsvector('english', i.title), 'A') || setweight(to_tsvector('english', coalesce(i.body_text, '')), 'B'), q.t) as r
    from weft.items i, q
    where q.t is not null
      and (setweight(to_tsvector('english', i.title), 'A') || setweight(to_tsvector('english', coalesce(i.body_text, '')), 'B')) @@ q.t
    order by r desc, i.updated_at desc limit (select n from q)),
  evt as (
    select e.id, e.space_id, e.project_id, e.title, e.location, e.starts_at,
           ts_rank(setweight(to_tsvector('english', e.title), 'A') || setweight(to_tsvector('english', coalesce(e.location, '')), 'B'), q.t) as r
    from weft.events e, q
    where q.t is not null
      and (setweight(to_tsvector('english', e.title), 'A') || setweight(to_tsvector('english', coalesce(e.location, '')), 'B')) @@ q.t
    order by r desc, e.starts_at limit (select n from q)),
  -- Nine apps share this branch: each gets its own few best matches, so one busy app cannot crowd out another.
  rec as (
    select * from (
      select x.kind, x.id, x.space_id, x.title, x.body, x.at, x.ref, x.r,
             row_number() over (partition by x.kind order by x.r desc, x.at desc) as k
      from (select x.*, ts_rank(setweight(to_tsvector('english', x.title), 'A') || setweight(to_tsvector('english', coalesce(x.body, '')), 'B'), q.t) as r
            from weft.records x, q
            where q.t is not null
              and (setweight(to_tsvector('english', x.title), 'A') || setweight(to_tsvector('english', coalesce(x.body, '')), 'B')) @@ q.t) x
    ) ranked
    where k <= (select greatest(2, (n + 1) / 2) from q))
  select 'message', m.id, m.space_id, s.name, s.kind, null::text,
         ts_headline('english', left(m.body, 4000), q.t, hl.opt), m.created_at, m.r, null::text, m.project_id, p.name
  from msg m join weft.spaces s on s.id = m.space_id left join weft.projects p on p.id = m.project_id, q, hl
  union all
  select i.kind, i.id, i.space_id, s.name, s.kind, i.title,
         case when coalesce(i.body_text, '') = '' then null
              else ts_headline('english', left(i.body_text, 20000), q.t, hl.opt) end, i.updated_at, i.r, null, i.project_id, p.name
  from itm i join weft.spaces s on s.id = i.space_id left join weft.projects p on p.id = i.project_id, q, hl
  union all
  select 'event', e.id, e.space_id, s.name, s.kind, e.title, e.location, e.starts_at, e.r, null, e.project_id, p.name
  from evt e join weft.spaces s on s.id = e.space_id left join weft.projects p on p.id = e.project_id, q
  union all
  select x.kind, x.id, x.space_id, s.name, s.kind, x.title,
         case when coalesce(x.body, '') = '' then null
              else ts_headline('english', left(x.body, 20000), q.t, hl.opt) end, x.at, x.r, x.ref, null::uuid, null::text
  from rec x left join weft.spaces s on s.id = x.space_id, q, hl
  union all
  select 'channel', s.id, s.id, s.name, s.kind, s.name, null, s.created_at, 1.0, null, null, null
  from weft.spaces s, q
  where s.kind = 'channel' and length(btrim(coalesce(p_q, ''))) >= 1
    and s.name ilike '%' || replace(replace(replace(btrim(p_q), '\', '\\'), '%', '\%'), '_', '\_') || '%'
  limit 60
$$;
revoke execute on function weft.search(text, int) from public;
grant execute on function weft.search(text, int) to weft_user;
