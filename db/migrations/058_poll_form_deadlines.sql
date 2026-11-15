-- 058 poll and form deadlines: a poll (023) or a form (024) can carry a "closes at" time, after which it is
-- closed by itself.
--   * One column each, weft.polls.closes_at and weft.forms.closes_at (timestamptz, optional). No new table: the
--     row already reaches its space through the item, so the 023/024 policies decide who sees it (members) and
--     who sets it (editors and owners, the same rule as closing), unchanged.
--   * No background job. A poll or form whose time has passed counts as closed wherever "closed" is checked:
--     poll_closed() and form_closed() (and so the guards that refuse votes, answers, and changes to choices and
--     questions), the screens and the Home widgets. The stored `closed` flag stays what an editor last set.
--   * A closing time that is set or changed must be in the future and at most a year ahead; one already set
--     stays, so a poll that closed by itself can still be edited otherwise. Reopening (closed going from true to
--     false) clears a time that has passed; to reopen a poll or form that closed by itself, clear the time.
--   * The text summary (search and the assistant) says "open until YYYY-MM-DD HH:MM UTC" or "closed".
--   * Live updates, the audit log and the assistant's read-only access are 023/024's, unchanged.
set client_min_messages = warning;

alter table weft.polls add column if not exists closes_at timestamptz;
alter table weft.forms add column if not exists closes_at timestamptz;

-- Column grants: 023/024's plus closes_at (still never closed_at or closed_by).
grant update (closes_at) on weft.polls to weft_user;
grant update (closes_at) on weft.forms to weft_user;

-- Closed by hand, or by the time.
create or replace function weft_private.poll_closed(p_poll uuid) returns boolean
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select coalesce((select closed or coalesce(closes_at <= now(), false) from weft.polls where id = p_poll), false)
$$;
create or replace function weft_private.form_closed(p_form uuid) returns boolean
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select coalesce((select closed or coalesce(closes_at <= now(), false) from weft.forms where id = p_form), false)
$$;

-- The open/closed row of a poll or a form (both have the same columns, so one trigger serves both). It replaces
-- the first branch of the 023/024 guards (who closed it and when, stamped here) and adds the closing time.
-- Only editors reach it: row-level security refuses everyone else first.
create or replace function weft_private.deadline_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
begin
  if new.closed and not old.closed then new.closed_at := now(); new.closed_by := weft_private.uid();
  elsif not new.closed then new.closed_at := null; new.closed_by := null;
  else new.closed_at := old.closed_at; new.closed_by := old.closed_by; end if;
  if new.closes_at is distinct from old.closes_at and new.closes_at is not null then
    if new.closes_at <= now() then
      raise exception 'the closing time must be in the future' using errcode = '22023';
    elsif new.closes_at > now() + interval '1 year' then
      raise exception 'the closing time must be within a year' using errcode = '22023';
    end if;
  end if;
  -- reopening by hand clears a time that has already passed, so the reopened poll or form is really open
  if old.closed and not new.closed and new.closes_at <= now() then new.closes_at := null; end if;
  return new;
end $$;
drop trigger if exists polls_guard on weft.polls;
create trigger polls_guard before update on weft.polls for each row execute function weft_private.deadline_guard();
drop trigger if exists forms_guard on weft.forms;
create trigger forms_guard before update on weft.forms for each row execute function weft_private.deadline_guard();

-- "open until 2026-11-20 17:00 UTC" while a time is set and has not passed; "closed" once it has.
create or replace function weft_private.deadline_words(p_closed boolean, p_closes_at timestamptz) returns text
language sql stable set search_path = pg_catalog, pg_temp as $$
  select case when p_closed or p_closes_at <= now() then 'closed'
              when p_closes_at is not null then 'open until ' || to_char(p_closes_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC'
              else 'open' end
$$;

-- 023's summary, with the closing time.
create or replace function weft_private.refresh_poll_text(p_poll uuid) returns void
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare t text; n int; s text;
begin
  select count(*) into n from weft.poll_votes where poll_id = p_poll;
  select weft_private.deadline_words(closed, closes_at) into s from weft.polls where id = p_poll;
  select concat_ws(E'\n',
           'Poll, ' || coalesce(s, 'open')
             || ', ' || n || case when n = 1 then ' vote' else ' votes' end,
           string_agg(c.label || ': ' || c.votes || case when c.votes = 1 then ' vote' else ' votes' end, E'\n' order by c.position, c.created_at))
    into t
    from (select c.label, c.position, c.created_at, (select count(*) from weft.poll_votes v where v.choice_id = c.id) as votes
            from weft.poll_choices c where c.poll_id = p_poll limit 50) c;
  update weft.items set body_text = t where id = p_poll and body_text is distinct from t;
end $$;

-- 024's summary, with the closing time (still never the answers).
create or replace function weft_private.refresh_form_text(p_form uuid) returns void
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare t text; n int; s text;
begin
  select count(*) into n from weft.form_responses where form_id = p_form;
  select weft_private.deadline_words(closed, closes_at) into s from weft.forms where id = p_form;
  select concat_ws(E'\n',
           'Form, ' || coalesce(s, 'open')
             || ', ' || n || case when n = 1 then ' answer' else ' answers' end,
           string_agg(q.label
             || case when q.kind = 'choice' then ' (one of: ' || (select string_agg(o, ', ') from jsonb_array_elements_text(q.options) o) || ')' else '' end
             || case when q.required then ' (required)' else '' end, E'\n' order by q.position, q.created_at))
    into t
    from (select * from weft.form_questions where form_id = p_form order by position, created_at limit 50) q;
  update weft.items set body_text = t where id = p_form and body_text is distinct from t;
end $$;

revoke execute on function weft_private.deadline_guard(), weft_private.refresh_poll_text(uuid), weft_private.refresh_form_text(uuid)
  from public, weft_user, weft_assistant;
grant execute on function weft_private.refresh_poll_text(uuid), weft_private.refresh_form_text(uuid) to weft_owner;
