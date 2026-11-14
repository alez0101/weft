-- 030 rsvps: Going, Maybe or Not going on a calendar event.
-- An answer belongs to its event, and through it to the event's space (like a poll vote through its poll):
-- the one permission rule applies without a copy of the space. What this adds:
--   * weft.rsvps: one answer per person per event. Members of the event's space read every answer, with
--     names, viewers included. Every member may answer, viewers too: answering is taking part, like voting
--     in a poll, not editing the event. You set, change or clear only your own answer; who answered is set
--     here, never by the client. The assistant role only reads.
--   * Once an event has ended its answers are fixed (nobody adds, changes or clears one).
--   * Answers follow the space: deleting an event deletes its answers; an event moved to another space keeps
--     only the answers of people who are members there; someone who leaves or is removed from a space loses
--     their answers on its events (so nobody's name shows where they cannot see).
--   * Changes are announced (ids only, to members, through the notification server) and the old row is kept
--     in the audit log, under the event's id.
set client_min_messages = warning;

create table if not exists weft.rsvps (
  event_id   uuid not null references weft.events (id) on delete cascade,
  user_id    uuid not null default weft_private.uid() references weft.users (id) on delete cascade,
  answer     text not null check (answer in ('going', 'maybe', 'no')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (event_id, user_id)
);
create index if not exists rsvps_user_idx on weft.rsvps (user_id, answer);

-- The space of an event (null if there is none). security definer: used inside policies.
create or replace function weft_private.event_space(p_event uuid) returns uuid
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select space_id from weft.events where id = p_event
$$;

alter table weft.rsvps enable row level security;
alter table weft.rsvps force row level security;
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'weft' and tablename = 'rsvps' loop
    execute format('drop policy %I on weft.rsvps', p.policyname);
  end loop;
end $$;
create policy rsvps_read on weft.rsvps for select to weft_user, weft_assistant
  using (weft_private.is_member(weft_private.event_space(event_id)));
create policy rsvps_answer on weft.rsvps for insert to weft_user
  with check (user_id = weft_private.uid() and weft_private.is_member(weft_private.event_space(event_id)));
create policy rsvps_change on weft.rsvps for update to weft_user
  using (user_id = weft_private.uid() and weft_private.is_member(weft_private.event_space(event_id)))
  with check (user_id = weft_private.uid() and weft_private.is_member(weft_private.event_space(event_id)));
create policy rsvps_clear on weft.rsvps for delete to weft_user
  using (user_id = weft_private.uid() and weft_private.is_member(weft_private.event_space(event_id)));

-- event_id is never updatable; user_id, created_at and updated_at are never granted.
grant select on weft.rsvps to weft_user, weft_assistant;
grant insert (event_id, answer), update (answer), delete on weft.rsvps to weft_user;
grant execute on function weft_private.event_space(uuid) to weft_user, weft_assistant;

-- Before a change: an ended event's answers are fixed; stamp the times. Someone outside the event's space
-- gets no answer here (row-level security refuses them, without learning whether the event has ended).
-- Deletes made by the database itself (an event or person deleted, a move, someone leaving) run inside
-- another trigger and always pass.
create or replace function weft_private.rsvp_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare r record;
begin
  r := coalesce(new, old);
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then return old; end if;
  if tg_op = 'INSERT' and not weft_private.is_member(weft_private.event_space(r.event_id)) then return new; end if;
  if exists (select 1 from weft.events e where e.id = r.event_id and e.ends_at < now()) then
    raise exception 'this event has ended, so its answers can no longer change' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' then
    new.created_at := old.created_at;
    new.updated_at := now();
  elsif tg_op = 'INSERT' then
    new.created_at := now();
    new.updated_at := now();
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists rsvps_guard on weft.rsvps;
create trigger rsvps_guard before insert or update or delete on weft.rsvps
  for each row execute function weft_private.rsvp_guard();

-- After a change: announce it (ids only) and keep the old row in the audit log. While an event is being
-- moved (rsvp_event_moved below), the answers it drops are recorded and announced under the space it is
-- moving FROM: they belonged there, and the new space's members must not learn who had answered.
create or replace function weft_private.rsvp_changed() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare r record; v_space uuid;
begin
  r := coalesce(new, old);
  v_space := coalesce(nullif(current_setting('weft.rsvp_moving_from', true), '')::uuid, weft_private.event_space(r.event_id));
  if v_space is null then return null; end if;   -- the event itself is being deleted
  perform pg_notify('weft_events', json_build_object('t', 'rsvps', 'op', tg_op, 'id', r.event_id, 'space', v_space,
                                                     'event', r.event_id, 'user', r.user_id)::text);
  if tg_op in ('UPDATE', 'DELETE') then
    insert into weft.audit (table_name, row_id, space_id, op, actor_id, actor_role, old_row)
    values ('rsvps', old.event_id, v_space, tg_op, weft_private.uid(),
            coalesce(nullif(current_setting('role', true), 'none'), session_user), to_jsonb(old));
  end if;
  return null;
end $$;
drop trigger if exists rsvps_changed on weft.rsvps;
create trigger rsvps_changed after insert or update or delete on weft.rsvps
  for each row execute function weft_private.rsvp_changed();

-- An event moved to another space: only answers from people who are members there stay.
create or replace function weft_private.rsvp_event_moved() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  perform set_config('weft.rsvp_moving_from', old.space_id::text, true);   -- see rsvp_changed
  delete from weft.rsvps r
   where r.event_id = new.id
     and not exists (select 1 from weft.members m where m.space_id = new.space_id and m.user_id = r.user_id);
  perform set_config('weft.rsvp_moving_from', '', true);
  return null;
end $$;
drop trigger if exists events_rsvp_moved on weft.events;
create trigger events_rsvp_moved after update of space_id on weft.events for each row
  when (new.space_id is distinct from old.space_id) execute function weft_private.rsvp_event_moved();

-- Someone left or was removed from a space: their answers on its events go.
create or replace function weft_private.rsvp_member_left() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  delete from weft.rsvps r using weft.events e
   where e.id = r.event_id and e.space_id = old.space_id and r.user_id = old.user_id;
  return null;
end $$;
drop trigger if exists members_rsvp_left on weft.members;
create trigger members_rsvp_left after delete on weft.members for each row execute function weft_private.rsvp_member_left();

revoke execute on function weft_private.rsvp_guard(), weft_private.rsvp_changed(), weft_private.rsvp_event_moved(),
  weft_private.rsvp_member_left() from public, weft_user, weft_assistant;
