// An ideas board: ideas people in a space suggest, the votes they get, and where each stands (new,
// planned, done, declined). Editors and owners suggest; you reword only your own idea; editors and owners
// can delete any (tidying up). Every member votes, viewers included, once per idea and only while it is
// new or planned. Only owners of the space change the status.
// Row-level security and the guard trigger decide; when they say no, the reason is shown and the board is
// reloaded. Live: any change to this board's ideas or votes refetches it.
// Weft (search and the assistant) reads the board's text summary, kept by the database.
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

const SELECT = 'id,title,details,status,created_by,created_at,author:users!ideas_created_by_fkey(display_name),votes:idea_votes(voter_id)';
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

export default function Ideas({ item, me, editable, owner, notice }) {
  const [ideas, setIdeas] = useState(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('open');
  const [sort, setSort] = useState('votes');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);

  const load = useCallback(() => api(`/ideas?board_id=eq.${item.id}&select=${SELECT}&order=created_at.desc`).then(setIdeas), [item.id]);
  useEffect(() => { load().catch((e) => setError(`The ideas could not load: ${e.message}`)); }, [load]);
  useEffect(() => { if (notice?.t === 'ideas' && notice.board === item.id) load().catch(() => {}); }, [notice, item.id, load]);

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
  const setStatus = (d, status) => change('Could not change the status', () => api(`/ideas?id=eq.${d.id}`, { method: 'PATCH', body: { status }, prefer: 'return=minimal' }));
  const vote = (d, mine) => change(mine ? 'Could not take back the vote' : 'Could not vote', () => (mine
    ? api(`/idea_votes?idea_id=eq.${d.id}&voter_id=eq.${me.id}`, { method: 'DELETE', prefer: 'return=minimal' })
    : api('/idea_votes', { method: 'POST', body: { idea_id: d.id }, prefer: 'return=minimal' })));

  if (!ideas) return error ? <p className="send-error" role="alert">{error}</p> : <div className="skeleton" aria-label="Loading the ideas"><span /><span /><span /></div>;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const count = (k) => ideas.filter((d) => (k === 'all' ? true : k === 'open' ? isOpen(d.status) : d.status === k)).length;
  const shown = ideas
    .filter((d) => (filter === 'all' || (filter === 'open' ? isOpen(d.status) : d.status === filter))
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
            <button key={k} type="button" className="link-tag" aria-pressed={filter === k} onClick={() => setFilter(k)}>{label} <span className="idea-count">{count(k)}</span></button>
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
                    <div className="link-foot">
                      <span className="link-by">Suggested by {d.author?.display_name || 'someone'}, {day(d.created_at)}</span>
                      {editable && mine && <button className="btn btn--sm" type="button" onClick={() => setEditing(d.id)}>Edit<span className="visually-hidden"> {d.title}</span></button>}
                      {editable && <button className="btn btn--sm" type="button" onClick={() => remove(d)}>Delete<span className="visually-hidden"> {d.title}</span></button>}
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
