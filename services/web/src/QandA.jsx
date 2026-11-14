// A Q and A board: questions people in a space ask, the answers they give, upvotes, and one accepted
// answer per question, newest question first. Editors and owners ask and answer; you change only what you
// wrote; editors and owners can delete anything (tidying up). Every member upvotes, viewers included,
// never their own answer. The person who asked, or an owner of the space, accepts an answer.
// Row-level security and the guard trigger decide; when they say no, the reason is shown and the board
// is reloaded. Live: any change to this board's questions, answers or upvotes refetches it.
// Weft (search and the assistant) reads the board's text summary, kept by the database.
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

const SELECT = 'id,title,details,accepted_id,created_by,created_at,author:users!questions_created_by_fkey(display_name),'
  + 'answers:answers!answers_question_id_fkey(id,body,created_by,created_at,updated_at,author:users!answers_created_by_fkey(display_name),votes:answer_votes(voter_id))';
const day = (iso) => new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });

function QuestionForm({ initial, onSave, onCancel, label, idp, submit }) {
  const [f, setF] = useState(initial);
  const save = (e) => {
    e.preventDefault();
    if (!f.title.trim()) return;
    onSave({ title: f.title.trim(), details: f.details.trim() }, () => setF({ title: '', details: '' }));
  };
  return (
    <form className="link-form" onSubmit={save} aria-label={label} noValidate>
      <label htmlFor={`${idp}-title`}>Question</label>
      <input id={`${idp}-title`} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={200} autoComplete="off" placeholder="What do you want to know?" required />
      <label htmlFor={`${idp}-details`}>Details</label>
      <textarea id={`${idp}-details`} value={f.details} onChange={(e) => setF({ ...f, details: e.target.value })} maxLength={4000} rows={3} placeholder="Anything that helps someone answer (optional)" />
      <div className="link-form-actions">
        <button className="btn btn--primary btn--sm" type="submit" disabled={!f.title.trim()}>{submit}</button>
        {onCancel && <button className="btn btn--sm" type="button" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

function AnswerForm({ initial = '', onSave, onCancel, label, idp, submit }) {
  const [body, setBody] = useState(initial);
  const save = (e) => { e.preventDefault(); if (body.trim()) onSave(body.trim(), () => setBody('')); };
  return (
    <form className="qa-answer-form" onSubmit={save} aria-label={label} noValidate>
      <label className="visually-hidden" htmlFor={`${idp}-body`}>{label}</label>
      <textarea id={`${idp}-body`} value={body} onChange={(e) => setBody(e.target.value)} maxLength={8000} rows={2} placeholder="Write an answer" />
      <div className="link-form-actions">
        <button className="btn btn--sm" type="submit" disabled={!body.trim()}>{submit}</button>
        {onCancel && <button className="btn btn--sm" type="button" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

export default function QandA({ item, me, editable, owner, notice }) {
  const [questions, setQuestions] = useState(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const [editing, setEditing] = useState(null);   // a question or answer id

  const load = useCallback(() => api(`/questions?board_id=eq.${item.id}&select=${SELECT}&order=created_at.desc`).then(setQuestions), [item.id]);
  useEffect(() => { load().catch((e) => setError(`The board could not load: ${e.message}`)); }, [load]);
  useEffect(() => { if (notice?.t === 'qa' && notice.board === item.id) load().catch(() => {}); }, [notice, item.id, load]);

  // Every change: show the database's answer if it refuses, and reload so the screen matches the data.
  const change = async (what, run) => {
    let ok = false;
    try { await run(); setError(''); ok = true; } catch (e) { setError(`${what}: ${e.message}`); }
    load().catch(() => {});
    return ok;
  };
  const ask = async (body, reset) => {
    if (await change('Could not ask', () => api('/questions', { method: 'POST', body: { ...body, board_id: item.id }, prefer: 'return=minimal' }))) { reset(); setAsking(false); }
  };
  const saveQuestion = async (q, body) => {
    if (await change('That change was not saved', () => api(`/questions?id=eq.${q.id}`, { method: 'PATCH', body, prefer: 'return=minimal' }))) setEditing(null);
  };
  const removeQuestion = (q) => {
    if (!window.confirm(`Delete "${q.title}" and its answers? Everyone who can see this board loses them.`)) return;
    change('Could not delete', () => api(`/questions?id=eq.${q.id}`, { method: 'DELETE', prefer: 'return=minimal' }));
  };
  const answer = (q) => (body, reset) => change('Could not answer', () => api('/answers', { method: 'POST', body: { question_id: q.id, body }, prefer: 'return=minimal' }))
    .then((ok) => ok && reset());
  const saveAnswer = async (a, body) => {
    if (await change('That change was not saved', () => api(`/answers?id=eq.${a.id}`, { method: 'PATCH', body: { body }, prefer: 'return=minimal' }))) setEditing(null);
  };
  const removeAnswer = (a) => {
    if (!window.confirm('Delete this answer? Everyone who can see this board loses it.')) return;
    change('Could not delete', () => api(`/answers?id=eq.${a.id}`, { method: 'DELETE', prefer: 'return=minimal' }));
  };
  const accept = (q, a) => change('Could not change the accepted answer', () => api(`/questions?id=eq.${q.id}`, { method: 'PATCH', body: { accepted_id: q.accepted_id === a.id ? null : a.id }, prefer: 'return=minimal' }));
  const upvote = (a, mine) => change(mine ? 'Could not take back the upvote' : 'Could not upvote', () => (mine
    ? api(`/answer_votes?answer_id=eq.${a.id}&voter_id=eq.${me.id}`, { method: 'DELETE', prefer: 'return=minimal' })
    : api('/answer_votes', { method: 'POST', body: { answer_id: a.id }, prefer: 'return=minimal' })));

  if (!questions) return error ? <p className="send-error" role="alert">{error}</p> : <div className="skeleton" aria-label="Loading the board"><span /><span /><span /></div>;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = questions.filter((q) => (!open || !q.accepted_id)
    && words.every((w) => `${q.title} ${q.details} ${q.answers.map((a) => a.body).join(' ')}`.toLowerCase().includes(w)));
  const answered = questions.filter((q) => q.accepted_id).length;
  // The accepted answer first, then the most upvoted, then the oldest.
  const ordered = (q) => [...q.answers].sort((a, b) => (b.id === q.accepted_id) - (a.id === q.accepted_id) || b.votes.length - a.votes.length || a.created_at.localeCompare(b.created_at));

  return (
    <div className="links qa">
      {editable ? (asking
        ? <QuestionForm initial={{ title: '', details: '' }} onSave={ask} onCancel={() => setAsking(false)} label="Ask a question" idp="qa-new" submit="Ask" />
        : <div className="links-bar"><button className="btn btn--primary btn--sm" type="button" onClick={() => setAsking(true)}>Ask a question</button>
            <p className="docs-hint">Only members of this space can see these questions. Weft can answer from them.</p></div>)
        : <p className="docs-hint">You can read the answers and upvote the helpful ones. Ask an owner of the space to make you an editor to ask or answer.</p>}
      {error && <p className="send-error" role="alert">{error}</p>}
      {questions.length > 0 && (
        <div className="links-filters">
          <label className="visually-hidden" htmlFor="qa-find">Find a question</label>
          <input id="qa-find" type="search" placeholder="Find in questions and answers…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <label className="toggle"><input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} /> No accepted answer yet</label>
          <span className="task-count" role="status">{shown.length === questions.length
            ? `${questions.length} question${questions.length === 1 ? '' : 's'}, ${answered} answered`
            : `${shown.length} of ${questions.length}`}</span>
        </div>
      )}
      {!questions.length ? <p className="convo-empty">{editable ? 'No questions yet. Ask the first one above.' : 'No questions yet.'}</p>
        : !shown.length ? <p className="convo-empty">No questions match.</p> : (
        <ul className="link-list" aria-label="Questions">
          {shown.map((q) => {
            const mineQ = q.created_by === me.id; const canAccept = editable && (mineQ || owner);
            return (
              <li key={q.id} className={`link qa-question${q.accepted_id ? ' is-answered' : ''}`}>
                {editing === q.id ? (
                  <QuestionForm initial={{ title: q.title, details: q.details }} onSave={(b) => saveQuestion(q, b)} onCancel={() => setEditing(null)} label={`Edit ${q.title}`} idp={`qa-${q.id}`} submit="Save" />
                ) : (<>
                  <div className="qa-head">
                    <h3 className="qa-title">{q.title}</h3>
                    <span className={`qa-state${q.accepted_id ? ' is-answered' : ''}`}>{q.accepted_id ? 'Answered' : q.answers.length ? `${q.answers.length} answer${q.answers.length === 1 ? '' : 's'}` : 'No answers yet'}</span>
                  </div>
                  {q.details && <p className="link-note">{q.details}</p>}
                  <div className="link-foot">
                    <span className="link-by">Asked by {q.author?.display_name || 'someone'}, {day(q.created_at)}</span>
                    {editable && mineQ && <button className="btn btn--sm" type="button" onClick={() => setEditing(q.id)}>Edit<span className="visually-hidden"> {q.title}</span></button>}
                    {editable && <button className="btn btn--sm" type="button" onClick={() => removeQuestion(q)}>Delete<span className="visually-hidden"> {q.title}</span></button>}
                  </div>
                </>)}
                {q.answers.length > 0 && (
                  <ul className="qa-answers" aria-label={`Answers to ${q.title}`}>
                    {ordered(q).map((a) => {
                      const mine = a.created_by === me.id; const voted = a.votes.some((v) => v.voter_id === me.id); const isAccepted = a.id === q.accepted_id;
                      return (
                        <li key={a.id} className={`qa-answer${isAccepted ? ' is-accepted' : ''}`}>
                          <button type="button" className="qa-vote" aria-pressed={voted} disabled={mine}
                            title={mine ? 'You cannot upvote your own answer' : voted ? 'Take back your upvote' : 'Upvote this answer'}
                            onClick={() => upvote(a, voted)}>
                            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 3l5 7H3z" fill="currentColor" /></svg>
                            <span className="qa-votes">{a.votes.length}</span>
                            <span className="visually-hidden">{voted ? ', you upvoted' : mine ? ' upvotes on your answer' : ', upvote'}</span>
                          </button>
                          <div className="qa-answer-main">
                            {isAccepted && <span className="qa-accepted">Accepted answer</span>}
                            {editing === a.id
                              ? <AnswerForm initial={a.body} onSave={(b) => saveAnswer(a, b)} onCancel={() => setEditing(null)} label="Edit your answer" idp={`qa-a-${a.id}`} submit="Save" />
                              : <p className="qa-body">{a.body}</p>}
                            <div className="link-foot">
                              <span className="link-by">{a.author?.display_name || 'Someone'}, {day(a.created_at)}</span>
                              {canAccept && <button className="btn btn--sm" type="button" aria-pressed={isAccepted} onClick={() => accept(q, a)}>{isAccepted ? 'Unaccept' : 'Accept'}<span className="visually-hidden"> answer by {a.author?.display_name}</span></button>}
                              {editable && mine && editing !== a.id && <button className="btn btn--sm" type="button" onClick={() => setEditing(a.id)}>Edit<span className="visually-hidden"> your answer</span></button>}
                              {editable && <button className="btn btn--sm" type="button" onClick={() => removeAnswer(a)}>Delete<span className="visually-hidden"> answer by {a.author?.display_name}</span></button>}
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {editable && <AnswerForm onSave={answer(q)} label={`Answer ${q.title}`} idp={`qa-ans-${q.id}`} submit="Answer" />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
