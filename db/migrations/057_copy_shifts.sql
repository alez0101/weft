-- 057 copy shifts: editors copy every shift of a day or a week in a channel's Shifts (032) to a later date, with
-- no sign-ups, so a regular rota is not typed in again every week.
--   * No new table. weft.copy_shifts reads the channel's shifts that start on the chosen days and inserts an
--     ordinary weft.shifts row for each, the same number of days later, so 032 decides everything that matters:
--     the policies (editors and owners of the channel add shifts), the guard (channels only, ends in the future,
--     at most 7 days, title trimmed, created_at by the database), created_by (the caller, never sent), the live
--     notices, the audit log and search. Sign-ups are never copied: every copy starts empty.
--   * It runs as the caller (security invoker), so it reads only what the caller may read and writes only where
--     the caller may write. Someone who may not edit the channel gets one refusal, whether the channel exists or
--     not, and learns nothing about its shifts.
--   * Days are counted in the caller's time zone, so a 19:00 shift stays at 19:00 across clock changes. A day or
--     a week (1 to 7 days) is copied to a later date, at most 52 weeks on; at most 300 shifts at once.
--   * A copy that is already there (same channel, title, start and end) is not made twice, so pressing the
--     button again does nothing; a copy that would already have ended is skipped. The answer counts both.
--   * One live notice for the whole copy (announce() skips shifts inside, via weft.quiet from 049).
--   * The assistant role cannot copy (it does not execute the function); it still only reads shifts.
set client_min_messages = warning;

-- Copy the shifts in p_space that start on p_days days from p_from (in p_tz) to the same times p_to - p_from
-- days later. Returns {"copied": n, "already": n, "past": n, "first": id of the first copy or null}.
create or replace function weft.copy_shifts(p_space uuid, p_from date, p_days int, p_to date, p_tz text default 'UTC')
returns jsonb
language plpgsql security invoker set search_path = weft, weft_private, pg_temp as $$
declare v_shift int; s record; v_start timestamptz; v_end timestamptz; v_id uuid; v_first uuid;
        v_copied int := 0; v_already int := 0; v_past int := 0; v_count int;
begin
  if p_space is null or not weft_private.can_edit(p_space) then
    raise exception 'no channel where you can add shifts with that id' using errcode = '42501';
  end if;
  if p_days is null or p_days < 1 or p_days > 7 then
    raise exception 'copy a day or a week: 1 to 7 days' using errcode = '22023';
  end if;
  perform weft_private.check_tz(p_tz);
  if p_from is null or p_to is null or p_to <= p_from then
    raise exception 'copy to a later date' using errcode = '22023';
  end if;
  v_shift := p_to - p_from;
  if v_shift > 364 then
    raise exception 'copy at most 52 weeks ahead' using errcode = '22023';
  end if;

  select count(*) into v_count from weft.shifts x
   where x.space_id = p_space and (x.starts_at at time zone p_tz)::date between p_from and p_from + (p_days - 1);
  if v_count > 300 then
    raise exception 'that is % shifts; copy at most 300 at once', v_count using errcode = '22023';
  end if;

  perform set_config('weft.quiet', 'shifts', true);
  -- The source is read in full before anything is inserted, so copies landing inside the chosen days (a week
  -- copied 3 days on) are not copied again.
  for s in select x.title, x.starts_at, x.ends_at, x.places, x.note from weft.shifts x
            where x.space_id = p_space and (x.starts_at at time zone p_tz)::date between p_from and p_from + (p_days - 1)
            order by x.starts_at, x.title loop
    v_start := ((s.starts_at at time zone p_tz) + make_interval(days => v_shift)) at time zone p_tz;
    v_end := ((s.ends_at at time zone p_tz) + make_interval(days => v_shift)) at time zone p_tz;
    if v_end <= now() then
      v_past := v_past + 1;
    elsif exists (select 1 from weft.shifts y where y.space_id = p_space and y.title = s.title
                    and y.starts_at = v_start and y.ends_at = v_end) then
      v_already := v_already + 1;
    else
      insert into weft.shifts (space_id, title, starts_at, ends_at, places, note)
      values (p_space, s.title, v_start, v_end, s.places, s.note) returning id into v_id;
      v_first := coalesce(v_first, v_id);
      v_copied := v_copied + 1;
    end if;
  end loop;
  perform set_config('weft.quiet', '', true);

  if v_first is not null then
    perform pg_notify('weft_events', json_build_object('t', 'shifts', 'op', 'INSERT', 'id', v_first, 'space', p_space)::text);
  end if;
  return jsonb_build_object('copied', v_copied, 'already', v_already, 'past', v_past, 'first', v_first);
end $$;

revoke execute on function weft.copy_shifts(uuid, date, int, date, text) from public, weft_assistant;
grant execute on function weft.copy_shifts(uuid, date, int, date, text) to weft_user;
