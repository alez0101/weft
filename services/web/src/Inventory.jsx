// An inventory: the things a group owns, where each is kept, and who has it now. Checking a thing out
// writes down who has it; checking it in puts it back in its place. The database keeps the record of every
// check out and check in (who, by whom, when) and shows it per thing and as recent activity.
// Editors and owners add, change and delete things and check out to or in from anyone in the space. Every
// member, viewers included, may check out a thing that is in to themselves and check in what they have.
// Row-level security and the guard trigger decide; when they say no, the reason is shown and the
// inventory is reloaded. Live: any change to this inventory's things refetches it. Weft (search and the
// assistant) reads the inventory's text summary, kept by the database.
// Due-back dates (055): a thing that is out can carry a "back by" date, set when checking out or later by an
// editor or by whoever has it; checking in clears it. Overdue things say so in red; "Checked out now" is
// sorted by the date, overdue first.
// Download as a file (066): every thing as CSV (where it is kept, who has it, since when, back by), for anyone
// who can read the inventory, built here from the rows already loaded.
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { saveCsv, localDay } from './download.js';
import { today } from './TaskList.jsx';

const THINGS = 'id,name,location,note,holder_id,held_since,due_back,holder:users!inventory_things_holder_id_fkey(display_name)';
const MOVES = 'id,thing_id,action,holder_id,at,holder:users!inventory_moves_holder_id_fkey(display_name),by:users!inventory_moves_by_id_fkey(display_name)';
const day = (iso) => new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });
const stamp = (iso) => new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const NOWHERE = 'No place set';
// A back-by date as words, and whether it has passed. Dates are plain days (YYYY-MM-DD), compared as text.
const dueDay = (d) => new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
export const isOverdue = (x, t = today()) => Boolean(x.holder_id && x.due_back && x.due_back < t);
export const dueWords = (d, t = today()) => {
  if (!d) return '';
  if (d < t) return `was due back ${dueDay(d)}, overdue`;
  if (d === t) return 'due back today';
  return `back by ${dueDay(d)}`;
};
// By back-by date, overdue first, things with no date last.
export const byDue = (a, b) => (a.due_back ? 0 : 1) - (b.due_back ? 0 : 1) || (a.due_back || '').localeCompare(b.due_back || '');

function ThingForm({ initial, places, onSave, onCancel, label, idp, submit }) {
  const [f, setF] = useState(initial);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const ok = f.name.trim().length > 0;
  return (
    <form className="link-form" aria-label={label} noValidate
      onSubmit={(e) => { e.preventDefault(); if (ok) onSave({ name: f.name.trim(), location: f.location.trim(), note: f.note.trim() }); }}>
      <label htmlFor={`${idp}-name`}>Thing</label>
      <input id={`${idp}-name`} value={f.name} onChange={set('name')} maxLength={200} autoComplete="off" placeholder="Tent, extension lead, van keys" required />
      <label htmlFor={`${idp}-where`}>Kept in</label>
      <input id={`${idp}-where`} value={f.location} onChange={set('location')} maxLength={200} autoComplete="off" list={`${idp}-places`} placeholder="Shed, shelf 2" />
      <datalist id={`${idp}-places`}>{places.map((p) => <option key={p} value={p} />)}</datalist>
      <label htmlFor={`${idp}-note`}>Note</label>
      <textarea id={`${idp}-note`} value={f.note} onChange={set('note')} maxLength={1000} rows={2} placeholder="Size, condition, what goes with it" />
      <div className="link-form-actions">
        <button className="btn btn--primary btn--sm" type="submit" disabled={!ok}>{submit}</button>
        {onCancel && <button className="btn btn--sm" type="button" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

export default function Inventory({ item, me, members, editable, notice }) {
  const [things, setThings] = useState(null);
  const [moves, setMoves] = useState([]);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [lending, setLending] = useState(null);   // { id, to, due } while an editor picks who to check out to
  const [dating, setDating] = useState(null);     // { id, due } while someone sets a back-by date
  const [query, setQuery] = useState('');
  const [show, setShow] = useState('all');

  const load = useCallback(() => Promise.all([
    api(`/inventory_things?inventory_id=eq.${item.id}&select=${THINGS}&order=name`),
    api(`/inventory_moves?inventory_id=eq.${item.id}&select=${MOVES}&order=at.desc&limit=300`),
  ]).then(([t, m]) => { setThings(t); setMoves(m); }), [item.id]);
  useEffect(() => { load().catch((e) => setError(`The inventory could not load: ${e.message}`)); }, [load]);
  useEffect(() => { if (notice?.t === 'inventory' && notice.list === item.id) load().catch(() => {}); }, [notice, item.id, load]);

  const change = async (what, run) => {
    let ok = false;
    try { await run(); setError(''); ok = true; } catch (e) { setError(`${what}: ${e.message}`); }
    load().catch(() => {});
    return ok;
  };
  // Only if it is still as we saw it: two people pressing Check out at once, the second is told.
  const patch = async (x, where, body, gone) => {
    const rows = await api(`/inventory_things?id=eq.${x.id}&${where}`, { method: 'PATCH', body, prefer: 'return=representation' });
    if (!rows.length) throw new Error(gone);
  };
  const checkOut = (x, to, due) => change(`Could not check out ${x.name}`, () => patch(x, 'holder_id=is.null', { holder_id: to, ...(due ? { due_back: due } : {}) },
    'someone else has just checked it out, or you cannot check it out')).then((ok) => { if (ok) setLending(null); });
  const setDue = (x, due) => change(`Could not set the date for ${x.name}`, () => patch(x, `holder_id=eq.${x.holder_id}`, { due_back: due || null },
    'it has just been checked in or out by someone else, or you cannot change its date')).then((ok) => { if (ok) setDating(null); });
  const checkIn = (x) => change(`Could not check in ${x.name}`, () => patch(x, `holder_id=eq.${x.holder_id}`, { holder_id: null },
    'it has just been checked in or out by someone else, or you cannot check it in'));
  const add = async (body) => {
    if (await change('Could not add the thing', () => api('/inventory_things', { method: 'POST', body: { ...body, inventory_id: item.id }, prefer: 'return=minimal' }))) setAdding(false);
  };
  const save = async (x, body) => {
    if (await change('That change was not saved', () => patch(x, 'select=id', body, 'you cannot change it'))) setEditing(null);
  };
  const remove = (x) => {
    if (!window.confirm(`Delete "${x.name}" and its record of check outs?`)) return;
    change('Could not delete', () => api(`/inventory_things?id=eq.${x.id}`, { method: 'DELETE', prefer: 'return=minimal' }));
  };

  if (!things) return error ? <p className="send-error" role="alert">{error}</p> : <div className="skeleton" aria-label="Loading the inventory"><span /><span /><span /></div>;

  const people = members.filter((m) => m.space_id === item.space_id && m.user).map((m) => ({ id: m.user.id, name: m.user.display_name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const inSpace = people.some((p) => p.id === me.id);
  const nameOf = (x) => (x.holder_id === me.id ? 'you' : x.holder?.display_name || 'someone who left');
  const places = [...new Set(things.map((x) => x.location).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const out = things.filter((x) => x.holder_id);
  const mine = out.filter((x) => x.holder_id === me.id);
  const t0 = today();
  const late = out.filter((x) => isOverdue(x, t0));
  const q = query.trim().toLowerCase();
  const shown = things.filter((x) => (show === 'all' || (show === 'in' && !x.holder_id) || (show === 'out' && x.holder_id) || (show === 'mine' && x.holder_id === me.id) || (show === 'late' && isOverdue(x, t0)))
    && (!q || [x.name, x.location, x.note, x.holder?.display_name].some((s) => (s || '').toLowerCase().includes(q))));
  const groups = {};
  shown.forEach((x) => { (groups[x.location || NOWHERE] = groups[x.location || NOWHERE] || []).push(x); });
  const order = Object.keys(groups).sort((a, b) => (a === NOWHERE) - (b === NOWHERE) || a.localeCompare(b));
  const history = (id) => moves.filter((m) => m.thing_id === id);
  const names = Object.fromEntries(things.map((x) => [x.id, x.name]));
  const moveText = (m) => `${m.action === 'out' ? 'Checked out to' : 'Checked in from'} ${m.holder_id === me.id ? 'you' : m.holder?.display_name || 'someone who left'}`
    + (m.by?.display_name && m.by.display_name !== m.holder?.display_name ? ` by ${m.by.display_name}` : '');
  const FILTERS = [['all', 'All'], ['in', 'In'], ['out', 'Checked out'], ['mine', 'With you'], ['late', 'Overdue']];

  const downloadCsv = () => saveCsv(item.title, 'inventory', ['Thing', 'Kept in', 'Note', 'Has it', 'Since', 'Back by'],
    things.map((x) => [x.name, x.location, x.note, x.holder_id ? (x.holder?.display_name || 'someone who left') : '',
      x.holder_id && x.held_since ? localDay(x.held_since) : '', x.holder_id ? (x.due_back || '') : '']));

  return (
    <div className="links inventory">
      {editable ? (adding
        ? <ThingForm initial={{ name: '', location: '', note: '' }} places={places} onSave={add} onCancel={() => setAdding(false)} label="Add a thing" idp="inv-new" submit="Add thing" />
        : <div className="links-bar"><button className="btn btn--primary btn--sm" type="button" onClick={() => setAdding(true)}>Add a thing</button>
            <p className="docs-hint">Check things out to whoever takes them, and back in when they are returned.</p></div>)
        : <p className="docs-hint">You can check things out to yourself and check in what you have. Ask an owner of the space to make you an editor to add or change things.</p>}
      {error && <p className="send-error" role="alert">{error}</p>}
      {things.length > 0 && (
        <div className="links-filters">
          <label className="visually-hidden" htmlFor="inv-find">Find a thing</label>
          <input id="inv-find" type="search" placeholder="Find by name, place, who has it…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="links-tags" role="group" aria-label="Show">
            {FILTERS.map(([k, l]) => <button key={k} type="button" className="link-tag" aria-pressed={show === k} onClick={() => setShow(k)}>{l}</button>)}
          </div>
          <span className="task-count" role="status">{shown.length === things.length
            ? `${things.length} thing${things.length === 1 ? '' : 's'}, ${out.length} checked out${late.length ? `, ${late.length} overdue` : ''}` : `${shown.length} of ${things.length}`}</span>
          <button className="btn btn--sm" type="button" onClick={downloadCsv}>Download CSV</button>
        </div>
      )}
      <div className="cl-grid">
        <section className="cl-runs" aria-label="Things">
          {!things.length ? <p className="convo-empty">{editable ? 'Nothing here yet. Add the first thing above.' : 'Nothing here yet.'}</p>
            : !shown.length ? <p className="convo-empty">No things match.</p> : order.map((place) => (
            <div key={place} className="inv-place">
              <h3 className="cl-section">{place} <span className="task-count">{groups[place].length}</span></h3>
              <ul className="link-list" aria-label={place}>
                {groups[place].map((x) => {
                  const h = history(x.id); const canIn = x.holder_id && (editable || x.holder_id === me.id); const od = isOverdue(x, t0);
                  return (
                    <li key={x.id} className={`link inv-thing${x.holder_id ? ' is-out' : ''}${od ? ' is-overdue' : ''}`}>
                      {editing === x.id ? (
                        <ThingForm initial={{ name: x.name, location: x.location, note: x.note }} places={places} onSave={(b) => save(x, b)} onCancel={() => setEditing(null)}
                          label={`Edit ${x.name}`} idp={`inv-${x.id}`} submit="Save" />
                      ) : (<>
                        <div className="inv-head">
                          <h4 className="inv-name">{x.name}</h4>
                          <span className={`inv-state${x.holder_id ? ' is-out' : ''}`}>{x.holder_id ? `With ${nameOf(x)}` : 'In'}</span>
                          {od && <span className="inv-state is-overdue">Overdue</span>}
                        </div>
                        {x.holder_id && <p className="inv-meta">Checked out to <strong>{nameOf(x)}</strong> since <time dateTime={x.held_since}>{day(x.held_since)}</time>
                          {x.due_back && <>, <time dateTime={x.due_back} className={`inv-due${od ? ' is-late' : ''}`}>{dueWords(x.due_back, t0)}</time></>}</p>}
                        {x.note && <p className="link-note">{x.note}</p>}
                        {lending?.id === x.id ? (
                          <form className="inv-lend" aria-label={`Check out ${x.name}`} noValidate onSubmit={(e) => { e.preventDefault(); if (lending.to) checkOut(x, lending.to, lending.due); }}>
                            <label htmlFor={`inv-to-${x.id}`}>Check out to</label>
                            <select id={`inv-to-${x.id}`} className="decision-select" value={lending.to} onChange={(e) => setLending({ ...lending, to: e.target.value })}>
                              {people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.id === me.id ? ' (you)' : ''}</option>)}
                            </select>
                            <label htmlFor={`inv-due-${x.id}`}>Back by</label>
                            <input id={`inv-due-${x.id}`} type="date" className="inv-date" min={t0} value={lending.due} onChange={(e) => setLending({ ...lending, due: e.target.value })} />
                            <button className="btn btn--primary btn--sm" type="submit">Check out</button>
                            <button className="btn btn--sm" type="button" onClick={() => setLending(null)}>Cancel</button>
                          </form>
                        ) : dating?.id === x.id ? (
                          <form className="inv-lend" aria-label={`Back by date for ${x.name}`} noValidate onSubmit={(e) => { e.preventDefault(); setDue(x, dating.due); }}>
                            <label htmlFor={`inv-set-${x.id}`}>Back by</label>
                            <input id={`inv-set-${x.id}`} type="date" className="inv-date" min={x.due_back && x.due_back < t0 ? x.due_back : t0} value={dating.due} onChange={(e) => setDating({ ...dating, due: e.target.value })} />
                            <button className="btn btn--primary btn--sm" type="submit">Save date</button>
                            {x.due_back && <button className="btn btn--sm" type="button" onClick={() => setDue(x, null)}>No date</button>}
                            <button className="btn btn--sm" type="button" onClick={() => setDating(null)}>Cancel</button>
                          </form>
                        ) : (
                          <div className="link-foot">
                            {!x.holder_id && (editable
                              ? <button className="btn btn--primary btn--sm" type="button" onClick={() => setLending({ id: x.id, to: inSpace ? me.id : people[0]?.id || '', due: '' })}>Check out<span className="visually-hidden"> {x.name}</span></button>
                              : inSpace && <button className="btn btn--primary btn--sm" type="button" onClick={() => checkOut(x, me.id)}>Check out to me<span className="visually-hidden"> {x.name}</span></button>)}
                            {canIn && <button className="btn btn--sm" type="button" onClick={() => checkIn(x)}>Check in<span className="visually-hidden"> {x.name}</span></button>}
                            {canIn && <button className="btn btn--sm" type="button" onClick={() => setDating({ id: x.id, due: x.due_back || '' })}>{x.due_back ? 'Change date' : 'Set back by date'}<span className="visually-hidden"> for {x.name}</span></button>}
                            {editable && <>
                              <button className="btn btn--sm" type="button" onClick={() => setEditing(x.id)}>Edit<span className="visually-hidden"> {x.name}</span></button>
                              <button className="btn btn--sm" type="button" onClick={() => remove(x)}>Delete<span className="visually-hidden"> {x.name}</span></button>
                            </>}
                            {h.length > 0 && (
                              <details className="inv-history">
                                <summary>History <span className="visually-hidden">of {x.name}</span>({h.length})</summary>
                                <ul>{h.slice(0, 20).map((m) => <li key={m.id}><time dateTime={m.at}>{stamp(m.at)}</time> {moveText(m)}</li>)}</ul>
                              </details>
                            )}
                          </div>
                        )}
                      </>)}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </section>

        <section className="cl-template inv-side" aria-labelledby="inv-out-title">
          <h3 id="inv-out-title" className="cl-section">Checked out now <span className="task-count">{out.length || ''}</span></h3>
          {!out.length ? <p className="convo-empty">Everything is in its place.</p> : (
            <ul className="inv-out" aria-label="Checked out now">
              {[...out].sort((a, b) => byDue(a, b) || nameOf(a).localeCompare(nameOf(b)) || a.name.localeCompare(b.name)).map((x) => (
                <li key={x.id} className={isOverdue(x, t0) ? 'is-overdue' : undefined}><strong>{x.name}</strong> <span>with {nameOf(x)}, since {day(x.held_since)}
                  {x.due_back && <>, <span className={isOverdue(x, t0) ? 'is-late' : undefined}>{dueWords(x.due_back, t0)}</span></>}</span></li>
              ))}
            </ul>
          )}
          {mine.length > 0 && <p className="docs-hint">You have {mine.length} thing{mine.length === 1 ? '' : 's'} from here.</p>}
          <h3 className="cl-section">Recent check outs and check ins</h3>
          {!moves.length ? <p className="convo-empty">Nothing checked out yet.</p> : (
            <ul className="inv-moves" aria-label="Recent check outs and check ins">
              {moves.slice(0, 10).map((m) => (
                <li key={m.id}><span className="inv-move-what"><strong>{names[m.thing_id]}</strong>: {moveText(m).replace(/^C/, 'c')}</span>
                  <time dateTime={m.at}>{stamp(m.at)}</time></li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
