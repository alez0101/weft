import { useCallback, useEffect, useState } from 'react';
import { assistant } from './api.js';

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

export default function AdminPanel() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => assistant('/admin/providers').then(setRows).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="admin">
      <h2>Assistant settings</h2>
      <p className="admin-lead">Weft asks the primary first and falls back to the secondary when the primary has no key, reaches its monthly cap, times out or errors. It never re-asks a question the primary declined. Every answer shows which model wrote it.</p>
      {error ? <p role="alert" className="send-error">Settings could not load: {error}</p>
        : !rows ? <div className="skeleton" aria-label="Loading settings"><span /><span /><span /></div>
        : <div className="slots">{rows.map((r) => <Slot key={`${r.slot}-${r.updated_at}`} slot={r.slot} initial={r} onSaved={load} />)}</div>}
    </div>
  );
}
