-- 048 index the rest: announcements, RSVPs, bookings, shifts, time off, kudos, milestones, journal pages and
-- profiles become findable by the search box, meaning search and the assistant, like items.
--   * Nothing is copied. weft.records is a view (security_invoker) that turns each app's rows into one shape
--     (kind, id, space, title, text, time, ref). It runs as the caller, so it shows exactly what that app's own
--     row-level security shows: the channel-scope claim, disabled accounts, Journal only for its writer,
--     profiles only for people who share a space with their owner. No new rule to get wrong.
--   * One record per announcement, kudos, milestone, time-off entry, shift (with who signed up), thing to book
--     (with its bookings from the last 30 days on), event that has answers (going, maybe, not going), journal
--     page and profile.
--   * weft.search gains a branch over the view (and a `ref` column, the journal day, so the app can open it).
--   * Embeddings: the new kinds are allowed, the read policy asks the view (an embedding is readable only
--     while its record is, by the same people), the worker embeds them, and deleting a row deletes its
--     embeddings (so deleting a journal page still removes its words).
--   * The assistant role reads journal pages for their writer only with an unscoped token, i.e. only in the
--     writer's own Weft conversation: never in a channel, a direct message or a personal space, where
--     others could read the answer. It still cannot write or delete any of it.
set client_min_messages = warning;

-- ---------------------------------------------------------------- the view
create or replace view weft.records with (security_invoker = true) as
  select 'announcement'::text as kind, a.id, a.space_id, a.title,
         concat_ws(E'\n', nullif(a.body, ''), 'Shown until ' || to_char(a.expires_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC.') as body,
         a.updated_at as at, null::text as ref
  from weft.announcements a
  union all
  select 'rsvps', e.id, e.space_id, 'Answers to ' || e.title,
         concat_ws(E'\n', 'Event on ' || to_char(e.starts_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC.',
           'Going: ' || string_agg(coalesce(u.display_name, 'someone'), ', ' order by u.display_name) filter (where r.answer = 'going'),
           'Maybe: ' || string_agg(coalesce(u.display_name, 'someone'), ', ' order by u.display_name) filter (where r.answer = 'maybe'),
           'Not going: ' || string_agg(coalesce(u.display_name, 'someone'), ', ' order by u.display_name) filter (where r.answer = 'no')),
         max(r.updated_at), null
  from weft.events e join weft.rsvps r on r.event_id = e.id left join weft.users u on u.id = r.user_id
  group by e.id, e.space_id, e.title, e.starts_at
  union all
  select 'resource', t.id, t.space_id, t.name,
         concat_ws(E'\n', nullif(t.note, ''),
           (select 'Bookings: ' || string_agg(to_char(b.starts_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' to '
                     || to_char(b.ends_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC, ' || coalesce(u.display_name, 'someone')
                     || coalesce(' (' || nullif(b.note, '') || ')', ''), '; ' order by b.starts_at)
            from (select * from weft.bookings b0 where b0.resource_id = t.id and b0.ends_at > now() - interval '30 days'
                  order by b0.starts_at limit 40) b
            left join weft.users u on u.id = b.booked_by)),
         t.created_at, null
  from weft.resources t
  union all
  select 'shift', s.id, s.space_id, s.title,
         concat_ws(E'\n', 'Shift from ' || to_char(s.starts_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' to '
                     || to_char(s.ends_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC, ' || s.places || ' places.',
           nullif(s.note, ''),
           coalesce((select 'Signed up (' || count(*) || ' of ' || s.places || '): ' || string_agg(coalesce(u.display_name, 'someone'), ', ' order by u.display_name)
                     from weft.shift_signups x left join weft.users u on u.id = x.user_id
                     where x.shift_id = s.id having count(*) > 0), 'Nobody has signed up yet.')),
         s.created_at, null
  from weft.shifts s
  union all
  select 'timeoff', t.id, t.space_id, coalesce(u.display_name, 'Someone') || ' away',
         concat_ws(E'\n', 'Away from ' || t.starts_on || ' to ' || t.ends_on || ' (both days included).', nullif(t.note, '')),
         t.created_at, null
  from weft.time_off t left join weft.users u on u.id = t.user_id
  union all
  select 'kudos', k.id, k.space_id, 'Kudos for ' || coalesce(tu.display_name, 'someone'),
         k.message || E'\nFrom ' || coalesce(fu.display_name, 'someone') || '.',
         k.updated_at, null
  from weft.kudos k left join weft.users tu on tu.id = k.to_user left join weft.users fu on fu.id = k.created_by
  union all
  select 'milestone', m.id, m.space_id, m.title,
         concat_ws(E'\n', 'Milestone on ' || m.day || '.', nullif(m.note, '')),
         m.updated_at, null
  from weft.milestones m
  union all
  select 'journal', j.id, j.space_id, 'Journal page for ' || j.day, j.body, j.updated_at, j.day::text
  from weft.journal_entries j
  union all
  select 'profile', p.user_id, null::uuid, coalesce(u.display_name, 'Someone'),
         concat_ws(E'\n', 'Role: ' || nullif(p.role, ''), 'Skills: ' || nullif(array_to_string(p.skills, ', '), ''),
           'How to reach: ' || nullif(p.reach, ''), 'Available: ' || nullif(p.availability, '')),
         p.updated_at, null
  from weft.profiles p left join weft.users u on u.id = p.user_id;

revoke all on weft.records from public;
grant select on weft.records to weft_user, weft_assistant;

-- ---------------------------------------------------------------- journal pages for the assistant
-- Only for their writer, and only with an unscoped token (the writer's own Weft conversation).
drop policy if exists journal_read_assistant on weft.journal_entries;
create policy journal_read_assistant on weft.journal_entries for select to weft_assistant
  using (author_id = weft_private.uid() and weft_private.scope_space() is null
         and space_id = weft_private.personal_space(weft_private.uid())
         and weft_private.is_member(space_id));
grant select on weft.journal_entries to weft_assistant;

-- ---------------------------------------------------------------- search
drop function if exists weft.search(text, int);
create function weft.search(p_q text, p_limit int default 6)
returns table (kind text, id uuid, space_id uuid, space_name text, space_kind text, title text, snippet text, at timestamptz, rank real, ref text)
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
         ts_headline('english', left(m.body, 4000), q.t, hl.opt), m.created_at, m.r, null::text
  from msg m join weft.spaces s on s.id = m.space_id, q, hl
  union all
  select i.kind, i.id, i.space_id, s.name, s.kind, i.title,
         case when coalesce(i.body_text, '') = '' then null
              else ts_headline('english', left(i.body_text, 20000), q.t, hl.opt) end, i.updated_at, i.r, null
  from itm i join weft.spaces s on s.id = i.space_id, q, hl
  union all
  select 'event', e.id, e.space_id, s.name, s.kind, e.title, e.location, e.starts_at, e.r, null
  from evt e join weft.spaces s on s.id = e.space_id, q
  union all
  select x.kind, x.id, x.space_id, s.name, s.kind, x.title,
         case when coalesce(x.body, '') = '' then null
              else ts_headline('english', left(x.body, 20000), q.t, hl.opt) end, x.at, x.r, x.ref
  from rec x left join weft.spaces s on s.id = x.space_id, q, hl
  union all
  select 'channel', s.id, s.id, s.name, s.kind, s.name, null, s.created_at, 1.0, null
  from weft.spaces s, q
  where s.kind = 'channel' and length(btrim(coalesce(p_q, ''))) >= 1
    and s.name ilike '%' || replace(replace(replace(btrim(p_q), '\', '\\'), '%', '\%'), '_', '\_') || '%'
  limit 60
$$;
revoke execute on function weft.search(text, int) from public;
grant execute on function weft.search(text, int) to weft_user;

-- ---------------------------------------------------------------- embeddings
alter table weft.embeddings drop constraint if exists embeddings_source_type_check;
alter table weft.embeddings add constraint embeddings_source_type_check check (source_type in
  ('message', 'item', 'event', 'announcement', 'rsvps', 'resource', 'shift', 'timeoff', 'kudos', 'milestone', 'journal', 'profile'));

drop policy if exists embeddings_read on weft.embeddings;
create policy embeddings_read on weft.embeddings for select to weft_user, weft_assistant using (
  case source_type
    when 'message' then exists (select 1 from weft.messages m where m.id = source_id)
    when 'item'    then exists (select 1 from weft.items i where i.id = source_id)
    when 'event'   then exists (select 1 from weft.events e where e.id = source_id)
    else exists (select 1 from weft.records r where r.kind = source_type and r.id = source_id)
  end);

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
    union all
    select r.kind, r.id, r.title || E'\n' || coalesce(r.body, '') from weft.records r
  )
  select s.t, s.id, s.b, md5(s.b) from src s
  left join weft_private.embed_state st on st.source_type = s.t and st.source_id = s.id
  where st.hash is distinct from md5(s.b) or st.model is distinct from p_model
  limit p_limit
$$;

-- A deleted row takes its record's embeddings with it (argument 0: the record kind, 1: the key column).
create or replace function weft_private.record_forget() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare k uuid := (to_jsonb(old) ->> tg_argv[1])::uuid;
begin
  delete from weft.embeddings where source_type = tg_argv[0] and source_id = k;
  delete from weft_private.embed_state where source_type = tg_argv[0] and source_id = k;
  return null;
end $$;
do $$
declare r record;
begin
  for r in select * from (values ('announcements', 'announcement', 'id'), ('events', 'rsvps', 'id'), ('resources', 'resource', 'id'),
                                 ('shifts', 'shift', 'id'), ('time_off', 'timeoff', 'id'), ('kudos', 'kudos', 'id'),
                                 ('milestones', 'milestone', 'id'), ('journal_entries', 'journal', 'id'), ('profiles', 'profile', 'user_id')) v(tbl, kind, col) loop
    execute format('drop trigger if exists record_forget_%1$s on weft.%1$I', r.tbl);
    execute format('create trigger record_forget_%1$s after delete on weft.%1$I for each row execute function weft_private.record_forget(%2$L, %3$L)',
                   r.tbl, r.kind, r.col);
  end loop;
end $$;

revoke execute on function weft_private.embed_pending(int, text), weft_private.record_forget() from public, weft_user, weft_assistant;
grant execute on function weft_private.embed_pending(int, text) to weft_assist;
