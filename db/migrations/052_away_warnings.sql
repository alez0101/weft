-- 052 away warnings: when someone is picked for a task, put on a shift or made a meeting action owner on a
-- day their time off covers, the screens show a gentle "Pat is away then" next to the choice.
--   * Nothing new is stored. weft.away_between(from, to) is one read helper: who is away on which days in a
--     window, from weft.time_off (040), as (user_id, starts_on, ends_on). No note and no channel, and the same
--     person and days recorded in two channels come back once.
--   * It runs as the caller (security invoker), so time off's own row-level security decides: you only get
--     warnings from time off in channels you are a member of (viewers included), and a channel-scoped token
--     only from that channel. No security definer, nothing read across spaces.
--   * A window must be given, end on or after its start, and span at most 400 days; anything else returns
--     nothing. At most 2000 rows.
--   * Only weft_user may call it. The assistant role keeps reading time off directly (040) and has no use
--     for warnings. Nothing to write, so nothing to forge, delete or move: a warning simply follows the time
--     off it comes from (moved, changed or removed there, it changes here, live through the time_off notice).
set client_min_messages = warning;

create or replace function weft.away_between(p_from date, p_to date)
returns table (user_id uuid, starts_on date, ends_on date)
language sql stable security invoker set search_path = weft, weft_private, pg_temp as $$
  select distinct t.user_id, t.starts_on, t.ends_on
    from weft.time_off t
   where p_from is not null and p_to is not null and p_to >= p_from and p_to - p_from <= 400
     and t.starts_on <= p_to and t.ends_on >= p_from
   order by t.starts_on, t.ends_on, t.user_id
   limit 2000
$$;

revoke execute on function weft.away_between(date, date) from public, weft_assistant;
grant execute on function weft.away_between(date, date) to weft_user;
