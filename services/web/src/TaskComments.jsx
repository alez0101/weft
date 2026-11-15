// Comments on tasks (053): a short thread under each task, in Tasks and on its card in Boards, so questions
// and updates stay with the task. Members read (viewers too); editors and owners post, and so does the
// person the task is assigned to; you delete your own comment, owners of the space delete any. Comments are
// not edited. Row-level security decides; when it says no, the reason is shown. Live: a task_comments (or
// tasks) notice for the list refetches its comments.
import { useCallback, useEffect, useId, useState } from 'react';
import { api } from './api.js';

const MAX = 1000;
export const commentWhen = (iso) => {
  const d = new Date(iso); const m = Math.round((Date.now() - d) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 1440 && d.toDateString() === new Date().toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};
export const countLabel = (n) => (n === 1 ? '1 comment' : `${n} comments`);

// Every comment on the tasks of one list, grouped by task: { byTask: { [taskId]: [comment] }, reload }.
export function useTaskComments(listId, notice) {
  const [byTask, setByTask] = useState({});
  const reload = useCallback(() => api(`/task_comments?select=id,task_id,body,author_id,created_at,task:tasks!inner(list_id)&task.list_id=eq.${listId}&order=created_at&limit=3000`)
    .then((rows) => {
      const g = {};
      for (const c of rows) (g[c.task_id] ||= []).push(c);
      setByTask(g);
    }), [listId]);
  useEffect(() => { reload().catch(() => {}); }, [reload]);
  useEffect(() => {
    if ((notice?.t === 'task_comments' || notice?.t === 'tasks') && notice.list === listId) reload().catch(() => {});
  }, [notice, listId, reload]);
  return { byTask, reload };
}

// Is the person an owner of this space (who may delete any comment)?
export const ownsSpace = (members, spaceId, me) => members.some((m) => m.space_id === spaceId && m.user?.id === me.id && m.role === 'owner');

// The toggle ("2 comments" / "Comment") and, when open, the thread with its add box.
export function TaskComments({ task, comments = [], me, nameOf, canPost, isOwner, onChanged, compact = false }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const id = useId();
  const n = comments.length;
  if (!n && !canPost) return null;

  async function post(e) {
    e.preventDefault();
    const body = draft.trim(); if (!body) return;
    setBusy(true);
    try { await api('/task_comments', { method: 'POST', body: { task_id: task.id, body }, prefer: 'return=minimal' }); setDraft(''); setError(''); }
    catch (err) { setError(`Your comment was not posted: ${err.message}`); }
    finally { setBusy(false); onChanged(); }
  }
  async function remove(c) {
    if (!window.confirm('Delete this comment? Everyone who can see the task loses it.')) return;
    try { await api(`/task_comments?id=eq.${c.id}`, { method: 'DELETE', prefer: 'return=minimal' }); setError(''); }
    catch (err) { setError(`The comment was not deleted: ${err.message}`); }
    finally { onChanged(); }
  }

  return (
    // Keys typed in the thread stay in it (a Boards card moves with the arrow keys).
    <div className={`tc${compact ? ' tc--compact' : ''}`} onKeyDown={(e) => e.stopPropagation()}>
      <button type="button" className="tc-toggle" aria-expanded={open} aria-controls={`${id}-thread`} onClick={() => setOpen((o) => !o)}>
        <svg className="tc-glyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" /></svg>
        {n ? countLabel(n) : 'Comment'}<span className="visually-hidden"> on {task.title}</span>
      </button>
      {open && (
        <div className="tc-thread" id={`${id}-thread`}>
          {n > 0 && (
            <ul className="tc-list" aria-label={`Comments on ${task.title}`}>
              {comments.map((c) => (
                <li key={c.id} className="tc-item">
                  <p className="tc-head">
                    <span className="tc-who">{c.author_id === me.id ? 'You' : c.author_id ? nameOf(c.author_id) : 'Someone not in this space'}</span>
                    <time className="tc-when" dateTime={c.created_at}>{commentWhen(c.created_at)}</time>
                    {(c.author_id === me.id || isOwner) && (
                      <button type="button" className="tc-delete" onClick={() => remove(c)}>Delete<span className="visually-hidden"> comment</span></button>
                    )}
                  </p>
                  <p className="tc-body">{c.body}</p>
                </li>
              ))}
            </ul>
          )}
          {canPost ? (
            <form className="tc-add" onSubmit={post} aria-label={`Add a comment on ${task.title}`}>
              <label className="visually-hidden" htmlFor={`${id}-new`}>Comment</label>
              <textarea id={`${id}-new`} rows={2} maxLength={MAX} placeholder="Ask a question or give an update" value={draft} onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) post(e); }} />
              <button className="btn btn--sm btn--primary" type="submit" disabled={busy || !draft.trim()}>Post</button>
            </form>
          ) : <p className="tc-hint">Only editors and the person the task is assigned to can comment.</p>}
          {error && <p className="send-error" role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}
