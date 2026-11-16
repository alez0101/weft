import { useCallback, useEffect, useState } from 'react';
import { api, assistant } from './api.js';
import { AdminUsers } from './People.jsx';

const KIND_LABEL = { anthropic: 'Anthropic', openai: 'OpenAI-compatible', ollama: 'Ollama' };
const usd = (n) => (n === null || n === undefined || n === '' ? '' : `$${Number(n).toFixed(2)}`);

function Slot({ slot, initial, onSaved }) {
  const [f, setF] = useState({ ...initial, base_url: initial.base_url ?? '', monthly_cap_usd: initial.monthly_cap_usd ?? '', effort: initial.effort ?? 'low' });
  const [key, setKey] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const run = async (label, fn) => {
    setBusy(true); setStatus('');
    try { setStatus(await fn()); onSaved(); } catch (e) { setStatus(`${label} failed: ${e.message}`); }
    setBusy(false);
  };
  const id = (k) => `${slot}-${k}`;

  return (
    <section className="slot" aria-labelledby={id('title')}>
      <header className="slot-head">
        <h3 id={id('title')}>{slot === 'primary' ? 'Primary' : 'Secondary (fallback)'}</h3>
        <label className="toggle"><input type="checkbox" checked={f.enabled} onChange={set('enabled')} /> Enabled</label>
      </header>
      <div className="fields">
        <label htmlFor={id('kind')}>Provider</label>
        <select id={id('kind')} value={f.kind} onChange={set('kind')}>
          {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <label htmlFor={id('model')}>Model</label>
        <input id={id('model')} value={f.model} onChange={set('model')} />
        {f.kind === 'anthropic' ? (<>
          <label htmlFor={id('effort')}>Effort</label>
          <select id={id('effort')} value={f.effort} onChange={set('effort')}>
            {['low', 'medium', 'high', 'xhigh', 'max'].map((e) => <option key={e} value={e}>{e}</option>)}
          </select>
        </>) : (<>
          <label htmlFor={id('url')}>Base URL</label>
          <input id={id('url')} value={f.base_url} onChange={set('base_url')} placeholder={f.kind === 'ollama' ? 'http://host:11434' : 'https://host/v1'} />
        </>)}
        <label htmlFor={id('cap')}>Monthly cap (USD)</label>
        <input id={id('cap')} type="number" min="0" step="0.5" value={f.monthly_cap_usd} onChange={set('monthly_cap_usd')} placeholder="No cap" />
        <label htmlFor={id('pin')}>Price per million tokens, in / out</label>
        <span className="pair">
          <input id={id('pin')} type="number" min="0" step="0.01" value={f.price_in} onChange={set('price_in')} aria-label="Input price" />
          <input type="number" min="0" step="0.01" value={f.price_out} onChange={set('price_out')} aria-label="Output price" />
        </span>
      </div>
      <p className="slot-usage">This month: {usd(initial.month_cost_usd) || '$0.00'}{initial.monthly_cap_usd !== null ? ` of ${usd(initial.monthly_cap_usd)}` : ''}</p>
      <div className="slot-actions">
        <button className="btn btn--primary btn--sm" disabled={busy} onClick={() => run('Save', async () => {
          await assistant(`/admin/providers/${slot}`, { method: 'PUT', body: { ...f, base_url: f.kind === 'anthropic' ? '' : f.base_url } });
          return 'Saved.';
        })}>Save settings</button>
        <button className="btn btn--sm" disabled={busy} onClick={() => run('Test', async () => {
          const r = await assistant(`/admin/providers/${slot}/test`, { method: 'POST', body: {} });
          return r.ok ? `Connected: ${r.model} answered in ${r.ms} ms.` : `Not connected: ${r.error}.`;
        })}>Test connection</button>
      </div>

      {f.kind !== 'ollama' && (
        <div className="keybox">
          <label htmlFor={id('key')}>API key</label>
          <p className="key-state">{initial.has_key ? `Set, ending in ${initial.key_hint}. It cannot be shown again.` : 'Not set.'}</p>
          <span className="pair">
            <input id={id('key')} type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={initial.has_key ? 'Replace the key' : 'Paste the key'} />
            <button className="btn btn--sm" disabled={busy || key.trim().length < 8} onClick={() => run('Saving the key', async () => {
              const r = await assistant(`/admin/providers/${slot}/key`, { method: 'PUT', body: { key } });
              setKey(''); return `Key saved, ending in ${r.key_hint}.`;
            })}>Save key</button>
            {initial.has_key && <button className="btn btn--sm" disabled={busy} onClick={() => run('Removing the key', async () => {
              await assistant(`/admin/providers/${slot}/key`, { method: 'DELETE' }); return 'Key removed.';
            })}>Remove</button>}
          </span>
        </div>
      )}
      {status && <p className="slot-status" role="status">{status}</p>}
    </section>
  );
}

export default function AdminPanel({ me, info }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => assistant('/admin/providers').then(setRows).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="admin">
      <h2>Settings</h2>
      <AdminUsers me={me} info={info} />
      <h2 className="admin-sub">Assistant</h2>
      <p className="admin-lead">Weft asks the primary first and falls back to the secondary when the primary has no key, reaches its monthly cap, times out or errors. It never re-asks a question the primary declined. Every answer shows which model wrote it.</p>
      {error ? <p role="alert" className="send-error">Settings could not load: {error}</p>
        : !rows ? <div className="skeleton" aria-label="Loading settings"><span /><span /><span /></div>
        : <div className="slots">{rows.map((r) => <Slot key={`${r.slot}-${r.updated_at}`} slot={r.slot} initial={r} onSaved={load} />)}</div>}
      <PersonalKeys />
      <WebSearch />
      <Agents />
    </div>
  );
}

// Whether people may bring their own model key. Admins see only how many have one, never whose.
function PersonalKeys() {
  const [s, setS] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { assistant('/admin/settings').then(setS).catch((e) => setError(e.message)); }, []);
  if (error) return <p className="send-error" role="alert">{error}</p>;
  if (!s) return null;
  return (
    <section className="slot users" aria-labelledby="pk-title">
      <header className="slot-head">
        <h3 id="pk-title">Personal keys</h3>
        <label className="toggle"><input type="checkbox" checked={s.allow_personal_keys}
          onChange={async (e) => {
            const on = e.target.checked; const was = s;
            setS({ ...s, allow_personal_keys: on });   // the switch moves at once; put back if saving fails
            try { setS(await assistant('/admin/settings', { method: 'PUT', body: { allow_personal_keys: on } })); } catch (err) { setS(was); setError(err.message); }
          }} /> Allow</label>
      </header>
      <p className="admin-lead">When allowed, each person can add their own Anthropic or OpenAI key from the menu on their initial. It answers only their own questions, before the models above, and is billed to them. Nobody else can see or use it, admins included. {s.personal_keys} {s.personal_keys === 1 ? 'person has' : 'people have'} a key saved.</p>
    </section>
  );
}

// Web search (074): lets the main model look things up on the web. Workspace-wide, off by default.
function WebSearch() {
  const [s, setS] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { assistant('/admin/settings').then(setS).catch((e) => setError(e.message)); }, []);
  if (error) return <p className="send-error" role="alert">{error}</p>;
  if (!s) return null;
  return (
    <section className="slot users" aria-labelledby="ws-title">
      <header className="slot-head">
        <h3 id="ws-title">Web search</h3>
        <label className="toggle"><input type="checkbox" checked={!!s.web_search}
          onChange={async (e) => {
            const on = e.target.checked; const was = s;
            setS({ ...s, web_search: on });   // the switch moves at once; put back if saving fails
            try { setS(await assistant('/admin/settings', { method: 'PUT', body: { web_search: on } })); } catch (err) { setS(was); setError(err.message); }
          }} /> Allow</label>
      </header>
      <p className="admin-lead">When allowed, Weft's main (Anthropic) model may search the web for facts that are not in Weft, such as a school district's calendar or opening hours, up to three searches a question, and links the pages it used under the answer. Searches run at Anthropic and cost about one cent each on top of the model, counted in the monthly cap. The local fallback model never searches.</p>
    </section>
  );
}

// Personal agents (067): someone's own AI agent (any OpenAI-compatible chat address, such as a Hermes
// Agent's API server). Only admins set the address; only the owner can talk to it.
const BLANK = { display_name: '', handle: '', owner_id: '', base_url: '', model: 'hermes-agent', enabled: true };
function Agents() {
  const [rows, setRows] = useState(null);
  const [people, setPeople] = useState([]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(() => assistant('/admin/agents').then(setRows).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); api('/rpc/admin_users').then((u) => setPeople(u.filter((x) => !x.disabled))).catch(() => {}); }, [load]);
  return (
    <>
      <h2 className="admin-sub">Personal agents</h2>
      <p className="admin-lead">Bring someone's own AI agent into Weft. It appears in their chat list, where they can start as many conversations with it as they like, and they can @mention it in channels they are in. Only its owner can talk to it. It sees only what is sent to it: the conversation, or in a channel that channel's recent messages.</p>
      {error && <p className="send-error" role="alert">Agents could not load: {error}</p>}
      {!rows ? (!error && <div className="skeleton" aria-label="Loading agents"><span /><span /></div>) : (
        <div className="slots">
          {rows.map((a) => <AgentForm key={`${a.id}-${a.updated_at}`} initial={a} people={people} onSaved={load} />)}
          {adding ? <AgentForm initial={BLANK} people={people} onSaved={() => { setAdding(false); load(); }} onCancel={() => setAdding(false)} />
            : <p><button className="btn btn--sm" type="button" onClick={() => setAdding(true)}>Add an agent</button></p>}
        </div>
      )}
    </>
  );
}

function AgentForm({ initial, people, onSaved, onCancel }) {
  const isNew = !initial.id;
  const [f, setF] = useState({ ...initial });
  const [key, setKey] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const id = (k) => `agent-${initial.id || 'new'}-${k}`;
  const run = async (label, fn, reload = true) => {
    setBusy(true); setStatus('');
    try { setStatus(await fn()); if (reload) onSaved(); } catch (e) { setStatus(`${label} failed: ${e.message}`); }
    setBusy(false);
  };
  const body = { display_name: f.display_name, handle: f.handle, owner_id: f.owner_id, base_url: f.base_url, model: f.model, enabled: f.enabled };
  return (
    <section className="slot" aria-labelledby={id('title')}>
      <header className="slot-head">
        <h3 id={id('title')}>{isNew ? 'New agent' : initial.display_name}</h3>
        {!isNew && <label className="toggle"><input type="checkbox" checked={f.enabled} onChange={set('enabled')} /> Enabled</label>}
      </header>
      <div className="fields">
        <label htmlFor={id('name')}>Name</label>
        <input id={id('name')} value={f.display_name} maxLength={60} onChange={set('display_name')} placeholder="Sam's Hermes" />
        <label htmlFor={id('handle')}>@name (for channels)</label>
        <input id={id('handle')} value={f.handle} maxLength={30} onChange={set('handle')} placeholder="hermes" />
        <label htmlFor={id('owner')}>Whose agent</label>
        <select id={id('owner')} value={f.owner_id} onChange={set('owner_id')}>
          <option value="">Choose a person</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.display_name}</option>)}
        </select>
        <label htmlFor={id('url')}>Address</label>
        <input id={id('url')} value={f.base_url} onChange={set('base_url')} placeholder="http://host:8642/v1" />
        <label htmlFor={id('model')}>Model</label>
        <input id={id('model')} value={f.model} onChange={set('model')} />
      </div>
      {!isNew && <p className="slot-usage">{initial.last_used_at ? `Last asked ${new Date(initial.last_used_at).toLocaleString()}.` : 'Not asked yet.'}{initial.last_error ? ` Last error: ${initial.last_error}.` : ''}</p>}
      <div className="slot-actions">
        <button className="btn btn--primary btn--sm" disabled={busy} onClick={() => run('Save', async () => {
          await assistant(isNew ? '/admin/agents' : `/admin/agents/${initial.id}`, { method: isNew ? 'POST' : 'PUT', body });
          return isNew ? 'Added. Now save its key.' : 'Saved.';
        })}>{isNew ? 'Add agent' : 'Save settings'}</button>
        {isNew && <button className="btn btn--sm" disabled={busy} onClick={onCancel}>Cancel</button>}
        {!isNew && <button className="btn btn--sm" disabled={busy} onClick={() => run('Test', async () => {
          const r = await assistant(`/admin/agents/${initial.id}/test`, { method: 'POST', body: {} });
          return !r.ok ? `Not connected: ${r.error}.` : r.has_model ? `Connected in ${r.ms} ms.` : `Connected, but it does not list the model "${f.model}" (it lists: ${r.models.join(', ') || 'none'}).`;
        }, false)}>Test connection</button>}
        {!isNew && <button className="btn btn--sm" disabled={busy} onClick={() => {
          if (window.confirm(`Remove ${initial.display_name}? ${initial.owner_name}'s conversations with it are deleted from Weft. Its replies in channels stay.`)) run('Remove', async () => { await assistant(`/admin/agents/${initial.id}`, { method: 'DELETE' }); return 'Removed.'; });
        }}>Remove</button>}
      </div>
      {!isNew && (
        <div className="keybox">
          <label htmlFor={id('key')}>Key</label>
          <p className="key-state">{initial.has_key ? `Set, ending in ${initial.key_hint}. It cannot be shown again.` : 'Not set. Most agents need one (for Hermes: its API server key).'}</p>
          <span className="pair">
            <input id={id('key')} type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={initial.has_key ? 'Replace the key' : 'Paste the key'} />
            <button className="btn btn--sm" disabled={busy || key.trim().length < 8} onClick={() => run('Saving the key', async () => {
              const r = await assistant(`/admin/agents/${initial.id}/key`, { method: 'PUT', body: { key } });
              setKey(''); return `Key saved, ending in ${r.key_hint}.`;
            })}>Save key</button>
            {initial.has_key && <button className="btn btn--sm" disabled={busy} onClick={() => run('Removing the key', async () => {
              await assistant(`/admin/agents/${initial.id}/key`, { method: 'DELETE' }); return 'Key removed.';
            })}>Remove</button>}
          </span>
        </div>
      )}
      {status && <p className="slot-status" role="status">{status}</p>}
    </section>
  );
}
