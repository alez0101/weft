// A task list: tasks with who does them, when they are due, and done or not. Editors add, change, tick
// off and delete; viewers read. Row-level security decides; when it says no, the reason is shown and the
// list is reloaded. Live: any change to this list's tasks refetches it.
// Repeating tasks (050): a task may repeat every day, week or month; ticking it off makes the next one
// (the database does it, so it works the same from Boards and connected apps).
// Away warnings (052): an open task whose assignee has time off on its due date says "Pat is away then".
// Comments on tasks (053): each task has a short comment thread under it (TaskComments.jsx).
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { AwayLive, AwayNote, useAway } from './Away.jsx';
import { TaskComments, ownsSpace, useTaskComments } from './TaskComments.jsx';

export const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00`); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
// "Today", "Tomorrow", "Overdue, Tue 10 Nov", "Fri 20 Nov"
export const dueLabel = (iso) => {
  if (!iso) return '';
  const t = today();
  if (iso === t) return 'Due today';
  if (iso === addDays(t, 1)) return 'Due tomorrow';
  const s = new Date(`${iso}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', ...(iso.slice(0, 4) !== t.slice(0, 4) ? { year: 'numeric' } : {}) });
  return iso < t ? `Overdue, ${s}` : `Due ${s}`;
};

const EMPTY = { title: '', assignee_id: '', due_on: '', repeats: '' };
export const REPEATS = { daily: 'Every day', weekly: 'Every week', monthly: 'Every month' };
const RepeatOptions = () => (<><option value="">Does not repeat</option>{Object.entries(REPEATS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</>);

export default function TaskList({ item, me, members, editable, notice }) {
  const [tasks, setTasks] = useState(null);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [form, setForm] = useState(EMPTY);
  const [showDone, setShowDone] = useState(true);
  const [mineOnly, setMineOnly] = useState(false);
  const awayOn = useAway(notice);
  const { byTask, reload: reloadComments } = useTaskComments(item.id, notice);
  const owner = ownsSpace(members, item.space_id, me);

  const people = members.filter((m) => m.space_id === item.space_id && m.user)
    .map((m) => m.user).sort((a, b) => a.display_name.localeCompare(b.display_name));
  const nameOf = (id) => people.find((p) => p.id === id)?.display_name ?? (id ? 'Someone not in this space' : '');

  const load = useCallback(() => api(`/tasks?list_id=eq.${item.id}&select=id,title,assignee_id,due_on,repeats,done,done_at,position&order=position,created_at`)
    .then((r) => { setTasks(r); }), [item.id]);
  useEffect(() => { load().catch((e) => setError(`The list could not load: ${e.message}`)); }, [load]);
  useEffect(() => { if (notice?.t === 'tasks' && notice.list === item.id) load().catch(() => {}); }, [notice, item.id, load]);

  // Every change: show the database's answer if it refuses, and reload so the screen matches the data.
  const change = async (what, run) => {
    try { await run(); setError(''); return true; } catch (e) { setError(`${what}: ${e.message}`); setInfo(''); return false; } finally { load().catch(() => {}); }
  };
  const patch = (t, body) => {
    setTasks((ts) => ts.map((x) => (x.id === t.id ? { ...x, ...body } : x)));
    return change('That change was not saved', () => api(`/tasks?id=eq.${t.id}`, { method: 'PATCH', body, prefer: 'return=minimal' }));
  };
  async function add(e) {
    e.preventDefault();
    if (!form.title.trim()) return;
    const pos = Math.max(-1, ...(tasks || []).map((t) => t.position)) + 1;
    const body = { list_id: item.id, title: form.title.trim(), assignee_id: form.assignee_id || null, due_on: form.due_on || null, repeats: form.repeats || null, position: pos };
    await change('Could not add the task', async () => { await api('/tasks', { method: 'POST', body, prefer: 'return=minimal' }); setForm((f) => ({ ...EMPTY, assignee_id: f.assignee_id })); });
  }
  // Ticking off: a repeating task comes back with its next due date (made by the database).
  const tick = async (t, done) => {
    const ok = await patch(t, { done });
    setInfo(ok && done && t.repeats ? `"${t.title}" repeats ${REPEATS[t.repeats].toLowerCase()}, so the next one is on the list.` : '');
  };
  const remove = (t) => {
    if (!window.confirm(`Delete the task "${t.title}"? Everyone who can see this list loses it.`)) return;
    change('Could not delete', () => api(`/tasks?id=eq.${t.id}`, { method: 'DELETE', prefer: 'return=minimal' }));
  };
  const clearDone = () => {
    const ids = (tasks || []).filter((t) => t.done).map((t) => t.id);
    if (!ids.length || !window.confirm(`Delete ${ids.length} done task${ids.length > 1 ? 's' : ''}?`)) return;
    change('Could not delete', () => api(`/tasks?id=in.(${ids.join(',')})`, { method: 'DELETE', prefer: 'return=minimal' }));
  };

  if (!tasks) return error ? <p className="send-error" role="alert">{error}</p> : <div className="skeleton" aria-label="Loading the list"><span /><span /><span /></div>;
  const t0 = today();
  const shown = tasks.filter((t) => !mineOnly || t.assignee_id === me.id);
  const open = shown.filter((t) => !t.done);
  const done = shown.filter((t) => t.done);

  const row = (t) => (
    <li key={t.id} className={`task task--repeat${t.done ? ' is-done' : ''}`}>
      <input type="checkbox" className="task-check" checked={t.done} disabled={!editable && t.assignee_id !== me.id} aria-label={`Done: ${t.title}`}
        onChange={(e) => tick(t, e.target.checked)} />
      {editable ? (
        <>
          <label className="visually-hidden" htmlFor={`tt-${t.id}`}>Task</label>
          <input id={`tt-${t.id}`} className="task-title" defaultValue={t.title} key={`${t.id}-${t.title}`} maxLength={300}
            onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== t.title) patch(t, { title: v }); else e.target.value = t.title; }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
          <label className="visually-hidden" htmlFor={`ta-${t.id}`}>Assigned to</label>
          <select id={`ta-${t.id}`} className="task-who" value={t.assignee_id || ''} onChange={(e) => patch(t, { assignee_id: e.target.value || null })}>
            <option value="">No one</option>
            {t.assignee_id && !people.some((p) => p.id === t.assignee_id) && <option value={t.assignee_id}>{nameOf(t.assignee_id)}</option>}
            {people.map((p) => <option key={p.id} value={p.id}>{p.id === me.id ? `${p.display_name} (you)` : p.display_name}</option>)}
          </select>
          <label className="visually-hidden" htmlFor={`td-${t.id}`}>Due date</label>
          <input id={`td-${t.id}`} type="date" className={`task-due${!t.done && t.due_on && t.due_on < t0 ? ' is-late' : ''}`} value={t.due_on || ''}
            onChange={(e) => patch(t, { due_on: e.target.value || null })} />
          <label className="visually-hidden" htmlFor={`tr-${t.id}`}>Repeats</label>
          <select id={`tr-${t.id}`} className="task-repeat" value={t.repeats || ''} disabled={t.done} title={t.done ? 'A done task does not repeat; its next one does' : undefined}
            onChange={(e) => patch(t, { repeats: e.target.value || null })}><RepeatOptions /></select>
          <button className="btn btn--sm" type="button" onClick={() => remove(t)}>Delete<span className="visually-hidden"> {t.title}</span></button>
        </>
      ) : (
        <>
          <span className="task-title task-title--read">{t.title}</span>
          <span className="task-meta">{nameOf(t.assignee_id) || 'No one'}</span>
          <span className={`task-meta${!t.done && t.due_on && t.due_on < t0 ? ' is-late' : ''}`}>{t.due_on ? dueLabel(t.due_on) : 'No due date'}</span>
          <span className="task-meta task-repeats">{t.repeats ? REPEATS[t.repeats] : ''}</span>
        </>
      )}
      {!t.done && <AwayNote away={awayOn(t.assignee_id, t.due_on)} name={nameOf(t.assignee_id)} isMe={t.assignee_id === me.id} />}
      <TaskComments task={t} comments={byTask[t.id]} me={me} nameOf={nameOf} canPost={editable || t.assignee_id === me.id} isOwner={owner} onChanged={() => reloadComments().catch(() => {})} />
    </li>
  );

  return (
    <div className="tasks">
      {editable ? (
        <form className="task-add task-add--repeat" onSubmit={add} aria-label="Add a task">
          <label className="visually-hidden" htmlFor="task-new">New task</label>
          <input id="task-new" placeholder="Add a task" maxLength={300} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <label className="visually-hidden" htmlFor="task-new-who">Assigned to</label>
          <select id="task-new-who" value={form.assignee_id} onChange={(e) => setForm({ ...form, assignee_id: e.target.value })}>
            <option value="">No one</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.id === me.id ? `${p.display_name} (you)` : p.display_name}</option>)}
          </select>
          <label className="visually-hidden" htmlFor="task-new-due">Due date</label>
          <input id="task-new-due" type="date" value={form.due_on} onChange={(e) => setForm({ ...form, due_on: e.target.value })} />
          <label className="visually-hidden" htmlFor="task-new-repeat">Repeats</label>
          <select id="task-new-repeat" value={form.repeats} onChange={(e) => setForm({ ...form, repeats: e.target.value })}><RepeatOptions /></select>
          <button className="btn btn--primary btn--sm" type="submit" disabled={!form.title.trim()}>Add task</button>
          <AwayLive away={awayOn(form.assignee_id, form.due_on)} name={nameOf(form.assignee_id)} isMe={form.assignee_id === me.id} />
        </form>
      ) : <p className="docs-hint">You can read this list, and tick off and comment on tasks assigned to you. Ask an owner of the space to make you an editor to change anything else.</p>}
      {error && <p className="send-error" role="alert">{error}</p>}
      <p className="docs-hint task-info" role="status">{info}</p>
      <div className="task-filters">
        <span className="task-count" role="status">{open.length} open, {done.length} done</span>
        <label className="toggle"><input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} /> Only mine</label>
        <label className="toggle"><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Show done</label>
        {editable && done.length > 0 && <button className="btn btn--sm" type="button" onClick={clearDone}>Delete done tasks</button>}
      </div>
      {!open.length && !done.length ? <p className="convo-empty">{mineOnly ? 'Nothing here is assigned to you.' : editable ? 'No tasks yet. Add the first one above.' : 'No tasks yet.'}</p> : (
        <>
          <ul className="task-list" aria-label="Open tasks">{open.map(row)}</ul>
          {!open.length && <p className="convo-empty">Everything here is done.</p>}
          {showDone && done.length > 0 && (<>
            <p className="tree-group">Done</p>
            <ul className="task-list" aria-label="Done tasks">{done.map(row)}</ul>
          </>)}
        </>
      )}
    </div>
  );
}
