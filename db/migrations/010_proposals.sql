-- 010 proposals: actions the assistant suggests and only the asker can confirm. Phase 6.
-- Kept in weft_private (never exposed through the API); the assistant service reads and writes it
-- through these functions. Executing a confirmed proposal goes through PostgREST with an assistant
-- token for the asker, so row-level security still decides whether the action is allowed.
set client_min_messages = warning;

create table if not exists weft_private.proposals (
  id          uuid primary key default gen_random_uuid(),
  asker       uuid not null,
  space_id    uuid not null,          -- where the answer was posted
  scope_space uuid,                   -- the channel the question was asked in, if any
  kind        text not null check (kind in ('send', 'change')),
  payload     jsonb not null,         -- send: {space_id, text}; change: {event_id, set: {...}}
  summary     text not null,
  status      text not null default 'pending' check (status in ('pending', 'done', 'dismissed', 'failed', 'undone')),
  before      jsonb,                  -- the event's values before a change, for undo
  result      text,
  created_at  timestamptz not null default now(),
  decided_at  timestamptz
);
create index if not exists proposals_asker_idx on weft_private.proposals (asker, created_at);

create or replace function weft_private.proposal_create(p_asker uuid, p_space uuid, p_scope uuid, p_kind text,
  p_payload jsonb, p_summary text) returns uuid
language sql security definer set search_path = weft, weft_private, pg_temp as $$
  insert into weft_private.proposals (asker, space_id, scope_space, kind, payload, summary)
  values (p_asker, p_space, p_scope, p_kind, p_payload, p_summary) returning id
$$;

create or replace function weft_private.proposal_get(p_id uuid) returns setof weft_private.proposals
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select * from weft_private.proposals where id = p_id
$$;

-- Status of several proposals, for the person who asked them only.
create or replace function weft_private.proposal_statuses(p_asker uuid, p_ids uuid[])
returns table (id uuid, status text, result text, kind text)
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select p.id, p.status, p.result, p.kind from weft_private.proposals p where p.asker = p_asker and p.id = any (p_ids)
$$;

-- Move a proposal from one status to another, atomically (a double confirm finds nothing to move).
create or replace function weft_private.proposal_transition(p_id uuid, p_asker uuid, p_from text, p_to text,
  p_result text, p_before jsonb) returns boolean
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare n int;
begin
  update weft_private.proposals
     set status = p_to, result = coalesce(p_result, result), before = coalesce(p_before, before), decided_at = now()
   where id = p_id and asker = p_asker and status = p_from;
  get diagnostics n = row_count;
  return n = 1;
end $$;

revoke execute on function weft_private.proposal_create(uuid, uuid, uuid, text, jsonb, text),
  weft_private.proposal_get(uuid), weft_private.proposal_statuses(uuid, uuid[]),
  weft_private.proposal_transition(uuid, uuid, text, text, text, jsonb)
  from public, weft_user, weft_assistant;
grant execute on function weft_private.proposal_create(uuid, uuid, uuid, text, jsonb, text),
  weft_private.proposal_get(uuid), weft_private.proposal_statuses(uuid, uuid[]),
  weft_private.proposal_transition(uuid, uuid, text, text, text, jsonb)
  to weft_assist;
