set client_min_messages = warning;
-- 004 triggers: audit trail, space creators become owners, items keep updated_at.

-- Every update and delete on messages, items and events keeps the old row.
-- security definer so the insert works although no request role may write to audit.
-- actor_role is the role the request switched to (weft_user / weft_assistant), not the definer.
create or replace function weft_private.audit_row() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  insert into weft.audit (table_name, row_id, space_id, op, actor_id, actor_role, old_row)
  values (tg_table_name, old.id, old.space_id, tg_op, weft_private.uid(),
          coalesce(nullif(current_setting('role', true), 'none'), session_user), to_jsonb(old));
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['messages', 'items', 'events'] loop
    execute format('drop trigger if exists audit_%1$s on weft.%1$I', t);
    execute format('create trigger audit_%1$s after update or delete on weft.%1$I
                    for each row execute function weft_private.audit_row()', t);
  end loop;
end $$;

-- Whoever creates a space owns it.
create or replace function weft_private.add_creator() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  insert into weft.members (space_id, user_id, role)
  values (new.id, new.created_by, 'owner')
  on conflict do nothing;
  return null;
end $$;

drop trigger if exists spaces_add_creator on weft.spaces;
create trigger spaces_add_creator after insert on weft.spaces
  for each row execute function weft_private.add_creator();

create or replace function weft_private.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists items_touch on weft.items;
create trigger items_touch before update on weft.items
  for each row execute function weft_private.touch_updated_at();

-- Trigger functions are not callable through the API.
revoke execute on function weft_private.audit_row(), weft_private.add_creator(),
  weft_private.touch_updated_at() from weft_user, weft_assistant;
