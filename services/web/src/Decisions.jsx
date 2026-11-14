// A decision log: what a space decided, with the context, who decided, the date and which earlier decision
// it replaces, newest first, so anyone can find out why something is the way it is. A filter matches any
// word; "Hide replaced" shows only what is still in force. Editors add, change and delete; viewers read.
// Row-level security decides; when it says no, the reason is shown and the log is reloaded.
// Live: any change to this log's decisions refetches it.
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const EMPTY = () => ({ title: '', context: '', decided_by: '', decided_on: today(), replaces_id: '' });
// A date column comes back as YYYY-MM-DD; show it in the reader's own format without shifting the day.
const day = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });

function DecisionForm({ initial, others, onSave, onCancel, label, idp, submit: submitLabel }) {
  const [f, setF] = useState(initial);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = (e) => {
    e.preventDefault();
    if (!f.title.trim()) return;
    onSave({ title: f.title.trim(), context: f.context.trim(), decided_by: f.decided_by.trim(), decided_on: f.decided_on || today(), replaces_id: f.replaces_id || null }, () => setF(EMPTY()));
  };
  return (
    <form className="link-form" onSubmit={submit} aria-label={label} noValidate>
      <label htmlFor={`${idp}-title`}>Decision</label>
      <input id={`${idp}-title`} value={f.title} onChange={set('title')} maxLength={200} autoComplete="off" placeholder="What was decided" required />
      <label htmlFor={`${idp}-context`}>Context</label>
      <textarea id={`${idp}-context`} value={f.context} onChange={set('context')} maxLength={4000} rows={3} placeholder="Why, and what else was considered" />
      <label htmlFor={`${idp}-by`}>Decided by</label>
      <input id={`${idp}-by`} value={f.decided_by} onChange={set('decided_by')} maxLength={120} autoComplete="off" placeholder="A person, a group or a meeting" />
      <label htmlFor={`${idp}-on`}>Date</label>
      <input id={`${idp}-on`} type="date" value={f.decided_on} onChange={set('decided_on')} />
      <label htmlFor={`${idp}-replaces`}>Replaces</label>
      <select id={`${idp}-replaces`} className="decision-select" value={f.replaces_id} onChange={set('replaces_id')}>
        <option value="">Nothing</option>
        {others.map((o) => <option key={o.id} value={o.id}>{day(o.decided_on)}: {o.title}</option>)}
      </select>
      <div className="link-form-actions">
        <button className="btn btn--primary btn--sm" type="submit" disabled={!f.title.trim()}>{submitLabel}</button>
        {onCancel && <button className="btn btn--sm" type="button" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

export default function DecisionLog({ item, editable, notice }) {
  const [decisions, setDecisions] = useState(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [hideReplaced, setHideReplaced] = useState(false);
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(false);
  const [focus, setFocus] = useState(null);

  const load = useCallback(() => api(`/decisions?log_id=eq.${item.id}&select=id,title,context,decided_by,decided_on,replaces_id,created_at,author:users!decisions_created_by_fkey(display_name)&order=decided_on.desc,created_at.desc`)
    .then((r) => { setDecisions(r); }), [item.id]);
  useEffect(() => { load().catch((e) => setError(`The decision log could not load: ${e.message}`)); }, [load]);
  useEffect(() => { if (notice?.t === 'decisions' && notice.log === item.id) load().catch(() => {}); }, [notice, item.id, load]);
  // Jumping to a linked decision: show it even if a filter hid it, then move focus to it.
  useEffect(() => {
    if (!focus) return;
    const el = document.getElementById(`decision-${focus}`);
    if (el) { el.scrollIntoView({ block: 'center' }); el.focus({ preventScroll: true }); }
  }, [focus, query, hideReplaced]);
  const jump = (id) => { setQuery(''); setHideReplaced(false); setFocus(id); };

  // Every change: show the database's answer if it refuses, and reload so the screen matches the data.
  const change = async (what, run) => {
    let ok = false;
    try { await run(); setError(''); ok = true; } catch (e) { setError(`${what}: ${e.message}`); }
    load().catch(() => {});
    return ok;
  };
  const add = async (body, reset) => {
    if (await change('Could not add the decision', () => api('/decisions', { method: 'POST', body: { ...body, log_id: item.id }, prefer: 'return=minimal' }))) { reset(); setAdding(false); }
  };
  const save = async (d, body) => {
    if (await change('That change was not saved', () => api(`/decisions?id=eq.${d.id}`, { method: 'PATCH', body, prefer: 'return=minimal' }))) setEditing(null);
  };
  const remove = (d) => {
    if (!window.confirm(`Delete "${d.title}"? Everyone who can see this log loses it, and anything that replaced it no longer says so.`)) return;
    change('Could not delete', () => api(`/decisions?id=eq.${d.id}`, { method: 'DELETE', prefer: 'return=minimal' }));
  };

  if (!decisions) return error ? <p className="send-error" role="alert">{error}</p> : <div className="skeleton" aria-label="Loading the decision log"><span /><span /><span /></div>;
  const byId = Object.fromEntries(decisions.map((d) => [d.id, d]));
  const replacedBy = Object.fromEntries(decisions.filter((d) => d.replaces_id).map((d) => [d.replaces_id, d]));
  // What a decision may replace: another one in this log that nothing else replaces yet (or the one it already does).
  const othersFor = (d) => decisions.filter((o) => o.id !== d?.id && (!replacedBy[o.id] || replacedBy[o.id].id === d?.id));
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = decisions.filter((d) => (!hideReplaced || !replacedBy[d.id])
    && words.every((w) => `${d.title} ${d.context} ${d.decided_by}`.toLowerCase().includes(w)));
  const inForce = decisions.filter((d) => !replacedBy[d.id]).length;

  return (
    <div className="links decisions">
      {editable ? (adding
        ? <DecisionForm initial={EMPTY()} others={othersFor(null)} onSave={add} onCancel={() => setAdding(false)} label="Add a decision" idp="decision-new" submit="Add decision" />
        : <div className="links-bar"><button className="btn btn--primary btn--sm" type="button" onClick={() => setAdding(true)}>Add a decision</button>
            <p className="docs-hint">Only members of this space can see these decisions.</p></div>)
        : <p className="docs-hint">You can read these decisions. Ask an owner of the space to make you an editor to add or change them.</p>}
      {error && <p className="send-error" role="alert">{error}</p>}
      {decisions.length > 0 && (
        <div className="links-filters">
          <label className="visually-hidden" htmlFor="decisions-find">Find a decision</label>
          <input id="decisions-find" type="search" placeholder="Find by words, who decided…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <label className="toggle"><input type="checkbox" checked={hideReplaced} onChange={(e) => setHideReplaced(e.target.checked)} /> Hide replaced</label>
          <span className="task-count" role="status">{shown.length === decisions.length
            ? `${decisions.length} decision${decisions.length === 1 ? '' : 's'}, ${inForce} in force`
            : `${shown.length} of ${decisions.length}`}</span>
        </div>
      )}
      {!decisions.length ? <p className="convo-empty">{editable ? 'No decisions yet. Add the first one above.' : 'No decisions yet.'}</p>
        : !shown.length ? <p className="convo-empty">No decisions match.</p> : (
        <ul className="link-list" aria-label="Decisions">
          {shown.map((d) => {
            const old = d.replaces_id && byId[d.replaces_id]; const next = replacedBy[d.id];
            return (
              <li key={d.id} id={`decision-${d.id}`} tabIndex={-1} className={`link decision${next ? ' is-replaced' : ''}${focus === d.id ? ' is-focus' : ''}`} onBlur={() => focus === d.id && setFocus(null)}>
                {editing === d.id ? (
                  <DecisionForm initial={{ title: d.title, context: d.context, decided_by: d.decided_by, decided_on: d.decided_on, replaces_id: d.replaces_id || '' }} others={othersFor(d)}
                    onSave={(b) => save(d, b)} onCancel={() => setEditing(null)} label={`Edit ${d.title}`} idp={`decision-${d.id}`} submit="Save" />
                ) : (<>
                  <div className="decision-head">
                    <time className="decision-date" dateTime={d.decided_on}>{day(d.decided_on)}</time>
                    {next && <span className="decision-state">Replaced</span>}
                  </div>
                  <h3 className="decision-title">{d.title}</h3>
                  {d.decided_by && <p className="decision-by">Decided by {d.decided_by}</p>}
                  {d.context && <p className="link-note">{d.context}</p>}
                  {(old || next) && (
                    <p className="decision-links">
                      {old && <span>Replaces <button type="button" className="link-btn" onClick={() => jump(old.id)}>{old.title}</button> ({day(old.decided_on)})</span>}
                      {next && <span>Replaced by <button type="button" className="link-btn" onClick={() => jump(next.id)}>{next.title}</button> ({day(next.decided_on)})</span>}
                    </p>
                  )}
                  <div className="link-foot">
                    <span className="link-by">{d.author?.display_name ? `Written down by ${d.author.display_name}` : ''}</span>
                    {editable && <>
                      <button className="btn btn--sm" type="button" onClick={() => setEditing(d.id)}>Edit<span className="visually-hidden"> {d.title}</span></button>
                      <button className="btn btn--sm" type="button" onClick={() => remove(d)}>Delete<span className="visually-hidden"> {d.title}</span></button>
                    </>}
                  </div>
                </>)}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
