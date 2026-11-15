-- 065 settle up in one press: in an expense list, each suggested payment under "To settle up" can be recorded
-- in one press, which writes the pay-back expense people used to type by hand.
-- What this adds:
--   * weft.record_payment(p_list, p_from, p_to, p_amount_cents): writes "<from> paid <to> back" as an ordinary
--     expense (038), paid by p_from, split by amounts with all of it to p_to, dated today, through
--     weft.save_expense. security invoker: row-level security, the column grants, the member guard, the
--     authorship default, the audit log, the list's text summary and the notices all apply exactly as for an
--     expense typed by hand. Editors and owners of the list's space may record; viewers, other spaces and the
--     assistant role may not. No new table, column, policy or role.
--   * A guard against paying twice: the list is locked for the transaction (an advisory lock, so a double
--     press or two people pressing at once queue up), then the payment is refused unless, at that moment, the
--     payer owes at least that much and the receiver is owed at least that much (from weft.expense_balances,
--     read as the caller). Someone who cannot read the list gets the same refusal whatever is in it.
set client_min_messages = warning;

create or replace function weft.record_payment(p_list uuid, p_from uuid, p_to uuid, p_amount_cents bigint)
returns uuid
language plpgsql security invoker set search_path = weft, pg_temp as $$
declare v_from bigint; v_to bigint; n_from text; n_to text;
begin
  if not exists (select 1 from weft.items where id = p_list and kind = 'expenselist') then
    raise exception 'no such expense list, or you cannot record payments in it' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_from = p_to then
    raise exception 'a payment goes from one person to another' using errcode = '23514';
  end if;
  if p_amount_cents is null or p_amount_cents < 1 then
    raise exception 'a payment must be more than zero' using errcode = '23514';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('weft.record_payment:' || p_list::text, 0));
  -- Read after the lock: a payment recorded meanwhile is already in these sums.
  select coalesce(sum(net_cents) filter (where user_id = p_from), 0), coalesce(sum(net_cents) filter (where user_id = p_to), 0)
    into v_from, v_to from weft.expense_balances where list_id = p_list and user_id in (p_from, p_to);
  select coalesce(min(display_name) filter (where id = p_from), 'someone'), coalesce(min(display_name) filter (where id = p_to), 'someone')
    into n_from, n_to from weft.users where id in (p_from, p_to);
  if -v_from < p_amount_cents then
    raise exception '% owes %; the balances have changed', n_from,
      case when v_from >= 0 then 'nothing now' else 'only ' || to_char(-v_from / 100.0, 'FM999999990.00') || ' now' end using errcode = '23514';
  end if;
  if v_to < p_amount_cents then
    raise exception '% is owed %; the balances have changed', n_to,
      case when v_to <= 0 then 'nothing now' else 'only ' || to_char(v_to / 100.0, 'FM999999990.00') || ' now' end using errcode = '23514';
  end if;
  return weft.save_expense(p_list, left(n_from || ' paid ' || n_to || ' back', 200), p_amount_cents, p_from,
                           array[p_to], 'amounts', array[p_amount_cents], current_date, null);
end $$;
revoke execute on function weft.record_payment(uuid, uuid, uuid, bigint) from public, weft_assistant;
grant execute on function weft.record_payment(uuid, uuid, uuid, bigint) to weft_user;
