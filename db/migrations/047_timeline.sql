-- 047 timeline: milestones for a channel, drawn on a horizontal timeline with today marked.
-- A milestone belongs to its channel directly (like a kudos or an announcement): a short title, a date and
-- an optional note. Members read the timeline, viewers included; editors and owners add, change and delete
-- milestones (it is the channel's shared plan, like a task list, so not only the author's). Only channels
-- have a timeline (not personal spaces, direct messages or the assistant space). A milestone never moves to
-- another channel. Who added it and when is set here, never by the client. The assistant role only reads.
-- Changes are announced (ids only, through the shared announce trigger) and the old row is kept in the audit
-- log (the shared audit trigger). Not an item: not in search or the assistant's context.
set client_min_messages = warning;

create table if not exists weft.milestones (
  id          uuid primary key default gen_random_uuid(),
  space_id    uuid not null references weft.spaces (id) on delete cascade,
  title       text not null check (length(btrim(title)) between 1 and 120),
  day         date not null check (day between date '2000-01-01' and date '2100-12-31'),
  note        text not null default '' check (length(note) <= 300),
  created_by  uuid not null default weft_private.uid() references weft.users (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists milestones_space_idx on weft.milestones (space_id, day);
create index if not exists milestones_day_idx on weft.milestones (day);

alter table weft.milestones enable row level security;
alter table weft.milestones force row level security;
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'weft' and tablename = 'milestones' loop
    execute format('drop policy %I on weft.milestones', p.policyname);
  end loop;
end $$;
create policy milestones_read on weft.milestones for select to weft_user, weft_assistant
  using (weft_private.is_member(space_id));
create policy milestones_add on weft.milestones for insert to weft_user
  with check (created_by = weft_private.uid() and weft_private.can_edit(space_id));
create policy milestones_change on weft.milestones for update to weft_user
  using (weft_private.can_edit(space_id))
  with check (weft_private.can_edit(space_id));
create policy milestones_delete on weft.milestones for delete to weft_user
  using (weft_private.can_edit(space_id));

-- space_id is not updatable: a milestone does not jump between channels.
-- created_by, created_at and updated_at are never granted.
grant select on weft.milestones to weft_user, weft_assistant;
grant insert (space_id, title, day, note), update (title, day, note), delete on weft.milestones to weft_user;

-- Before a write: only channels; tidy the text; keep authorship and times. The "only channels" answer is
-- given only once the caller may write in that space (the policies run after this trigger), so an outsider
-- learns nothing about a space from it.
create or replace function weft_private.milestones_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  new.title := btrim(new.title, E' \t\r\n');
  new.note := btrim(coalesce(new.note, ''), E' \t\r\n');
  if tg_op = 'INSERT' then
    new.created_at := now(); new.updated_at := now();
    if weft_private.can_edit(new.space_id)
       and not exists (select 1 from weft.spaces s where s.id = new.space_id and s.kind = 'channel') then
      raise exception 'milestones can only be added in a channel' using errcode = '22023';
    end if;
  else
    new.created_at := old.created_at; new.created_by := old.created_by; new.space_id := old.space_id; new.updated_at := now();
  end if;
  return new;
end $$;
drop trigger if exists milestones_guard on weft.milestones;
create trigger milestones_guard before insert or update on weft.milestones
  for each row execute function weft_private.milestones_guard();

-- Live notices and the audit log: the shared triggers from 006 and 004 (the table has id and space_id).
drop trigger if exists announce_milestones on weft.milestones;
create trigger announce_milestones after insert or update or delete on weft.milestones
  for each row execute function weft_private.announce();
drop trigger if exists audit_milestones on weft.milestones;
create trigger audit_milestones after update or delete on weft.milestones
  for each row execute function weft_private.audit_row();

revoke execute on function weft_private.milestones_guard() from public, weft_user, weft_assistant;
