// A poll: a question (the item's title), a few choices, one vote per person, results live. Every member
// of the space votes, viewers too; editors and owners change the choices and close or reopen the poll.
// Row-level security decides; when it says no, the reason is shown and the poll is reloaded.
// Live: any vote or change on this poll refetches it.
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

const when = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const votesLabel = (n) => `${n} ${n === 1 ? 'vote' : 'votes'}`;

export default function Poll({ item, me, members, editable, notice }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState('');

  const people = members.filter((m) => m.space_id === item.space_id && m.user).map((m) => m.user);
  const nameOf = (id) => (id === me.id ? 'you' : people.find((p) => p.id === id)?.display_name ?? 'someone not in this space');

  const load = useCallback(async () => {
    const [state, choices, votes] = await Promise.all([
      api(`/polls?id=eq.${item.id}&select=closed,closed_at,closed_by`),
      api(`/poll_choices?poll_id=eq.${item.id}&select=id,label,position&order=position,created_at`),
      api(`/poll_votes?poll_id=eq.${item.id}&select=voter_id,choice_id&order=created_at`),
    ]);
    setData({ state: state[0] || { closed: false }, choices, votes });
  }, [item.id]);
  useEffect(() => { load().catch((e) => setError(`The poll could not load: ${e.message}`)); }, [load]);
  useEffect(() => { if (notice?.t === 'polls' && notice.poll === item.id) load().catch(() => {}); }, [notice, item.id, load]);
  useEffect(() => { if (data && editable && !data.choices.length) setEditing(true); }, [data, editable]);

  // Every change: show the database's answer if it refuses, and reload so the screen matches the data.
  const change = async (what, run) => {
    try { await run(); setError(''); } catch (e) { setError(`${what}: ${e.message}`); }
    load().catch(() => {});
  };

  if (!data) return error ? <p className="send-error" role="alert">{error}</p> : <div className="skeleton" aria-label="Loading the poll"><span /><span /><span /></div>;
  const { state, choices, votes } = data;
  const closed = state.closed;
  const mine = votes.find((v) => v.voter_id === me.id);
  const total = votes.length;
  const count = (c) => votes.filter((v) => v.choice_id === c.id).length;
  const top = Math.max(0, ...choices.map(count));

  // Show my vote at once; the reload after it puts the database's answer on screen.
  const setMine = (choiceId) => setData((d) => ({ ...d, votes: [...d.votes.filter((v) => v.voter_id !== me.id), ...(choiceId ? [{ voter_id: me.id, choice_id: choiceId }] : [])] }));
  const vote = (c) => { setMine(c.id); return change('Your vote was not saved', () => (mine
    ? api(`/poll_votes?poll_id=eq.${item.id}&voter_id=eq.${me.id}`, { method: 'PATCH', body: { choice_id: c.id }, prefer: 'return=minimal' })
    : api('/poll_votes', { method: 'POST', body: { poll_id: item.id, choice_id: c.id }, prefer: 'return=minimal' }))); };
  const withdraw = () => { setMine(null); return change('Your vote was not withdrawn', () => api(`/poll_votes?poll_id=eq.${item.id}&voter_id=eq.${me.id}`, { method: 'DELETE', prefer: 'return=minimal' })); };
  const setClosed = (v) => change(v ? 'Could not close the poll' : 'Could not reopen the poll', () => api(`/polls?id=eq.${item.id}`, { method: 'PATCH', body: { closed: v }, prefer: 'return=minimal' }));
  const rename = (c, v) => change('That choice was not changed', () => api(`/poll_choices?id=eq.${c.id}`, { method: 'PATCH', body: { label: v }, prefer: 'return=minimal' }));
  const remove = (c) => change('That choice was not removed', () => api(`/poll_choices?id=eq.${c.id}`, { method: 'DELETE', prefer: 'return=minimal' }));
  async function add(e) {
    e.preventDefault();
    if (!label.trim()) return;
    const position = Math.max(-1, ...choices.map((c) => c.position)) + 1;
    await change('Could not add the choice', async () => { await api('/poll_choices', { method: 'POST', body: { poll_id: item.id, label: label.trim(), position }, prefer: 'return=minimal' }); setLabel(''); });
  }

  return (
    <div className="poll">
      <div className="poll-head">
        <p className="poll-state" role="status">
          <span className={`poll-badge${closed ? ' is-closed' : ''}`}>{closed ? 'Closed' : 'Open'}</span>
          {votesLabel(total)}{closed && state.closed_at ? `, closed ${when(state.closed_at)}${state.closed_by ? ` by ${nameOf(state.closed_by)}` : ''}` : ''}
        </p>
        {editable && (
          <span className="pair">
            {!closed && choices.length > 0 && <button className="btn btn--sm" type="button" aria-pressed={editing} onClick={() => setEditing((x) => !x)}>{editing ? 'Done editing' : 'Edit choices'}</button>}
            <button className="btn btn--sm" type="button" onClick={() => setClosed(!closed)}>{closed ? 'Reopen poll' : 'Close poll'}</button>
          </span>
        )}
      </div>
      {error && <p className="send-error" role="alert">{error}</p>}

      {!choices.length ? <p className="convo-empty">{editable ? 'No choices yet. Add the first one below.' : 'No choices yet.'}</p> : (
        <fieldset className="poll-choices" disabled={closed}>
          <legend className="visually-hidden">{closed ? 'Results' : 'Your vote'}</legend>
          {choices.map((c) => {
            const n = count(c);
            const pct = total ? Math.round((n * 100) / total) : 0;
            const voters = votes.filter((v) => v.choice_id === c.id).map((v) => nameOf(v.voter_id));
            const chosen = mine?.choice_id === c.id;
            return (
              <div key={c.id} className={`poll-choice${chosen ? ' is-mine' : ''}${closed && n > 0 && n === top ? ' is-top' : ''}`}>
                {editing && !closed ? (
                  <div className="poll-edit">
                    <label className="visually-hidden" htmlFor={`pc-${c.id}`}>Choice</label>
                    <input id={`pc-${c.id}`} defaultValue={c.label} key={`${c.id}-${c.label}`} maxLength={200} readOnly={n > 0}
                      title={n > 0 ? 'People voted for this, so it stays as it is' : undefined}
                      onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== c.label) rename(c, v); else e.target.value = c.label; }}
                      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
                    <span className="poll-count">{votesLabel(n)}</span>
                    <button className="btn btn--sm" type="button" disabled={n > 0} onClick={() => remove(c)}>Remove<span className="visually-hidden"> {c.label}</span></button>
                  </div>
                ) : (
                  <label className="poll-option">
                    <input type="radio" name={`poll-${item.id}`} checked={chosen} onChange={() => vote(c)} />
                    <span className="poll-label">{c.label}{chosen && <span className="poll-you"> (your vote)</span>}</span>
                    <span className="poll-count">{votesLabel(n)}{total ? `, ${pct}%` : ''}</span>
                    <span className="poll-bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
                    {voters.length > 0 && <span className="poll-voters">{voters.join(', ')}</span>}
                  </label>
                )}
              </div>
            );
          })}
        </fieldset>
      )}

      {editable && editing && !closed && (
        <form className="poll-add" onSubmit={add} aria-label="Add a choice">
          <label className="visually-hidden" htmlFor="poll-new">New choice</label>
          <input id="poll-new" placeholder="Add a choice" maxLength={200} value={label} onChange={(e) => setLabel(e.target.value)} />
          <button className="btn btn--primary btn--sm" type="submit" disabled={!label.trim()}>Add choice</button>
        </form>
      )}
      <div className="poll-foot">
        {mine && !closed && <button className="btn btn--sm" type="button" onClick={withdraw}>Withdraw my vote</button>}
        <p className="docs-hint">{closed ? 'This poll is closed. The votes stay as they were.'
          : editable ? 'Everyone in this space can vote once and change their vote until the poll is closed. Everyone here sees who voted for what. A choice someone voted for cannot be changed.'
            : 'You can vote once and change your vote until the poll is closed. Everyone here sees who voted for what.'}</p>
      </div>
    </div>
  );
}
