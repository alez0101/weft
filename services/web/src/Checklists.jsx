// A checklist: a reusable template of steps (opening up, packing, onboarding) and its runs. Starting a run
// makes a fresh copy of the steps (the database copies them, so later changes to the template never touch
// a run); people tick through it, finish it, and it stays as a record of who did what and when.
// Editors and owners change the template and start, tick, finish, reopen and delete runs; viewers read.
// Row-level security and the guard trigger decide; when they say no, the reason is shown and the checklist
// is reloaded. Live: any change to this checklist's steps or runs refetches it.
// Weft (search and the assistant) reads the checklist's text summary, kept by the database.
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

const RUNS = 'id,label,started_at,finished,finished_at,starter:users!checklist_runs_started_by_fkey(display_name),'
  + 'finisher:users!checklist_runs_finished_by_fkey(display_name),steps:checklist_run_steps(id,position,label,done,done_at,doer:users(display_name))';
const day = (iso) => new Date(iso).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const stamp = (iso) => `${day(iso)}, ${time(iso)}`;

function Progress({ done, total }) {
  return (
    <span className="cl-progress">
      <span className="cl-bar" aria-hidden="true"><span style={{ width: `${total ? Math.round((done / total) * 100) : 0}%` }} /></span>
      <span>{done} of {total} done</span>
    </span>
  );
}

function Run({ run, editable, onTick, onFinish, onDelete, bare }) {
  const steps = [...run.steps].sort((a, b) => a.position - b.position);
  const done = steps.filter((s) => s.done).length;
  const canTick = editable && !run.finished;
  const name = run.label || 'Run';
  return (
    <>
      {!bare && (
        <div className="cl-run-head">
          <h4 className="cl-run-title">{name}</h4>
          <Progress done={done} total={steps.length} />
        </div>
      )}
      <p className="cl-run-meta">
        Started {stamp(run.started_at)} by {run.starter?.display_name || 'someone'}
        {run.finished && <>. Finished {stamp(run.finished_at)} by {run.finisher?.display_name || 'someone'}</>}
      </p>
      <ul className="cl-ticks" aria-label={`Steps of ${name}`}>
        {steps.map((s) => (
          <li key={s.id} className={`cl-tick${s.done ? ' is-done' : ''}`}>
            <input type="checkbox" id={`tick-${s.id}`} className="task-check" checked={s.done} disabled={!canTick} onChange={(e) => onTick(s, e.target.checked)} />
            <label htmlFor={`tick-${s.id}`} className="cl-tick-label">{s.label}</label>
            {s.done && s.done_at && <span className="cl-tick-by">{s.doer?.display_name || 'someone'}, {time(s.done_at)}</span>}
          </li>
        ))}
      </ul>
      {editable && (
        <div className="link-foot">
          {run.finished
            ? <button className="btn btn--sm" type="button" onClick={() => onFinish(run, false)}>Reopen<span className="visually-hidden"> {name}</span></button>
            : <button className="btn btn--primary btn--sm" type="button" onClick={() => onFinish(run, true)}>Finish<span className="visually-hidden"> {name}</span></button>}
          <button className="btn btn--sm" type="button" onClick={() => onDelete(run)}>Delete run<span className="visually-hidden"> {name}</span></button>
        </div>
      )}
    </>
  );
}

export default function Checklist({ item, editable, notice }) {
  const [steps, setSteps] = useState(null);
  const [runs, setRuns] = useState(null);
  const [error, setError] = useState('');
  const [newStep, setNewStep] = useState('');
  const [runLabel, setRunLabel] = useState('');
  const [renaming, setRenaming] = useState(null);   // { id, label }

  const load = useCallback(() => Promise.all([
    api(`/checklist_steps?checklist_id=eq.${item.id}&select=id,label,position&order=position,created_at`),
    api(`/checklist_runs?checklist_id=eq.${item.id}&select=${RUNS}&order=started_at.desc`),
  ]).then(([s, r]) => { setSteps(s); setRuns(r); }), [item.id]);
  useEffect(() => { load().catch((e) => setError(`The checklist could not load: ${e.message}`)); }, [load]);
  useEffect(() => { if (notice?.t === 'checklists' && notice.checklist === item.id) load().catch(() => {}); }, [notice, item.id, load]);

  // Every change: show the database's answer if it refuses, and reload so the screen matches the data.
  const change = async (what, run) => {
    let ok = false;
    try { await run(); setError(''); ok = true; } catch (e) { setError(`${what}: ${e.message}`); }
    load().catch(() => {});
    return ok;
  };

  const addStep = async (e) => {
    e.preventDefault();
    const label = newStep.trim(); if (!label) return;
    const position = steps.length ? Math.max(...steps.map((s) => s.position)) + 1 : 0;
    if (await change('Could not add the step', () => api('/checklist_steps', { method: 'POST', body: { checklist_id: item.id, label, position }, prefer: 'return=minimal' }))) setNewStep('');
  };
  const rename = async (e) => {
    e.preventDefault();
    const label = renaming.label.trim(); if (!label) return;
    if (await change('That change was not saved', () => api(`/checklist_steps?id=eq.${renaming.id}`, { method: 'PATCH', body: { label }, prefer: 'return=minimal' }))) setRenaming(null);
  };
  // Moving a step: number every step in the new order and save the ones whose place changed.
  const move = (i, d) => {
    const j = i + d; if (j < 0 || j >= steps.length) return;
    const next = [...steps]; [next[i], next[j]] = [next[j], next[i]];
    setSteps(next);
    change('Could not move the step', () => Promise.all(next.map((s, k) => (s.position === k ? null
      : api(`/checklist_steps?id=eq.${s.id}`, { method: 'PATCH', body: { position: k }, prefer: 'return=minimal' })))));
  };
  const removeStep = (s) => {
    if (!window.confirm(`Remove "${s.label}" from the checklist? Runs already started keep it.`)) return;
    change('Could not remove the step', () => api(`/checklist_steps?id=eq.${s.id}`, { method: 'DELETE', prefer: 'return=minimal' }));
  };
  const start = async (e) => {
    e.preventDefault();
    if (await change('Could not start a run', () => api('/checklist_runs', { method: 'POST', body: { checklist_id: item.id, label: runLabel.trim() }, prefer: 'return=minimal' }))) setRunLabel('');
  };
  const tick = (s, done) => {
    setRuns((rs) => rs.map((r) => ({ ...r, steps: r.steps.map((x) => (x.id === s.id ? { ...x, done } : x)) })));
    change('That tick was not saved', () => api(`/checklist_run_steps?id=eq.${s.id}`, { method: 'PATCH', body: { done }, prefer: 'return=minimal' }));
  };
  const finish = (r, finished) => change(finished ? 'Could not finish the run' : 'Could not reopen the run',
    () => api(`/checklist_runs?id=eq.${r.id}`, { method: 'PATCH', body: { finished }, prefer: 'return=minimal' }));
  const removeRun = (r) => {
    if (!window.confirm(`Delete the run "${r.label || 'Run'}" and its ticks? This cannot be undone.`)) return;
    change('Could not delete the run', () => api(`/checklist_runs?id=eq.${r.id}`, { method: 'DELETE', prefer: 'return=minimal' }));
  };

  if (!steps || !runs) return error ? <p className="send-error" role="alert">{error}</p> : <div className="skeleton" aria-label="Loading the checklist"><span /><span /><span /></div>;
  const open = runs.filter((r) => !r.finished);
  const past = runs.filter((r) => r.finished);
  const runProps = { editable, onTick: tick, onFinish: finish, onDelete: removeRun };

  return (
    <div className="links checklist">
      {!editable && <p className="docs-hint">You can read this checklist and its runs. Ask an owner of the space to make you an editor to tick steps or start a run.</p>}
      {error && <p className="send-error" role="alert">{error}</p>}
      <div className="cl-grid">
        <section className="cl-runs" aria-labelledby="cl-runs-title">
          <h3 id="cl-runs-title" className="cl-section">Runs</h3>
          {editable && (
            <form className="cl-start" onSubmit={start} aria-label="Start a run">
              <label className="visually-hidden" htmlFor="cl-run-label">Name of the run (optional)</label>
              <input id="cl-run-label" value={runLabel} onChange={(e) => setRunLabel(e.target.value)} maxLength={120} autoComplete="off" placeholder="Name it (optional), such as Saturday" />
              <button className="btn btn--primary btn--sm" type="submit" disabled={!steps.length}>Start a run</button>
            </form>
          )}
          {editable && !steps.length && <p className="docs-hint">Add steps to the checklist first.</p>}
          {!open.length ? <p className="convo-empty">No run in progress.</p> : (
            <ul className="link-list" aria-label="Runs in progress">
              {open.map((r) => <li key={r.id} className="link cl-run"><Run run={r} {...runProps} /></li>)}
            </ul>
          )}
          {past.length > 0 && (<>
            <h3 className="cl-section">Past runs <span className="task-count">{past.length}</span></h3>
            <ul className="link-list" aria-label="Past runs">
              {past.map((r) => {
                const done = r.steps.filter((s) => s.done).length;
                return (
                  <li key={r.id} className="link cl-run is-finished">
                    <details>
                      <summary><span className="cl-run-title">{r.label || 'Run'}</span>
                        <span className="cl-run-meta">finished {stamp(r.finished_at)} by {r.finisher?.display_name || 'someone'}, {done} of {r.steps.length} done</span></summary>
                      <Run run={r} {...runProps} bare />
                    </details>
                  </li>
                );
              })}
            </ul>
          </>)}
        </section>

        <section className="cl-template" aria-labelledby="cl-steps-title">
          <h3 id="cl-steps-title" className="cl-section">Steps <span className="task-count">{steps.length}</span></h3>
          <p className="docs-hint">Each run starts with a copy of these steps. Changing them does not change runs already started.</p>
          {!steps.length ? <p className="convo-empty">{editable ? 'No steps yet. Add the first one below.' : 'No steps yet.'}</p> : (
            <ol className="cl-steps" aria-label="Steps">
              {steps.map((s, i) => (
                <li key={s.id} className="cl-step">
                  <span className="cl-num" aria-hidden="true">{i + 1}</span>
                  {renaming?.id === s.id ? (
                    <form className="cl-rename" onSubmit={rename} aria-label={`Rename ${s.label}`}>
                      <label className="visually-hidden" htmlFor={`step-${s.id}`}>Step</label>
                      <input id={`step-${s.id}`} value={renaming.label} onChange={(e) => setRenaming({ ...renaming, label: e.target.value })} maxLength={200} autoComplete="off" autoFocus
                        onKeyDown={(e) => { if (e.key === 'Escape') setRenaming(null); }} />
                      <button className="btn btn--sm" type="submit" disabled={!renaming.label.trim()}>Save</button>
                      <button className="btn btn--sm" type="button" onClick={() => setRenaming(null)}>Cancel</button>
                    </form>
                  ) : (<>
                    <span className="cl-step-label">{s.label}</span>
                    {editable && <span className="cl-step-tools">
                      <button className="btn btn--sm" type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move up: ${s.label}`}>↑</button>
                      <button className="btn btn--sm" type="button" onClick={() => move(i, 1)} disabled={i === steps.length - 1} aria-label={`Move down: ${s.label}`}>↓</button>
                      <button className="btn btn--sm" type="button" onClick={() => setRenaming({ id: s.id, label: s.label })}>Rename<span className="visually-hidden"> {s.label}</span></button>
                      <button className="btn btn--sm" type="button" onClick={() => removeStep(s)}>Remove<span className="visually-hidden"> {s.label}</span></button>
                    </span>}
                  </>)}
                </li>
              ))}
            </ol>
          )}
          {editable && (
            <form className="cl-start" onSubmit={addStep} aria-label="Add a step">
              <label className="visually-hidden" htmlFor="cl-new-step">New step</label>
              <input id="cl-new-step" value={newStep} onChange={(e) => setNewStep(e.target.value)} maxLength={200} autoComplete="off" placeholder="A step, such as Unlock the side gate" />
              <button className="btn btn--sm" type="submit" disabled={!newStep.trim()}>Add step</button>
            </form>
          )}
        </section>
      </div>
    </div>
  );
}
