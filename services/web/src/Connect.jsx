// The connector's consent screen (served at /oauth/authorize). An AI app such as Claude asks to work in
// Weft as the signed-in person; they choose read only or read and write, or cancel. The connector service
// checks the request first and names the app and where the answer goes, so a look-alike is visible.
// Approving sends the person back to the app with a one-time code; the app never sees their password.
import { useEffect, useRef, useState } from 'react';
import { oauth } from './api.js';

export const CONNECTING = location.pathname === '/oauth/authorize';

export default function Connect({ me }) {
  const params = useRef(Object.fromEntries(new URLSearchParams(location.search)));
  const [req, setReq] = useState(null);
  const [error, setError] = useState('');
  const [access, setAccess] = useState('read');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');

  useEffect(() => {
    oauth(`/request${location.search}`).then(setReq).catch((e) => setError(e.message));
  }, []);

  const answer = async (decision) => {
    setBusy(true); setError('');
    try {
      const r = await oauth('/approve', { method: 'POST', body: { ...params.current, decision, access } });
      setDone(decision === 'allow' ? `Connected. Taking you back to ${req.redirect_host}…` : `Cancelled. Taking you back to ${req.redirect_host}…`);
      location.assign(r.redirect);
    } catch (e) { setError(e.message); setBusy(false); }
  };

  return (
    <main className="signin connect">
      <h1>Weft</h1>
      {!req && !error && <p>Checking the request…</p>}
      {error && !req && <p role="alert" className="signin-error">{error}</p>}
      {req && (
        <form className="signin-form" onSubmit={(e) => { e.preventDefault(); answer('allow'); }}>
          <h2 className="connect-title">Connect {req.client_name} to Weft?</h2>
          <p>{req.client_name} wants to work in Weft as you, <strong>{me.display_name}</strong>. It will see only what you can see, in the channels you are in.</p>
          <fieldset className="connect-choice">
            <legend>What may it do?</legend>
            <label className="toggle"><input type="radio" name="access" value="read" checked={access === 'read'} onChange={() => setAccess('read')} />
              <span><strong>Read only.</strong> Search and read messages, documents, the wiki, tables, tasks, files and the calendar.</span></label>
            <label className="toggle"><input type="radio" name="access" value="write" checked={access === 'write'} onChange={() => setAccess('write')} />
              <span><strong>Read and write.</strong> Also post messages, create and edit documents and wiki pages, and add events and tasks, all under your name. It cannot delete anything.</span></label>
          </fieldset>
          <p className="connect-note">After you answer, you go back to <strong>{req.redirect_host}</strong>. You can disconnect it at any time from your account menu, under Connected apps.</p>
          <span className="pair">
            <button className="btn btn--primary" type="submit" disabled={busy}>Allow</button>
            <button className="btn" type="button" disabled={busy} onClick={() => answer('deny')}>Cancel</button>
          </span>
          {done && <p role="status">{done}</p>}
          {error && <p role="alert" className="signin-error">{error}</p>}
        </form>
      )}
    </main>
  );
}

// Your connected apps, from the account menu: what each may do, when it was last used, and Disconnect.
export function ConnectedApps({ onClose }) {
  const ref = useRef(null);
  const [rows, setRows] = useState(null);
  const [status, setStatus] = useState('');
  const load = () => oauth('/connections').then(setRows).catch((e) => setStatus(e.message));
  useEffect(() => { load(); ref.current?.showModal(); }, []);
  const when = (t) => new Date(t).toLocaleString();
  return (
    <dialog ref={ref} className="people" aria-labelledby="ca-title" onClose={onClose}>
      <header className="people-head">
        <h2 id="ca-title">Connected apps</h2>
        <button className="icon-btn" type="button" aria-label="Close" onClick={() => ref.current.close()}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg>
        </button>
      </header>
      <p className="admin-lead">AI apps you have let work in Weft as you, such as Claude. Each sees only what you can see. To add one, give it this address as a connector: <code>{location.origin}/mcp</code></p>
      {!rows && !status && <div className="skeleton" aria-label="Loading"><span /><span /></div>}
      {rows && !rows.length && <p>No apps are connected.</p>}
      {rows && rows.length > 0 && (
        <ul className="people-list">
          {rows.map((r) => (
            <li key={r.id} className="person">
              <span className="person-name">{r.client_name}<small>{r.access === 'write' ? 'Read and write' : 'Read only'} · connected {when(r.created_at)} · {r.last_used_at ? `last used ${when(r.last_used_at)}` : 'not used yet'}</small></span>
              <button className="btn btn--sm btn--danger" type="button" onClick={async () => {
                setStatus('');
                try { await oauth(`/connections/${r.id}`, { method: 'DELETE' }); setStatus(`${r.client_name} is disconnected.`); load(); } catch (e) { setStatus(e.message); }
              }}>Disconnect</button>
            </li>
          ))}
        </ul>
      )}
      {status && <p className="slot-status" role="status">{status}</p>}
    </dialog>
  );
}
