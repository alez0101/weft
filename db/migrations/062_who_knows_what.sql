-- 062 who knows what: answer "who has a van licence?" (and "who in #festival does?") from the profiles of the
-- people you share a space with.
-- What this adds:
--   * weft.skill_holders, a read-only view: one row per skill, person and space, for every space the person is
--     in that the caller can see (skill, user_id, space_id). Profiles (034) keep the skills; nothing is copied.
--   * security_invoker: the caller's row-level security on weft.profiles, weft.members and weft.users decides
--     every row. A profile is read only if its owner shares a space with you, and a membership only if you are
--     in that space (both through weft_private.is_member(), so the channel-scope claim and disabled accounts
--     apply). A space you are not in never appears, so asking "who in Organizers knows first aid?" when you
--     are not in Organizers returns nothing, not even a count. No new policy, table or function.
--   * Disabled accounts and the assistant account are left out, as on the Profiles screen.
--   * Nobody writes through it: select only, for people and the assistant role.
--   * Live: a change to a profile or a membership already sends a profiles or members notice to co-members
--     only (034, 006); the screen refetches.
set client_min_messages = warning;

create or replace view weft.skill_holders with (security_invoker = true) as
  select s.skill, p.user_id, m.space_id
  from weft.profiles p
  cross join lateral unnest(p.skills) as s(skill)
  join weft.members m on m.user_id = p.user_id
  join weft.users u on u.id = p.user_id
  where not u.disabled and not u.is_assistant;

revoke all on weft.skill_holders from public;
grant select on weft.skill_holders to weft_user, weft_assistant;

