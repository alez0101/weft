-- 009 collab: the document co-editing server's login, and an audit trail that suits live editing.
-- Run with: psql -v collab_svc_pw=...
set client_min_messages = warning;

-- weft_collab can do nothing on its own (NOINHERIT). For every load and save it switches, inside a
-- transaction, to weft_user with the editing person's claims, so row-level security decides access
-- exactly as it does for the API.
do $$
begin
  if not exists (select from pg_roles where rolname = 'weft_collab') then
    create role weft_collab login noinherit;
  end if;
end $$;
alter role weft_collab password :'collab_svc_pw';
grant weft_user to weft_collab;
grant usage on schema weft_private to weft_collab;
-- To hear membership changes and close sessions of people who lost access.
grant execute on function weft_private.memberships(uuid) to weft_collab;

-- Audit for a live editor: a save every few seconds would flood the log, and the Yjs state is a
-- binary blob that cannot be meaningfully restored row by row. So for items:
--   * the old row is kept without ydoc (the text in body_text is the history worth keeping)
--   * a save that changed nothing a person would see (title, text, space, parent) is not logged
--   * consecutive saves by the same person within two minutes keep only the first old value
create or replace function weft_private.audit_row() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare j jsonb;
begin
  if tg_table_name = 'items' then
    if tg_op = 'UPDATE' and (old.title, old.body_text, old.space_id, old.parent_id)
                            is not distinct from (new.title, new.body_text, new.space_id, new.parent_id) then
      return null;
    end if;
    if tg_op = 'UPDATE' and exists (
      select 1 from weft.audit a
      where a.table_name = 'items' and a.row_id = old.id and a.actor_id is not distinct from weft_private.uid()
        and a.at > now() - interval '2 minutes') then
      return null;
    end if;
    j := to_jsonb(old) - 'ydoc';
  else
    j := to_jsonb(old);
  end if;
  insert into weft.audit (table_name, row_id, space_id, op, actor_id, actor_role, old_row)
  values (tg_table_name, old.id, old.space_id, tg_op, weft_private.uid(),
          coalesce(nullif(current_setting('role', true), 'none'), session_user), j);
  return null;
end $$;
revoke execute on function weft_private.audit_row() from weft_user, weft_assistant;
