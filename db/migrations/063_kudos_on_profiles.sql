-- 063 kudos on profiles: the recent kudos a person received, on their card in Profiles, only from channels the
-- viewer is also in.
-- What this adds:
--   * weft.kudos_received, a read-only view over weft.kudos (045): every kudos with, per person it is for, its
--     place newest first (n = 1 is the newest) and how many there are (received). Profiles asks for n <= 3.
--   * security_invoker: the caller's row-level security on weft.kudos (weft_private.is_member() of the
--     channel, so the channel-scope claim and disabled accounts apply) decides which rows exist before they
--     are numbered and counted. A kudos from a channel you are not in is not shown, does not push another one
--     out of the newest three and is not in the count. No new table, policy or function.
--   * Nobody writes through it: select only, for people and the assistant role. Giving, rewording and
--     deleting stay in the Kudos app, under its own rules.
--   * Live: a change to a kudos already sends a kudos notice to the channel's members only (045, 006); the
--     Profiles screen refetches.
set client_min_messages = warning;

create or replace view weft.kudos_received with (security_invoker = true) as
  select k.id, k.to_user, k.space_id, k.message, k.created_by, k.created_at, k.updated_at,
         row_number() over (partition by k.to_user order by k.created_at desc, k.id) as n,
         count(*) over (partition by k.to_user) as received
  from weft.kudos k;

revoke all on weft.kudos_received from public;
grant select on weft.kudos_received to weft_user, weft_assistant;
