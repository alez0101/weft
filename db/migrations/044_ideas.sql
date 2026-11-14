-- 044 ideas: a place to suggest ideas, vote on them and track their status (new, planned, done,
-- declined); Weft can answer from them.
-- An ideas board is an item (kind 'ideaboard'), so it lives in a space and gets everything items have: the
-- one permission rule, moving, deleting, sharing links, the audit log, search and the assistant (through
-- the board's text summary in body_text). Its title is the board's name. Ideas reach the space through
-- their board, votes through their idea: members read all of it, viewers included; editors and owners
-- suggest ideas; you reword only your own idea, and editors and owners can delete any (tidying up). Only
-- owners of the space set the status. Every member votes, viewers included (like poll votes: taking part,
-- not editing), once per idea, only for themselves, and only while the idea is new or planned (votes on
-- a done or declined idea are kept, not removed). Authors and voters are set here, never by the client;
-- nothing jumps between boards or ideas (move the board).
set client_min_messages = warning;

alter table weft.items drop constraint if exists items_kind_check;
alter table weft.items add constraint items_kind_check check (kind in ('document', 'wiki', 'whiteboard', 'table', 'file', 'tasklist', 'poll', 'form', 'linklist', 'meeting', 'addressbook', 'decisionlog', 'qa', 'checklist', 'expenselist', 'inventory', 'goalset', 'retro', 'glossary', 'ideaboard'));

create table if not exists weft.ideas (
  id          uuid primary key default gen_random_uuid(),
  board_id    uuid not null references weft.items (id) on delete cascade,
  title       text not null check (length(btrim(title)) between 1 and 200 and title !~ '[\n\r]'),
  details     text not null default '' check (length(details) <= 4000),
  status      text not null default 'new' check (status in ('new', 'planned', 'done', 'declined')),
  created_by  uuid not null default weft_private.uid() references weft.users (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists ideas_board_idx on weft.ideas (board_id, created_at desc);

create table if not exists weft.idea_votes (
  idea_id     uuid not null references weft.ideas (id) on delete cascade,
  voter_id    uuid not null default weft_private.uid() references weft.users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (idea_id, voter_id)
);
create index if not exists idea_votes_voter_idx on weft.idea_votes (voter_id);

-- The space of a board and of an idea (null if there is none). security definer: used inside policies;
-- each returns only a space id.
create or replace function weft_private.ideas_space(p_board uuid) returns uuid
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select space_id from weft.items where id = p_board and kind = 'ideaboard'
$$;
create or replace function weft_private.idea_space(p_idea uuid) returns uuid
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select i.space_id from weft.ideas d join weft.items i on i.id = d.board_id and i.kind = 'ideaboard' where d.id = p_idea
$$;

do $$
declare t text; p record;
begin
  foreach t in array array['ideas', 'idea_votes'] loop
    execute format('alter table weft.%I enable row level security', t);
    execute format('alter table weft.%I force row level security', t);
    for p in select policyname from pg_policies where schemaname = 'weft' and tablename = t loop
      execute format('drop policy %I on weft.%I', p.policyname, t);
    end loop;
  end loop;
end $$;

create policy ideas_read on weft.ideas for select to weft_user, weft_assistant
  using (weft_private.is_member(weft_private.ideas_space(board_id)));
create policy ideas_suggest on weft.ideas for insert to weft_user
  with check (created_by = weft_private.uid() and weft_private.can_edit(weft_private.ideas_space(board_id)));
-- Who may change which column (your own text; the status: owners) is checked by the guard.
create policy ideas_change on weft.ideas for update to weft_user
  using (weft_private.can_edit(weft_private.ideas_space(board_id)))
  with check (weft_private.can_edit(weft_private.ideas_space(board_id)));
create policy ideas_delete on weft.ideas for delete to weft_user
  using (weft_private.can_edit(weft_private.ideas_space(board_id)));

create policy idea_votes_read on weft.idea_votes for select to weft_user, weft_assistant
  using (weft_private.is_member(weft_private.idea_space(idea_id)));
create policy idea_votes_cast on weft.idea_votes for insert to weft_user
  with check (voter_id = weft_private.uid() and weft_private.is_member(weft_private.idea_space(idea_id)));
create policy idea_votes_withdraw on weft.idea_votes for delete to weft_user
  using (voter_id = weft_private.uid() and weft_private.is_member(weft_private.idea_space(idea_id)));

-- board_id and idea_id are never updatable; created_by, voter_id and the times are never granted. A vote
-- is never updated, only cast or withdrawn.
grant select on weft.ideas, weft.idea_votes to weft_user, weft_assistant;
grant insert (board_id, title, details), update (title, details, status), delete on weft.ideas to weft_user;
grant insert (idea_id), delete on weft.idea_votes to weft_user;
revoke execute on function weft_private.ideas_space(uuid), weft_private.idea_space(uuid) from public;
grant execute on function weft_private.ideas_space(uuid), weft_private.idea_space(uuid) to weft_user, weft_assistant;

-- Before a write: trim the text, keep authorship and times, and check who changes what. Row-level
-- security has already limited an update to rows the caller may edit, so those answers are only ever
-- given to editors of the space; a vote's answer is given only to members.
create or replace function weft_private.ideas_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  if tg_table_name = 'idea_votes' then
    if not weft_private.is_member(weft_private.idea_space(new.idea_id)) then return new; end if;   -- row-level security refuses
    if exists (select 1 from weft.ideas d where d.id = new.idea_id and d.status in ('done', 'declined')) then
      raise exception 'voting is closed: this idea is already done or declined' using errcode = '42501';
    end if;
    new.created_at := now();
    return new;
  end if;
  new.title := regexp_replace(btrim(new.title), '\s+', ' ', 'g');
  new.details := btrim(coalesce(new.details, ''), E' \t\r\n');
  if tg_op = 'INSERT' then
    new.created_at := now(); new.updated_at := now(); new.status := 'new';
    return new;
  end if;
  new.created_at := old.created_at; new.created_by := old.created_by; new.updated_at := now();
  if pg_trigger_depth() > 1 then return new; end if;
  if (new.title is distinct from old.title or new.details is distinct from old.details) and old.created_by is distinct from weft_private.uid() then
    raise exception 'only the person who suggested it can change the idea' using errcode = '42501';
  end if;
  if new.status is distinct from old.status and not weft_private.is_owner(weft_private.ideas_space(old.board_id)) then
    raise exception 'only an owner of the space can change the status of an idea' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists ideas_guard on weft.ideas;
create trigger ideas_guard before insert or update on weft.ideas for each row execute function weft_private.ideas_guard();
drop trigger if exists idea_votes_guard on weft.idea_votes;
create trigger idea_votes_guard before insert on weft.idea_votes for each row execute function weft_private.ideas_guard();

-- The board's text summary, what search and the assistant read: up to 300 ideas, open ones first (planned,
-- then new), then done, then declined, each by votes; with the status, votes, who suggested it and the
-- details (shortened to 800 characters).
create or replace function weft_private.refresh_ideas_text(p_board uuid) returns void
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare t text; n int;
begin
  select count(*) into n from weft.ideas where board_id = p_board;
  select concat_ws(E'\n', 'Ideas, ' || n || case when n = 1 then ' idea' else ' ideas' end,
                   string_agg(line, E'\n' order by rank, votes desc, created_at desc)) into t from (
    select array_position(array['planned', 'new', 'done', 'declined'], d.status) as rank, d.created_at, v.votes,
           'Idea: ' || d.title || ' (' || d.status || ', ' || v.votes || case when v.votes = 1 then ' vote' else ' votes' end
           || ', suggested by ' || coalesce(u.display_name, 'someone') || ')'
           || case when d.details <> '' then E'\n  ' || left(regexp_replace(d.details, '\s*\n\s*', ' ', 'g'), 800) else '' end as line
      from weft.ideas d
      left join weft.users u on u.id = d.created_by
      cross join lateral (select count(*) as votes from weft.idea_votes x where x.idea_id = d.id) v
     where d.board_id = p_board
     order by 1, 3 desc, 2 desc limit 300
  ) x;
  update weft.items set body_text = t where id = p_board and body_text is distinct from t;
end $$;

-- After a change: refresh the summary, announce it (to members only, through the notification server;
-- ids only), and keep the old row in the audit log under the board's space.
create or replace function weft_private.ideas_changed() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare r record; v_board uuid; v_space uuid; v_id uuid;
begin
  r := coalesce(new, old);
  if tg_table_name = 'ideas' then v_board := r.board_id; v_id := r.id;
  else select board_id into v_board from weft.ideas where id = r.idea_id;
       v_id := r.idea_id;   -- a vote has no id of its own: its notice and audit row use the idea
  end if;
  v_space := weft_private.ideas_space(v_board);
  if v_space is null then return null; end if;   -- the board or idea is being deleted with its parent
  perform weft_private.refresh_ideas_text(v_board);
  perform pg_notify('weft_events', json_build_object('t', 'ideas', 'op', tg_op, 'id', v_id, 'space', v_space, 'board', v_board)::text);
  if tg_op in ('UPDATE', 'DELETE') then
    insert into weft.audit (table_name, row_id, space_id, op, actor_id, actor_role, old_row)
    values (tg_table_name, v_id, v_space, tg_op, weft_private.uid(),
            coalesce(nullif(current_setting('role', true), 'none'), session_user), to_jsonb(old));
  end if;
  return null;
end $$;
do $$
declare t text;
begin
  foreach t in array array['ideas', 'idea_votes'] loop
    execute format('drop trigger if exists %1$s_changed on weft.%1$I', t);
    execute format('create trigger %1$s_changed after insert or update or delete on weft.%1$I
                    for each row execute function weft_private.ideas_changed()', t);
  end loop;
end $$;

revoke execute on function weft_private.ideas_guard(), weft_private.refresh_ideas_text(uuid), weft_private.ideas_changed()
  from public, weft_user, weft_assistant;
grant execute on function weft_private.refresh_ideas_text(uuid) to weft_owner;
