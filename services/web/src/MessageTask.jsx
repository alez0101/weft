// Task from a message (077): a "Make a task" action on a chat message opens Add a task with the message as the
// title, in a task list of the same channel (or Personal space). The task keeps a link back to the message
// (weft.tasks.message_id): Tasks shows "From a message", and the message shows the task it became.
// Only editors and owners see the action; the database decides (a viewer's insert is refused, and a link to a
// message in another space is refused) and its answer is shown.
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

// The message as a task title: one line, links to Weft items left out, at most 300 characters.
export const titleFrom = (body) => {
  const t = (body || '').replace(/weft:\/\/(?:item|event)\/[0-9a-f-]{36}/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > 300 ? `${t.slice(0, 299).trimEnd()}…` : t;
};

// The task lists in a space and the tasks made from its messages (by message id). Reloads on a tasks or items
// notice for that space. Off (nothing fetched) for conversations that have no task lists (assistant, agents, DMs).
export function useMessageTasks(spaceId, on, notice) {
  const [lists, setLists] = useState(null);
  const [byMessage, setByMessage] = useState({});
  const reload = useCallback(async () => {
    if (!on || !spaceId) { setLists(null); setByMessage({}); return; }
    const ls = await api(`/items?space_id=eq.${spaceId}&kind=eq.tasklist&select=id,title&order=title`);
    setLists(ls);
    if (!ls.length) { setByMessage({}); return; }
    const ts = await api(`/tasks?list_id=in.(${ls.map((l) => l.id).join(',')})&message_id=not.is.null&select=id,title,done,list_id,message_id&order=created_at`);
    const m = {};
    for (const t of ts) (m[t.message_id] ||= []).push({ ...t, list: ls.find((l) => l.id === t.list_id)?.title ?? 'a task list' });
    setByMessage(m);
  }, [spaceId, on]);
  useEffect(() => { reload().catch(() => { setLists([]); setByMessage({}); }); }, [reload]);
  useEffect(() => {
    if (on && notice && ['tasks', 'items'].includes(notice.t) && notice.space === spaceId) reload().catch(() => {});
  }, [notice, on, spaceId, reload]);
  return { lists, byMessage, reload };
}

// Under a message: the tasks it became ("Task open in Stage crew jobs"), each opening its list.
export function MessageTasks({ tasks = [], onOpenItem }) {
  if (!tasks.length) return null;
  return (
    <p className="msg-tasks">
      {tasks.map((t) => (
        <button key={t.id} type="button" className={`msg-task${t.done ? ' is-done' : ''}`} title={`Open ${t.list}`} onClick={() => onOpenItem(t.list_id)}>
          {t.done ? 'Task done' : 'Task open'} in {t.list}
        </button>
      ))}
    </p>
  );
}

// Add a task, filled in from the message. If the space has no task list yet, it offers to make one called Tasks.
export function MessageTaskForm({ message, spaceId, lists, people, me, lastList, onAdded, onCancel }) {
  const NEW = 'new';
  const [title, setTitle] = useState(() => titleFrom(message.body));
  const [picked, setList] = useState('');
  // The lists may arrive after the form opens: until one is picked, the last one used here, else the first.
  const list = (lists?.some((l) => l.id === picked) ? picked : lists?.some((l) => l.id === lastList) ? lastList : lists?.[0]?.id) || NEW;
  const [who, setWho] = useState('');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const idp = `mt-${message.id}`;
  async function submit(e) {
    e.preventDefault();
    const t = title.trim();
    if (!t) return;
    setBusy(true); setErr('');
    try {
      let listId = list; let listName = lists?.find((l) => l.id === list)?.title;
      if (list === NEW) {
        const [row] = await api('/items', { method: 'POST', body: { space_id: spaceId, kind: 'tasklist', title: 'Tasks' }, prefer: 'return=representation' });
        listId = row.id; listName = row.title;
      }
      const [last] = await api(`/tasks?list_id=eq.${listId}&select=position&order=position.desc&limit=1`);
      await api('/tasks', {
        method: 'POST', prefer: 'return=minimal',
        body: { list_id: listId, title: t, assignee_id: who || null, due_on: due || null, message_id: message.id, position: (last?.position ?? -1) + 1 },
      });
      onAdded({ listId, listName, title: t });
    } catch (x) { setErr(`Could not add the task: ${x.message}`); setBusy(false); }
  }
  return (
    <form className="link-form msg-task-form" aria-label="Add a task" onSubmit={submit} onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }}>
      <label htmlFor={`${idp}-title`}>Task</label>
      <input id={`${idp}-title`} value={title} maxLength={300} autoComplete="off" autoFocus onChange={(e) => setTitle(e.target.value)} />
      <label htmlFor={`${idp}-list`}>Task list</label>
      <select id={`${idp}-list`} value={list} onChange={(e) => setList(e.target.value)}>
        {(lists || []).map((l) => <option key={l.id} value={l.id}>{l.title}</option>)}
        {!lists?.length && <option value={NEW}>A new list called Tasks</option>}
      </select>
      <div className="msg-task-pair">
        <span>
          <label htmlFor={`${idp}-who`}>Assigned to</label>
          <select id={`${idp}-who`} value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">No one</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.id === me.id ? `${p.display_name} (you)` : p.display_name}</option>)}
          </select>
        </span>
        <span>
          <label htmlFor={`${idp}-due`}>Due date</label>
          <input id={`${idp}-due`} type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </span>
      </div>
      {err && <p className="send-error" role="alert">{err}</p>}
      <div className="link-form-actions">
        <button className="btn btn--primary btn--sm" type="submit" disabled={busy || !lists || !title.trim()}>Add task</button>
        <button className="btn btn--sm" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
