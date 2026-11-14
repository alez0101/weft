-- 038 expenses: who paid what for the group, split evenly or by amounts, with running balances of who
-- owes whom (no payments, just the record).
-- An expense list is an item (kind 'expenselist'), so it lives in a space and gets everything items have:
-- the one permission rule, moving, deleting, sharing links, the audit log, search and the assistant
-- (through the list's text summary in body_text). Its title is the list's name. Its expenses and each
-- expense's shares reach the space through the list: members read all of it, viewers included; editors
-- and owners add, change and delete expenses; the assistant role only reads.
-- Money is whole cents (one unnamed currency per list). Every expense is split into shares that always add
-- up to its amount (checked when the transaction commits, so an expense and its shares are saved together,
-- normally through weft.save_expense); an even split differs by at most one cent. Who paid and everyone
-- in a split must be members of the list's space when they are added; people who later leave stay in the
-- record. Paying someone back is not a payment here: it is written down as another expense.
-- Authorship is set here, never by the client; nothing jumps between lists (move the whole list instead).
set client_min_messages = warning;

alter table weft.items drop constraint if exists items_kind_check;
alter table weft.items add constraint items_kind_check check (kind in ('document', 'wiki', 'whiteboard', 'table', 'file', 'tasklist', 'poll', 'form', 'linklist', 'meeting', 'addressbook', 'decisionlog', 'qa', 'checklist', 'expenselist'));

create table if not exists weft.expenses (
  id            uuid primary key default gen_random_uuid(),
  list_id       uuid not null references weft.items (id) on delete cascade,
  title         text not null check (length(btrim(title)) between 1 and 200),
  amount_cents  bigint not null check (amount_cents between 1 and 100000000),
  paid_by       uuid not null references weft.users (id),
  spent_on      date not null default current_date,
  split         text not null default 'even' check (split in ('even', 'amounts')),
  created_by    uuid not null default weft_private.uid() references weft.users (id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists expenses_list_idx on weft.expenses (list_id, spent_on desc, created_at desc);
create index if not exists expenses_paid_by_idx on weft.expenses (paid_by);

create table if not exists weft.expense_shares (
  expense_id   uuid not null references weft.expenses (id) on delete cascade,
  user_id      uuid not null references weft.users (id),
  share_cents  bigint not null check (share_cents > 0),
  primary key (expense_id, user_id)
);
create index if not exists expense_shares_user_idx on weft.expense_shares (user_id);

-- The space of a list and of an expense (null if there is none). security definer: used inside policies;
-- each returns only a space id.
create or replace function weft_private.expense_list_space(p_list uuid) returns uuid
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select space_id from weft.items where id = p_list and kind = 'expenselist'
$$;
create or replace function weft_private.expense_space(p_expense uuid) returns uuid
language sql stable security definer set search_path = weft, weft_private, pg_temp as $$
  select i.space_id from weft.expenses e join weft.items i on i.id = e.list_id and i.kind = 'expenselist' where e.id = p_expense
$$;

do $$
declare t text; p record;
begin
  foreach t in array array['expenses', 'expense_shares'] loop
    execute format('alter table weft.%I enable row level security', t);
    execute format('alter table weft.%I force row level security', t);
    for p in select policyname from pg_policies where schemaname = 'weft' and tablename = t loop
      execute format('drop policy %I on weft.%I', p.policyname, t);
    end loop;
  end loop;
end $$;

create policy expenses_read on weft.expenses for select to weft_user, weft_assistant
  using (weft_private.is_member(weft_private.expense_list_space(list_id)));
create policy expenses_add on weft.expenses for insert to weft_user
  with check (created_by = weft_private.uid() and weft_private.can_edit(weft_private.expense_list_space(list_id)));
create policy expenses_change on weft.expenses for update to weft_user
  using (weft_private.can_edit(weft_private.expense_list_space(list_id)))
  with check (weft_private.can_edit(weft_private.expense_list_space(list_id)));
create policy expenses_delete on weft.expenses for delete to weft_user
  using (weft_private.can_edit(weft_private.expense_list_space(list_id)));

create policy expense_shares_read on weft.expense_shares for select to weft_user, weft_assistant
  using (weft_private.is_member(weft_private.expense_space(expense_id)));
create policy expense_shares_add on weft.expense_shares for insert to weft_user
  with check (weft_private.can_edit(weft_private.expense_space(expense_id)));
create policy expense_shares_change on weft.expense_shares for update to weft_user
  using (weft_private.can_edit(weft_private.expense_space(expense_id)))
  with check (weft_private.can_edit(weft_private.expense_space(expense_id)));
create policy expense_shares_delete on weft.expense_shares for delete to weft_user
  using (weft_private.can_edit(weft_private.expense_space(expense_id)));

-- list_id, expense_id and user_id are never updatable; created_by and the times are never granted.
grant select on weft.expenses, weft.expense_shares to weft_user, weft_assistant;
grant insert (list_id, title, amount_cents, paid_by, spent_on, split), update (title, amount_cents, paid_by, spent_on, split), delete on weft.expenses to weft_user;
grant insert (expense_id, user_id, share_cents), update (share_cents), delete on weft.expense_shares to weft_user;
revoke execute on function weft_private.expense_list_space(uuid), weft_private.expense_space(uuid) from public;
grant execute on function weft_private.expense_list_space(uuid), weft_private.expense_space(uuid) to weft_user, weft_assistant;

-- Running balances per person per list: what they paid, their share, and the difference (positive: they
-- are owed; negative: they owe). security_invoker: the caller's row-level security applies, so it only
-- ever sums expenses the caller can read.
create or replace view weft.expense_balances with (security_invoker = true) as
select list_id, user_id, sum(paid)::bigint as paid_cents, sum(owed)::bigint as share_cents, (sum(paid) - sum(owed))::bigint as net_cents
from (
  select e.list_id, e.paid_by as user_id, e.amount_cents as paid, 0::bigint as owed from weft.expenses e
  union all
  select e.list_id, s.user_id, 0, s.share_cents from weft.expense_shares s join weft.expenses e on e.id = s.expense_id
) x
group by list_id, user_id;
revoke all on weft.expense_balances from public;
grant select on weft.expense_balances to weft_user, weft_assistant;

-- Before a write: trim the text, keep authorship and times, and check that who paid and who shares are
-- members of the list's space. Those answers are only given to editors of the space (anyone else is
-- refused by row-level security with the same answer whatever the data). Someone already in the record
-- who has since left stays: the check is only for a new payer or a new person in the split.
create or replace function weft_private.expense_guard() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare v_space uuid;
begin
  if tg_table_name = 'expenses' then
    v_space := weft_private.expense_list_space(new.list_id);
    new.title := btrim(new.title);
    if tg_op = 'INSERT' then
      new.created_at := now(); new.updated_at := now();
    else
      new.list_id := old.list_id; new.created_by := old.created_by; new.created_at := old.created_at; new.updated_at := now();
    end if;
    if weft_private.can_edit(v_space) and (tg_op = 'INSERT' or new.paid_by is distinct from old.paid_by)
       and not exists (select 1 from weft.members where space_id = v_space and user_id = new.paid_by) then
      raise exception 'whoever paid must be a member of this space' using errcode = '23514';
    end if;
    return new;
  end if;
  -- expense_shares
  if tg_op = 'UPDATE' then new.expense_id := old.expense_id; new.user_id := old.user_id; return new; end if;
  v_space := weft_private.expense_space(new.expense_id);
  if weft_private.can_edit(v_space) and not exists (select 1 from weft.members where space_id = v_space and user_id = new.user_id) then
    raise exception 'everyone in a split must be a member of this space' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists expenses_guard on weft.expenses;
create trigger expenses_guard before insert or update on weft.expenses for each row execute function weft_private.expense_guard();
drop trigger if exists expense_shares_guard on weft.expense_shares;
create trigger expense_shares_guard before insert or update on weft.expense_shares for each row execute function weft_private.expense_guard();

-- When the transaction commits: every expense still there is split into shares that add up to its amount,
-- and an even split differs by at most one cent. Deferred, so the expense and its shares can be written
-- one after the other inside one transaction (weft.save_expense does).
create or replace function weft_private.expense_check() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare r record; v_id uuid; e record; n int; total bigint; lo bigint; hi bigint;
begin
  r := coalesce(new, old);
  if tg_table_name = 'expenses' then v_id := r.id; else v_id := r.expense_id; end if;
  select amount_cents, split into e from weft.expenses where id = v_id;
  if not found then return null; end if;   -- deleted (with its list, or on its own): nothing to check
  select count(*), coalesce(sum(share_cents), 0), min(share_cents), max(share_cents) into n, total, lo, hi
    from weft.expense_shares where expense_id = v_id;
  if n = 0 then
    raise exception 'say who shares this expense' using errcode = '23514';
  end if;
  if total <> e.amount_cents then
    raise exception 'the shares add up to %, not the amount of %', to_char(total / 100.0, 'FM999999990.00'), to_char(e.amount_cents / 100.0, 'FM999999990.00')
      using errcode = '23514';
  end if;
  if e.split = 'even' and hi - lo > 1 then
    raise exception 'an even split must give everyone the same share' using errcode = '23514';
  end if;
  return null;
end $$;
drop trigger if exists expenses_check on weft.expenses;
create constraint trigger expenses_check after insert or update on weft.expenses
  deferrable initially deferred for each row execute function weft_private.expense_check();
drop trigger if exists expense_shares_check on weft.expense_shares;
create constraint trigger expense_shares_check after insert or update or delete on weft.expense_shares
  deferrable initially deferred for each row execute function weft_private.expense_check();

-- Add or change an expense and its split in one go, as the caller (security invoker: row-level security,
-- the column grants and the guard all apply). p_people: who shares it; p_amounts: their shares in cents for
-- a split by amounts (null for an even split, which the database works out: the odd cents go to the first
-- people listed). p_id null adds a new expense. Returns the expense id.
create or replace function weft.save_expense(p_list uuid, p_title text, p_amount_cents bigint, p_paid_by uuid,
  p_people uuid[], p_split text default 'even', p_amounts bigint[] default null, p_spent_on date default null, p_id uuid default null)
returns uuid
language plpgsql security invoker set search_path = weft, pg_temp as $$
declare v_id uuid; n int; i int; v_share bigint;
begin
  n := coalesce(array_length(p_people, 1), 0);
  if n = 0 then raise exception 'say who shares this expense' using errcode = '23514'; end if;
  if (select count(distinct x) from unnest(p_people) x) <> n then
    raise exception 'each person can be in a split only once' using errcode = '23514';
  end if;
  if p_split = 'amounts' and coalesce(array_length(p_amounts, 1), 0) <> n then
    raise exception 'give an amount for each person in the split' using errcode = '23514';
  end if;
  if p_id is null then
    insert into weft.expenses (list_id, title, amount_cents, paid_by, spent_on, split)
    values (p_list, p_title, p_amount_cents, p_paid_by, coalesce(p_spent_on, current_date), p_split) returning id into v_id;
  else
    update weft.expenses set title = p_title, amount_cents = p_amount_cents, paid_by = p_paid_by,
           spent_on = coalesce(p_spent_on, spent_on), split = p_split
     where id = p_id and list_id = p_list returning id into v_id;
    if v_id is null then raise exception 'no such expense, or you cannot change it' using errcode = '42501'; end if;
    delete from weft.expense_shares where expense_id = v_id and not (user_id = any (p_people));
  end if;
  for i in 1 .. n loop
    v_share := case when p_split = 'amounts' then p_amounts[i]
                    else p_amount_cents / n + case when i <= p_amount_cents % n then 1 else 0 end end;
    if v_share is null or v_share < 0 then raise exception 'a share cannot be empty or below zero' using errcode = '23514'; end if;
    if v_share = 0 then   -- in the split for nothing: leave them out
      delete from weft.expense_shares where expense_id = v_id and user_id = p_people[i];
      continue;
    end if;
    update weft.expense_shares set share_cents = v_share where expense_id = v_id and user_id = p_people[i];
    if not found then
      insert into weft.expense_shares (expense_id, user_id, share_cents) values (v_id, p_people[i], v_share);
    end if;
  end loop;
  return v_id;
end $$;
revoke execute on function weft.save_expense(uuid, text, bigint, uuid, uuid[], text, bigint[], date, uuid) from public, weft_assistant;
grant execute on function weft.save_expense(uuid, text, bigint, uuid, uuid[], text, bigint[], date, uuid) to weft_user;

-- The list's text summary, what search and the assistant read: the total, each person's balance, who
-- should pay whom to settle up (largest debts first), and up to 200 expenses, newest first.
create or replace function weft_private.refresh_expense_text(p_list uuid) returns void
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare t text; n int; total bigint; bal text; settle text := ''; lines text; pay bigint;
        cn text[]; ca bigint[]; dn text[]; da bigint[]; ci int := 1; di int := 1;
begin
  select count(*), coalesce(sum(amount_cents), 0) into n, total from weft.expenses where list_id = p_list;
  -- Each person's balance: what they paid minus their shares.
  with net as (
    select coalesce(u.display_name, 'someone') as name, sum(x.v)::bigint as net from (
      select paid_by as user_id, amount_cents as v from weft.expenses where list_id = p_list
      union all
      select s.user_id, -s.share_cents from weft.expense_shares s join weft.expenses e on e.id = s.expense_id where e.list_id = p_list
    ) x left join weft.users u on u.id = x.user_id group by x.user_id, u.display_name
  )
  select string_agg(name || case when net > 0 then ' is owed ' else ' owes ' end || to_char(abs(net) / 100.0, 'FM999999990.00'), '; ' order by net desc, name) filter (where net <> 0),
         array_agg(name order by net desc, name) filter (where net > 0), array_agg(net order by net desc, name) filter (where net > 0),
         array_agg(name order by net, name) filter (where net < 0), array_agg(-net order by net, name) filter (where net < 0)
    into bal, cn, ca, dn, da from net;
  -- Settle up: the person owed most is paid by the person who owes most, and so on.
  while cn is not null and dn is not null and ci <= array_length(cn, 1) and di <= array_length(dn, 1) loop
    pay := least(ca[ci], da[di]);
    settle := settle || case when settle = '' then '' else '; ' end || dn[di] || ' pays ' || cn[ci] || ' ' || to_char(pay / 100.0, 'FM999999990.00');
    ca[ci] := ca[ci] - pay; da[di] := da[di] - pay;
    if ca[ci] = 0 then ci := ci + 1; end if;
    if da[di] = 0 then di := di + 1; end if;
  end loop;
  select string_agg(line, E'\n' order by spent_on desc, created_at desc) into lines from (
    select e.spent_on, e.created_at,
           '- ' || to_char(e.spent_on, 'YYYY-MM-DD') || ' ' || e.title || ', ' || to_char(e.amount_cents / 100.0, 'FM999999990.00')
           || ', paid by ' || coalesce(u.display_name, 'someone')
           || case when e.split = 'even' then ', split evenly between ' else ', split by amounts: ' end
           || coalesce((select string_agg(coalesce(us.display_name, 'someone')
                         || case when e.split = 'amounts' then ' ' || to_char(s.share_cents / 100.0, 'FM999999990.00') else '' end, ', ' order by us.display_name)
                          from weft.expense_shares s left join weft.users us on us.id = s.user_id where s.expense_id = e.id), 'nobody') as line
      from weft.expenses e left join weft.users u on u.id = e.paid_by
     where e.list_id = p_list order by e.spent_on desc, e.created_at desc limit 200
  ) x;
  t := concat_ws(E'\n', 'Expenses, ' || n || case when n = 1 then ' expense' else ' expenses' end || ', total ' || to_char(total / 100.0, 'FM999999990.00'),
                 case when bal is not null then 'Balances: ' || bal else 'Everyone is even.' end,
                 case when settle <> '' then 'To settle up: ' || settle end,
                 case when lines is not null then 'Expenses, newest first:' || E'\n' || lines end);
  update weft.items set body_text = t where id = p_list and body_text is distinct from t;
end $$;

-- After a change: refresh the summary, announce it (to members only, through the notification server;
-- ids only), and keep the old row in the audit log under the list's space.
create or replace function weft_private.expense_changed() returns trigger
language plpgsql security definer set search_path = weft, weft_private, pg_temp as $$
declare r record; v_list uuid; v_space uuid; v_id uuid;
begin
  r := coalesce(new, old);
  if tg_table_name = 'expenses' then v_list := r.list_id; v_id := r.id;
  else select list_id into v_list from weft.expenses where id = r.expense_id; v_id := r.expense_id;   -- a share has no id of its own: its notice and audit row use the expense
  end if;
  v_space := weft_private.expense_list_space(v_list);
  if v_space is null then return null; end if;   -- the list or the expense is being deleted with its parent
  perform weft_private.refresh_expense_text(v_list);
  perform pg_notify('weft_events', json_build_object('t', 'expenses', 'op', tg_op, 'id', v_id, 'space', v_space, 'list', v_list)::text);
  if tg_op in ('UPDATE', 'DELETE') then
    insert into weft.audit (table_name, row_id, space_id, op, actor_id, actor_role, old_row)
    values (tg_table_name, v_id, v_space, tg_op, weft_private.uid(),
            coalesce(nullif(current_setting('role', true), 'none'), session_user), to_jsonb(old));
  end if;
  return null;
end $$;
do $$
declare t text;
begin
  foreach t in array array['expenses', 'expense_shares'] loop
    execute format('drop trigger if exists %1$s_changed on weft.%1$I', t);
    execute format('create trigger %1$s_changed after insert or update or delete on weft.%1$I
                    for each row execute function weft_private.expense_changed()', t);
  end loop;
end $$;

revoke execute on function weft_private.expense_guard(), weft_private.expense_check(), weft_private.refresh_expense_text(uuid), weft_private.expense_changed()
  from public, weft_user, weft_assistant;
grant execute on function weft_private.refresh_expense_text(uuid) to weft_owner;
