-- 056 repeating bookings: a booking in Bookings (031) can repeat weekly for a number of weeks; the weeks that
-- clash with another booking of the thing are refused, the rest are booked, and the answer says which is which.
--   * Each week is an ordinary weft.bookings row, so 031 decides everything that matters: the policies (editors
--     and owners of the channel book, the booker or an owner changes and cancels, members read), the guard
--     (ends in the future, at most 31 days, a plain answer on a clash) and the exclusion constraint (no double
--     booking, even when two people race). The Calendar, Home, search and the audit log keep working per week.
--   * weft.booking_series groups the weeks: the thing, its channel (copied from the thing by the database, never
--     sent), how many weeks were asked for, the time zone, who made it. Members read it; editors and owners make
--     one; nobody changes or deletes it; it goes (with its bookings) only when the thing or the channel goes. Bookings point to it with series_id
--     (set only when a booking is made, never changed), and only to a series their booker made for the same thing.
--   * weft.book_weekly runs as the caller (security invoker), so nothing new can be got wrong: a viewer or an
--     outsider gets one refusal, whether the thing exists or not. Weeks are counted in the caller's time zone, so
--     a 19:00 booking stays at 19:00 across clock changes. 2 to 26 weeks; each week lasts at most 7 days (longer
--     would clash with itself). If every week clashes, nothing is made and the refusal lists the dates.
--   * One live notice for the whole series (announce() skips bookings inside, via weft.quiet from 049).
--   * Cancelling "this and the later ones" is an ordinary delete of bookings by series_id, so 031's cancel policy
--     and its rule that an ended booking is fixed still apply.
--   * The assistant role reads series, cannot make them, and still only reads bookings.
set client_min_messages = warning;

create table if not exists weft.booking_series (
  id          uuid primary key default gen_random_uuid(),
  resource_id uuid not null references weft.resources (id) on delete cascade,
  space_id    uuid not null references weft.spaces (id) on delete cascade,
  weeks       int not null check (weeks between 2 and 26),
  tz          text not null default 'UTC' check (length(tz) between 1 and 64),
  created_by  uuid not null default weft_private.uid() references weft.users (id),
  created_at  timestamptz not null default now()
);
create index if not exists booking_series_space_idx on weft.booking_series (space_id);
create index if not exists booking_series_resource_idx on weft.booking_series (resource_id);

alter table weft.bookings add column if not exists series_id uuid references weft.booking_series (id) on delete cascade;
create index if not exists bookings_series_idx on weft.bookings (series_id) where series_id is not null;

alter table weft.booking_series enable row level security;
alter table weft.booking_series force row level security;
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'weft' and tablename = 'booking_series' loop
    execute format('drop policy %I on weft.booking_series', p.policyname);
  end loop;
end $$;
create policy booking_series_read on weft.booking_series for select to weft_user, weft_assistant
  using (weft_private.is_member(space_id));
create policy booking_series_add on weft.booking_series for insert to weft_user
  with check (created_by = weft_private.uid() and weft_private.can_edit(space_id));

-- No updates or deletes by people. space_id, created_by and created_at are never granted.
grant select on weft.booking_series to weft_user, weft_assistant;
grant insert (resource_id, weeks, tz) on weft.booking_series to weft_user;
-- series_id can be set when a booking is made, never changed afterwards.
grant insert (series_id) on weft.bookings to weft_user;

-- Before a series is made: its channel is the thing's; the creation time is the database's. Like the bookings
-- guard, a thing the caller cannot book gets the same answer as a thing that does not exist.
create or replace function weft_private.booking_series_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare v_space uuid;
begin
  select space_id into v_space from weft.resources where id = new.resource_id;
  if v_space is null then
    raise exception 'new row violates row-level security policy for table "booking_series"' using errcode = '42501';
  end if;
  new.space_id := v_space;
  new.created_at := now();
  return new;
end $$;
drop trigger if exists booking_series_guard on weft.booking_series;
create trigger booking_series_guard before insert on weft.booking_series
  for each row execute function weft_private.booking_series_guard();

-- Before a booking is made with a series: the series must be the booker's own, for the same thing. Runs as
-- the caller, after 031's guard has set the booking's channel; someone who may not book there is refused by
-- the policy instead, so this says nothing to them.
create or replace function weft_private.bookings_series_guard() returns trigger
language plpgsql set search_path = weft, weft_private, pg_temp as $$
begin
  if tg_op = 'UPDATE' then
    new.series_id := old.series_id;
    return new;
  end if;
  if new.series_id is not null and weft_private.can_edit(new.space_id) and not exists (
       select 1 from weft.booking_series s
        where s.id = new.series_id and s.resource_id = new.resource_id and s.created_by = weft_private.uid()) then
    raise exception 'that series is not yours for this thing' using errcode = '22023';
  end if;
  return new;
end $$;
drop trigger if exists bookings_series_guard on weft.bookings;
create trigger bookings_series_guard before insert or update on weft.bookings
  for each row execute function weft_private.bookings_series_guard();

-- Live notices and the audit log, as for bookings.
drop trigger if exists announce_booking_series on weft.booking_series;
create trigger announce_booking_series after insert or update or delete on weft.booking_series
  for each row execute function weft_private.announce();
drop trigger if exists audit_booking_series on weft.booking_series;
create trigger audit_booking_series after update or delete on weft.booking_series
  for each row execute function weft_private.audit_row();

-- Book p_resource from p_starts to p_ends, and the same time every week after, p_weeks bookings in all.
-- Returns {"series": id, "booked": [{id, starts_at, ends_at}], "clashed": [{starts_at, ends_at, by}]}.
-- Errors other than a clash (the first week has ended, too long, a long note) refuse the whole series.
create or replace function weft.book_weekly(p_resource uuid, p_starts timestamptz, p_ends timestamptz,
                                            p_weeks int, p_note text default '', p_tz text default 'UTC')
returns jsonb
language plpgsql security invoker set search_path = weft, weft_private, pg_temp as $$
declare r weft.resources; v_series uuid; v_len interval; v_at timestamptz; v_id uuid; v_by text; v_first uuid;
        v_booked jsonb := '[]'; v_clashed jsonb := '[]'; v_dates text;
begin
  select * into r from weft.resources where id = p_resource;
  if not found or not weft_private.can_edit(r.space_id) then
    raise exception 'no thing you can book with that id' using errcode = '42501';
  end if;
  if p_weeks is null or p_weeks < 2 or p_weeks > 26 then
    raise exception 'a booking can repeat for 2 to 26 weeks' using errcode = '22023';
  end if;
  perform weft_private.check_tz(p_tz);
  if p_starts is null or p_ends is null or p_ends <= p_starts then
    raise exception 'a booking must end after it starts' using errcode = '22023';
  end if;
  v_len := p_ends - p_starts;
  if v_len > interval '7 days' then
    raise exception 'a weekly booking can last at most 7 days' using errcode = '22023';
  end if;

  insert into weft.booking_series (resource_id, weeks, tz) values (p_resource, p_weeks, p_tz) returning id into v_series;
  perform set_config('weft.quiet', 'bookings', true);
  for i in 0 .. p_weeks - 1 loop
    v_at := ((p_starts at time zone p_tz) + interval '7 days' * i) at time zone p_tz;
    begin
      insert into weft.bookings (resource_id, starts_at, ends_at, note, series_id)
      values (p_resource, v_at, v_at + v_len, coalesce(p_note, ''), v_series) returning id into v_id;
      v_first := coalesce(v_first, v_id);
      v_booked := v_booked || jsonb_build_object('id', v_id, 'starts_at', v_at, 'ends_at', v_at + v_len);
    exception when exclusion_violation then
      select u.display_name into v_by from weft.bookings b left join weft.users u on u.id = b.booked_by
       where b.resource_id = p_resource and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(v_at, v_at + v_len, '[)')
       order by b.starts_at limit 1;
      v_clashed := v_clashed || jsonb_build_object('starts_at', v_at, 'ends_at', v_at + v_len, 'by', v_by);
    end;
  end loop;
  perform set_config('weft.quiet', '', true);

  if v_first is null then
    select string_agg(to_char((x ->> 'starts_at')::timestamptz at time zone p_tz, 'YYYY-MM-DD'), ', ')
      into v_dates from jsonb_array_elements(v_clashed) x;
    raise exception 'every week clashes with another booking: %', v_dates using errcode = '23P01';
  end if;
  perform pg_notify('weft_events', json_build_object('t', 'bookings', 'op', 'INSERT', 'id', v_first, 'space', r.space_id)::text);
  return jsonb_build_object('series', v_series, 'booked', v_booked, 'clashed', v_clashed);
end $$;

revoke execute on function weft.book_weekly(uuid, timestamptz, timestamptz, int, text, text) from public, weft_assistant;
grant execute on function weft.book_weekly(uuid, timestamptz, timestamptz, int, text, text) to weft_user;
revoke execute on function weft_private.booking_series_guard(), weft_private.bookings_series_guard() from public, weft_user, weft_assistant;
