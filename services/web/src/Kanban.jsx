// Boards: a task list seen as columns. The cards are the list's tasks (the same rows as the Tasks app);
// the open columns are the list's board_columns, and Done is built in: the tasks that are done. Editors drag
// cards (or move them with the arrow keys), add cards and change the columns; viewers read, and the person a
// card is assigned to can still mark it done. Row-level security decides; when it says no, the reason is
// shown and the board is reloaded. Live: any change to this list's tasks or columns refetches it.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { dueLabel, today } from './TaskList.jsx';

const DONE = 'done';
// Where a card sits: Done if it is done, else its column if that still exists, else the first column.
const columnOf = (t, cols) => (t.done ? DONE : cols.some((c) => c.id === t.column_id) ? t.column_id : cols[0].id);
// A position between two neighbours (either may be missing).
const between = (a, b) => (a == null && b == null ? 0 : a == null ? b - 1 : b == null ? a + 1 : (a + b) / 2);

export default function Kanban({ item, me, members, editable, notice }) {
  const [columns, setColumns] = useState(null);
  const [tasks, setTasks] = useState(null);
  const [error, setError] = useState('');
  const [said, setSaid] = useState('');
  const [drag, setDrag] = useState(null);       // id of the card being dragged
  const [over, setOver] = useState(null);       // { col, before } while dragging over a column
  const [newCol, setNewCol] = useState('');
  const [drafts, setDrafts] = useState({});     // column id -> new card title
  const refocus = useRef(null);

  const people = members.filter((m) => m.space_id === item.space_id && m.user).map((m) => m.user);
  const nameOf = (id) => (id === me.id ? 'You' : people.find((p) => p.id === id)?.display_name ?? (id ? 'Someone not in this space' : ''));

  const load = useCallback(() => Promise.all([
    api(`/board_columns?list_id=eq.${item.id}&select=id,name,position&order=position,created_at`),
    api(`/tasks?list_id=eq.${item.id}&select=id,title,assignee_id,due_on,done,position,column_id&order=position,created_at`),
  ]).then(([c, t]) => { setColumns(c); setTasks(t); }), [item.id]);
  useEffect(() => { load().catch((e) => setError(`The board could not load: ${e.message}`)); }, [load]);
  useEffect(() => { if ((notice?.t === 'tasks' || notice?.t === 'board_columns') && notice.list === item.id) load().catch(() => {}); }, [notice, item.id, load]);
  // After a keyboard move, keep the focus on the card that moved.
  useEffect(() => { if (refocus.current) { document.querySelector(`[data-card="${refocus.current}"]`)?.focus(); refocus.current = null; } });

  // Every change: show the database's answer if it refuses, and reload so the screen matches the data.
  const change = async (what, run) => {
    let ok = false;
    try { await run(); setError(''); ok = true; } catch (e) { setError(`${what}: ${e.message}`); }
    load().catch(() => {});
    return ok;
  };

  if (!columns || !tasks) return error ? <p className="send-error" role="alert">{error}</p> : <div className="skeleton" aria-label="Loading the board"><span /><span /><span /></div>;
  // A list whose columns were all deleted still shows its open cards, in a plain "To do".
  const cols = columns.length ? columns : [{ id: null, name: 'To do', position: 0 }];
  const lanes = [...cols.map((c) => ({ ...c, key: c.id ?? 'todo' })), { id: DONE, key: DONE, name: 'Done' }];
  const cardsIn = (colId) => tasks.filter((t) => columnOf(t, cols) === colId).sort((a, b) => a.position - b.position);
  const nameOfCol = (colId) => lanes.find((l) => l.id === colId)?.name;

  // Move a card into a column, before another card (or at the end).
  const move = (t, colId, beforeId = null) => {
    const rest = cardsIn(colId).filter((x) => x.id !== t.id);
    const i = beforeId ? Math.max(0, rest.findIndex((x) => x.id === beforeId)) : rest.length;
    const position = between(rest[i - 1]?.position, rest[i]?.position);
    if (columnOf(t, cols) === colId && cardsIn(colId).findIndex((x) => x.id === t.id) === i) return;   // dropped where it was
    const body = colId === DONE ? { done: true, position } : { done: false, column_id: colId, position };
    setTasks((ts) => ts.map((x) => (x.id === t.id ? { ...x, ...body } : x)));
    setSaid(`Moved "${t.title}" to ${nameOfCol(colId)}.`);
    change('That move was not saved', () => api(`/tasks?id=eq.${t.id}`, { method: 'PATCH', body, prefer: 'return=minimal' }));
  };
  const onKey = (e, t) => {
    const here = columnOf(t, cols); const li = lanes.findIndex((l) => l.id === here); const list = cardsIn(here); const ci = list.findIndex((x) => x.id === t.id);
    let done = true;
    if (e.key === 'ArrowLeft' && li > 0) move(t, lanes[li - 1].id);
    else if (e.key === 'ArrowRight' && li < lanes.length - 1) move(t, lanes[li + 1].id);
    else if (e.key === 'ArrowUp' && ci > 0) move(t, here, list[ci - 1].id);
    else if (e.key === 'ArrowDown' && ci < list.length - 1) move(t, here, list[ci + 2]?.id ?? null);
    else done = false;
    if (done) { e.preventDefault(); refocus.current = t.id; }
  };
  // While dragging: the card the pointer is above (by the middle of each card) is where it will land.
  const dragOver = (e, colId) => {
    if (!drag) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    const cards = [...e.currentTarget.querySelectorAll('[data-card]')].filter((el) => el.dataset.card !== drag);
    const hit = cards.find((el) => { const r = el.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
    const before = hit?.dataset.card ?? null;
    if (over?.col !== colId || over?.before !== before) setOver({ col: colId, before });
  };
  const drop = (e, colId) => {
    e.preventDefault();
    const t = tasks.find((x) => x.id === (drag || e.dataTransfer.getData('text/plain')));
    if (t) move(t, colId, over?.col === colId ? over.before : null);
    setDrag(null); setOver(null);
  };

  const addCard = async (e, col) => {
    e.preventDefault();
    const title = (drafts[col.key] || '').trim(); if (!title) return;
    const position = Math.max(-1, ...tasks.map((t) => t.position)) + 1;
    if (await change('Could not add the card', () => api('/tasks', { method: 'POST', body: { list_id: item.id, title, column_id: col.id, position }, prefer: 'return=minimal' }))) setDrafts((d) => ({ ...d, [col.key]: '' }));
  };
  const addColumn = async (e) => {
    e.preventDefault();
    const name = newCol.trim(); if (!name) return;
    const position = Math.max(-1, ...columns.map((c) => c.position)) + 1;
    if (await change('Could not add the column', () => api('/board_columns', { method: 'POST', body: { list_id: item.id, name, position }, prefer: 'return=minimal' }))) setNewCol('');
  };
  const rename = (c, name) => change('Could not rename the column', () => api(`/board_columns?id=eq.${c.id}`, { method: 'PATCH', body: { name }, prefer: 'return=minimal' }));
  const shift = (c, d) => {
    const order = [...columns]; const i = order.findIndex((x) => x.id === c.id); const j = i + d;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    setColumns(order.map((x, k) => ({ ...x, position: k })));
    change('Could not move the column', () => Promise.all(order.map((x, k) => (x.position === k ? null
      : api(`/board_columns?id=eq.${x.id}`, { method: 'PATCH', body: { position: k }, prefer: 'return=minimal' }))).filter(Boolean)));
  };
  const removeColumn = (c) => {
    const n = cardsIn(c.id).length; const first = columns.find((x) => x.id !== c.id);
    if (!window.confirm(`Delete the column "${c.name}"?${n ? ` Its ${n} card${n > 1 ? 's move' : ' moves'} to "${first.name}".` : ''}`)) return;
    change('Could not delete the column', () => api(`/board_columns?id=eq.${c.id}`, { method: 'DELETE', prefer: 'return=minimal' }));
  };
  const setDone = (t, done) => {
    setTasks((ts) => ts.map((x) => (x.id === t.id ? { ...x, done } : x)));
    change('That change was not saved', () => api(`/tasks?id=eq.${t.id}`, { method: 'PATCH', body: { done }, prefer: 'return=minimal' }));
  };

  const t0 = today();
  const card = (t, lane) => {
    const late = !t.done && t.due_on && t.due_on < t0;
    const mine = t.assignee_id === me.id;
    return (
      <li key={t.id} data-card={t.id} className={`kanban-card${t.done ? ' is-done' : ''}${drag === t.id ? ' is-dragging' : ''}${over?.col === lane.id && over.before === t.id ? ' is-drop-before' : ''}`}
        draggable={editable} tabIndex={editable ? 0 : undefined}
        aria-label={editable ? `${t.title}, in ${lane.name}. Arrow keys move it.` : undefined}
        onDragStart={editable ? (e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.id); setDrag(t.id); } : undefined}
        onDragEnd={editable ? () => { setDrag(null); setOver(null); } : undefined}
        onKeyDown={editable ? (e) => onKey(e, t) : undefined}>
        <span className="kanban-title">{t.title}</span>
        {(t.assignee_id || t.due_on) && (
          <span className="kanban-meta">
            {t.assignee_id && <span>{nameOf(t.assignee_id)}</span>}
            {t.due_on && <span className={late ? 'is-late' : ''}>{dueLabel(t.due_on)}</span>}
          </span>
        )}
        {!editable && mine && <button className="btn btn--sm kanban-tick" type="button" onClick={() => setDone(t, !t.done)}>{t.done ? 'Reopen' : 'Mark done'}<span className="visually-hidden"> {t.title}</span></button>}
      </li>
    );
  };

  return (
    <div className="kanban-wrap">
      {editable ? (
        <div className="kanban-bar">
          <p className="docs-hint">Drag cards between columns, or focus a card and use the arrow keys. These are the same tasks as in Tasks: a card in Done is a ticked-off task.</p>
          <form className="kanban-newcol" onSubmit={addColumn} aria-label="Add a column">
            <label className="visually-hidden" htmlFor="kanban-newcol">New column</label>
            <input id="kanban-newcol" placeholder="New column" maxLength={40} value={newCol} onChange={(e) => setNewCol(e.target.value)} />
            <button className="btn btn--sm" type="submit" disabled={!newCol.trim()}>Add column</button>
          </form>
        </div>
      ) : <p className="docs-hint">You can see this board{tasks.some((t) => t.assignee_id === me.id) ? ' and mark your own cards done' : ''}. Ask an owner of the space to make you an editor to move cards or change the columns.</p>}
      {error && <p className="send-error" role="alert">{error}</p>}
      <p className="visually-hidden" role="status">{said}</p>
      <div className="kanban" role="group" aria-label="Board">
        {lanes.map((lane, li) => {
          const list = cardsIn(lane.id);
          const real = lane.id && lane.id !== DONE;
          return (
            <section key={lane.key} className={`kanban-col${lane.id === DONE ? ' kanban-col--done' : ''}${over?.col === lane.id ? ' is-over' : ''}`} aria-label={`${lane.name}, ${list.length} card${list.length === 1 ? '' : 's'}`}
              onDragOver={editable ? (e) => dragOver(e, lane.id) : undefined}
              onDragLeave={editable ? (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(null); } : undefined}
              onDrop={editable ? (e) => drop(e, lane.id) : undefined}>
              <header className="kanban-head">
                {editable && real ? (
                  <>
                    <label className="visually-hidden" htmlFor={`kc-${lane.id}`}>Column name</label>
                    <input id={`kc-${lane.id}`} className="kanban-name" defaultValue={lane.name} key={`${lane.id}-${lane.name}`} maxLength={40}
                      onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== lane.name) rename(lane, v); else e.target.value = lane.name; }}
                      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
                  </>
                ) : <h3 className="kanban-name kanban-name--read">{lane.name}</h3>}
                <span className="kanban-count" aria-hidden="true">{list.length}</span>
                {editable && real && (
                  <span className="kanban-tools">
                    <button className="kanban-tool" type="button" onClick={() => shift(lane, -1)} disabled={li === 0} aria-label={`Move ${lane.name} left`} title="Move left">‹</button>
                    <button className="kanban-tool" type="button" onClick={() => shift(lane, 1)} disabled={li === cols.length - 1} aria-label={`Move ${lane.name} right`} title="Move right">›</button>
                    {columns.length > 1 && <button className="kanban-tool" type="button" onClick={() => removeColumn(lane)} aria-label={`Delete column ${lane.name}`} title="Delete column">×</button>}
                  </span>
                )}
              </header>
              <ul className="kanban-cards" aria-label={`Cards in ${lane.name}`}>
                {list.map((t) => card(t, lane))}
                {over?.col === lane.id && !over.before && <li className="kanban-drop" aria-hidden="true" />}
              </ul>
              {!list.length && !(over?.col === lane.id) && <p className="kanban-empty">{lane.id === DONE ? 'Nothing done yet.' : 'No cards.'}</p>}
              {editable && lane.id !== DONE && (
                <form className="kanban-add" onSubmit={(e) => addCard(e, lane)} aria-label={`Add a card to ${lane.name}`}>
                  <label className="visually-hidden" htmlFor={`ka-${lane.key}`}>New card in {lane.name}</label>
                  <input id={`ka-${lane.key}`} placeholder="Add a card" maxLength={300} value={drafts[lane.key] || ''} onChange={(e) => setDrafts((d) => ({ ...d, [lane.key]: e.target.value }))} />
                  <button className="btn btn--sm" type="submit" disabled={!(drafts[lane.key] || '').trim()}>Add</button>
                </form>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
