// Meeting decisions to the log (054): under a meeting's Decisions section, each line can be sent with one
// press to a decision log in the same space. A sent line says which log it is in, with a way to open it; the
// decision in the log links back to the meeting. Editors and owners send; viewers, who read the Decisions text
// above it, see just the lines that are in a log. Row-level security decides; when it says no, the reason
// is shown. The parent meeting refetches on 'meeting_decisions' notices for this meeting, and on items or
// decisions changing in its space.
import { useState } from 'react';
import { api } from './api.js';
import { dayKey } from './TimeOff.jsx';

// The lines of a meeting's Decisions text, each once, as the database stores them (trimmed, non-empty).
export const decisionLines = (text) => [...new Set((text || '').split('\n').map((l) => l.trim()).filter(Boolean))];

export default function MeetingDecisions({ meeting, sent, logs, editable, onChanged, onOpenItem }) {
  const lines = decisionLines(meeting.decisions);
  const lastUsed = sent.map((s) => s.decision?.log_id).find((id) => logs.some((l) => l.id === id));
  const [chosen, setChosen] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const logId = logs.some((l) => l.id === chosen) ? chosen : (lastUsed || logs[0]?.id || '');
  const byLine = Object.fromEntries(sent.map((s) => [s.line, s]));
  const shown = editable ? lines : lines.filter((l) => byLine[l]);

  if (!shown.length) return null;
  const send = async (line) => {
    setBusy(line); setStatus('');
    try {
      await api('/rpc/send_meeting_decision', { method: 'POST',
        body: { p_meeting: meeting.id, p_log: logId, p_line: line, p_on: meeting.held_at ? dayKey(meeting.held_at) : null } });
      setError(''); setStatus(`Sent to ${logs.find((l) => l.id === logId)?.title ?? 'the decision log'}.`);
    } catch (e) { setError(`Could not send it: ${e.message}`); }
    setBusy('');
    await onChanged();
  };
  const unsent = lines.filter((l) => !byLine[l]).length;

  return (
    <div className="meeting-decisions" aria-label="Decisions in a log" role="group">
      {editable && (logs.length ? (
        <div className="meeting-fact">
          <label htmlFor="meeting-log">Send to the log</label>
          {logs.length > 1 ? (
            <select id="meeting-log" value={logId} onChange={(e) => setChosen(e.target.value)}>
              {logs.map((l) => <option key={l.id} value={l.id}>{l.title}</option>)}
            </select>
          ) : <span id="meeting-log" className="meeting-value">{logs[0].title}</span>}
          <span className="task-count">{unsent ? `${unsent} of ${lines.length} not in a log yet` : 'All in a log'}</span>
        </div>
      ) : <p className="docs-hint meeting-hint">There is no decision log in this space yet. Make one in Decisions to send these lines to it.</p>)}
      {error && <p className="send-error" role="alert">{error}</p>}
      {!editable && <p className="docs-hint meeting-hint">In a decision log:</p>}
      <ul className="meeting-decision-lines" aria-label="Decision lines">
        {shown.map((line) => {
          const s = byLine[line]; const log = s?.decision?.log;
          return (
            <li key={line} className={`meeting-decision${s ? ' is-sent' : ''}`}>
              <span className="meeting-decision-text">{line}</span>
              {s ? (<>
                <span className="meeting-decision-state">In {log?.title ?? 'a decision log'}</span>
                {log && onOpenItem && <button type="button" className="btn btn--sm" onClick={() => onOpenItem(log.id)}>Open the log<span className="visually-hidden">: {log.title}</span></button>}
              </>) : editable && logId
                ? <button type="button" className="btn btn--sm" disabled={busy === line} onClick={() => send(line)}>Send to log<span className="visually-hidden">: {line}</span></button>
                : <span className="meeting-decision-state is-none">Not in a log</span>}
            </li>
          );
        })}
      </ul>
      {status && <p className="slot-status" role="status">{status}</p>}
    </div>
  );
}
