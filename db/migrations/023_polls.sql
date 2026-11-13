-- 023 polls: a quick vote in a space.
-- A poll is an item (kind 'poll'), so it lives in a space and gets everything items have: the one
-- permission rule, moving, deleting, sharing links, the audit log, search and the assistant (through
-- the poll's text summary in body_text). Its title is the question. Choices, votes and the poll's
-- open or closed state reach the space through the item, like table rows and tasks.
-- Members read everything about a poll, including who voted for what. Every member may vote, viewers
-- too: a vote is taking part, like sending a chat message (which viewers may also do). One vote per
-- person per poll; you change or withdraw only your own. Editors and owners make polls, change the
-- choices, and close or reopen them. A choice someone voted for cannot be renamed or removed, and
-- nothing about a closed poll's choices or votes changes. The voter is set here, never by the client.
set client_min_messages = warning;

alter table weft.items drop constraint if exists items_kind_check;
alter table weft.items add constraint items_kind_check check (kind in ('document', 'wiki', 'whiteboard', 'table', 'file', 'tasklist', 'poll'));

create table if not exists weft.polls (
  id        uuid primary key references weft.items (id) on delete cascade,
  closed    boolean not null default false,
  closed_at timestamptz,
  closed_by uuid references weft.users (id) on delete set null
);

create table if not exists weft.poll_choices (
  id         uuid primary key default gen_random_uuid(),
  poll_id    uuid not null references weft.items (id) on delete cascade,
  label      text not null check (length(btrim(label)) between 1 and 200),
  position   double precision not null default 0,
  created_at timestamptz not null default now(),
  unique (id, poll_id)
);
create index if not exists poll_choices_poll_idx on weft.poll_choices (poll_id, position);

create table if not exists weft.poll_votes (
  poll_id    uuid not null references weft.items (id) on delete cascade,
  voter_id   uuid not null default weft_private.uid() references weft.users (id) on delete cascade,
  choice_id  uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (poll_id, voter_id),
  -- the choice must be one of this poll's
  foreign key (choice_id, poll_id) references weft.poll_choices (id, poll_id) on delete cascade
);
create index if not exists poll_votes_choice_idx on weft.poll_votes (choice_id);

-- The space of a poll (null if it is not one). security definer: used inside policies.
create or replace function weft_private.poll_space(p_poll uuid) returns uuid
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select space_id from weft.items where id = p_poll and kind = 'poll'
$$;
create or replace function weft_private.poll_closed(p_poll uuid) returns boolean
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select coalesce((select closed from weft.polls where id = p_poll), false)
$$;

do $$
declare t text; p record;
begin
  foreach t in array array['polls', 'poll_choices', 'poll_votes'] loop
    execute format('alter table weft.%I enable row level security', t);
    execute format('alter table weft.%I force row level security', t);
    for p in select policyname from pg_policies where schemaname = 'weft' and tablename = t loop
      execute format('drop policy %I on weft.%I', p.policyname, t);
    end loop;
  end loop;
end $$;

-- polls (open or closed): created with the item by a trigger below; editors close and reopen.
create policy polls_read on weft.polls for select to weft_user, weft_assistant
  using (weft_private.is_member(weft_private.poll_space(id)));
create policy polls_change on weft.polls for update to weft_user
  using (weft_private.can_edit(weft_private.poll_space(id)))
  with check (weft_private.can_edit(weft_private.poll_space(id)));

-- choices: editors and owners.
create policy poll_choices_read on weft.poll_choices for select to weft_user, weft_assistant
  using (weft_private.is_member(weft_private.poll_space(poll_id)));
create policy poll_choices_insert on weft.poll_choices for insert to weft_user
  with check (weft_private.can_edit(weft_private.poll_space(poll_id)));
create policy poll_choices_change on weft.poll_choices for update to weft_user
  using (weft_private.can_edit(weft_private.poll_space(poll_id)))
  with check (weft_private.can_edit(weft_private.poll_space(poll_id)));
create policy poll_choices_delete on weft.poll_choices for delete to weft_user
  using (weft_private.can_edit(weft_private.poll_space(poll_id)));

-- votes: any member, only their own.
create policy poll_votes_read on weft.poll_votes for select to weft_user, weft_assistant
  using (weft_private.is_member(weft_private.poll_space(poll_id)));
create policy poll_votes_cast on weft.poll_votes for insert to weft_user
  with check (voter_id = weft_private.uid() and weft_private.is_member(weft_private.poll_space(poll_id)));
create policy poll_votes_change on weft.poll_votes for update to weft_user
  using (voter_id = weft_private.uid() and weft_private.is_member(weft_private.poll_space(poll_id)))
  with check (voter_id = weft_private.uid() and weft_private.is_member(weft_private.poll_space(poll_id)));
create policy poll_votes_withdraw on weft.poll_votes for delete to weft_user
  using (voter_id = weft_private.uid() and weft_private.is_member(weft_private.poll_space(poll_id)));

-- poll_id is never updatable; voter_id, closed_at and closed_by are never granted.
grant select on weft.polls, weft.poll_choices, weft.poll_votes to weft_user, weft_assistant;
grant update (closed) on weft.polls to weft_user;
grant insert (poll_id, label, position), update (label, position), delete on weft.poll_choices to weft_user;
grant insert (poll_id, choice_id), update (choice_id), delete on weft.poll_votes to weft_user;
grant execute on function weft_private.poll_space(uuid), weft_private.poll_closed(uuid) to weft_user, weft_assistant;

-- A new poll item gets its open/closed row.
create or replace function weft_private.poll_created() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  insert into weft.polls (id) values (new.id) on conflict do nothing;
  return null;
end $$;
drop trigger if exists items_poll_created on weft.items;
create trigger items_poll_created after insert on weft.items for each row
  when (new.kind = 'poll') execute function weft_private.poll_created();

-- Before a change. Someone outside the poll's space gets no answer here: row-level security refuses
-- them, without learning whether the poll is closed. Rows of a poll or a person that is being deleted
-- pass (the cascade removes them).
create or replace function weft_private.poll_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare r record; v_space uuid;
begin
  if tg_table_name = 'polls' then
    if new.closed and not old.closed then new.closed_at := now(); new.closed_by := weft_private.uid();
    elsif not new.closed then new.closed_at := null; new.closed_by := null;
    else new.closed_at := old.closed_at; new.closed_by := old.closed_by; end if;
    return new;
  end if;
  r := coalesce(new, old);
  v_space := weft_private.poll_space(r.poll_id);
  if tg_op = 'DELETE' then
    if v_space is null then return old; end if;
    if tg_table_name = 'poll_votes' then   -- (a nested if: only votes have a voter)
      if not exists (select 1 from weft.users u where u.id = old.voter_id) then return old; end if;
    end if;
  end if;
  if tg_op = 'INSERT' and not weft_private.is_member(v_space) then return new; end if;
  if weft_private.poll_closed(r.poll_id) then
    raise exception 'this poll is closed' using errcode = '42501';
  end if;
  if tg_table_name = 'poll_choices' then
    if tg_op <> 'INSERT' and (tg_op = 'DELETE' or new.label is distinct from old.label)
       and exists (select 1 from weft.poll_votes v where v.choice_id = old.id) then
      raise exception 'people have voted for this choice, so it cannot be changed or removed' using errcode = '42501';
    end if;
    if tg_op <> 'DELETE' then new.label := btrim(new.label); end if;
  elsif tg_op = 'UPDATE' then
    new.updated_at := now();
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists polls_guard on weft.polls;
create trigger polls_guard before update on weft.polls for each row execute function weft_private.poll_guard();
drop trigger if exists poll_choices_guard on weft.poll_choices;
create trigger poll_choices_guard before insert or update or delete on weft.poll_choices for each row execute function weft_private.poll_guard();
drop trigger if exists poll_votes_guard on weft.poll_votes;
create trigger poll_votes_guard before insert or update or delete on weft.poll_votes for each row execute function weft_private.poll_guard();

-- The poll's text summary: the question, open or closed, and each choice with its count (no names).
create or replace function weft_private.refresh_poll_text(p_poll uuid) returns void
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare t text; n int;
begin
  select count(*) into n from weft.poll_votes where poll_id = p_poll;
  select concat_ws(E'\n',
           'Poll, ' || case when weft_private.poll_closed(p_poll) then 'closed' else 'open' end
             || ', ' || n || case when n = 1 then ' vote' else ' votes' end,
           string_agg(c.label || ': ' || c.votes || case when c.votes = 1 then ' vote' else ' votes' end, E'\n' order by c.position, c.created_at))
    into t
    from (select c.label, c.position, c.created_at, (select count(*) from weft.poll_votes v where v.choice_id = c.id) as votes
            from weft.poll_choices c where c.poll_id = p_poll limit 50) c;
  update weft.items set body_text = t where id = p_poll and body_text is distinct from t;
end $$;

-- After a change: refresh the summary, announce it (to members only, through the notification server),
-- and keep the old row in the audit log.
create or replace function weft_private.poll_changed() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare r record; v_poll uuid; v_space uuid; v_id uuid;
begin
  r := coalesce(new, old);
  -- (field by field: each table's rows have different columns)
  if tg_table_name = 'polls' then v_poll := r.id; v_id := r.id;
  elsif tg_table_name = 'poll_choices' then v_poll := r.poll_id; v_id := r.id;
  else v_poll := r.poll_id; v_id := r.voter_id;   -- a vote has no id of its own: its notice and audit row use the voter
  end if;
  v_space := weft_private.poll_space(v_poll);
  if v_space is null then return null; end if;   -- the poll itself is being deleted
  perform weft_private.refresh_poll_text(v_poll);
  perform pg_notify('weft_events', json_build_object('t', 'polls', 'op', tg_op, 'id', v_id, 'space', v_space, 'poll', v_poll)::text);
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
  foreach t in array array['polls', 'poll_choices', 'poll_votes'] loop
    execute format('drop trigger if exists %1$s_changed on weft.%1$I', t);
    execute format('create trigger %1$s_changed after insert or update or delete on weft.%1$I
                    for each row execute function weft_private.poll_changed()', t);
  end loop;
end $$;

revoke execute on function weft_private.poll_created(), weft_private.poll_guard(), weft_private.refresh_poll_text(uuid), weft_private.poll_changed()
  from public, weft_user, weft_assistant;
grant execute on function weft_private.refresh_poll_text(uuid) to weft_owner;
