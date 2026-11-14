// A goal set: a space's goals, each with measurable key results, and how far along they are. A key result
// runs from a start value to a target (which may be lower than the start) and someone updates its current
// value by hand; the database works out its progress (kept between 0 and 100 %) and stamps who updated it
// and when. A goal's progress is the average of its key results, the set's the average of its goals that
// have any. Editors and owners add, change, delete and update; viewers read.
// Row-level security decides; when it says no, the reason is shown and the set is reloaded.
// Live: any change to this set's goals or key results refetches it. Weft (search and the assistant) reads the
// set's text summary, kept by the database.
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

const KRS = 'id,goal_id,title,start_value,target_value,current_value,unit,position,progress,value_updated_at,updated_by:users!key_results_value_updated_by_fkey(display_name)';
const GOALS = `id,title,note,due_on,position,created_at,krs:key_results(${KRS})`;
const day = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
const stamp = (iso) => new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const num = (v) => Number(v).toLocaleString([], { maximumFractionDigits: 4 });
const pct = (p) => (p == null ? null : Math.round(Number(p) * 100));
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + Number(b), 0) / xs.length : null);
export const goalProgress = (g) => avg((g.krs || []).map((k) => k.progress));
export const setProgress = (goals) => avg(goals.map(goalProgress).filter((p) => p != null));
const isNum = (s) => String(s).trim() !== '' && Number.isFinite(Number(s));

export function Bar({ value, label, big }) {
  const p = pct(value);
  return (
    <span className={`goal-bar${big ? ' goal-bar--big' : ''}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={p ?? 0}
      aria-valuetext={p == null ? 'No key results yet' : `${p}%`}>
      <span style={{ width: `${p ?? 0}%` }} />
    </span>
  );
}

function GoalForm({ initial, onSave, onCancel, label, idp, submit }) {
  const [f, setF] = useState(initial);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const ok = f.title.trim().length > 0;
  return (
    <form className="link-form" aria-label={label} noValidate
      onSubmit={(e) => { e.preventDefault(); if (ok) onSave({ title: f.title.trim(), note: f.note.trim(), due_on: f.due_on || null }); }}>
      <label htmlFor={`${idp}-title`}>Goal</label>
      <input id={`${idp}-title`} value={f.title} onChange={set('title')} maxLength={200} autoComplete="off" placeholder="What you want to achieve" required />
      <label htmlFor={`${idp}-note`}>Note</label>
      <textarea id={`${idp}-note`} value={f.note} onChange={set('note')} maxLength={2000} rows={2} placeholder="Why it matters, who is on it" />
      <label htmlFor={`${idp}-due`}>Due</label>
      <input id={`${idp}-due`} type="date" value={f.due_on} onChange={set('due_on')} />
      <div className="link-form-actions">
        <button className="btn btn--primary btn--sm" type="submit" disabled={!ok}>{submit}</button>
        {onCancel && <button className="btn btn--sm" type="button" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

function ResultForm({ initial, onSave, onCancel, label, idp, submit }) {
  const [f, setF] = useState(initial);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const same = isNum(f.start_value) && isNum(f.target_value) && Number(f.start_value) === Number(f.target_value);
  const ok = f.title.trim() && isNum(f.start_value) && isNum(f.target_value) && isNum(f.current_value) && !same;
  return (
    <form className="link-form goal-kr-form" aria-label={label} noValidate
      onSubmit={(e) => { e.preventDefault(); if (ok) onSave({ title: f.title.trim(), unit: f.unit.trim(), start_value: Number(f.start_value), target_value: Number(f.target_value), current_value: Number(f.current_value) }); }}>
      <label htmlFor={`${idp}-title`}>Key result</label>
      <input id={`${idp}-title`} value={f.title} onChange={set('title')} maxLength={200} autoComplete="off" placeholder="Something you can count" required />
      <span className="goal-kr-nums">
        <label htmlFor={`${idp}-start`}>From</label>
        <input id={`${idp}-start`} type="number" step="any" inputMode="decimal" value={f.start_value} onChange={set('start_value')} />
        <label htmlFor={`${idp}-target`}>Target</label>
        <input id={`${idp}-target`} type="number" step="any" inputMode="decimal" value={f.target_value} onChange={set('target_value')} />
        <label htmlFor={`${idp}-now`}>Now</label>
        <input id={`${idp}-now`} type="number" step="any" inputMode="decimal" value={f.current_value} onChange={set('current_value')} />
        <label htmlFor={`${idp}-unit`}>Unit</label>
        <input id={`${idp}-unit`} value={f.unit} onChange={set('unit')} maxLength={20} autoComplete="off" placeholder="tickets, €, %" />
      </span>
      {same && <p className="goal-kr-hint">The target has to differ from where you start.</p>}
      <div className="link-form-actions">
        <button className="btn btn--primary btn--sm" type="submit" disabled={!ok}>{submit}</button>
        {onCancel && <button className="btn btn--sm" type="button" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

// Update a key result's current value by hand: the one thing people do most often, so it sits on the row.
function UpdateValue({ kr, onSave }) {
  const [v, setV] = useState(String(Number(kr.current_value)));
  useEffect(() => { setV(String(Number(kr.current_value))); }, [kr.current_value]);
  const changed = isNum(v) && Number(v) !== Number(kr.current_value);
  return (
    <form className="goal-update" onSubmit={(e) => { e.preventDefault(); if (changed) onSave(Number(v)); }}>
      <label className="visually-hidden" htmlFor={`kr-now-${kr.id}`}>Current value of {kr.title}</label>
      <input id={`kr-now-${kr.id}`} type="number" step="any" inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} />
      <button className="btn btn--sm" type="submit" disabled={!changed}>Update<span className="visually-hidden"> {kr.title}</span></button>
    </form>
  );
}

export default function GoalSet({ item, editable, notice }) {
  const [goals, setGoals] = useState(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);     // goal id being edited
  const [addingKr, setAddingKr] = useState(null);   // goal id getting a new key result
  const [editingKr, setEditingKr] = useState(null); // key result id being edited

  const load = useCallback(() => api(`/goals?set_id=eq.${item.id}&select=${GOALS}&order=position,created_at&krs.order=position,created_at`)
    .then(setGoals), [item.id]);
  useEffect(() => { load().catch((e) => setError(`The goals could not load: ${e.message}`)); }, [load]);
  useEffect(() => { if (notice?.t === 'goals' && notice.set === item.id) load().catch(() => {}); }, [notice, item.id, load]);

  const change = async (what, run) => {
    let ok = false;
    try { await run(); setError(''); ok = true; } catch (e) { setError(`${what}: ${e.message}`); }
    load().catch(() => {});
    return ok;
  };
  // A PATCH that row-level security filters out changes nothing and says nothing: say so.
  const patch = async (path, body) => {
    const rows = await api(path, { method: 'PATCH', body, prefer: 'return=representation' });
    if (!rows.length) throw new Error('you cannot change it, or it was just deleted');
  };
  const addGoal = async (body) => {
    const position = goals.length ? Math.min(10000, Math.max(...goals.map((g) => g.position)) + 1) : 0;
    if (await change('Could not add the goal', () => api('/goals', { method: 'POST', body: { ...body, set_id: item.id, position }, prefer: 'return=minimal' }))) setAdding(false);
  };
  const saveGoal = async (g, body) => { if (await change('That change was not saved', () => patch(`/goals?id=eq.${g.id}`, body))) setEditing(null); };
  const removeGoal = (g) => {
    if (!window.confirm(`Delete the goal "${g.title}" and its ${g.krs.length} key result${g.krs.length === 1 ? '' : 's'}?`)) return;
    change('Could not delete', () => api(`/goals?id=eq.${g.id}`, { method: 'DELETE', prefer: 'return=minimal' }));
  };
  const addKr = async (g, body) => {
    const position = g.krs.length ? Math.min(10000, Math.max(...g.krs.map((k) => k.position)) + 1) : 0;
    if (await change('Could not add the key result', () => api('/key_results', { method: 'POST', body: { ...body, goal_id: g.id, position }, prefer: 'return=minimal' }))) setAddingKr(null);
  };
  const saveKr = async (k, body) => { if (await change('That change was not saved', () => patch(`/key_results?id=eq.${k.id}`, body))) setEditingKr(null); };
  const updateValue = (k, current_value) => change(`Could not update ${k.title}`, () => patch(`/key_results?id=eq.${k.id}`, { current_value }));
  const removeKr = (k) => {
    if (!window.confirm(`Delete the key result "${k.title}"?`)) return;
    change('Could not delete', () => api(`/key_results?id=eq.${k.id}`, { method: 'DELETE', prefer: 'return=minimal' }));
  };

  if (!goals) return error ? <p className="send-error" role="alert">{error}</p> : <div className="skeleton" aria-label="Loading the goals"><span /><span /><span /></div>;
  const overall = setProgress(goals);
  const krCount = goals.reduce((n, g) => n + g.krs.length, 0);
  const done = goals.filter((g) => g.krs.length && goalProgress(g) >= 1).length;
  const now = today();

  return (
    <div className="links goals">
      <section className="goal-overall" aria-label="Overall progress">
        <div className="goal-overall-head">
          <h3>Overall</h3>
          <span className="goal-pct goal-pct--big">{overall == null ? '–' : `${pct(overall)}%`}</span>
        </div>
        <Bar value={overall} label="Overall progress" big />
        <p className="goal-meta" role="status">{goals.length} goal{goals.length === 1 ? '' : 's'}, {krCount} key result{krCount === 1 ? '' : 's'}{goals.length ? `, ${done} reached` : ''}</p>
      </section>

      {editable ? (adding
        ? <GoalForm initial={{ title: '', note: '', due_on: '' }} onSave={addGoal} onCancel={() => setAdding(false)} label="Add a goal" idp="goal-new" submit="Add goal" />
        : <div className="links-bar"><button className="btn btn--primary btn--sm" type="button" onClick={() => setAdding(true)}>Add a goal</button>
            <p className="docs-hint">Only members of this space can see these goals.</p></div>)
        : <p className="docs-hint">You can follow these goals. Ask an owner of the space to make you an editor to add goals or update progress.</p>}
      {error && <p className="send-error" role="alert">{error}</p>}

      {!goals.length ? <p className="convo-empty">{editable ? 'No goals yet. Add the first one above, then give it key results you can count.' : 'No goals yet.'}</p> : (
        <ul className="link-list" aria-label="Goals">
          {goals.map((g) => {
            const p = goalProgress(g);
            const late = g.due_on && g.due_on < now && (p == null || p < 1);
            return (
              <li key={g.id} className={`link goal${p != null && p >= 1 ? ' is-reached' : ''}`}>
                {editing === g.id ? (
                  <GoalForm initial={{ title: g.title, note: g.note, due_on: g.due_on || '' }} onSave={(b) => saveGoal(g, b)} onCancel={() => setEditing(null)}
                    label={`Edit ${g.title}`} idp={`goal-${g.id}`} submit="Save" />
                ) : (<>
                  <div className="goal-head">
                    <h3 className="goal-title">{g.title}</h3>
                    <span className="goal-pct">{p == null ? 'No key results' : `${pct(p)}%`}</span>
                  </div>
                  <Bar value={p} label={`Progress of ${g.title}`} />
                  {(g.due_on || (p != null && p >= 1)) && (
                    <p className="goal-meta">
                      {p != null && p >= 1 && <span className="goal-state">Reached</span>}
                      {g.due_on && <span className={late ? 'goal-late' : ''}>{late ? 'Overdue, was due ' : 'Due '}{day(g.due_on)}</span>}
                    </p>
                  )}
                  {g.note && <p className="link-note">{g.note}</p>}
                </>)}
                {g.krs.length > 0 && (
                  <ul className="goal-krs" aria-label={`Key results of ${g.title}`}>
                    {g.krs.map((k) => (
                      <li key={k.id} className="goal-kr">
                        {editingKr === k.id ? (
                          <ResultForm initial={{ title: k.title, unit: k.unit, start_value: String(Number(k.start_value)), target_value: String(Number(k.target_value)), current_value: String(Number(k.current_value)) }}
                            onSave={(b) => saveKr(k, b)} onCancel={() => setEditingKr(null)} label={`Edit ${k.title}`} idp={`kr-${k.id}`} submit="Save" />
                        ) : (<>
                          <div className="goal-kr-head">
                            <span className="goal-kr-title">{k.title}</span>
                            <span className="goal-kr-value"><strong>{num(k.current_value)}</strong> of {num(k.target_value)}{k.unit ? ` ${k.unit}` : ''}
                              {Number(k.start_value) !== 0 && <span className="goal-kr-from"> (from {num(k.start_value)})</span>}</span>
                            <span className="goal-pct">{pct(k.progress)}%</span>
                          </div>
                          <Bar value={k.progress} label={`Progress of ${k.title}`} />
                          <div className="link-foot">
                            <span className="link-by">{k.value_updated_at ? `Updated ${stamp(k.value_updated_at)}${k.updated_by?.display_name ? ` by ${k.updated_by.display_name}` : ''}` : ''}</span>
                            {editable && <>
                              <UpdateValue kr={k} onSave={(v) => updateValue(k, v)} />
                              <button className="btn btn--sm" type="button" onClick={() => setEditingKr(k.id)}>Edit<span className="visually-hidden"> {k.title}</span></button>
                              <button className="btn btn--sm" type="button" onClick={() => removeKr(k)}>Delete<span className="visually-hidden"> {k.title}</span></button>
                            </>}
                          </div>
                        </>)}
                      </li>
                    ))}
                  </ul>
                )}
                {editable && editing !== g.id && (addingKr === g.id
                  ? <ResultForm initial={{ title: '', unit: '', start_value: '0', target_value: '', current_value: '0' }} onSave={(b) => addKr(g, b)} onCancel={() => setAddingKr(null)}
                      label={`Add a key result to ${g.title}`} idp={`kr-new-${g.id}`} submit="Add key result" />
                  : <div className="link-foot goal-actions">
                      <button className="btn btn--sm" type="button" onClick={() => setAddingKr(g.id)}>Add a key result<span className="visually-hidden"> to {g.title}</span></button>
                      <button className="btn btn--sm" type="button" onClick={() => setEditing(g.id)}>Edit goal<span className="visually-hidden"> {g.title}</span></button>
                      <button className="btn btn--sm" type="button" onClick={() => removeGoal(g)}>Delete goal<span className="visually-hidden"> {g.title}</span></button>
                    </div>)}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
