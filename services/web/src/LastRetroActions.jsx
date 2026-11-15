// Last retro's actions: at the top of a retro, the actions of the previous retro in the same space (the newest
// one made before this one), each with its task's state: done, open (who, when, late) or never made a task.
// The team checks follow-through before writing new notes. "Carry over" adds an action that is not done to this
// retro as an ordinary action note (anyone in the space may add notes, viewers too); ticking a task follows
// the Tasks rule (editors and owners, or the person it is for). Data: weft.retro_previous_actions (064), a
// security_invoker view, so row-level security decides; it never says who wrote a note.
// Live: a retro, task or item notice in this space refetches.
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { dueLabel, today } from './TaskList.jsx';
import { periodLabel } from './Retro.jsx';

const COLS = 'previous_id,previous_title,previous_from,previous_to,note_id,body,created_at,task_id,task_title,task_done,task_assignee_id,task_due_on';
// The badge already says Late or Done, so a past date is just a date here.
const dueText = (iso, t0) => (iso < t0 ? `due ${new Date(`${iso}T12:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short', ...(iso.slice(0, 4) !== t0.slice(0, 4) ? { year: 'numeric' } : {}) })}` : dueLabel(iso).replace(/^Due/, 'due'));
const same = (a, b) => a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase();

export default function LastRetroActions({ item, me, editable, notes, nameOf, notice, onCarry, onTick, onOpenItem }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setRows(await api(`/retro_previous_actions?retro_id=eq.${item.id}&select=${COLS}&order=created_at.asc.nullsfirst`));
  }, [item.id]);
  useEffect(() => { load().catch((e) => setError(`Last retro's actions could not load: ${e.message}`)); }, [load]);
  useEffect(() => {
    if (notice && ['retros', 'tasks', 'items'].includes(notice.t) && notice.space === item.space_id) load().catch(() => {});
  }, [notice, item.space_id, load]);

  if (error) return <p className="send-error" role="alert">{error}</p>;
  if (!rows || !rows.length) return null;   // still loading, or this is the space's first retro
  const prev = rows[0];
  const actions = rows.filter((r) => r.note_id);
  const done = actions.filter((r) => r.task_done).length;
  const open = actions.filter((r) => r.task_id && !r.task_done).length;
  const none = actions.length - done - open;
  const here = notes.filter((n) => n.kind === 'action');
  const t0 = today();
  const period = periodLabel(prev.previous_from, prev.previous_to);

  return (
    <section className="retro-last" aria-labelledby="retro-last-h">
      <div className="retro-last-head">
        <h3 id="retro-last-h" className="retro-col-head">Last retro's actions</h3>
        <span className="retro-last-from">
          From {onOpenItem
            ? <button type="button" className="retro-last-link" onClick={() => onOpenItem(prev.previous_id)}>{prev.previous_title}</button>
            : <strong>{prev.previous_title}</strong>}{period && `, ${period}`}
        </span>
      </div>
      {!actions.length ? <p className="convo-empty">The last retro had no actions.</p> : (<>
        <p className="goal-meta" role="status">
          {actions.length} action{actions.length === 1 ? '' : 's'}: {done} done, {open} still open{none ? `, ${none} never made a task` : ''}
        </p>
        <ul className="retro-last-list" aria-label="Last retro's actions">
          {actions.map((a) => {
            const carried = here.some((n) => same(n.body, a.body));
            const late = a.task_id && !a.task_done && a.task_due_on && a.task_due_on < t0;
            const state = a.task_done ? 'done' : a.task_id ? (late ? 'late' : 'open') : 'none';
            return (
              <li key={a.note_id} className={`retro-last-row is-${state}`}>
                {a.task_id
                  ? <input type="checkbox" className="task-check" checked={a.task_done} disabled={!editable && a.task_assignee_id !== me.id}
                      aria-label={`Task done: ${a.task_title}`} onChange={(e) => onTick({ id: a.task_id }, e.target.checked)} />
                  : <span className="retro-last-dot" aria-hidden="true" />}
                <div className="retro-last-main">
                  <p className="retro-body">{a.body}</p>
                  <span className="retro-last-state">
                    <span className="retro-last-badge">{state === 'done' ? 'Done' : state === 'late' ? 'Late' : state === 'open' ? 'Open' : 'Not a task'}</span>
                    {a.task_id && <> {nameOf(a.task_assignee_id) || 'No one'}{a.task_due_on && `, ${dueText(a.task_due_on, t0)}`}</>}
                  </span>
                </div>
                {!a.task_done && (carried
                  ? <span className="retro-last-carried">In this retro</span>
                  : <button type="button" className="btn btn--sm" onClick={() => onCarry(a.body)}>Carry over<span className="visually-hidden">: {a.body}</span></button>)}
              </li>
            );
          })}
        </ul>
      </>)}
    </section>
  );
}
