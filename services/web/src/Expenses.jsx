// An expense list: who paid what for the group, each expense split evenly between some people or by exact
// amounts, with everyone's running balance and a short list of who should pay whom to settle up. Nothing is
// paid here: paying someone back is written down as another expense. Editors and owners add, change and
// delete expenses; viewers read. The database keeps the sums right (the shares always add up to the amount,
// and an even split is worked out there); when it says no, its reason is shown and the list is reloaded.
// Live: any change to this list's expenses refetches it. Weft (search and the assistant) reads the list's
// text summary, kept by the database.
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

const fmt = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const money = (cents) => fmt.format(cents / 100);
// "12", "12.5", "12,50": whole cents, or null if it is not an amount.
const cents = (s) => {
  const m = String(s).trim().match(/^(\d{1,9})(?:[.,](\d{1,2}))?$/);
  return m ? Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0')) : null;
};
const asText = (c) => (c == null ? '' : (c / 100).toFixed(2));
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const day = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
const SELECT = 'id,title,amount_cents,paid_by,spent_on,split,created_at,payer:users!expenses_paid_by_fkey(display_name),'
  + 'author:users!expenses_created_by_fkey(display_name),shares:expense_shares(user_id,share_cents,who:users(display_name))';

// Who should pay whom: the person who owes most pays the person owed most, and so on (the same rule the
// database uses for the text summary).
function settleUp(balances) {
  const cred = balances.filter((b) => b.net > 0).map((b) => ({ ...b, left: b.net })).sort((a, b) => b.net - a.net || a.name.localeCompare(b.name));
  const debt = balances.filter((b) => b.net < 0).map((b) => ({ ...b, left: -b.net })).sort((a, b) => a.net - b.net || a.name.localeCompare(b.name));
  const out = []; let i = 0; let j = 0;
  while (i < cred.length && j < debt.length) {
    const pay = Math.min(cred[i].left, debt[j].left);
    out.push({ from: debt[j], to: cred[i], cents: pay });
    cred[i].left -= pay; debt[j].left -= pay;
    if (!cred[i].left) i += 1;
    if (!debt[j].left) j += 1;
  }
  return out;
}

function ExpenseForm({ initial, people, onSave, onCancel, label, idp, submit: submitLabel }) {
  const [f, setF] = useState(initial);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const amount = cents(f.amount);
  const chosen = people.filter((p) => f.in[p.id]);
  const parts = chosen.map((p) => cents(f.parts[p.id] || '0'));
  const partsTotal = parts.reduce((a, b) => a + (b ?? 0), 0);
  const left = amount == null ? null : amount - partsTotal;
  const ok = f.title.trim() && amount > 0 && f.paid_by && chosen.length > 0
    && (f.split === 'even' || (parts.every((c) => c != null) && left === 0));
  const each = f.split === 'even' && amount > 0 && chosen.length ? Math.floor(amount / chosen.length) : null;
  const submit = (e) => {
    e.preventDefault();
    if (!ok) return;
    const ids = chosen.map((p) => p.id);
    onSave({ p_title: f.title.trim(), p_amount_cents: amount, p_paid_by: f.paid_by, p_people: ids, p_split: f.split,
      p_amounts: f.split === 'amounts' ? parts : null, p_spent_on: f.spent_on || today() });
  };
  return (
    <form className="link-form exp-form" onSubmit={submit} aria-label={label} noValidate>
      <label htmlFor={`${idp}-title`}>What for</label>
      <input id={`${idp}-title`} value={f.title} onChange={set('title')} maxLength={200} autoComplete="off" placeholder="Van hire, groceries, tickets" required />
      <label htmlFor={`${idp}-amount`}>Amount</label>
      <input id={`${idp}-amount`} className="exp-amount" value={f.amount} onChange={set('amount')} inputMode="decimal" autoComplete="off" placeholder="0.00"
        aria-invalid={f.amount !== '' && !(amount > 0)} required />
      <label htmlFor={`${idp}-paid`}>Paid by</label>
      <select id={`${idp}-paid`} className="decision-select" value={f.paid_by} onChange={set('paid_by')}>
        <option value="">Choose who paid</option>
        {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <label htmlFor={`${idp}-on`}>Date</label>
      <input id={`${idp}-on`} type="date" value={f.spent_on} onChange={set('spent_on')} />
      <span className="exp-form-label" id={`${idp}-split-label`}>Split</span>
      <div className="exp-split" role="radiogroup" aria-labelledby={`${idp}-split-label`}>
        <label className="toggle"><input type="radio" name={`${idp}-split`} value="even" checked={f.split === 'even'} onChange={set('split')} /> Evenly</label>
        <label className="toggle"><input type="radio" name={`${idp}-split`} value="amounts" checked={f.split === 'amounts'} onChange={set('split')} /> By amounts</label>
      </div>
      <span className="exp-form-label">Between</span>
      <fieldset className="exp-people">
        <legend className="visually-hidden">Who shares this expense</legend>
        {people.map((p) => (
          <div key={p.id} className="exp-person">
            <label className="toggle"><input type="checkbox" checked={!!f.in[p.id]} onChange={(e) => setF({ ...f, in: { ...f.in, [p.id]: e.target.checked } })} /> {p.name}</label>
            {f.split === 'amounts' && f.in[p.id] && (<>
              <label className="visually-hidden" htmlFor={`${idp}-part-${p.id}`}>Share of {p.name}</label>
              <input id={`${idp}-part-${p.id}`} className="exp-amount" value={f.parts[p.id] || ''} inputMode="decimal" autoComplete="off" placeholder="0.00"
                onChange={(e) => setF({ ...f, parts: { ...f.parts, [p.id]: e.target.value } })} />
            </>)}
          </div>
        ))}
        <p className="exp-left" role="status">
          {!chosen.length ? 'Tick at least one person.'
            : f.split === 'even' ? (each != null ? `${money(each)}${amount % chosen.length ? ' or a cent more' : ''} each` : '')
            : left == null ? '' : left === 0 ? 'The shares add up.' : left > 0 ? `${money(left)} still to share out` : `${money(-left)} too much`}
        </p>
      </fieldset>
      <div className="link-form-actions">
        <button className="btn btn--primary btn--sm" type="submit" disabled={!ok}>{submitLabel}</button>
        {onCancel && <button className="btn btn--sm" type="button" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

export default function ExpenseList({ item, me, members, editable, notice }) {
  const [expenses, setExpenses] = useState(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => api(`/expenses?list_id=eq.${item.id}&select=${SELECT}&order=spent_on.desc,created_at.desc`).then(setExpenses), [item.id]);
  useEffect(() => { load().catch((e) => setError(`The expenses could not load: ${e.message}`)); }, [load]);
  useEffect(() => { if (notice?.t === 'expenses' && notice.list === item.id) load().catch(() => {}); }, [notice, item.id, load]);

  const change = async (what, run) => {
    let ok = false;
    try { await run(); setError(''); ok = true; } catch (e) { setError(`${what}: ${e.message}`); }
    load().catch(() => {});
    return ok;
  };
  const save = async (body, id) => {
    if (await change(id ? 'That change was not saved' : 'Could not add the expense',
      () => api('/rpc/save_expense', { method: 'POST', body: { ...body, p_list: item.id, p_id: id || null } }))) { setAdding(false); setEditing(null); }
  };
  const remove = (x) => {
    if (!window.confirm(`Delete "${x.title}" (${money(x.amount_cents)})? Everyone's balances change.`)) return;
    change('Could not delete', () => api(`/expenses?id=eq.${x.id}`, { method: 'DELETE', prefer: 'return=minimal' }));
  };

  if (!expenses) return error ? <p className="send-error" role="alert">{error}</p> : <div className="skeleton" aria-label="Loading the expenses"><span /><span /><span /></div>;

  // Everyone who can be chosen: the space's members, plus anyone already in the record who has since left.
  const names = {};
  members.filter((m) => m.space_id === item.space_id && m.user).forEach((m) => { names[m.user.id] = m.user.display_name; });
  const inSpace = new Set(Object.keys(names));
  const recorded = {};
  expenses.forEach((x) => {
    recorded[x.paid_by] = recorded[x.paid_by] || x.payer?.display_name;
    x.shares.forEach((s) => { recorded[s.user_id] = recorded[s.user_id] || s.who?.display_name; });
  });
  const nameOf = (id) => names[id] || recorded[id] || 'Someone who left';
  const byName = (a, b) => a.name.localeCompare(b.name);
  const people = [...inSpace].map((id) => ({ id, name: nameOf(id) })).sort(byName);
  const peopleFor = (x) => [...people, ...[x.paid_by, ...x.shares.map((s) => s.user_id)].filter((id, i, a) => !inSpace.has(id) && a.indexOf(id) === i)
    .map((id) => ({ id, name: nameOf(id) }))].sort(byName);

  // Running balances: what each person paid minus their shares.
  const bal = {};
  const at = (id) => (bal[id] = bal[id] || { id, name: nameOf(id), paid: 0, share: 0, net: 0 });
  expenses.forEach((x) => { at(x.paid_by).paid += x.amount_cents; x.shares.forEach((s) => { at(s.user_id).share += s.share_cents; }); });
  const balances = Object.values(bal).map((b) => ({ ...b, net: b.paid - b.share })).sort((a, b) => b.net - a.net || byName(a, b));
  const settle = settleUp(balances);
  const total = expenses.reduce((a, x) => a + x.amount_cents, 0);
  const blank = () => ({ title: '', amount: '', paid_by: inSpace.has(me.id) ? me.id : '', spent_on: today(), split: 'even', in: Object.fromEntries(people.map((p) => [p.id, true])), parts: {} });
  const fromExpense = (x) => ({ title: x.title, amount: asText(x.amount_cents), paid_by: x.paid_by, spent_on: x.spent_on, split: x.split,
    in: Object.fromEntries(x.shares.map((s) => [s.user_id, true])), parts: Object.fromEntries(x.shares.map((s) => [s.user_id, asText(s.share_cents)])) });
  const shareText = (x) => {
    const sh = [...x.shares].map((s) => ({ ...s, name: nameOf(s.user_id) })).sort(byName);
    return x.split === 'even' ? `split evenly between ${sh.map((s) => s.name).join(', ')}` : `split by amounts: ${sh.map((s) => `${s.name} ${money(s.share_cents)}`).join(', ')}`;
  };

  return (
    <div className="links expenses">
      {editable ? (adding
        ? <ExpenseForm initial={blank()} people={people} onSave={(b) => save(b)} onCancel={() => setAdding(false)} label="Add an expense" idp="exp-new" submit="Add expense" />
        : <div className="links-bar"><button className="btn btn--primary btn--sm" type="button" onClick={() => setAdding(true)}>Add an expense</button>
            <p className="docs-hint">A record of who paid what. To pay someone back, add it as an expense paid by you, split by amounts to them.</p></div>)
        : <p className="docs-hint">You can read these expenses and balances. Ask an owner of the space to make you an editor to add or change them.</p>}
      {error && <p className="send-error" role="alert">{error}</p>}
      <div className="cl-grid">
        <section className="cl-runs" aria-labelledby="exp-list-title">
          <h3 id="exp-list-title" className="cl-section">Expenses <span className="task-count">{expenses.length ? `${expenses.length}, total ${money(total)}` : ''}</span></h3>
          {!expenses.length ? <p className="convo-empty">{editable ? 'No expenses yet. Add the first one above.' : 'No expenses yet.'}</p> : (
            <ul className="link-list" aria-label="Expenses">
              {expenses.map((x) => (
                <li key={x.id} className="link expense">
                  {editing === x.id ? (
                    <ExpenseForm initial={fromExpense(x)} people={peopleFor(x)} onSave={(b) => save(b, x.id)} onCancel={() => setEditing(null)} label={`Edit ${x.title}`} idp={`exp-${x.id}`} submit="Save" />
                  ) : (<>
                    <div className="exp-head">
                      <h4 className="exp-title">{x.title}</h4>
                      <span className="exp-sum">{money(x.amount_cents)}</span>
                    </div>
                    <p className="exp-meta"><time dateTime={x.spent_on}>{day(x.spent_on)}</time>. Paid by <strong>{nameOf(x.paid_by)}</strong>, {shareText(x)}</p>
                    <div className="link-foot">
                      <span className="link-by">{x.author?.display_name ? `Added by ${x.author.display_name}` : ''}</span>
                      {editable && <>
                        <button className="btn btn--sm" type="button" onClick={() => setEditing(x.id)}>Edit<span className="visually-hidden"> {x.title}</span></button>
                        <button className="btn btn--sm" type="button" onClick={() => remove(x)}>Delete<span className="visually-hidden"> {x.title}</span></button>
                      </>}
                    </div>
                  </>)}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="cl-template exp-balances" aria-labelledby="exp-bal-title">
          <h3 id="exp-bal-title" className="cl-section">Balances</h3>
          {!balances.some((b) => b.net) ? <p className="convo-empty">{expenses.length ? 'Everyone is even.' : 'Nothing to balance yet.'}</p> : (
            <ul className="exp-bal-list" aria-label="Balances">
              {balances.map((b) => (
                <li key={b.id} className={`exp-bal${b.net > 0 ? ' is-owed' : b.net < 0 ? ' owes' : ''}`}>
                  <span className="exp-bal-name">{b.name}{b.id === me.id ? ' (you)' : ''}</span>
                  <span className="exp-bal-net">{b.net > 0 ? `is owed ${money(b.net)}` : b.net < 0 ? `owes ${money(-b.net)}` : 'even'}</span>
                  <span className="exp-bal-sub">paid {money(b.paid)}, share {money(b.share)}</span>
                </li>
              ))}
            </ul>
          )}
          {settle.length > 0 && (<>
            <h3 className="cl-section">To settle up</h3>
            <ul className="exp-settle" aria-label="To settle up">
              {settle.map((s) => <li key={`${s.from.id}-${s.to.id}`}><strong>{s.from.name}</strong> pays <strong>{s.to.name}</strong> <span className="exp-sum">{money(s.cents)}</span></li>)}
            </ul>
            <p className="docs-hint">The fewest payments that make everyone even. Nothing is paid through Weft.</p>
          </>)}
        </section>
      </div>
    </div>
  );
}
