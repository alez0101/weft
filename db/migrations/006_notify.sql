-- 006 notify: announce every change on the weft_events channel.
-- A notice carries only the table, the operation, the row id and its space: never content.
-- The browser fetches the row through PostgREST, so RLS decides what anyone sees even if a
-- notice is misrouted. The notification server still forwards notices only to members.
set client_min_messages = warning;

create or replace function weft_private.announce() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare r record;
begin
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

do $$
declare t text;
begin
  foreach t in array array['messages', 'items', 'events', 'members'] loop
    execute format('drop trigger if exists announce_%1$s on weft.%1$I', t);
    execute format('create trigger announce_%1$s after insert or update or delete on weft.%1$I
                    for each row execute function weft_private.announce()', t);
  end loop;
end $$;

revoke execute on function weft_private.announce() from weft_user, weft_assistant;
