-- 073 assistant content: @Weft may propose creating documents, wiki pages, spreadsheets, tables and task
-- lists, and editing documents, wiki pages, tables and task lists. As before, nothing happens until the
-- person who asked confirms, and the change then runs with that person's own token, so row-level security
-- decides exactly as if they had done it by hand (editor or owner of the space; never a managed page).
set client_min_messages = warning;

alter table weft_private.proposals drop constraint if exists proposals_kind_check;
alter table weft_private.proposals add constraint proposals_kind_check
  check (kind in ('send', 'change', 'create', 'create_item', 'edit_page', 'add_rows', 'add_tasks'));

-- Statuses now also name the item a confirmed proposal made or changed, so the chat can link to it.
drop function if exists weft_private.proposal_statuses(uuid, uuid[]);
create function weft_private.proposal_statuses(p_asker uuid, p_ids uuid[])
returns table (id uuid, status text, result text, kind text, item_id uuid)
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select p.id, p.status, p.result, p.kind,
         case when p.status = 'done' and p.kind in ('create_item', 'edit_page', 'add_rows', 'add_tasks')
              then coalesce(p.before ->> 'item_id', p.payload ->> 'item_id')::uuid end
    from weft_private.proposals p where p.asker = p_asker and p.id = any (p_ids)
$$;
revoke execute on function weft_private.proposal_statuses(uuid, uuid[]) from public, weft_user, weft_assistant;
grant execute on function weft_private.proposal_statuses(uuid, uuid[]) to weft_assist;
