-- 049 repeating events: a Calendar event can repeat every day, week or month until a date.
--   * Each occurrence is an ordinary weft.events row, so RSVPs, meeting notes, search, the assistant and
--     sharing keep working per occurrence, under the events policies from 003. Nothing new to get wrong.
--   * weft.event_series holds what repeats (how often, until when, in which time zone) and belongs to a space.
--     Events point to it with series_id. Every occurrence is in its series' space (a guard checks it); moving
--     one occurrence to another space takes it out of the series, so the series never spans two spaces.
--   * weft.repeat_event makes the occurrences, weft.change_series changes all of them (title, place, a time
--     shift) and weft.delete_series deletes all of them. All three run as the caller (security invoker), so
--     the events and series policies decide: members read, editors and owners write, viewers only read.
--     Times are worked out in the caller's time zone, so a 19:00 rehearsal stays at 19:00 across clock
--     changes. Monthly on the 31st lands on the last day of shorter months.
--   * At most a year: the last day is no later than a year after the first (up to 367 daily occurrences).
--   * Bulk writes send one live notice (events, for the first occurrence) instead of one per occurrence:
--     announce() skips the table named in the transaction-local setting weft.quiet.
--   * The assistant role reads series but cannot create, change or delete them, and series_id is not among
--     its event columns. It still changes single events as before.
set client_min_messages = warning;

create table if not exists weft.event_series (
  id          uuid primary key default gen_random_uuid(),
  space_id    uuid not null references weft.spaces (id) on delete cascade,
  repeats     text not null check (repeats in ('daily', 'weekly', 'monthly')),
  until_on    date not null check (until_on between date '2000-01-01' and date '2100-12-31'),
  tz          text not null default 'UTC' check (length(tz) between 1 and 64),
  created_by  uuid not null default weft_private.uid() references weft.users (id),
  created_at  timestamptz not null default now()
);
create index if not exists event_series_space_idx on weft.event_series (space_id);

alter table weft.events add column if not exists series_id uuid references weft.event_series (id) on delete cascade;
create index if not exists events_series_idx on weft.events (series_id) where series_id is not null;

alter table weft.event_series enable row level security;
alter table weft.event_series force row level security;
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'weft' and tablename = 'event_series' loop
    execute format('drop policy %I on weft.event_series', p.policyname);
  end loop;
end $$;
create policy event_series_read on weft.event_series for select to weft_user, weft_assistant
  using (weft_private.is_member(space_id));
create policy event_series_add on weft.event_series for insert to weft_user
  with check (created_by = weft_private.uid() and weft_private.can_edit(space_id));
create policy event_series_delete on weft.event_series for delete to weft_user
  using (weft_private.can_edit(space_id));

-- No updates: a series is made once; changes go to its events. created_by and created_at are never granted.
grant select on weft.event_series to weft_user, weft_assistant;
grant insert (space_id, repeats, until_on, tz), delete on weft.event_series to weft_user;
-- People may set or clear series_id on events they can write (the guard below keeps it in the same space).
grant insert (series_id), update (series_id) on weft.events to weft_user;

-- Before an event is written: its series must be in the same space. Runs as the caller (not security
-- definer), so a series the caller cannot see counts as missing; the answer is the same either way.
create or replace function weft_private.events_series_guard() returns trigger
language plpgsql set search_path = weft, weft_private, pg_temp as $$
begin
  if tg_op = 'UPDATE' and new.space_id is distinct from old.space_id and new.series_id is not distinct from old.series_id then
    new.series_id := null;   -- moved to another space: no longer part of the series
  end if;
  if new.series_id is not null and not exists (
       select 1 from weft.event_series s where s.id = new.series_id and s.space_id = new.space_id) then
    raise exception 'that series is not in this event''s space' using errcode = '22023';
  end if;
  return new;
end $$;
drop trigger if exists events_series_guard on weft.events;
create trigger events_series_guard before insert or update of series_id, space_id on weft.events
  for each row execute function weft_private.events_series_guard();

-- Live notices: skip the table named in weft.quiet (set only inside the bulk functions below, for their own
-- transaction). Otherwise unchanged from 006: table, operation, id and space, never content.
create or replace function weft_private.announce() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare r record;
begin
  if tg_table_name = current_setting('weft.quiet', true) then return null; end if;
  r := coalesce(new, old);
  if tg_table_name = 'members' then
    perform pg_notify('weft_events', json_build_object(
      't', 'members', 'op', tg_op, 'space', r.space_id, 'user', r.user_id)::text);
  else
    perform pg_notify('weft_events', json_build_object(
      't', tg_table_name, 'op', tg_op, 'id', r.id, 'space', r.space_id)::text);
  end if;
  return null;
end $$;
revoke execute on function weft_private.announce() from weft_user, weft_assistant;

drop trigger if exists announce_event_series on weft.event_series;
create trigger announce_event_series after insert or update or delete on weft.event_series
  for each row execute function weft_private.announce();
drop trigger if exists audit_event_series on weft.event_series;
create trigger audit_event_series after update or delete on weft.event_series
  for each row execute function weft_private.audit_row();

-- The time zone a browser sends, checked against the database's list.
create or replace function weft_private.check_tz(p_tz text) returns text
language plpgsql stable set search_path = pg_catalog, pg_temp as $$
begin
  if p_tz is null or length(p_tz) > 64 or not exists (select 1 from pg_timezone_names where name = p_tz) then
    raise exception 'unknown time zone' using errcode = '22023';
  end if;
  return p_tz;
end $$;

-- Make an event repeat: the event becomes the first occurrence; copies follow until p_until (inclusive,
-- in the caller's time zone). Returns the new series id.
create or replace function weft.repeat_event(p_event uuid, p_repeats text, p_until date, p_tz text default 'UTC')
returns uuid
language plpgsql security invoker set search_path = weft, weft_private, pg_temp as $$
declare e weft.events; v_series uuid; v_base timestamp; v_len interval; v_step interval; v_at timestamptz; n int := 1;
begin
  select * into e from weft.events where id = p_event;
  if not found or not weft_private.can_edit(e.space_id) then
    raise exception 'no event you can change with that id' using errcode = '42501';
  end if;
  if p_repeats is null or p_repeats not in ('daily', 'weekly', 'monthly') then
    raise exception 'an event repeats daily, weekly or monthly' using errcode = '22023';
  end if;
  perform weft_private.check_tz(p_tz);
  if e.series_id is not null then
    raise exception 'this event already repeats' using errcode = '22023';
  end if;
  v_base := e.starts_at at time zone p_tz;
  v_len := e.ends_at - e.starts_at;
  if p_until is null or p_until <= v_base::date then
    raise exception 'the last day must be after the first event' using errcode = '22023';
  end if;
  if p_until > (v_base::date + interval '1 year')::date then
    raise exception 'an event can repeat for at most a year' using errcode = '22023';
  end if;
  v_step := case p_repeats when 'daily' then interval '1 day' when 'weekly' then interval '7 days' else interval '1 month' end;

  insert into weft.event_series (space_id, repeats, until_on, tz) values (e.space_id, p_repeats, p_until, p_tz)
  returning id into v_series;
  perform set_config('weft.quiet', 'events', true);
  update weft.events set series_id = v_series where id = e.id;
  loop
    exit when (v_base + v_step * n)::date > p_until;
    v_at := (v_base + v_step * n) at time zone p_tz;
    insert into weft.events (space_id, title, starts_at, ends_at, location, item_id, series_id)
    values (e.space_id, e.title, v_at, v_at + v_len, e.location, e.item_id, v_series);
    n := n + 1;
  end loop;
  perform set_config('weft.quiet', '', true);
  perform pg_notify('weft_events', json_build_object('t', 'events', 'op', 'UPDATE', 'id', e.id, 'space', e.space_id)::text);
  return v_series;
end $$;

-- Change every occurrence of p_event's series: the title and place (null keeps each one's own; an empty
-- place clears it), and the time, shifted by as much as p_event moved (in the series' time zone) and with
-- p_event's new length. Returns how many changed.
create or replace function weft.change_series(p_event uuid, p_title text, p_location text, p_starts timestamptz, p_ends timestamptz)
returns int
language plpgsql security invoker set search_path = weft, weft_private, pg_temp as $$
declare e weft.events; s weft.event_series; v_shift interval; v_len interval; v_count int;
begin
  select * into e from weft.events where id = p_event;
  if not found or not weft_private.can_edit(e.space_id) then
    raise exception 'no event you can change with that id' using errcode = '42501';
  end if;
  select * into s from weft.event_series where id = e.series_id;
  if not found then
    raise exception 'this event does not repeat' using errcode = '22023';
  end if;
  if p_title is not null and length(btrim(p_title)) = 0 then
    raise exception 'an event needs a title' using errcode = '22023';
  end if;
  if p_starts is null or p_ends is null or p_ends < p_starts then
    raise exception 'an event must end after it starts' using errcode = '22023';
  end if;
  v_shift := (p_starts at time zone s.tz) - (e.starts_at at time zone s.tz);
  v_len := p_ends - p_starts;
  perform set_config('weft.quiet', 'events', true);
  update weft.events x set title = coalesce(btrim(p_title), x.title),
         location = case when p_location is null then x.location else nullif(btrim(p_location), '') end,
         starts_at = ((x.starts_at at time zone s.tz) + v_shift) at time zone s.tz,
         ends_at = (((x.starts_at at time zone s.tz) + v_shift) at time zone s.tz) + v_len
   where x.series_id = s.id;
  get diagnostics v_count = row_count;
  perform set_config('weft.quiet', '', true);
  perform pg_notify('weft_events', json_build_object('t', 'events', 'op', 'UPDATE', 'id', e.id, 'space', e.space_id)::text);
  return v_count;
end $$;

-- Delete every occurrence of p_event's series, and the series. Returns how many events went.
create or replace function weft.delete_series(p_event uuid)
returns int
language plpgsql security invoker set search_path = weft, weft_private, pg_temp as $$
declare e weft.events; v_count int;
begin
  select * into e from weft.events where id = p_event;
  if not found or not weft_private.can_edit(e.space_id) then
    raise exception 'no event you can change with that id' using errcode = '42501';
  end if;
  if e.series_id is null then
    raise exception 'this event does not repeat' using errcode = '22023';
  end if;
  perform set_config('weft.quiet', 'events', true);
  delete from weft.events where series_id = e.series_id;
  get diagnostics v_count = row_count;
  delete from weft.event_series where id = e.series_id;
  perform set_config('weft.quiet', '', true);
  perform pg_notify('weft_events', json_build_object('t', 'events', 'op', 'DELETE', 'id', e.id, 'space', e.space_id)::text);
  return v_count;
end $$;

revoke execute on function weft.repeat_event(uuid, text, date, text), weft.change_series(uuid, text, text, timestamptz, timestamptz),
  weft.delete_series(uuid) from public, weft_assistant;
grant execute on function weft.repeat_event(uuid, text, date, text), weft.change_series(uuid, text, text, timestamptz, timestamptz),
  weft.delete_series(uuid) to weft_user;
revoke execute on function weft_private.check_tz(text) from public, weft_assistant;
grant execute on function weft_private.check_tz(text) to weft_user;
revoke execute on function weft_private.events_series_guard() from public, weft_user, weft_assistant;
