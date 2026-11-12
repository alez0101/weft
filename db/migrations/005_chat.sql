-- 005 chat: read markers, unread and mention counts.
set client_min_messages = warning;

-- One row per person per space: when they last read it.
create table if not exists weft.reads (
  space_id     uuid not null references weft.spaces (id) on delete cascade,
  user_id      uuid not null default weft_private.uid() references weft.users (id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (space_id, user_id)
);
alter table weft.reads enable row level security;
alter table weft.reads force row level security;
drop policy if exists reads_own on weft.reads;
create policy reads_own on weft.reads for all to weft_user
  using (user_id = weft_private.uid() and weft_private.is_member(space_id))
  with check (user_id = weft_private.uid() and weft_private.is_member(space_id));
grant select, insert (space_id, last_read_at), update (space_id, last_read_at) on weft.reads to weft_user;

-- Unread and @mention counts per space you can see. security_invoker: RLS of the caller applies,
-- so the counts can never include messages from spaces the caller is not in.
-- A mention is "@" followed by the first word of your display name (case-insensitive).
create or replace view weft.unread with (security_invoker = true) as
select m.space_id,
       count(*) filter (where m.created_at > coalesce(r.last_read_at, '-infinity')
                          and m.author_id <> weft_private.uid())::int as unread,
       count(*) filter (where m.created_at > coalesce(r.last_read_at, '-infinity')
                          and m.author_id <> weft_private.uid()
                          and m.body ~* ('@' || split_part(me.display_name, ' ', 1) || '\M'))::int as mentions
from weft.messages m
left join weft.reads r on r.space_id = m.space_id and r.user_id = weft_private.uid()
cross join lateral (select display_name from weft.users where id = weft_private.uid()) me
group by m.space_id;
grant select on weft.unread to weft_user;
