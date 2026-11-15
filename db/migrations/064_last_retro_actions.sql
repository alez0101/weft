-- 064 last retro's actions: in a retro, the actions of the previous retro in the same space, with whether their
-- tasks are done, so the team checks follow-through first.
-- What this adds:
--   * weft.retro_previous_actions, a read-only view: for every retro (retro_id), the previous retro in the same
--     space (the newest one made before it: previous_id, its title and period) and one row per action note in
--     it, with the action's text and its task's state (title, done, assignee, due date) if it became one. A
--     previous retro with no actions gives one row with an empty note_id; a retro with no previous one gives
--     no rows.
--   * security_invoker: the caller's row-level security on weft.items, weft.retros, weft.retro_notes and
--     weft.tasks (all built on weft_private.is_member(), so the channel-scope claim and disabled accounts
--     apply) decides every row. The previous retro is looked for only in the retro's own space, among retros
--     the caller can see, so it never reaches into another space. No new table, policy or function.
--   * It never carries who wrote a note (created_by is not readable, author_id is left out): an anonymous
--     action stays anonymous, and a named one is shown without a name too.
--   * Nobody writes through it: select only, for people and the assistant role. Carrying an action over into
--     the new retro is an ordinary note (042), under the Retros rules.
--   * Live: changes to retros, notes and tasks already send notices to the space's members only (042, 022);
--     the Retros screen refetches.
set client_min_messages = warning;

create or replace view weft.retro_previous_actions with (security_invoker = true) as
  select cur.id as retro_id, cur.space_id,
         prev.id as previous_id, prev.title as previous_title, prev.created_at as previous_created_at,
         pr.period_from as previous_from, pr.period_to as previous_to,
         n.id as note_id, n.body, n.created_at,
         k.id as task_id, k.title as task_title, k.done as task_done, k.assignee_id as task_assignee_id, k.due_on as task_due_on
  from weft.items cur
  cross join lateral (
    select p.id, p.title, p.created_at
      from weft.items p
     where p.kind = 'retro' and p.space_id = cur.space_id
       and (p.created_at, p.id) < (cur.created_at, cur.id)
     order by p.created_at desc, p.id desc
     limit 1
  ) prev
  left join weft.retros pr on pr.id = prev.id
  left join weft.retro_notes n on n.retro_id = prev.id and n.kind = 'action'
  left join weft.tasks k on k.id = n.task_id
  where cur.kind = 'retro';

revoke all on weft.retro_previous_actions from public;
grant select on weft.retro_previous_actions to weft_user, weft_assistant;
