-- 014 tables (version 1.5 "Sheets as tables"): typed columns and rows, not a spreadsheet engine.
-- A table is an item (kind 'table'), so it lives in a space. Columns and rows reach the space through
-- their table: you see them only if you can see the table, and change them only if you can edit its
-- space. Cells are written one at a time (weft.set_cell), so two people editing different cells of the
-- same row both keep their change. Every change refreshes the table's text summary (body_text), so
-- search and the assistant can read the rows.
set client_min_messages = warning;

alter table weft.items drop constraint if exists items_kind_check;
alter table weft.items add constraint items_kind_check check (kind in ('document', 'wiki', 'whiteboard', 'table'));

create table if not exists weft.table_columns (
  id         uuid primary key default gen_random_uuid(),
  table_id   uuid not null references weft.items (id) on delete cascade,
  name       text not null check (length(name) between 1 and 80),
  type       text not null check (type in ('text', 'number', 'date', 'checkbox', 'select')),
  options    jsonb not null default '[]'::jsonb,   -- choices for 'select'
  position   double precision not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists table_columns_table_idx on weft.table_columns (table_id, position);

create table if not exists weft.table_rows (
  id         uuid primary key default gen_random_uuid(),
  table_id   uuid not null references weft.items (id) on delete cascade,
  cells      jsonb not null default '{}'::jsonb,   -- {column id: value}
  position   double precision not null default 0,
  created_by uuid not null default weft_private.uid() references weft.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists table_rows_table_idx on weft.table_rows (table_id, position);

-- The space of a table (null if it is not a table). security definer: used inside policies.
create or replace function weft_private.table_space(p_table uuid) returns uuid
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select space_id from weft.items where id = p_table and kind = 'table'
$$;

alter table weft.table_columns enable row level security; alter table weft.table_columns force row level security;
alter table weft.table_rows enable row level security;    alter table weft.table_rows force row level security;
do $$
declare p record;
begin
  for p in select policyname, tablename from pg_policies where schemaname = 'weft' and tablename in ('table_columns', 'table_rows') loop
    execute format('drop policy %I on weft.%I', p.policyname, p.tablename);
  end loop;
end $$;
create policy columns_read on weft.table_columns for select to weft_user, weft_assistant
  using (weft_private.is_member(weft_private.table_space(table_id)));
create policy columns_write on weft.table_columns for all to weft_user
  using (weft_private.can_edit(weft_private.table_space(table_id)))
  with check (weft_private.can_edit(weft_private.table_space(table_id)));
create policy rows_read on weft.table_rows for select to weft_user, weft_assistant
  using (weft_private.is_member(weft_private.table_space(table_id)));
create policy rows_insert on weft.table_rows for insert to weft_user
  with check (created_by = weft_private.uid() and weft_private.can_edit(weft_private.table_space(table_id)));
create policy rows_change on weft.table_rows for update to weft_user
  using (weft_private.can_edit(weft_private.table_space(table_id)))
  with check (weft_private.can_edit(weft_private.table_space(table_id)));
create policy rows_delete on weft.table_rows for delete to weft_user
  using (weft_private.can_edit(weft_private.table_space(table_id)));

grant select on weft.table_columns, weft.table_rows to weft_user, weft_assistant;
grant insert (table_id, name, type, options, position), update (name, type, options, position), delete on weft.table_columns to weft_user;
grant insert (table_id, cells, position), update (cells, position), delete on weft.table_rows to weft_user;
grant execute on function weft_private.table_space(uuid) to weft_user, weft_assistant;

-- One cell at a time, as the caller (security invoker), so RLS applies. Returns 1 if a row changed.
-- A null value clears the cell.
create or replace function weft.set_cell(p_row uuid, p_column uuid, p_value jsonb) returns int
language sql security invoker set search_path = weft, weft_private, pg_temp as $$
  with u as (
    update weft.table_rows
       set cells = case when p_value is null or p_value = 'null'::jsonb then cells - p_column::text
                        else jsonb_set(cells, array[p_column::text], p_value) end
     where id = p_row
       and exists (select 1 from weft.table_columns c where c.id = p_column and c.table_id = table_rows.table_id)
    returning 1)
  select count(*)::int from u
$$;
revoke execute on function weft.set_cell(uuid, uuid, jsonb) from public;
grant execute on function weft.set_cell(uuid, uuid, jsonb) to weft_user;

-- updated_at is stamped by a trigger, so it needs no column grant (a SET on it would be refused).
drop trigger if exists table_rows_touch on weft.table_rows;
create trigger table_rows_touch before update on weft.table_rows for each row execute function weft_private.touch_updated_at();

-- The table's text summary: header, then up to 300 rows as "Column: value; ...".
create or replace function weft_private.refresh_table_text(p_table uuid) returns void
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare t text;
begin
  select string_agg(line, E'\n' order by ord) into t from (
    select 0 as ord, 'Columns: ' || coalesce(string_agg(c.name, ', ' order by c.position), '') as line
      from weft.table_columns c where c.table_id = p_table
    union all
    select row_number() over (order by r.position) as ord,
           (select string_agg(c.name || ': ' || coalesce(r.cells ->> c.id::text, ''), '; ' order by c.position)
              from weft.table_columns c where c.table_id = p_table and r.cells ? c.id::text)
      from (select * from weft.table_rows where table_id = p_table order by position limit 300) r
  ) x where line is not null;
  update weft.items set body_text = t where id = p_table and body_text is distinct from t;
end $$;

create or replace function weft_private.table_changed() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare r record; v_space uuid;
begin
  r := coalesce(new, old);
  v_space := weft_private.table_space(r.table_id);
  if v_space is null then return null; end if;   -- the table itself is being deleted
  perform weft_private.refresh_table_text(r.table_id);
  perform pg_notify('weft_events', json_build_object('t', tg_table_name, 'op', tg_op, 'id', r.id, 'space', v_space, 'table', r.table_id)::text);
  if tg_op in ('UPDATE', 'DELETE') then
    insert into weft.audit (table_name, row_id, space_id, op, actor_id, actor_role, old_row)
    values (tg_table_name, old.id, v_space, tg_op, weft_private.uid(),
            coalesce(nullif(current_setting('role', true), 'none'), session_user), to_jsonb(old));
  end if;
  return null;
end $$;
drop trigger if exists table_columns_changed on weft.table_columns;
create trigger table_columns_changed after insert or update or delete on weft.table_columns for each row execute function weft_private.table_changed();
drop trigger if exists table_rows_changed on weft.table_rows;
create trigger table_rows_changed after insert or update or delete on weft.table_rows for each row execute function weft_private.table_changed();
revoke execute on function weft_private.refresh_table_text(uuid), weft_private.table_changed() from public, weft_user, weft_assistant;
grant execute on function weft_private.refresh_table_text(uuid) to weft_owner;
