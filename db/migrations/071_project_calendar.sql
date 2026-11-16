-- 071 project calendars: events in projects (069 gave events a home project; this makes the calendar use it).
--   * A repeating event's copies are in the same project as the event they were made from (repeat_event below
--     is 049's, plus project_id on the copies).
--   * weft.set_series_project puts every occurrence of a series in a project, or takes them all out (null), as the
--     caller (security invoker), with one live notice. The project must be in the series' own space; the 069
--     trigger checks each row, so a project from elsewhere is refused for someone who may edit, and dropped
--     (then refused by the policies) for anyone else.
set client_min_messages = warning;

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
    insert into weft.events (space_id, title, starts_at, ends_at, location, item_id, series_id, project_id)
    values (e.space_id, e.title, v_at, v_at + v_len, e.location, e.item_id, v_series, e.project_id);
    n := n + 1;
  end loop;
  perform set_config('weft.quiet', '', true);
  perform pg_notify('weft_events', json_build_object('t', 'events', 'op', 'UPDATE', 'id', e.id, 'space', e.space_id)::text);
  return v_series;
end $$;

create or replace function weft.set_series_project(p_event uuid, p_project uuid)
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
  update weft.events set project_id = p_project where series_id = e.series_id;
  get diagnostics v_count = row_count;
  perform set_config('weft.quiet', '', true);
  perform pg_notify('weft_events', json_build_object('t', 'events', 'op', 'UPDATE', 'id', e.id, 'space', e.space_id)::text);
  return v_count;
end $$;

revoke execute on function weft.repeat_event(uuid, text, date, text), weft.set_series_project(uuid, uuid) from public, weft_assistant;
grant execute on function weft.repeat_event(uuid, text, date, text), weft.set_series_project(uuid, uuid) to weft_user;
