// A retrospective: looking back on a period in three columns, Went well, To improve and Actions. Every member
// of the space adds notes, viewers included, and may post anonymously: then nobody in Weft can see who wrote
// it (the database never hands out the author of an anonymous note, not even to owners). You change or
// delete your own notes; editors and owners set the period and the task list, delete any note (tidying up)
// and turn an action into a real task in that list, so it shows in Tasks, Boards, the Calendar and on Home.
// Row-level security and the guard trigger decide; when they say no, the reason is shown and the retro is
// reloaded. Live: changes to this retro, its notes, or tasks and lists in its space refetch it.
// Weft (search and the assistant) reads the retro's text summary, kept by the database; it names no one.
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { dueLabel, today } from './TaskList.jsx';

const COLUMNS = [
  ['went_well', 'Went well', 'Something that worked'],
  ['to_improve', 'To improve', 'Something to do better'],
  ['action', 'Actions', 'Something to do next'],
];
// Never created_by: no one may read it, and asking for it (or for *) is refused.
const NOTE = 'id,kind,body,anonymous,author_id,task_id,created_at,updated_at,author:users!retro_notes_author_id_fkey(display_name),task:tasks(id,title,done,assignee_id,due_on)';
const day = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
export const periodLabel = (from, to) => (from && to ? `${day(from)} to ${day(to)}` : from ? `From ${day(from)}` : to ? `Until ${day(to)}` : '');

function AddNote({ kind, label, hint, onAdd }) {
  const [body, setBody] = useState('');
  const [anon, setAnon] = useState(false);
  const save = async (e) => {
    e.preventDefault();
    if (body.trim() && await onAdd(kind, body.trim(), anon)) setBody('');
  };
  return (
    <form className="retro-add" onSubmit={save} aria-label={`Add to ${label}`} noValidate>
      <label className="visually-hidden" htmlFor={`retro-new-${kind}`}>New note in {label}</label>
      <textarea id={`retro-new-${kind}`} rows={2} maxLength={1000} placeholder={hint} value={body} onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save(e); }} />
      <div className="retro-add-foot">
        <label className="retro-anon"><input type="checkbox" checked={anon} onChange={(e) => setAnon(e.target.checked)} /> Post anonymously</label>
        <button className="btn btn--primary btn--sm" type="submit" disabled={!body.trim()}>Add<span className="visually-hidden"> to {label}</span></button>
      </div>
    </form>
  );
}

function EditNote({ note, onSave, onCancel }) {
  const [body, setBody] = useState(note.body);
  return (
    <form className="retro-add" aria-label="Change your note" noValidate onSubmit={(e) => { e.preventDefault(); if (body.trim()) onSave(body.trim()); }}>
      <label className="visually-hidden" htmlFor={`retro-edit-${note.id}`}>Your note</label>
      <textarea id={`retro-edit-${note.id}`} rows={3} maxLength={1000} value={body} onChange={(e) => setBody(e.target.value)} autoFocus />
      <div className="retro-add-foot">
        <button className="btn btn--primary btn--sm" type="submit" disabled={!body.trim()}>Save</button>
        <button className="btn btn--sm" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function MakeTask({ note, people, me, onMake, onCancel }) {
  const [who, setWho] = useState('');
  const [due, setDue] = useState('');
  return (
    <form className="retro-task-form" aria-label="Make a task" noValidate onSubmit={(e) => { e.preventDefault(); onMake(note, who || null, due || null); }}>
      <label htmlFor={`retro-who-${note.id}`}>Assigned to</label>
      <select id={`retro-who-${note.id}`} value={who} onChange={(e) => setWho(e.target.value)}>
        <option value="">No one</option>
        {people.map((p) => <option key={p.id} value={p.id}>{p.id === me.id ? `${p.display_name} (you)` : p.display_name}</option>)}
      </select>
      <label htmlFor={`retro-due-${note.id}`}>Due</label>
      <input id={`retro-due-${note.id}`} type="date" value={due} onChange={(e) => setDue(e.target.value)} />
      <div className="retro-add-foot">
        <button className="btn btn--primary btn--sm" type="submit">Make the task</button>
        <button className="btn btn--sm" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

export default function Retro({ item, me, members, editable, notice, onOpenItem }) {
  const [r, setR] = useState(null);
  const [notes, setNotes] = useState([]);
  const [mine, setMine] = useState(new Set());
  const [lists, setLists] = useState([]);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);
  const [making, setMaking] = useState(null);

  const people = members.filter((x) => x.space_id === item.space_id && x.user)
    .map((x) => x.user).sort((a, b) => a.display_name.localeCompare(b.display_name));
  const nameOf = (id) => people.find((p) => p.id === id)?.display_name ?? (id ? 'Someone not in this space' : '');

  const load = useCallback(async () => {
    const [rows, ns, my, ls] = await Promise.all([
      api(`/retros?id=eq.${item.id}&select=id,period_from,period_to,task_list_id,updated_at,list:items!retros_task_list_id_fkey(id,title)`),
      api(`/retro_notes?retro_id=eq.${item.id}&select=${NOTE}&order=created_at`),
      api('/rpc/my_retro_notes', { method: 'POST', body: { p_retro: item.id } }),
      api(`/items?kind=eq.tasklist&space_id=eq.${item.space_id}&select=id,title&order=title`),
    ]);
    setR(rows[0] || false); setNotes(ns); setMine(new Set(my)); setLists(ls);
  }, [item.id, item.space_id]);
  useEffect(() => { load().catch((e) => setError(`The retro could not load: ${e.message}`)); }, [load]);
  useEffect(() => {
    if (!notice) return;
    if ((notice.t === 'retros' && notice.retro === item.id)
      || (['tasks', 'items'].includes(notice.t) && notice.space === item.space_id)) load().catch(() => {});
  }, [notice, item.id, item.space_id, load]);

  // Every change: show the database's answer if it refuses, and reload so the screen matches the data.
  const change = async (what, run) => {
    let ok = false;
    try { await run(); setError(''); ok = true; } catch (e) { setError(`${what}: ${e.message}`); }
    await load().catch(() => {});
    return ok;
  };
  const patch = (body, what = 'That change was not saved') => change(what, () => api(`/retros?id=eq.${item.id}`, { method: 'PATCH', body, prefer: 'return=minimal' }));
  const add = (kind, body, anonymous) => change('Could not add the note', () => api('/retro_notes', { method: 'POST', body: { retro_id: item.id, kind, body, anonymous }, prefer: 'return=minimal' }));
  const save = async (n, body) => { if (await change('Could not save your note', () => api(`/retro_notes?id=eq.${n.id}`, { method: 'PATCH', body: { body }, prefer: 'return=minimal' }))) setEditing(null); };
  const remove = (n) => {
    if (!window.confirm(mine.has(n.id) ? 'Delete your note?' : `Delete this note${n.anonymous ? '' : ` by ${n.author?.display_name || 'someone'}`}?`)) return;
    change('Could not delete the note', () => api(`/retro_notes?id=eq.${n.id}`, { method: 'DELETE', prefer: 'return=minimal' }));
  };
  const makeTask = async (n, assignee, due) => {
    if (await change('Could not make the task', () => api('/rpc/retro_action_to_task', { method: 'POST', body: { p_note: n.id, p_assignee: assignee, p_due: due } }))) setMaking(null);
  };
  const tick = (t, done) => change('That change was not saved', () => api(`/tasks?id=eq.${t.id}`, { method: 'PATCH', body: { done }, prefer: 'return=minimal' }));

  if (r === null) return error ? <p className="send-error" role="alert">{error}</p> : <div className="skeleton" aria-label="Loading the retro"><span /><span /><span /></div>;
  if (r === false) return <p className="send-error" role="alert">This retro could not be found.</p>;
  const t0 = today();
  const actions = notes.filter((n) => n.kind === 'action');
  const asTasks = actions.filter((n) => n.task).length;

  return (
    <div className="retro">
      {editable
        ? <p className="docs-hint">Everyone in this space can add notes, viewers too. Anonymous notes show no name to anyone, owners included; people may still guess from timing or wording.</p>
        : <p className="docs-hint">You can add notes and change or delete your own. Anonymous notes show no name to anyone. Ask an owner of the space to make you an editor to set the period or turn actions into tasks.</p>}
      {error && <p className="send-error" role="alert">{error}</p>}

      <section className="meeting-facts" aria-label="Period and tasks">
        <div className="meeting-fact">
          <span className="retro-fact-label" id="retro-period-label">Period</span>
          {editable ? (<>
            <label className="visually-hidden" htmlFor="retro-from">From</label>
            <input id="retro-from" type="date" aria-describedby="retro-period-label" value={r.period_from || ''} max={r.period_to || undefined}
              onChange={(e) => patch({ period_from: e.target.value || null }, 'Could not set the period')} />
            <span aria-hidden="true">to</span>
            <label className="visually-hidden" htmlFor="retro-to">To</label>
            <input id="retro-to" type="date" aria-describedby="retro-period-label" value={r.period_to || ''} min={r.period_from || undefined}
              onChange={(e) => patch({ period_to: e.target.value || null }, 'Could not set the period')} />
          </>) : <span className="meeting-value">{periodLabel(r.period_from, r.period_to) || 'Not set'}</span>}
        </div>
        <div className="meeting-fact">
          <label htmlFor="retro-list">Actions become tasks in</label>
          {editable ? (
            <select id="retro-list" value={r.task_list_id || ''} onChange={(e) => patch({ task_list_id: e.target.value || null }, 'Could not choose that list')}>
              <option value="">Choose a task list…</option>
              {lists.map((l) => <option key={l.id} value={l.id}>{l.title}</option>)}
            </select>
          ) : <span id="retro-list" className="meeting-value">{r.list ? r.list.title : 'No task list chosen'}</span>}
          {r.list && onOpenItem && <button type="button" className="btn btn--sm" onClick={() => onOpenItem(r.list.id)}>Open the list<span className="visually-hidden">: {r.list.title}</span></button>}
        </div>
        {editable && !lists.length && <p className="docs-hint meeting-hint">There is no task list in this space yet. Make one in Tasks, then choose it here.</p>}
        <p className="goal-meta" role="status">{notes.length} note{notes.length === 1 ? '' : 's'}, {actions.length} action{actions.length === 1 ? '' : 's'}{actions.length ? `, ${asTasks} made into tasks` : ''}</p>
      </section>

      <div className="retro-columns">
        {COLUMNS.map(([kind, label, hint]) => {
          const col = notes.filter((n) => n.kind === kind);
          return (
            <section key={kind} className={`retro-col retro-col--${kind}`} aria-labelledby={`retro-h-${kind}`}>
              <h3 id={`retro-h-${kind}`} className="retro-col-head">{label}<span className="retro-count">{col.length}</span></h3>
              <AddNote kind={kind} label={label} hint={hint} onAdd={add} />
              {!col.length ? <p className="convo-empty">Nothing yet.</p> : (
                <ul className="retro-notes" aria-label={label}>
                  {col.map((n) => {
                    const own = mine.has(n.id);
                    const who = n.anonymous ? (own ? 'Anonymous (you)' : 'Anonymous') : `${n.author?.display_name || 'Someone'}${own ? ' (you)' : ''}`;
                    return (
                      <li key={n.id} className={`retro-note${n.anonymous ? ' is-anon' : ''}`}>
                        {editing === n.id ? <EditNote note={n} onSave={(b) => save(n, b)} onCancel={() => setEditing(null)} /> : <p className="retro-body">{n.body}</p>}
                        {n.task && (
                          <div className={`retro-task${n.task.done ? ' is-done' : ''}`}>
                            <input type="checkbox" className="task-check" checked={n.task.done} disabled={!editable && n.task.assignee_id !== me.id}
                              aria-label={`Task done: ${n.task.title}`} onChange={(e) => tick(n.task, e.target.checked)} />
                            <span className="retro-task-text">Task{n.task.done ? ', done' : ''}: {nameOf(n.task.assignee_id) || 'no one'}
                              {n.task.due_on && <span className={!n.task.done && n.task.due_on < t0 ? ' is-late' : ''}>, {dueLabel(n.task.due_on)}</span>}</span>
                          </div>
                        )}
                        {making === n.id && <MakeTask note={n} people={people} me={me} onMake={makeTask} onCancel={() => setMaking(null)} />}
                        {editing !== n.id && making !== n.id && (
                          <div className="link-foot">
                            <span className={`retro-by${n.anonymous ? ' is-anon' : ''}`}>{who}</span>
                            {editable && kind === 'action' && !n.task && r.task_list_id && (
                              <button className="btn btn--sm" type="button" onClick={() => setMaking(n.id)}>Make a task<span className="visually-hidden">: {n.body}</span></button>)}
                            {own && <button className="btn btn--sm" type="button" onClick={() => setEditing(n.id)}>Change<span className="visually-hidden"> your note</span></button>}
                            {(own || editable) && <button className="btn btn--sm" type="button" onClick={() => remove(n)}>Delete<span className="visually-hidden"> note: {n.body}</span></button>}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
      </div>
      {editable && actions.some((n) => !n.task) && !r.task_list_id && <p className="docs-hint">Choose a task list above to turn actions into tasks.</p>}
    </div>
  );
}
