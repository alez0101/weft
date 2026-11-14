// A meeting: when it is held, its calendar event, the agenda, notes and decisions, and its action items.
// Action items are real tasks in a task list the meeting chooses (same space), so they also show in Tasks,
// Boards, the Calendar and on Home. Editors change everything; viewers read, and may tick off a task assigned
// to them (the Tasks rule). Each text section saves on its own when you leave it, so two people writing in
// different sections do not overwrite each other. Row-level security decides; when it says no, the reason
// is shown and the meeting is reloaded. Live: changes to this meeting, its action items or tasks in its
// space refetch it, without touching a section someone is still typing in.
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { dueLabel, today } from './TaskList.jsx';

const SECTIONS = [
  ['agenda', 'Agenda', 'What you will talk about, one point per line'],
  ['notes', 'Notes', 'What was said'],
  ['decisions', 'Decisions', 'What was decided, one per line'],
];
// datetime-local works in local time, without seconds.
const toLocal = (d) => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };
export const heldLabel = (iso) => (iso ? new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const EMPTY = { title: '', assignee_id: '', due_on: '' };

export default function Meeting({ item, me, members, editable, notice, onOpenEvent, onOpenItem }) {
  const [m, setM] = useState(null);
  const [actions, setActions] = useState([]);
  const [events, setEvents] = useState([]);
  const [lists, setLists] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [form, setForm] = useState(EMPTY);

  const people = members.filter((x) => x.space_id === item.space_id && x.user)
    .map((x) => x.user).sort((a, b) => a.display_name.localeCompare(b.display_name));
  const nameOf = (id) => people.find((p) => p.id === id)?.display_name ?? (id ? 'Someone not in this space' : '');

  const load = useCallback(async () => {
    const from = new Date(Date.now() - 90 * 86400000).toISOString(); const to = new Date(Date.now() + 180 * 86400000).toISOString();
    const [rows, acts, evs, ls] = await Promise.all([
      api(`/meetings?id=eq.${item.id}&select=id,held_at,agenda,notes,decisions,event_id,task_list_id,updated_at,event:events(id,title,starts_at,ends_at,location),list:items!meetings_task_list_id_fkey(id,title)`),
      api(`/meeting_actions?meeting_id=eq.${item.id}&select=task_id,created_at,task:tasks(id,title,assignee_id,due_on,done,list_id)&order=created_at`),
      api(`/events?space_id=eq.${item.space_id}&starts_at=gte.${from}&starts_at=lte.${to}&select=id,title,starts_at&order=starts_at&limit=300`),
      api(`/items?kind=eq.tasklist&space_id=eq.${item.space_id}&select=id,title&order=title`),
    ]);
    setM(rows[0] || false); setActions(acts.filter((a) => a.task)); setEvents(evs); setLists(ls);
  }, [item.id, item.space_id]);
  useEffect(() => { load().catch((e) => setError(`The meeting could not load: ${e.message}`)); }, [load]);
  useEffect(() => {
    if (!notice) return;
    if ((notice.t === 'meetings' && notice.id === item.id) || (notice.t === 'meeting_actions' && notice.meeting === item.id)
      || (['tasks', 'events', 'items'].includes(notice.t) && notice.space === item.space_id)) load().catch(() => {});
  }, [notice, item.id, item.space_id, load]);

  // Every change: show the database's answer if it refuses, and reload so the screen matches the data.
  const change = async (what, run) => {
    let ok = false;
    try { await run(); setError(''); ok = true; } catch (e) { setError(`${what}: ${e.message}`); }
    await load().catch(() => {});
    return ok;
  };
  const patch = (body, what = 'That change was not saved') => change(what, () => api(`/meetings?id=eq.${item.id}`, { method: 'PATCH', body, prefer: 'return=minimal' }));

  const saveSection = async (key) => {
    if (!(key in drafts)) return;
    const v = drafts[key];
    if (v.trim() !== (m[key] || '')) {
      if (await patch({ [key]: v })) setSaved(`${SECTIONS.find((s) => s[0] === key)[1]} saved.`);
    }
    setDrafts((d) => { const n = { ...d }; delete n[key]; return n; });
  };
  const linkEvent = (id) => {
    const ev = events.find((e) => e.id === id);
    // Linking an event also sets the meeting's time to the event's start.
    patch(id ? { event_id: id, held_at: ev?.starts_at ?? m.held_at } : { event_id: null }, 'Could not link the event');
  };
  async function addAction(e) {
    e.preventDefault();
    if (!form.title.trim()) return;
    const ok = await change('Could not add the action item', () => api('/rpc/add_meeting_action', { method: 'POST',
      body: { p_meeting: item.id, p_title: form.title.trim(), p_assignee: form.assignee_id || null, p_due: form.due_on || null } }));
    if (ok) setForm((f) => ({ ...EMPTY, assignee_id: f.assignee_id }));
  }
  const tick = (t, done) => {
    setActions((as) => as.map((x) => (x.task.id === t.id ? { ...x, task: { ...x.task, done } } : x)));
    return change('That change was not saved', () => api(`/tasks?id=eq.${t.id}`, { method: 'PATCH', body: { done }, prefer: 'return=minimal' }));
  };
  const unlink = (t) => {
    if (!window.confirm(`Remove "${t.title}" from this meeting? The task stays in its list.`)) return;
    change('Could not remove it', () => api(`/meeting_actions?task_id=eq.${t.id}`, { method: 'DELETE', prefer: 'return=minimal' }));
  };

  if (m === null) return error ? <p className="send-error" role="alert">{error}</p> : <div className="skeleton" aria-label="Loading the meeting"><span /><span /><span /></div>;
  if (m === false) return <p className="send-error" role="alert">This meeting could not be found.</p>;
  const t0 = today();
  const linkedMissing = m.event_id && !events.some((e) => e.id === m.event_id);

  return (
    <div className="meeting">
      {!editable && <p className="docs-hint">You can read this meeting and tick off action items assigned to you. Ask an owner of the space to make you an editor to change anything else.</p>}
      {error && <p className="send-error" role="alert">{error}</p>}

      <section className="meeting-facts" aria-label="When and where">
        <div className="meeting-fact">
          <label htmlFor="meeting-when">When</label>
          {editable
            ? <input id="meeting-when" type="datetime-local" key={m.held_at || 'none'} defaultValue={m.held_at ? toLocal(m.held_at) : ''}
                onBlur={(e) => { const v = e.target.value ? new Date(e.target.value).toISOString() : null; if (v !== (m.held_at ? new Date(m.held_at).toISOString() : null)) patch({ held_at: v }); }} />
            : <span id="meeting-when" className="meeting-value">{m.held_at ? heldLabel(m.held_at) : 'No date set'}</span>}
        </div>
        <div className="meeting-fact">
          <label htmlFor="meeting-event">Calendar event</label>
          {editable ? (
            <select id="meeting-event" value={m.event_id || ''} onChange={(e) => linkEvent(e.target.value)}>
              <option value="">None</option>
              {linkedMissing && m.event && <option value={m.event_id}>{m.event.title}, {heldLabel(m.event.starts_at)}</option>}
              {events.map((ev) => <option key={ev.id} value={ev.id}>{ev.title}, {heldLabel(ev.starts_at)}</option>)}
            </select>
          ) : <span id="meeting-event" className="meeting-value">{m.event ? m.event.title : 'None'}</span>}
          {m.event && onOpenEvent && <button type="button" className="btn btn--sm" onClick={() => onOpenEvent(m.event.id)}>Open in Calendar<span className="visually-hidden">: {m.event.title}</span></button>}
        </div>
        {editable && !events.length && !m.event && <p className="docs-hint meeting-hint">No events in this space around now. Add one in Calendar, in the same space, to link it.</p>}
      </section>

      {SECTIONS.map(([key, label, hint]) => (
        <section key={key} className="meeting-section" aria-labelledby={`meeting-h-${key}`}>
          <h3 id={`meeting-h-${key}`} className="meeting-heading">{label}</h3>
          {editable ? (<>
            <label className="visually-hidden" htmlFor={`meeting-${key}`}>{label}</label>
            <textarea id={`meeting-${key}`} className="meeting-text" rows={key === 'notes' ? 8 : 4} maxLength={20000} placeholder={hint}
              value={drafts[key] ?? m[key]} onChange={(e) => { setSaved(''); setDrafts((d) => ({ ...d, [key]: e.target.value })); }} onBlur={() => saveSection(key)} />
          </>) : m[key] ? <p className="meeting-read">{m[key]}</p> : <p className="convo-empty">Nothing written yet.</p>}
        </section>
      ))}
      {saved && <p className="slot-status" role="status">{saved}</p>}

      <section className="meeting-section" aria-labelledby="meeting-h-actions">
        <h3 id="meeting-h-actions" className="meeting-heading">Action items</h3>
        <div className="meeting-fact">
          <label htmlFor="meeting-list">Add them to</label>
          {editable ? (
            <select id="meeting-list" value={m.task_list_id || ''} onChange={(e) => patch({ task_list_id: e.target.value || null }, 'Could not choose that list')}>
              <option value="">Choose a task list…</option>
              {lists.map((l) => <option key={l.id} value={l.id}>{l.title}</option>)}
            </select>
          ) : <span id="meeting-list" className="meeting-value">{m.list ? m.list.title : 'No task list chosen'}</span>}
          {m.list && onOpenItem && <button type="button" className="btn btn--sm" onClick={() => onOpenItem(m.list.id)}>Open the list<span className="visually-hidden">: {m.list.title}</span></button>}
        </div>
        {editable && !lists.length && <p className="docs-hint meeting-hint">There is no task list in this space yet. Make one in Tasks, then choose it here.</p>}
        {editable && m.task_list_id && (
          <form className="task-add" onSubmit={addAction} aria-label="Add an action item">
            <label className="visually-hidden" htmlFor="action-new">New action item</label>
            <input id="action-new" placeholder="Add an action item" maxLength={300} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            <label className="visually-hidden" htmlFor="action-new-who">Assigned to</label>
            <select id="action-new-who" value={form.assignee_id} onChange={(e) => setForm({ ...form, assignee_id: e.target.value })}>
              <option value="">No one</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.id === me.id ? `${p.display_name} (you)` : p.display_name}</option>)}
            </select>
            <label className="visually-hidden" htmlFor="action-new-due">Due date</label>
            <input id="action-new-due" type="date" value={form.due_on} onChange={(e) => setForm({ ...form, due_on: e.target.value })} />
            <button className="btn btn--primary btn--sm" type="submit" disabled={!form.title.trim()}>Add action item</button>
          </form>
        )}
        {!actions.length ? <p className="convo-empty">No action items yet.</p> : (
          <ul className="task-list" aria-label="Action items">
            {actions.map(({ task: t }) => (
              <li key={t.id} className={`task meeting-action${t.done ? ' is-done' : ''}`}>
                <input type="checkbox" className="task-check" checked={t.done} disabled={!editable && t.assignee_id !== me.id} aria-label={`Done: ${t.title}`}
                  onChange={(e) => tick(t, e.target.checked)} />
                <span className="task-title task-title--read">{t.title}</span>
                <span className="task-meta">{nameOf(t.assignee_id) || 'No one'}</span>
                <span className={`task-meta${!t.done && t.due_on && t.due_on < t0 ? ' is-late' : ''}`}>{t.due_on ? dueLabel(t.due_on) : 'No due date'}</span>
                {editable && <button className="btn btn--sm" type="button" onClick={() => unlink(t)}>Remove<span className="visually-hidden"> {t.title}</span></button>}
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="docs-hint">Last changed {heldLabel(m.updated_at)}.</p>
    </div>
  );
}
