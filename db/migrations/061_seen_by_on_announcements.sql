-- 061 seen by on announcements: a "Got it" button on notices people must not miss.
-- What this adds:
--   * weft.announcements.ask_ack: the poster (an editor or owner, as for the rest of the notice) can ask
--     every member to press "Got it". Off by default.
--   * weft.announcement_acks: one "Got it" per person per notice. It belongs to its announcement, and through
--     it to the announcement's channel (like an RSVP through its event). Every member may press it, viewers
--     too: it is taking part, not editing. You add or take back only your own; who pressed is set here,
--     never by the client.
--   * Who reads what: each member reads their own "Got it"; editors and owners of the channel (the people
--     who post notices) read everyone's, so they can see how many have pressed it and who has not. The
--     assistant role gets nothing on this table.
--   * You can press it only while the notice is showing and asks for it. Taking it back is always allowed.
--   * It follows the space: deleting a notice deletes its "Got it"s; someone who leaves or is removed from
--     the channel loses theirs. Notices never move between channels (027), so there is no move case.
--   * Changes are announced with the announcement's id and space only (never who pressed). There is no audit
--     row: the audit log is readable by every member of the space, and who pressed is for editors and
--     owners only.
set client_min_messages = warning;

alter table weft.announcements add column if not exists ask_ack boolean not null default false;
grant insert (ask_ack), update (ask_ack) on weft.announcements to weft_user;

create table if not exists weft.announcement_acks (
  announcement_id uuid not null references weft.announcements (id) on delete cascade,
  user_id         uuid not null default weft_private.uid() references weft.users (id) on delete cascade,
  created_at      timestamptz not null default now(),
  primary key (announcement_id, user_id)
);
create index if not exists announcement_acks_user_idx on weft.announcement_acks (user_id);

-- The channel of a notice (null if there is none). security definer: used inside policies.
create or replace function weft_private.announcement_space(p_announcement uuid) returns uuid
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select space_id from weft.announcements where id = p_announcement
$$;

alter table weft.announcement_acks enable row level security;
alter table weft.announcement_acks force row level security;
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'weft' and tablename = 'announcement_acks' loop
    execute format('drop policy %I on weft.announcement_acks', p.policyname);
  end loop;
end $$;
create policy announcement_acks_read on weft.announcement_acks for select to weft_user
  using ((user_id = weft_private.uid() and weft_private.is_member(weft_private.announcement_space(announcement_id)))
         or weft_private.can_edit(weft_private.announcement_space(announcement_id)));
create policy announcement_acks_press on weft.announcement_acks for insert to weft_user
  with check (user_id = weft_private.uid() and weft_private.is_member(weft_private.announcement_space(announcement_id)));
create policy announcement_acks_undo on weft.announcement_acks for delete to weft_user
  using (user_id = weft_private.uid() and weft_private.is_member(weft_private.announcement_space(announcement_id)));

-- Nothing is updatable; user_id and created_at are never granted.
grant select, insert (announcement_id), delete on weft.announcement_acks to weft_user;
grant execute on function weft_private.announcement_space(uuid) to weft_user, weft_assistant;

-- Before pressing: the notice must ask for it and still be showing. Someone outside the channel gets no
-- answer here (row-level security refuses them, without learning anything about the notice).
create or replace function weft_private.announcement_ack_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  if not weft_private.is_member(weft_private.announcement_space(new.announcement_id)) then return new; end if;
  if not exists (select 1 from weft.announcements a where a.id = new.announcement_id and a.ask_ack) then
    raise exception 'this announcement does not ask for "Got it"' using errcode = '22023';
  end if;
  if exists (select 1 from weft.announcements a where a.id = new.announcement_id and a.expires_at <= now()) then
    raise exception 'this announcement has ended' using errcode = '22023';
  end if;
  new.created_at := now();
  return new;
end $$;
drop trigger if exists announcement_acks_guard on weft.announcement_acks;
create trigger announcement_acks_guard before insert on weft.announcement_acks
  for each row execute function weft_private.announcement_ack_guard();

-- After a change: announce it with the notice's id and channel only.
create or replace function weft_private.announcement_ack_changed() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare r record; v_space uuid;
begin
  r := coalesce(new, old);
  v_space := weft_private.announcement_space(r.announcement_id);
  if v_space is null then return null; end if;   -- the notice itself is being deleted
  perform pg_notify('weft_events', json_build_object('t', 'announcement_acks', 'op', tg_op,
                                                     'id', r.announcement_id, 'space', v_space)::text);
  return null;
end $$;
drop trigger if exists announcement_acks_changed on weft.announcement_acks;
create trigger announcement_acks_changed after insert or delete on weft.announcement_acks
  for each row execute function weft_private.announcement_ack_changed();

-- Someone left or was removed from a channel: their "Got it"s on its notices go.
create or replace function weft_private.announcement_ack_member_left() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  delete from weft.announcement_acks k using weft.announcements a
   where a.id = k.announcement_id and a.space_id = old.space_id and k.user_id = old.user_id;
  return null;
end $$;
drop trigger if exists members_announcement_ack_left on weft.members;
create trigger members_announcement_ack_left after delete on weft.members
  for each row execute function weft_private.announcement_ack_member_left();

revoke execute on function weft_private.announcement_ack_guard(), weft_private.announcement_ack_changed(),
  weft_private.announcement_ack_member_left() from public, weft_user, weft_assistant;
