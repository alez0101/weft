-- 036 Q and A: questions and answers for a space, with upvotes and an accepted answer; Weft can answer
-- from them.
-- A Q and A board is an item (kind 'qa'), so it lives in a space and gets everything items have: the one
-- permission rule, moving, deleting, sharing links, the audit log, search and the assistant (through the
-- board's text summary in body_text). Its title is the board's name. Questions reach the space through
-- their board, answers through their question, upvotes through their answer: members read all of it,
-- viewers included; editors and owners ask and answer; you change only your own question or answer, and
-- editors and owners can delete any (tidying up). Every member upvotes, viewers included (like poll
-- votes: taking part, not editing), only for themselves and never their own answer. The accepted answer
-- is chosen by the person who asked or an owner of the space, and must answer that question. Authors and
-- voters are set here, never by the client; nothing jumps between boards or questions (move the board).
set client_min_messages = warning;

alter table weft.items drop constraint if exists items_kind_check;
alter table weft.items add constraint items_kind_check check (kind in ('document', 'wiki', 'whiteboard', 'table', 'file', 'tasklist', 'poll', 'form', 'linklist', 'meeting', 'addressbook', 'decisionlog', 'qa'));

create table if not exists weft.questions (
  id           uuid primary key default gen_random_uuid(),
  board_id     uuid not null references weft.items (id) on delete cascade,
  title        text not null check (length(btrim(title)) between 1 and 200),
  details      text not null default '' check (length(details) <= 4000),
  accepted_id  uuid,
  created_by   uuid not null default weft_private.uid() references weft.users (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists questions_board_idx on weft.questions (board_id, created_at desc);

create table if not exists weft.answers (
  id           uuid primary key default gen_random_uuid(),
  question_id  uuid not null references weft.questions (id) on delete cascade,
  body         text not null check (length(btrim(body)) between 1 and 8000),
  created_by   uuid not null default weft_private.uid() references weft.users (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint answers_question_id_key unique (question_id, id)
);
create index if not exists answers_question_idx on weft.answers (question_id, created_at);

-- The accepted answer must be an answer to the same question; deleting it clears the mark.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'questions_accepted_fkey') then
    alter table weft.questions add constraint questions_accepted_fkey foreign key (id, accepted_id)
      references weft.answers (question_id, id) on delete set null (accepted_id);
  end if;
end $$;

create table if not exists weft.answer_votes (
  answer_id   uuid not null references weft.answers (id) on delete cascade,
  voter_id    uuid not null default weft_private.uid() references weft.users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (answer_id, voter_id)
);
create index if not exists answer_votes_voter_idx on weft.answer_votes (voter_id);

-- The space of a board, a question and an answer (null if there is none). security definer: used inside
-- policies; each returns only a space id.
create or replace function weft_private.qa_space(p_board uuid) returns uuid
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select space_id from weft.items where id = p_board and kind = 'qa'
$$;
create or replace function weft_private.qa_question_space(p_question uuid) returns uuid
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select i.space_id from weft.questions q join weft.items i on i.id = q.board_id and i.kind = 'qa' where q.id = p_question
$$;
create or replace function weft_private.qa_answer_space(p_answer uuid) returns uuid
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select i.space_id from weft.answers a join weft.questions q on q.id = a.question_id
    join weft.items i on i.id = q.board_id and i.kind = 'qa' where a.id = p_answer
$$;

do $$
declare t text; p record;
begin
  foreach t in array array['questions', 'answers', 'answer_votes'] loop
    execute format('alter table weft.%I enable row level security', t);
    execute format('alter table weft.%I force row level security', t);
    for p in select policyname from pg_policies where schemaname = 'weft' and tablename = t loop
      execute format('drop policy %I on weft.%I', p.policyname, t);
    end loop;
  end loop;
end $$;

create policy questions_read on weft.questions for select to weft_user, weft_assistant
  using (weft_private.is_member(weft_private.qa_space(board_id)));
create policy questions_ask on weft.questions for insert to weft_user
  with check (created_by = weft_private.uid() and weft_private.can_edit(weft_private.qa_space(board_id)));
-- Who may change which column (your own text; accepting: the asker or an owner) is checked by the guard.
create policy questions_change on weft.questions for update to weft_user
  using (weft_private.can_edit(weft_private.qa_space(board_id)))
  with check (weft_private.can_edit(weft_private.qa_space(board_id)));
create policy questions_delete on weft.questions for delete to weft_user
  using (weft_private.can_edit(weft_private.qa_space(board_id)));

create policy answers_read on weft.answers for select to weft_user, weft_assistant
  using (weft_private.is_member(weft_private.qa_question_space(question_id)));
create policy answers_add on weft.answers for insert to weft_user
  with check (created_by = weft_private.uid() and weft_private.can_edit(weft_private.qa_question_space(question_id)));
create policy answers_change on weft.answers for update to weft_user
  using (created_by = weft_private.uid() and weft_private.can_edit(weft_private.qa_question_space(question_id)))
  with check (created_by = weft_private.uid() and weft_private.can_edit(weft_private.qa_question_space(question_id)));
create policy answers_delete on weft.answers for delete to weft_user
  using (weft_private.can_edit(weft_private.qa_question_space(question_id)));

create policy answer_votes_read on weft.answer_votes for select to weft_user, weft_assistant
  using (weft_private.is_member(weft_private.qa_answer_space(answer_id)));
create policy answer_votes_cast on weft.answer_votes for insert to weft_user
  with check (voter_id = weft_private.uid() and weft_private.is_member(weft_private.qa_answer_space(answer_id)));
create policy answer_votes_withdraw on weft.answer_votes for delete to weft_user
  using (voter_id = weft_private.uid() and weft_private.is_member(weft_private.qa_answer_space(answer_id)));

-- board_id, question_id and answer_id are never updatable; created_by, voter_id and the times are never
-- granted. An upvote is never updated, only cast or withdrawn.
grant select on weft.questions, weft.answers, weft.answer_votes to weft_user, weft_assistant;
grant insert (board_id, title, details), update (title, details, accepted_id), delete on weft.questions to weft_user;
grant insert (question_id, body), update (body), delete on weft.answers to weft_user;
grant insert (answer_id), delete on weft.answer_votes to weft_user;
revoke execute on function weft_private.qa_space(uuid), weft_private.qa_question_space(uuid), weft_private.qa_answer_space(uuid) from public;
grant execute on function weft_private.qa_space(uuid), weft_private.qa_question_space(uuid), weft_private.qa_answer_space(uuid) to weft_user, weft_assistant;

-- Before a write: trim the text, keep authorship and times, and check who changes what. Row-level
-- security has already limited an update to rows the caller may edit, so these answers are only ever
-- given to editors of the space. Changes the database makes itself (inside another trigger: an accepted
-- answer deleted clears accepted_id) pass.
create or replace function weft_private.qa_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  if tg_table_name = 'answer_votes' then
    if not weft_private.is_member(weft_private.qa_answer_space(new.answer_id)) then return new; end if;   -- row-level security refuses
    if exists (select 1 from weft.answers a where a.id = new.answer_id and a.created_by = new.voter_id) then
      raise exception 'you cannot upvote your own answer' using errcode = '42501';
    end if;
    new.created_at := now();
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.created_at := now(); new.updated_at := now();
    if tg_table_name = 'questions' then
      new.title := btrim(new.title); new.details := btrim(coalesce(new.details, ''), E' \t\r\n'); new.accepted_id := null;
    else
      new.body := btrim(new.body, E' \t\r\n');
    end if;
    return new;
  end if;
  new.created_at := old.created_at; new.created_by := old.created_by;
  if pg_trigger_depth() > 1 then return new; end if;
  new.updated_at := now();
  if tg_table_name = 'questions' then
    new.title := btrim(new.title); new.details := btrim(coalesce(new.details, ''), E' \t\r\n');
    if (new.title is distinct from old.title or new.details is distinct from old.details) and old.created_by is distinct from weft_private.uid() then
      raise exception 'only the person who asked can change the question' using errcode = '42501';
    end if;
    if new.accepted_id is distinct from old.accepted_id and old.created_by is distinct from weft_private.uid()
       and not weft_private.is_owner(weft_private.qa_space(old.board_id)) then
      raise exception 'only the person who asked, or an owner of the space, can accept an answer' using errcode = '42501';
    end if;
  else
    new.body := btrim(new.body, E' \t\r\n');
  end if;
  return new;
end $$;
drop trigger if exists questions_guard on weft.questions;
create trigger questions_guard before insert or update on weft.questions for each row execute function weft_private.qa_guard();
drop trigger if exists answers_guard on weft.answers;
create trigger answers_guard before insert or update on weft.answers for each row execute function weft_private.qa_guard();
drop trigger if exists answer_votes_guard on weft.answer_votes;
create trigger answer_votes_guard before insert on weft.answer_votes for each row execute function weft_private.qa_guard();

-- The board's text summary, what search and the assistant read: up to 200 questions, newest first, each
-- with who asked, the details, and up to 5 answers (the accepted one first, then by upvotes), each
-- shortened to 800 characters.
create or replace function weft_private.refresh_qa_text(p_board uuid) returns void
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare t text; n int;
begin
  select count(*) into n from weft.questions where board_id = p_board;
  select concat_ws(E'\n', 'Q and A, ' || n || case when n = 1 then ' question' else ' questions' end,
                   string_agg(block, E'\n' order by created_at desc)) into t from (
    select q.created_at,
           'Question: ' || q.title || ' (asked by ' || coalesce(u.display_name, 'someone') || ')'
           || case when q.details <> '' then E'\n  ' || regexp_replace(q.details, '\s*\n\s*', ' ', 'g') else '' end
           || coalesce((select string_agg(
                  E'\n  ' || case when a.id = q.accepted_id then 'Accepted answer' else 'Answer' end
                  || ' (' || a.votes || case when a.votes = 1 then ' upvote' else ' upvotes' end || ', by ' || coalesce(a.who, 'someone') || '): '
                  || left(regexp_replace(a.body, '\s*\n\s*', ' ', 'g'), 800), '' order by a.accepted desc, a.votes desc, a.created_at)
                from (select x.id, x.body, x.created_at, ux.display_name as who, (x.id = q.accepted_id) as accepted,
                             (select count(*) from weft.answer_votes v where v.answer_id = x.id) as votes
                        from weft.answers x left join weft.users ux on ux.id = x.created_by
                       where x.question_id = q.id
                       order by (x.id = q.accepted_id) desc, (select count(*) from weft.answer_votes v where v.answer_id = x.id) desc, x.created_at
                       limit 5) a), E'\n  No answers yet') as block
      from weft.questions q left join weft.users u on u.id = q.created_by
     where q.board_id = p_board order by q.created_at desc limit 200
  ) x;
  update weft.items set body_text = t where id = p_board and body_text is distinct from t;
end $$;

-- After a change: refresh the summary, announce it (to members only, through the notification server;
-- ids only), and keep the old row in the audit log under the board's space.
create or replace function weft_private.qa_changed() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare r record; v_board uuid; v_space uuid; v_id uuid;
begin
  r := coalesce(new, old);
  -- (field by field: each table's rows have different columns)
  if tg_table_name = 'questions' then v_board := r.board_id; v_id := r.id;
  elsif tg_table_name = 'answers' then select board_id into v_board from weft.questions where id = r.question_id; v_id := r.id;
  else select q.board_id into v_board from weft.answers a join weft.questions q on q.id = a.question_id where a.id = r.answer_id;
       v_id := r.answer_id;   -- an upvote has no id of its own: its notice and audit row use the answer
  end if;
  v_space := weft_private.qa_space(v_board);
  if v_space is null then return null; end if;   -- the board, question or answer is being deleted with its parent
  perform weft_private.refresh_qa_text(v_board);
  perform pg_notify('weft_events', json_build_object('t', 'qa', 'op', tg_op, 'id', v_id, 'space', v_space, 'board', v_board)::text);
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
  foreach t in array array['questions', 'answers', 'answer_votes'] loop
    execute format('drop trigger if exists %1$s_changed on weft.%1$I', t);
    execute format('create trigger %1$s_changed after insert or update or delete on weft.%1$I
                    for each row execute function weft_private.qa_changed()', t);
  end loop;
end $$;

revoke execute on function weft_private.qa_guard(), weft_private.refresh_qa_text(uuid), weft_private.qa_changed()
  from public, weft_user, weft_assistant;
grant execute on function weft_private.refresh_qa_text(uuid) to weft_owner;
