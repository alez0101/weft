// A form: a few questions (the item's title is its name), one answer per person, the answers collected
// into a table. Every member of the space fills it in, viewers too, and changes or withdraws only their
// own answer until the form is closed. Only editors and owners see everyone's answers (row-level security
// returns a viewer only their own row); they also edit the questions, close or reopen, download the
// answers as CSV, or copy them into a new table in Sheets. The database checks every answer; when it says
// no, its reason is shown and the form is reloaded. Live: any change on this form refetches it.
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

const when = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const answersLabel = (n) => `${n} ${n === 1 ? 'answer' : 'answers'}`;
const KINDS = [['short', 'Short answer'], ['long', 'Long answer'], ['choice', 'One choice']];
const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;   // a spreadsheet must not run an answer as a formula
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function QuestionEditor({ q, locked, onSave, onRemove }) {
  const [label, setLabel] = useState(q.label);
  const [options, setOptions] = useState(q.options.join('\n'));
  const saved = q.options.join('\n');   // a string, so a reload with the same choices does not reset typing
  useEffect(() => { setLabel(q.label); }, [q.label]);
  useEffect(() => { setOptions(saved); }, [saved]);
  const saveLabel = () => { const v = label.trim(); if (v && v !== q.label) onSave({ label: v }); else setLabel(q.label); };
  const saveOptions = () => { const list = options.split('\n').map((s) => s.trim()).filter(Boolean); if (list.join('\n') !== saved) onSave({ options: list }); };
  return (
    <li className="form-q is-editing">
      <div className="form-q-row">
        <label className="visually-hidden" htmlFor={`fq-${q.id}`}>Question</label>
        <input id={`fq-${q.id}`} value={label} maxLength={200} readOnly={locked} onChange={(e) => setLabel(e.target.value)}
          onBlur={saveLabel} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
        <label className="visually-hidden" htmlFor={`fk-${q.id}`}>Kind of answer</label>
        <select id={`fk-${q.id}`} value={q.kind} disabled={locked}
          onChange={(e) => onSave(e.target.value === 'choice' ? { kind: 'choice', options: q.options.length ? q.options : ['Yes', 'No'] } : { kind: e.target.value, options: [] })}>
          {KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <label className="form-req"><input type="checkbox" checked={q.required} disabled={locked} onChange={(e) => onSave({ required: e.target.checked })} /> Required</label>
        <button className="btn btn--sm" type="button" disabled={locked} onClick={onRemove}>Remove<span className="visually-hidden"> {q.label}</span></button>
      </div>
      {q.kind === 'choice' && (
        <div className="form-q-opts">
          <label htmlFor={`fo-${q.id}`}>Choices, one per line</label>
          <textarea id={`fo-${q.id}`} rows={Math.min(8, Math.max(2, q.options.length + 1))} value={options} readOnly={locked}
            onChange={(e) => setOptions(e.target.value)} onBlur={saveOptions} />
        </div>
      )}
    </li>
  );
}

export default function Form({ item, me, members, editable, notice }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [view, setView] = useState(null);        // 'fill' | 'answers' | 'edit'
  const [draft, setDraft] = useState({});
  const [newLabel, setNewLabel] = useState('');
  const [busy, setBusy] = useState(false);

  const people = members.filter((m) => m.space_id === item.space_id && m.user).map((m) => m.user);
  const nameOf = (id) => (id === me.id ? 'You' : people.find((p) => p.id === id)?.display_name ?? 'Someone not in this space');

  const load = useCallback(async () => {
    const [state, questions, responses] = await Promise.all([
      api(`/forms?id=eq.${item.id}&select=closed,closed_at,closed_by`),
      api(`/form_questions?form_id=eq.${item.id}&select=id,label,kind,options,required,position&order=position,created_at`),
      api(`/form_responses?form_id=eq.${item.id}&select=id,respondent_id,answers,created_at,updated_at&order=created_at`),
    ]);
    setData({ state: state[0] || { closed: false }, questions, responses });
  }, [item.id]);
  useEffect(() => { load().catch((e) => setError(`The form could not load: ${e.message}`)); }, [load]);
  useEffect(() => { if (notice?.t === 'forms' && notice.form === item.id) load().catch(() => {}); }, [notice, item.id, load]);

  const mine = data?.responses.find((r) => r.respondent_id === me.id);
  // The draft starts from my saved answer, and follows it when it changes (not while I type).
  useEffect(() => { setNote(''); }, [data?.state.closed, view]);   // a note about the last action, not a stale one
  const mineKey = data ? (mine ? `${mine.id}-${mine.updated_at}` : 'none') : null;
  useEffect(() => { if (mineKey) setDraft(mine ? { ...mine.answers } : {}); }, [mineKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (data && view === null) setView(editable && !data.responses.length ? 'edit' : 'fill'); }, [data, editable, view]);

  const change = async (what, run) => {
    setBusy(true);
    try { await run(); setError(''); return true; } catch (e) { setError(`${what}: ${e.message}`); setNote(''); return false; } finally { setBusy(false); load().catch(() => {}); }
  };

  if (!data) return error ? <p className="send-error" role="alert">{error}</p> : <div className="skeleton" aria-label="Loading the form"><span /><span /><span /></div>;
  const { state, questions, responses } = data;
  const closed = state.closed;
  const locked = responses.length > 0 || closed;   // an editor sees every answer, so this is exact for them

  const setClosed = (v) => change(v ? 'Could not close the form' : 'Could not reopen the form', () => api(`/forms?id=eq.${item.id}`, { method: 'PATCH', body: { closed: v }, prefer: 'return=minimal' }));
  // Show the change at once; the reload after it puts the database's answer on screen.
  const saveQ = (q, body) => {
    setData((d) => ({ ...d, questions: d.questions.map((x) => (x.id === q.id ? { ...x, ...body } : x)) }));
    return change('That question was not changed', () => api(`/form_questions?id=eq.${q.id}`, { method: 'PATCH', body, prefer: 'return=minimal' }));
  };
  const removeQ = (q) => change('That question was not removed', () => api(`/form_questions?id=eq.${q.id}`, { method: 'DELETE', prefer: 'return=minimal' }));
  async function addQ(e) {
    e.preventDefault();
    if (!newLabel.trim()) return;
    const position = Math.max(-1, ...questions.map((q) => q.position)) + 1;
    if (await change('Could not add the question', () => api('/form_questions', { method: 'POST', body: { form_id: item.id, label: newLabel.trim(), kind: 'short', position }, prefer: 'return=minimal' }))) setNewLabel('');
  }
  async function submit(e) {
    e.preventDefault();
    const answers = Object.fromEntries(questions.map((q) => [q.id, (draft[q.id] ?? '').trim()]).filter(([, v]) => v));
    const ok = await change('Your answer was not saved', () => (mine
      ? api(`/form_responses?id=eq.${mine.id}`, { method: 'PATCH', body: { answers }, prefer: 'return=minimal' })
      : api('/form_responses', { method: 'POST', body: { form_id: item.id, answers }, prefer: 'return=minimal' })));
    if (ok) setNote(mine ? 'Your answer was updated.' : 'Thank you, your answer was sent.');
  }
  async function withdraw() {
    if (!mine || !window.confirm('Withdraw your answer? It is deleted for everyone.')) return;
    if (await change('Your answer was not withdrawn', () => api(`/form_responses?id=eq.${mine.id}`, { method: 'DELETE', prefer: 'return=minimal' }))) setNote('Your answer was withdrawn.');
  }

  const header = ['Person', 'Answered', ...questions.map((q) => q.label)];
  const rowsOf = () => responses.map((r) => [nameOf(r.respondent_id), when(r.updated_at), ...questions.map((q) => r.answers[q.id] ?? '')]);
  function downloadCsv() {
    const csv = [header, ...rowsOf()].map((row) => row.map(csvCell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([`﻿${csv}\r\n`], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = `${item.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'form'} answers.csv`;
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  // A copy, as the person: a new table in the same space, so the same people can open it.
  async function copyToTable() {
    const title = `${item.title} (answers)`.slice(0, 200);
    await change('Could not copy the answers to a table', async () => {
      const [table] = await api('/items', { method: 'POST', body: { space_id: item.space_id, kind: 'table', title }, prefer: 'return=representation' });
      const cols = await api('/table_columns', { method: 'POST', prefer: 'return=representation',
        body: header.map((name, i) => ({ table_id: table.id, name: name.slice(0, 80), type: 'text', position: i })) });
      const byPos = [...cols].sort((a, b) => a.position - b.position);
      const rows = rowsOf();
      if (rows.length) await api('/table_rows', { method: 'POST', prefer: 'return=minimal',
        body: rows.map((row, i) => ({ table_id: table.id, position: i, cells: Object.fromEntries(row.map((v, j) => [byPos[j].id, v]).filter(([, v]) => v !== '')) })) });
      setNote(`Copied ${answersLabel(rows.length)} to the table "${title}" in Sheets. It is a copy: later answers are not added to it.`);
    });
  }

  const field = (q) => {
    const id = `fa-${q.id}`;
    const value = draft[q.id] ?? '';
    const set = (v) => setDraft((d) => ({ ...d, [q.id]: v }));
    return (
      <li key={q.id} className="form-q">
        {q.kind === 'choice' ? (
          <fieldset className="form-choices">
            <legend className="form-label">{q.label}{q.required && <span className="form-star" aria-label="required"> *</span>}</legend>
            {q.options.map((o) => (
              <label key={o} className="form-choice"><input type="radio" name={id} value={o} checked={value === o} required={q.required} onChange={() => set(o)} /> {o}</label>
            ))}
            {!q.required && value && <button type="button" className="btn btn--sm form-clear" onClick={() => set('')}>Clear<span className="visually-hidden"> {q.label}</span></button>}
          </fieldset>
        ) : (<>
          <label className="form-label" htmlFor={id}>{q.label}{q.required && <span className="form-star" aria-label="required"> *</span>}</label>
          {q.kind === 'long'
            ? <textarea id={id} rows={4} maxLength={4000} value={value} required={q.required} onChange={(e) => set(e.target.value)} />
            : <input id={id} maxLength={300} value={value} required={q.required} onChange={(e) => set(e.target.value)} />}
        </>)}
      </li>
    );
  };

  return (
    <div className="form">
      <div className="form-head">
        <p className="poll-state" role="status">
          <span className={`poll-badge${closed ? ' is-closed' : ''}`}>{closed ? 'Closed' : 'Open'}</span>
          {editable ? answersLabel(responses.length) : mine ? 'You have answered' : 'You have not answered yet'}
          {closed && state.closed_at ? `, closed ${when(state.closed_at)}${state.closed_by ? ` by ${nameOf(state.closed_by)}` : ''}` : ''}
        </p>
        {editable && (
          <span className="pair">
            <span className="form-views" role="group" aria-label="Show">
              <button className="btn btn--sm" type="button" aria-pressed={view === 'fill'} onClick={() => setView('fill')}>Fill in</button>
              <button className="btn btn--sm" type="button" aria-pressed={view === 'answers'} onClick={() => setView('answers')}>Answers ({responses.length})</button>
              <button className="btn btn--sm" type="button" aria-pressed={view === 'edit'} onClick={() => setView('edit')}>Edit questions</button>
            </span>
            <button className="btn btn--sm" type="button" onClick={() => setClosed(!closed)}>{closed ? 'Reopen form' : 'Close form'}</button>
          </span>
        )}
      </div>
      {error && <p className="send-error" role="alert">{error}</p>}
      {note && <p className="slot-status" role="status">{note}</p>}

      {view === 'edit' && editable ? (<>
        {locked && <p className="docs-hint">{closed ? 'This form is closed, so its questions stay as they are.' : 'People have answered, so these questions stay as they are. You can still add new ones.'}</p>}
        {!questions.length && <p className="convo-empty">No questions yet. Add the first one below.</p>}
        <ol className="form-qs">
          {questions.map((q) => <QuestionEditor key={q.id} q={q} locked={locked} onSave={(body) => saveQ(q, body)} onRemove={() => removeQ(q)} />)}
        </ol>
        {!closed && (
          <form className="poll-add" onSubmit={addQ} aria-label="Add a question">
            <label className="visually-hidden" htmlFor="form-new-q">New question</label>
            <input id="form-new-q" placeholder="Add a question" maxLength={200} value={newLabel} onChange={(e) => setNewLabel(e.target.value)} />
            <button className="btn btn--primary btn--sm" type="submit" disabled={!newLabel.trim() || busy}>Add question</button>
          </form>
        )}
        <p className="docs-hint">Everyone in this space can answer once and change their answer until the form is closed. Only editors and owners see everyone's answers. Share the form in a channel with Share to a channel above.</p>
      </>) : view === 'answers' && editable ? (<>
        <div className="form-tools">
          <span className="task-count">Only editors and owners of this space see this table.</span>
          <button className="btn btn--sm" type="button" onClick={downloadCsv} disabled={!responses.length}>Download CSV</button>
          <button className="btn btn--sm" type="button" onClick={copyToTable} disabled={!responses.length || busy}>Copy to a new table</button>
        </div>
        {!responses.length ? <p className="convo-empty">No answers yet. They appear here as they come in.</p> : (
          <div className="form-table-wrap" tabIndex={0} role="region" aria-label="Answers">
            <table className="form-table">
              <thead><tr>{header.map((h, i) => <th key={i} scope="col">{h}</th>)}</tr></thead>
              <tbody>{rowsOf().map((row, i) => <tr key={responses[i].id}>{row.map((v, j) => (j === 0 ? <th key={j} scope="row">{v}</th> : <td key={j}>{v}</td>))}</tr>)}</tbody>
            </table>
          </div>
        )}
      </>) : (<>
        {!questions.length ? <p className="convo-empty">This form has no questions yet.</p> : (
          <form className="form-fill" onSubmit={submit} aria-label="Your answer">
            <fieldset className="form-fieldset" disabled={closed || busy}>
              <legend className="visually-hidden">Your answer</legend>
              <ol className="form-qs">{questions.map(field)}</ol>
              {!closed && (
                <div className="form-actions">
                  <button className="btn btn--primary btn--sm" type="submit">{mine ? 'Update my answer' : 'Send my answer'}</button>
                  {mine && <button className="btn btn--sm" type="button" onClick={withdraw}>Withdraw my answer</button>}
                </div>
              )}
            </fieldset>
          </form>
        )}
        <p className="docs-hint">{closed ? 'This form is closed. Answers stay as they were.'
          : mine ? `You answered ${when(mine.updated_at)}. You can change your answer until the form is closed.`
            : 'Fields marked * are required.'}{' '}{editable ? 'Only editors and owners of this space see everyone\'s answers.' : 'Only you and the editors and owners of this space see your answer.'}</p>
      </>)}
    </div>
  );
}
