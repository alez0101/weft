-- 069 projects: projects inside channels, rules for the assistant, and the external-agent read switch.
--
--   * A project lives in one channel (or in someone's personal space) and has a name, instructions for the
--     assistant and up to 10 pinned items. Members read its projects; only owners of the space create, rename,
--     archive, delete, change instructions and pin. There are no project members: the space stays the only
--     permission unit, so nothing here grants anything.
--   * An item or an event can have one home project (project_id), which must be in the item's own space.
--     Moving the item to another space clears it, and removes its pins, so nothing points across spaces.
--   * A message can belong to a project: that is the project's own chat. A thread reply always follows its
--     root's project. Deleting a project deletes its chat (owners archive instead to keep it); its items and
--     events stay in the channel with no project.
--   * space_rules holds a space's own instructions and whether external agents (AI apps through the connector,
--     personal agents) may read it. Owners change them; members read them.
--   * user_prefs.ai_instructions holds a person's own rules, readable only by them.
--   * Instruction history is the audit log: projects and space_rules use the shared audit trigger, so every
--     earlier version stays readable by the space's members.
set client_min_messages = warning;

-- ---------------------------------------------------------------- projects
create table if not exists weft.projects (
  id           uuid primary key default gen_random_uuid(),
  space_id     uuid not null references weft.spaces (id) on delete cascade,
  name         text not null check (length(btrim(name)) between 1 and 80),
  instructions text not null default '' check (length(instructions) <= 8000),
  archived_at  timestamptz,
  created_by   uuid not null default weft_private.uid() references weft.users (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index if not exists projects_name_idx on weft.projects (space_id, lower(name));

alter table weft.projects enable row level security;
alter table weft.projects force row level security;
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'weft' and tablename = 'projects' loop
    execute format('drop policy %I on weft.projects', p.policyname);
  end loop;
end $$;
create policy projects_read on weft.projects for select to weft_user, weft_assistant
  using (weft_private.is_member(space_id));
create policy projects_add on weft.projects for insert to weft_user
  with check (created_by = weft_private.uid() and weft_private.is_owner(space_id));
create policy projects_change on weft.projects for update to weft_user
  using (weft_private.is_owner(space_id)) with check (weft_private.is_owner(space_id));
create policy projects_delete on weft.projects for delete to weft_user
  using (weft_private.is_owner(space_id));

-- space_id is not updatable: a project never moves to another space. created_by and the times are never granted.
grant select on weft.projects to weft_user, weft_assistant;
grant insert (space_id, name, instructions), update (name, instructions, archived_at), delete on weft.projects to weft_user;

-- Only channels and personal spaces have projects. The reason is given only once the caller owns the space
-- (the policies run after this trigger), so an outsider learns nothing about a space from it.
create or replace function weft_private.projects_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  new.name := btrim(new.name, E' \t\r\n');
  if tg_op = 'INSERT' then
    new.created_at := now(); new.updated_at := now(); new.archived_at := null;
    if weft_private.is_owner(new.space_id)
       and not exists (select 1 from weft.spaces s where s.id = new.space_id and s.kind in ('channel', 'personal')) then
      raise exception 'projects can only be made in a channel or your personal space' using errcode = '22023';
    end if;
  else
    new.created_at := old.created_at; new.created_by := old.created_by; new.space_id := old.space_id; new.updated_at := now();
  end if;
  return new;
end $$;
drop trigger if exists projects_guard on weft.projects;
create trigger projects_guard before insert or update on weft.projects
  for each row execute function weft_private.projects_guard();

drop trigger if exists announce_projects on weft.projects;
create trigger announce_projects after insert or update or delete on weft.projects
  for each row execute function weft_private.announce();
drop trigger if exists audit_projects on weft.projects;
create trigger audit_projects after update or delete on weft.projects
  for each row execute function weft_private.audit_row();

-- ---------------------------------------------------------------- pinned items
-- A pinned item is always given to the assistant when it answers in the project. space_id is copied from the
-- project by the guard (never by the client), so notices and policies work like everywhere else.
create table if not exists weft.project_pins (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references weft.projects (id) on delete cascade,
  item_id    uuid not null references weft.items (id) on delete cascade,
  space_id   uuid not null references weft.spaces (id) on delete cascade,
  position   integer not null default 0,
  created_by uuid not null default weft_private.uid() references weft.users (id),
  created_at timestamptz not null default now(),
  unique (project_id, item_id)
);
create index if not exists project_pins_item_idx on weft.project_pins (item_id);

alter table weft.project_pins enable row level security;
alter table weft.project_pins force row level security;
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'weft' and tablename = 'project_pins' loop
    execute format('drop policy %I on weft.project_pins', p.policyname);
  end loop;
end $$;
create policy project_pins_read on weft.project_pins for select to weft_user, weft_assistant
  using (weft_private.is_member(space_id));
create policy project_pins_add on weft.project_pins for insert to weft_user
  with check (created_by = weft_private.uid() and weft_private.is_owner(space_id));
create policy project_pins_change on weft.project_pins for update to weft_user
  using (weft_private.is_owner(space_id)) with check (weft_private.is_owner(space_id));
create policy project_pins_delete on weft.project_pins for delete to weft_user
  using (weft_private.is_owner(space_id));

grant select on weft.project_pins to weft_user, weft_assistant;
grant insert (project_id, item_id, position), update (position), delete on weft.project_pins to weft_user;

create or replace function weft_private.project_pins_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare v_space uuid;
begin
  if tg_op = 'UPDATE' then
    new.project_id := old.project_id; new.item_id := old.item_id; new.space_id := old.space_id;
    new.created_by := old.created_by; new.created_at := old.created_at;
    return new;
  end if;
  select p.space_id into v_space from weft.projects p where p.id = new.project_id;
  -- An unknown project: leave space_id empty so the insert fails without saying why.
  new.space_id := v_space;
  new.created_at := now();
  if v_space is not null and weft_private.is_owner(v_space) then
    if not exists (select 1 from weft.items i where i.id = new.item_id and i.space_id = v_space) then
      raise exception 'only an item from the same space can be pinned' using errcode = '22023';
    end if;
    if (select count(*) from weft.project_pins where project_id = new.project_id) >= 10 then
      raise exception 'a project can pin at most 10 items' using errcode = '22023';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists project_pins_guard on weft.project_pins;
create trigger project_pins_guard before insert or update on weft.project_pins
  for each row execute function weft_private.project_pins_guard();

drop trigger if exists announce_project_pins on weft.project_pins;
create trigger announce_project_pins after insert or update or delete on weft.project_pins
  for each row execute function weft_private.announce();

-- ---------------------------------------------------------------- home project on items and events
alter table weft.items  add column if not exists project_id uuid references weft.projects (id) on delete set null;
alter table weft.events add column if not exists project_id uuid references weft.projects (id) on delete set null;
create index if not exists items_project_idx on weft.items (project_id) where project_id is not null;
create index if not exists events_project_idx on weft.events (project_id) where project_id is not null;
grant insert (project_id), update (project_id) on weft.items to weft_user;
grant insert (project_id), update (project_id) on weft.events to weft_user, weft_assistant;

-- The project must be in the row's own space. A move to another space clears it (unless the same write sets a
-- project in the new space). The reason is given only to someone who may edit the space; anyone else just has
-- the project dropped and meets the ordinary refusal from the policies.
create or replace function weft_private.project_link_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  if new.project_id is null then return new; end if;
  if tg_op = 'UPDATE' and new.space_id is distinct from old.space_id
     and new.project_id is not distinct from old.project_id then
    new.project_id := null;
    return new;
  end if;
  if not exists (select 1 from weft.projects p where p.id = new.project_id and p.space_id = new.space_id) then
    if weft_private.can_edit(new.space_id) then
      raise exception 'that project is not in this space' using errcode = '22023';
    end if;
    new.project_id := null;
  end if;
  return new;
end $$;
drop trigger if exists items_project_link on weft.items;
create trigger items_project_link before insert or update of project_id, space_id on weft.items
  for each row execute function weft_private.project_link_guard();
drop trigger if exists events_project_link on weft.events;
create trigger events_project_link before insert or update of project_id, space_id on weft.events
  for each row execute function weft_private.project_link_guard();

-- An item that moves away is unpinned from its old space's projects.
create or replace function weft_private.items_unpin_on_move() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  delete from weft.project_pins where item_id = new.id and space_id <> new.space_id;
  return null;
end $$;
drop trigger if exists items_unpin_on_move on weft.items;
create trigger items_unpin_on_move after update of space_id on weft.items
  for each row when (new.space_id is distinct from old.space_id)
  execute function weft_private.items_unpin_on_move();

-- ---------------------------------------------------------------- project chat
alter table weft.messages add column if not exists project_id uuid references weft.projects (id) on delete cascade;
create index if not exists messages_project_idx on weft.messages (project_id, created_at) where project_id is not null;
grant insert (project_id) on weft.messages to weft_user, weft_assistant;

-- A reply follows its root's project. A project's chat must be in the message's space, and an archived project
-- takes no new messages. Same rule as above for who hears the reason.
create or replace function weft_private.messages_project_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare v_archived timestamptz;
begin
  if new.thread_root_id is not null then
    select r.project_id into new.project_id from weft.messages r where r.id = new.thread_root_id;
  end if;
  if new.project_id is null then return new; end if;
  select p.archived_at into v_archived from weft.projects p where p.id = new.project_id and p.space_id = new.space_id;
  if not found then
    if weft_private.is_member(new.space_id) then
      raise exception 'that project is not in this space' using errcode = '22023';
    end if;
    new.project_id := null;
  elsif v_archived is not null and weft_private.is_member(new.space_id) then
    raise exception 'this project is archived' using errcode = '22023';
  end if;
  return new;
end $$;
drop trigger if exists messages_project_guard on weft.messages;
create trigger messages_project_guard before insert on weft.messages
  for each row execute function weft_private.messages_project_guard();

-- ---------------------------------------------------------------- a space's own rules
create table if not exists weft.space_rules (
  id              uuid primary key default gen_random_uuid(),
  space_id        uuid not null unique references weft.spaces (id) on delete cascade,
  instructions    text not null default '' check (length(instructions) <= 8000),
  agents_may_read boolean not null default true,
  updated_by      uuid not null default weft_private.uid() references weft.users (id),
  updated_at      timestamptz not null default now()
);

alter table weft.space_rules enable row level security;
alter table weft.space_rules force row level security;
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'weft' and tablename = 'space_rules' loop
    execute format('drop policy %I on weft.space_rules', p.policyname);
  end loop;
end $$;
create policy space_rules_read on weft.space_rules for select to weft_user, weft_assistant
  using (weft_private.is_member(space_id));
create policy space_rules_add on weft.space_rules for insert to weft_user
  with check (weft_private.is_owner(space_id));
create policy space_rules_change on weft.space_rules for update to weft_user
  using (weft_private.is_owner(space_id)) with check (weft_private.is_owner(space_id));

-- No delete: an owner empties the instructions instead (the old text stays in the audit log).
grant select on weft.space_rules to weft_user, weft_assistant;
grant insert (space_id, instructions, agents_may_read), update (instructions, agents_may_read) on weft.space_rules to weft_user;

create or replace function weft_private.space_rules_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  -- Who changed it, from the token; an admin's direct SQL (no token) keeps the previous value.
  new.updated_by := coalesce(weft_private.uid(), case when tg_op = 'UPDATE' then old.updated_by end, new.updated_by);
  new.updated_at := now();
  if tg_op = 'INSERT' then
    if weft_private.is_owner(new.space_id)
       and not exists (select 1 from weft.spaces s where s.id = new.space_id and s.kind in ('channel', 'personal')) then
      raise exception 'rules can only be set for a channel or your personal space' using errcode = '22023';
    end if;
  else
    new.space_id := old.space_id;
  end if;
  return new;
end $$;
drop trigger if exists space_rules_guard on weft.space_rules;
create trigger space_rules_guard before insert or update on weft.space_rules
  for each row execute function weft_private.space_rules_guard();

drop trigger if exists announce_space_rules on weft.space_rules;
create trigger announce_space_rules after insert or update or delete on weft.space_rules
  for each row execute function weft_private.announce();
drop trigger if exists audit_space_rules on weft.space_rules;
create trigger audit_space_rules after update or delete on weft.space_rules
  for each row execute function weft_private.audit_row();

-- ---------------------------------------------------------------- a person's own rules
alter table weft.user_prefs add column if not exists ai_instructions text not null default ''
  check (length(ai_instructions) <= 4000);
grant insert (ai_instructions), update (ai_instructions) on weft.user_prefs to weft_user;

revoke execute on function weft_private.projects_guard(), weft_private.project_pins_guard(),
  weft_private.project_link_guard(), weft_private.items_unpin_on_move(),
  weft_private.messages_project_guard(), weft_private.space_rules_guard()
  from public, weft_user, weft_assistant;
