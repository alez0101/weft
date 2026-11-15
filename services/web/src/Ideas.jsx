// An ideas board: ideas people in a space suggest, the votes they get, and where each stands (new,
// planned, done, declined). Editors and owners suggest; you reword only your own idea; editors and owners
// can delete any (tidying up). Every member votes, viewers included, once per idea and only while it is
// new or planned. Only owners of the space change the status.
// Row-level security and the guard trigger decide; when they say no, the reason is shown and the board is
// reloaded. Live: any change to this board's ideas or votes refetches it.
// Weft (search and the assistant) reads the board's text summary, kept by the database.
// Next steps (060): when an owner marks an idea planned, it offers to add it as a task to a list in the same
// space (weft.idea_to_task); when an owner declines one, it asks for a short reason, shown under the idea to
// everyone who can see the board. The status is saved first either way, so skipping the question is fine.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

const SELECT = 'id,title,details,status,decline_reason,task_id,task:tasks!ideas_task_id_fkey(id,title,done,list_id,list:items!tasks_list_id_fkey(title)),created_by,created_at,author:users!ideas_created_by_fkey(display_name),votes:idea_votes(voter_id)';
const STATUS = { new: 'New', planned: 'Planned', done: 'Done', declined: 'Declined' };
const FILTERS = [['open', 'Open'], ['new', 'New'], ['planned', 'Planned'], ['done', 'Done'], ['declined', 'Declined'], ['all', 'All']];
const isOpen = (s) => s === 'new' || s === 'planned';
const day = (iso) => new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });

function IdeaForm({ initial, onSave, onCancel, label, idp, submit }) {
  const [f, setF] = useState(initial);
  const save = (e) => {
    e.preventDefault();
    if (!f.title.trim()) return;
    onSave({ title: f.title.trim(), details: f.details.trim() }, () => setF({ title: '', details: '' }));
  };
  return (
    <form className="link-form" onSubmit={save} aria-label={label} noValidate>
      <label htmlFor={`${idp}-title`}>Idea</label>
      <input id={`${idp}-title`} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={200} autoComplete="off" placeholder="A water refill point by the main stage" required />
      <label htmlFor={`${idp}-details`}>Details</label>
      <textarea id={`${idp}-details`} value={f.details} onChange={(e) => setF({ ...f, details: e.target.value })} maxLength={4000} rows={3} placeholder="Why it would help, and anything else people should know (optional)" />
      <div className="link-form-actions">
        <button className="btn btn--primary btn--sm" type="submit" disabled={!f.title.trim()}>{submit}</button>
        {onCancel && <button className="btn btn--sm" type="button" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

// After marking an idea planned: pick a task list in this space and add the idea to it as a task.
function TaskOffer({ d, lists, onAdd, onSkip }) {
  const [picked, setList] = useState('');
  if (!lists) return <p className="docs-hint idea-ask" role="status">Looking for task lists…</p>;
  const list = lists.some((l) => l.id === picked) ? picked : (lists[0]?.id || '');   // the lists may arrive after this opens
  const idp = `idea-${d.id}-task`;
  if (!lists.length) return (
    <div className="idea-ask" role="group" aria-label={`Next step for ${d.title}`}>
      <p className="docs-hint">There is no task list in this channel to add it to yet. Make one in Tasks, then press Add as a task here.</p>
      <div className="link-form-actions"><button className="btn btn--sm" type="button" onClick={onSkip}>Close</button></div>
    </div>
  );
  return (
    <form className="link-form idea-ask" aria-label={`Add ${d.title} as a task`} onSubmit={(e) => { e.preventDefault(); if (list) onAdd(list); }}>
      <label htmlFor={idp}>Add as a task to</label>
      <select id={idp} className="idea-ask-list" value={list} onChange={(e) => setList(e.target.value)}>
        {lists.map((l) => <option key={l.id} value={l.id}>{l.title}</option>)}
      </select>
      <div className="link-form-actions">
        <button className="btn btn--primary btn--sm" type="submit" disabled={!list}>Add task</button>
        <button className="btn btn--sm" type="button" onClick={onSkip}>Not now</button>
      </div>
    </form>
  );
}

// After declining an idea (or to change the reason later): a short reason, shown under the idea.
function ReasonForm({ d, onSave, onSkip }) {
  const [reason, setReason] = useState(d.decline_reason || '');
  const idp = `idea-${d.id}-reason`;
  return (
    <form className="link-form idea-ask" aria-label={`Why ${d.title} was declined`} onSubmit={(e) => { e.preventDefault(); onSave(reason.trim()); }}>
      <label htmlFor={idp}>Why declined?</label>
      <input id={idp} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} autoComplete="off" placeholder="A short reason, shown under the idea" autoFocus />
      <div className="link-form-actions">
        <button className="btn btn--primary btn--sm" type="submit" disabled={!reason.trim() && !d.decline_reason}>{reason.trim() || !d.decline_reason ? 'Save reason' : 'Remove reason'}</button>
        <button className="btn btn--sm" type="button" onClick={onSkip}>{d.decline_reason ? 'Cancel' : 'Skip'}</button>
      </div>
    </form>
  );
}

export default function Ideas({ item, me, editable, owner, notice, onOpenItem }) {
  const [ideas, setIdeas] = useState(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('open');
  const [sort, setSort] = useState('votes');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [asking, setAsking] = useState(null);   // { id, kind: 'task' | 'reason' }: the next-step question open under an idea
  const [lists, setLists] = useState(null);     // task lists in this space, for an owner adding a planned idea (null: loading)
  const manage = owner && editable;

  // Reloads overlap (your own change, then the notices it causes): only the latest one's answer is shown, so an
  // older, slower answer never overwrites a newer one.
  const seq = useRef(0);
  const load = useCallback(() => {
    const n = ++seq.current;
    return api(`/ideas?board_id=eq.${item.id}&select=${SELECT}&order=created_at.desc`).then((rows) => { if (n === seq.current) setIdeas(rows); });
  }, [item.id]);
  useEffect(() => { load().catch((e) => setError(`The ideas could not load: ${e.message}`)); }, [load]);
  useEffect(() => { if (notice?.t === 'ideas' && notice.board === item.id) load().catch(() => {}); }, [notice, item.id, load]);
  // Fetched when the question opens (not on every notice), so a list made a moment ago in Tasks is offered.
  const loadLists = useCallback(() => (manage
    ? (setLists(null), api(`/items?space_id=eq.${item.space_id}&kind=eq.tasklist&select=id,title&order=title`).then(setLists).catch(() => setLists([])))
    : Promise.resolve()), [manage, item.space_id]);

  // Every change: show the database's answer if it refuses, and reload so the screen matches the data.
  const change = async (what, run) => {
    let ok = false;
    try { await run(); setError(''); ok = true; } catch (e) { setError(`${what}: ${e.message}`); }
    load().catch(() => {});
    return ok;
  };
  const suggest = async (body, reset) => {
    if (await change('Could not add the idea', () => api('/ideas', { method: 'POST', body: { ...body, board_id: item.id }, prefer: 'return=minimal' }))) { reset(); setAdding(false); }
  };
  const save = async (d, body) => {
    if (await change('That change was not saved', () => api(`/ideas?id=eq.${d.id}`, { method: 'PATCH', body, prefer: 'return=minimal' }))) setEditing(null);
  };
  const remove = (d) => {
    if (!window.confirm(`Delete "${d.title}" and its votes? Everyone who can see this board loses it.`)) return;
    change('Could not delete', () => api(`/ideas?id=eq.${d.id}`, { method: 'DELETE', prefer: 'return=minimal' }));
  };
  const setStatus = async (d, status) => {
    setAsking(null);
    if (!await change('Could not change the status', () => api(`/ideas?id=eq.${d.id}`, { method: 'PATCH', body: { status }, prefer: 'return=minimal' }))) return;
    if (status === 'planned' && !d.task_id) { loadLists(); setAsking({ id: d.id, kind: 'task' }); }
    if (status === 'declined') setAsking({ id: d.id, kind: 'reason' });
  };
  const addTask = async (d, list) => {
    if (await change('Could not add it as a task', () => api('/rpc/idea_to_task', { method: 'POST', body: { p_idea: d.id, p_list: list } }))) setAsking(null);
  };
  const saveReason = async (d, reason) => {
    if (await change('The reason was not saved', () => api(`/ideas?id=eq.${d.id}`, { method: 'PATCH', body: { decline_reason: reason }, prefer: 'return=minimal' }))) setAsking(null);
  };
  const vote = (d, mine) => change(mine ? 'Could not take back the vote' : 'Could not vote', () => (mine
    ? api(`/idea_votes?idea_id=eq.${d.id}&voter_id=eq.${me.id}`, { method: 'DELETE', prefer: 'return=minimal' })
    : api('/idea_votes', { method: 'POST', body: { idea_id: d.id }, prefer: 'return=minimal' })));

  if (!ideas) return error ? <p className="send-error" role="alert">{error}</p> : <div className="skeleton" aria-label="Loading the ideas"><span /><span /><span /></div>;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const count = (k) => ideas.filter((d) => (k === 'all' ? true : k === 'open' ? isOpen(d.status) : d.status === k)).length;
  const shown = ideas
    .filter((d) => (filter === 'all' || d.id === asking?.id || (filter === 'open' ? isOpen(d.status) : d.status === filter))
      && words.every((w) => `${d.title} ${d.details}`.toLowerCase().includes(w)))
    .sort((a, b) => (sort === 'votes' ? b.votes.length - a.votes.length : 0) || b.created_at.localeCompare(a.created_at));

  return (
    <div className="links ideas">
      {editable ? (adding
        ? <IdeaForm initial={{ title: '', details: '' }} onSave={suggest} onCancel={() => setAdding(false)} label="Suggest an idea" idp="idea-new" submit="Add idea" />
        : <div className="links-bar"><button className="btn btn--primary btn--sm" type="button" onClick={() => setAdding(true)}>Suggest an idea</button>
            <p className="docs-hint">{owner ? 'As an owner of this space you set the status of each idea.' : 'Only members of this space can see these ideas. Owners of the space set their status.'}</p></div>)
        : <p className="docs-hint">You can read the ideas and vote for the ones you want. Ask an owner of the space to make you an editor to suggest one.</p>}
      {error && <p className="send-error" role="alert">{error}</p>}
      {ideas.length > 0 && (<>
        <div className="links-tags" role="group" aria-label="Show">
          {FILTERS.map(([k, label]) => (
            <button key={k} type="button" className="link-tag" aria-pressed={filter === k} onClick={() => { setFilter(k); setAsking(null); }}>{label} <span className="idea-count">{count(k)}</span></button>
          ))}
        </div>
        <div className="links-filters">
          <label className="visually-hidden" htmlFor="ideas-find">Find an idea</label>
          <input id="ideas-find" type="search" placeholder="Find in ideas…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <label className="idea-sort">Sort by{' '}
            <select id="ideas-sort" value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="votes">Most votes</option>
              <option value="new">Newest</option>
            </select>
          </label>
          <span className="task-count" role="status">{shown.length} of {ideas.length} idea{ideas.length === 1 ? '' : 's'}</span>
        </div>
      </>)}
      {!ideas.length ? <p className="convo-empty">{editable ? 'No ideas yet. Suggest the first one above.' : 'No ideas yet.'}</p>
        : !shown.length ? <p className="convo-empty">No ideas match.</p> : (
        <ul className="link-list" aria-label="Ideas">
          {shown.map((d) => {
            const mine = d.created_by === me.id; const voted = d.votes.some((v) => v.voter_id === me.id); const closed = !isOpen(d.status);
            return (
              <li key={d.id} className={`link idea is-${d.status}`}>
                <button type="button" className="qa-vote" aria-pressed={voted} disabled={closed && !voted}
                  title={closed ? (voted ? 'Voting is closed. Take back your vote' : 'Voting is closed') : voted ? 'Take back your vote' : 'Vote for this idea'}
                  onClick={() => vote(d, voted)}>
                  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 3l5 7H3z" fill="currentColor" /></svg>
                  <span className="qa-votes">{d.votes.length}</span>
                  <span className="visually-hidden">{d.votes.length === 1 ? ' vote' : ' votes'}{voted ? ', you voted' : closed ? ', voting closed' : ', vote'} for {d.title}</span>
                </button>
                <div className="idea-main">
                  {editing === d.id ? (
                    <IdeaForm initial={{ title: d.title, details: d.details }} onSave={(b) => save(d, b)} onCancel={() => setEditing(null)} label={`Edit ${d.title}`} idp={`idea-${d.id}`} submit="Save" />
                  ) : (<>
                    <div className="qa-head">
                      <h3 className="qa-title">{d.title}</h3>
                      {owner && editable ? (
                        <select className={`idea-status is-${d.status}`} aria-label={`Status of ${d.title}`} value={d.status} onChange={(e) => setStatus(d, e.target.value)}>
                          {Object.entries(STATUS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                        </select>
                      ) : <span className={`idea-status is-${d.status}`}>{STATUS[d.status]}</span>}
                    </div>
                    {d.details && <p className="link-note">{d.details}</p>}
                    {d.status === 'declined' && d.decline_reason && !(asking?.id === d.id && asking.kind === 'reason') && (
                      <p className="idea-next idea-reason"><strong>Declined:</strong> {d.decline_reason}</p>)}
                    {d.task && (
                      <p className="idea-next">
                        <span className={`idea-task-state${d.task.done ? ' is-done' : ''}`}>{d.task.done ? 'Task done' : 'Task open'}</span>
                        {' '}in{' '}
                        {onOpenItem ? <button type="button" className="link-btn" onClick={() => onOpenItem(d.task.list_id)}>{d.task.list?.title || 'a task list'}</button>
                          : <strong>{d.task.list?.title || 'a task list'}</strong>}
                        {d.task.title !== d.title && <span className="idea-task-title">: {d.task.title}</span>}
                      </p>)}
                    {manage && asking?.id === d.id && asking.kind === 'task' && d.status === 'planned' && !d.task_id && (
                      <TaskOffer d={d} lists={lists} onAdd={(l) => addTask(d, l)} onSkip={() => setAsking(null)} />)}
                    {manage && asking?.id === d.id && asking.kind === 'reason' && d.status === 'declined' && (
                      <ReasonForm d={d} onSave={(r) => saveReason(d, r)} onSkip={() => setAsking(null)} />)}
                    <div className="link-foot">
                      <span className="link-by">Suggested by {d.author?.display_name || 'someone'}, {day(d.created_at)}</span>
                      {editable && mine && <button className="btn btn--sm" type="button" onClick={() => setEditing(d.id)}>Edit<span className="visually-hidden"> {d.title}</span></button>}
                      {editable && <button className="btn btn--sm" type="button" onClick={() => remove(d)}>Delete<span className="visually-hidden"> {d.title}</span></button>}
                      {manage && d.status === 'planned' && !d.task_id && asking?.id !== d.id && (
                        <button className="btn btn--sm" type="button" onClick={() => { loadLists(); setAsking({ id: d.id, kind: 'task' }); }}>Add as a task<span className="visually-hidden"> ({d.title})</span></button>)}
                      {manage && d.status === 'declined' && asking?.id !== d.id && (
                        <button className="btn btn--sm" type="button" onClick={() => setAsking({ id: d.id, kind: 'reason' })}>{d.decline_reason ? 'Change reason' : 'Add a reason'}<span className="visually-hidden"> for {d.title}</span></button>)}
                    </div>
                  </>)}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
