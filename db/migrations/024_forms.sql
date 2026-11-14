-- 024 forms: a short form in a space, its answers collected into a table.
-- A form is an item (kind 'form'), so it lives in a space and gets everything items have: the one
-- permission rule, moving, deleting, sharing links in a channel, the audit log, search and the
-- assistant (through the form's text summary in body_text). Its title is the form's name. Questions,
-- answers and the form's open or closed state reach the space through the item, like poll choices.
-- Every member of the space may answer, viewers too (taking part, like voting): one answer per person
-- per form, changed or withdrawn only by that person, until the form is closed. Answers are NOT public
-- in the space: you read your own; editors and owners read everyone's (that is the table they collect).
-- So the summary in body_text, the live notices and the audit log never carry answer text.
-- Editors and owners add and change questions and close or reopen the form. Once anyone has answered,
-- existing questions cannot be reworded, retyped or removed, so no answer ends up meaning something
-- else; new questions can still be added. The respondent is set here, never by the client.
set client_min_messages = warning;

alter table weft.items drop constraint if exists items_kind_check;
alter table weft.items add constraint items_kind_check check (kind in ('document', 'wiki', 'whiteboard', 'table', 'file', 'tasklist', 'poll', 'form'));

create table if not exists weft.forms (
  id        uuid primary key references weft.items (id) on delete cascade,
  closed    boolean not null default false,
  closed_at timestamptz,
  closed_by uuid references weft.users (id) on delete set null
);

create table if not exists weft.form_questions (
  id         uuid primary key default gen_random_uuid(),
  form_id    uuid not null references weft.items (id) on delete cascade,
  label      text not null check (length(btrim(label)) between 1 and 200),
  kind       text not null default 'short' check (kind in ('short', 'long', 'choice')),
  options    jsonb not null default '[]'::jsonb,   -- the choices, for kind 'choice'
  required   boolean not null default false,
  position   double precision not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists form_questions_form_idx on weft.form_questions (form_id, position);

create table if not exists weft.form_responses (
  id            uuid primary key default gen_random_uuid(),
  form_id       uuid not null references weft.items (id) on delete cascade,
  respondent_id uuid not null default weft_private.uid() references weft.users (id) on delete cascade,
  answers       jsonb not null default '{}'::jsonb,   -- {question id: text}, checked by the guard below
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (form_id, respondent_id)
);

-- The space of a form (null if it is not one). security definer: used inside policies.
create or replace function weft_private.form_space(p_form uuid) returns uuid
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select space_id from weft.items where id = p_form and kind = 'form'
$$;
create or replace function weft_private.form_closed(p_form uuid) returns boolean
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select coalesce((select closed from weft.forms where id = p_form), false)
$$;

do $$
declare t text; p record;
begin
  foreach t in array array['forms', 'form_questions', 'form_responses'] loop
    execute format('alter table weft.%I enable row level security', t);
    execute format('alter table weft.%I force row level security', t);
    for p in select policyname from pg_policies where schemaname = 'weft' and tablename = t loop
      execute format('drop policy %I on weft.%I', p.policyname, t);
    end loop;
  end loop;
end $$;

-- forms (open or closed): created with the item by a trigger below; editors close and reopen.
create policy forms_read on weft.forms for select to weft_user, weft_assistant
  using (weft_private.is_member(weft_private.form_space(id)));
create policy forms_change on weft.forms for update to weft_user
  using (weft_private.can_edit(weft_private.form_space(id)))
  with check (weft_private.can_edit(weft_private.form_space(id)));

-- questions: every member reads; editors and owners write.
create policy form_questions_read on weft.form_questions for select to weft_user, weft_assistant
  using (weft_private.is_member(weft_private.form_space(form_id)));
create policy form_questions_insert on weft.form_questions for insert to weft_user
  with check (weft_private.can_edit(weft_private.form_space(form_id)));
create policy form_questions_change on weft.form_questions for update to weft_user
  using (weft_private.can_edit(weft_private.form_space(form_id)))
  with check (weft_private.can_edit(weft_private.form_space(form_id)));
create policy form_questions_delete on weft.form_questions for delete to weft_user
  using (weft_private.can_edit(weft_private.form_space(form_id)));

-- answers: your own (as a member), or everyone's if you edit the space. Only your own to write.
create policy form_responses_read on weft.form_responses for select to weft_user, weft_assistant
  using ((respondent_id = weft_private.uid() and weft_private.is_member(weft_private.form_space(form_id)))
         or weft_private.can_edit(weft_private.form_space(form_id)));
create policy form_responses_insert on weft.form_responses for insert to weft_user
  with check (respondent_id = weft_private.uid() and weft_private.is_member(weft_private.form_space(form_id)));
create policy form_responses_change on weft.form_responses for update to weft_user
  using (respondent_id = weft_private.uid() and weft_private.is_member(weft_private.form_space(form_id)))
  with check (respondent_id = weft_private.uid() and weft_private.is_member(weft_private.form_space(form_id)));
create policy form_responses_withdraw on weft.form_responses for delete to weft_user
  using (respondent_id = weft_private.uid() and weft_private.is_member(weft_private.form_space(form_id)));

-- form_id is never updatable; respondent_id, closed_at, closed_by and the timestamps are never granted.
grant select on weft.forms, weft.form_questions, weft.form_responses to weft_user, weft_assistant;
grant update (closed) on weft.forms to weft_user;
grant insert (form_id, label, kind, options, required, position), update (label, kind, options, required, position), delete on weft.form_questions to weft_user;
grant insert (form_id, answers), update (answers), delete on weft.form_responses to weft_user;
grant execute on function weft_private.form_space(uuid), weft_private.form_closed(uuid) to weft_user, weft_assistant;

-- A new form item gets its open/closed row.
create or replace function weft_private.form_created() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  insert into weft.forms (id) values (new.id) on conflict do nothing;
  return null;
end $$;
drop trigger if exists items_form_created on weft.items;
create trigger items_form_created after insert on weft.items for each row
  when (new.kind = 'form') execute function weft_private.form_created();

-- Before a change. Someone outside the form's space gets no answer here: row-level security refuses
-- them, without learning whether the form is closed. Rows of a form or a person that is being deleted
-- pass (the cascade removes them).
create or replace function weft_private.form_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare r record; v_space uuid; q record; v_answers jsonb := '{}'::jsonb; v_val jsonb; v_text text; v_opts jsonb; k text;
begin
  if tg_table_name = 'forms' then
    if new.closed and not old.closed then new.closed_at := now(); new.closed_by := weft_private.uid();
    elsif not new.closed then new.closed_at := null; new.closed_by := null;
    else new.closed_at := old.closed_at; new.closed_by := old.closed_by; end if;
    return new;
  end if;
  r := coalesce(new, old);
  v_space := weft_private.form_space(r.form_id);
  if tg_op = 'DELETE' then
    if v_space is null then return old; end if;
    if tg_table_name = 'form_responses' then   -- (a nested if: only answers have a respondent)
      if not exists (select 1 from weft.users u where u.id = old.respondent_id) then return old; end if;
    end if;
  end if;
  if tg_op = 'INSERT' and not weft_private.is_member(v_space) then return new; end if;
  if weft_private.form_closed(r.form_id) then
    raise exception 'this form is closed' using errcode = '42501';
  end if;

  if tg_table_name = 'form_questions' then
    if tg_op <> 'INSERT' and (tg_op = 'DELETE' or new.label is distinct from old.label or new.kind is distinct from old.kind
                              or new.options is distinct from old.options or new.required is distinct from old.required)
       and exists (select 1 from weft.form_responses x where x.form_id = old.form_id) then
      raise exception 'people have answered this form, so its questions cannot be changed or removed (you can still add new ones)' using errcode = '42501';
    end if;
    if tg_op = 'DELETE' then return old; end if;
    new.label := btrim(new.label);
    if new.kind = 'choice' then
      if jsonb_typeof(new.options) <> 'array' then
        raise exception 'the choices must be a list' using errcode = '23514';
      end if;
      select coalesce(jsonb_agg(o order by n), '[]'::jsonb) into v_opts
        from (select distinct on (btrim(e #>> '{}')) btrim(e #>> '{}') as o, n
                from jsonb_array_elements(new.options) with ordinality as a(e, n)
               where jsonb_typeof(e) = 'string' and btrim(e #>> '{}') <> ''
               order by btrim(e #>> '{}'), n) x;
      if jsonb_array_length(v_opts) not between 1 and 20 or exists (select 1 from jsonb_array_elements_text(v_opts) o where length(o) > 100) then
        raise exception 'a choice question needs 1 to 20 choices of at most 100 characters' using errcode = '23514';
      end if;
      new.options := v_opts;
    else
      new.options := '[]'::jsonb;
    end if;
    return new;
  end if;

  -- form_responses
  if tg_op = 'DELETE' then return old; end if;
  if jsonb_typeof(new.answers) <> 'object' then
    raise exception 'answers must be an object of question id to text' using errcode = '23514';
  end if;
  for k in select jsonb_object_keys(new.answers) loop
    if not exists (select 1 from weft.form_questions fq where fq.form_id = new.form_id and fq.id::text = k) then
      raise exception 'that answer is not for a question on this form' using errcode = '23514';
    end if;
  end loop;
  for q in select * from weft.form_questions where form_id = new.form_id order by position, created_at loop
    v_val := new.answers -> q.id::text;
    v_text := null;
    if v_val is not null and jsonb_typeof(v_val) not in ('string', 'null') then
      raise exception 'answers are text' using errcode = '23514';
    end if;
    if jsonb_typeof(v_val) = 'string' then v_text := nullif(btrim(v_val #>> '{}'), ''); end if;
    if v_text is null then
      if q.required then raise exception 'please answer "%"', q.label using errcode = '23514'; end if;
      continue;
    end if;
    if q.kind = 'choice' and not (q.options ? v_text) then
      raise exception '"%" is not one of the choices for "%"', v_text, q.label using errcode = '23514';
    end if;
    if length(v_text) > (array[300, 4000])[(q.kind = 'long')::int + 1] then
      raise exception 'the answer to "%" is too long', q.label using errcode = '23514';
    end if;
    v_answers := v_answers || jsonb_build_object(q.id::text, v_text);
  end loop;
  new.answers := v_answers;
  if tg_op = 'UPDATE' then new.updated_at := now(); end if;
  return new;
end $$;
drop trigger if exists forms_guard on weft.forms;
create trigger forms_guard before update on weft.forms for each row execute function weft_private.form_guard();
drop trigger if exists form_questions_guard on weft.form_questions;
create trigger form_questions_guard before insert or update or delete on weft.form_questions for each row execute function weft_private.form_guard();
drop trigger if exists form_responses_guard on weft.form_responses;
create trigger form_responses_guard before insert or update or delete on weft.form_responses for each row execute function weft_private.form_guard();

-- The form's text summary: open or closed, how many answers, and the questions (never the answers,
-- because every member of the space can read body_text, and only editors may read the answers).
create or replace function weft_private.refresh_form_text(p_form uuid) returns void
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare t text; n int;
begin
  select count(*) into n from weft.form_responses where form_id = p_form;
  select concat_ws(E'\n',
           'Form, ' || case when weft_private.form_closed(p_form) then 'closed' else 'open' end
             || ', ' || n || case when n = 1 then ' answer' else ' answers' end,
           string_agg(q.label
             || case when q.kind = 'choice' then ' (one of: ' || (select string_agg(o, ', ') from jsonb_array_elements_text(q.options) o) || ')' else '' end
             || case when q.required then ' (required)' else '' end, E'\n' order by q.position, q.created_at))
    into t
    from (select * from weft.form_questions where form_id = p_form order by position, created_at limit 50) q;
  update weft.items set body_text = t where id = p_form and body_text is distinct from t;
end $$;

-- After a change: refresh the summary, announce it (to members only, through the notification server;
-- a notice carries ids, never answers), and keep the old row in the audit log. The audit log is
-- readable by every member of the space, so an answer's old row is kept without its answers.
create or replace function weft_private.form_changed() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare r record; v_form uuid; v_space uuid; v_old jsonb;
begin
  r := coalesce(new, old);
  if tg_table_name = 'forms' then v_form := r.id; else v_form := r.form_id; end if;
  v_space := weft_private.form_space(v_form);
  if v_space is null then return null; end if;   -- the form itself is being deleted
  perform weft_private.refresh_form_text(v_form);
  perform pg_notify('weft_events', json_build_object('t', 'forms', 'op', tg_op, 'id', r.id, 'space', v_space, 'form', v_form)::text);
  if tg_op in ('UPDATE', 'DELETE') then
    v_old := to_jsonb(old);
    if tg_table_name = 'form_responses' then v_old := v_old - 'answers'; end if;
    insert into weft.audit (table_name, row_id, space_id, op, actor_id, actor_role, old_row)
    values (tg_table_name, r.id, v_space, tg_op, weft_private.uid(),
            coalesce(nullif(current_setting('role', true), 'none'), session_user), v_old);
  end if;
  return null;
end $$;
do $$
declare t text;
begin
  foreach t in array array['forms', 'form_questions', 'form_responses'] loop
    execute format('drop trigger if exists %1$s_changed on weft.%1$I', t);
    execute format('create trigger %1$s_changed after insert or update or delete on weft.%1$I
                    for each row execute function weft_private.form_changed()', t);
  end loop;
end $$;

revoke execute on function weft_private.form_created(), weft_private.form_guard(), weft_private.refresh_form_text(uuid), weft_private.form_changed()
  from public, weft_user, weft_assistant;
grant execute on function weft_private.refresh_form_text(uuid) to weft_owner;
