-- 011: the assistant may propose creating an event (Alex, 2026-11-12: "can you schedule an event?").
-- Still confirmation-gated, still subject to row-level security: it creates only where the asker can
-- edit, and only inside the token's scope. The assistant still cannot delete; undoing a created event
-- is a delete performed with the asker's own token, after they press Undo.
set client_min_messages = warning;

grant insert (space_id, title, starts_at, ends_at, location, item_id) on weft.events to weft_assistant;
drop policy if exists events_create_assistant on weft.events;
create policy events_create_assistant on weft.events for insert to weft_assistant
  with check (created_by = weft_private.uid() and weft_private.can_edit(space_id));

alter table weft_private.proposals drop constraint if exists proposals_kind_check;
alter table weft_private.proposals add constraint proposals_kind_check check (kind in ('send', 'change', 'create'));
