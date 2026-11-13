// Your own model key: used only for your questions, before the workspace's models. Write-only: the screen
// shows its last four characters, never the key. Only Anthropic and OpenAI, at their official addresses.
import { useEffect, useRef, useState } from 'react';
import { assistant } from './api.js';

const usd = (n) => `$${Number(n || 0).toFixed(2)}`;

export default function ModelKey({ onClose }) {
  const ref = useRef(null);
  const [data, setData] = useState(null);
  const [f, setF] = useState({ kind: 'anthropic', model: 'claude-opus-5-5', effort: 'low', enabled: true, monthly_cap_usd: '', price_in: '', price_out: '' });
  const [key, setKey] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async () => {
    const d = await assistant('/me/provider'); setData(d);
    if (d.provider) setF({ kind: d.provider.kind, model: d.provider.model, effort: d.provider.effort || 'low', enabled: d.provider.enabled,
      monthly_cap_usd: d.provider.monthly_cap_usd ?? '', price_in: d.provider.price_in ?? '', price_out: d.provider.price_out ?? '' });
  };
  useEffect(() => { load().catch((e) => setStatus(e.message)); ref.current?.showModal(); }, []);
  const run = async (fn) => { setBusy(true); setStatus(''); try { setStatus(await fn()); await load(); } catch (e) { setStatus(e.message); } setBusy(false); };
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const p = data?.provider;

  return (
    <dialog ref={ref} className="people" aria-labelledby="mk-title" onClose={onClose}>
      <header className="people-head">
        <h2 id="mk-title">Your model key</h2>
        <button className="icon-btn" type="button" aria-label="Close" onClick={() => ref.current.close()}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg>
        </button>
      </header>
      {!data ? (status ? <p className="send-error" role="alert">{status}</p> : <div className="skeleton" aria-label="Loading"><span /><span /></div>) : (<>
        <p className="admin-lead">Use your own Anthropic or OpenAI key for your questions to Weft. It answers your questions first, in your Weft conversation and when you @Weft in a channel; if it fails, Weft's own models answer. Nobody else can see or use your key, admins included.</p>
        {!data.allowed && <p className="slot-status" role="status">Your admin has not turned on personal keys.{p ? ' Your saved key is kept but not used.' : ''}</p>}
        {data.allowed && (
          <form className="fields" onSubmit={(e) => { e.preventDefault(); run(async () => { await assistant('/me/provider', { method: 'PUT', body: f }); return 'Saved.'; }); }}>
            <label htmlFor="mk-kind">Provider</label>
            <select id="mk-kind" value={f.kind} onChange={(e) => setF((x) => ({ ...x, kind: e.target.value, model: e.target.value === 'anthropic' ? 'claude-opus-5-5' : x.model }))}>
              <option value="anthropic">Anthropic</option><option value="openai">OpenAI</option>
            </select>
            <label htmlFor="mk-model">Model</label>
            <input id="mk-model" value={f.model} onChange={set('model')} required />
            {f.kind === 'anthropic' && (<><label htmlFor="mk-effort">Effort</label>
              <select id="mk-effort" value={f.effort} onChange={set('effort')}>{['low', 'medium', 'high', 'xhigh', 'max'].map((x) => <option key={x}>{x}</option>)}</select></>)}
            <label htmlFor="mk-cap">Your monthly cap (USD)</label>
            <input id="mk-cap" type="number" min="0" step="0.5" value={f.monthly_cap_usd} onChange={set('monthly_cap_usd')} placeholder="No cap" />
            <label htmlFor="mk-pin">Price per million tokens, in / out</label>
            <span className="pair">
              <input id="mk-pin" type="number" min="0" step="0.01" value={f.price_in} onChange={set('price_in')} aria-label="Input price" placeholder="0" />
              <input type="number" min="0" step="0.01" value={f.price_out} onChange={set('price_out')} aria-label="Output price" placeholder="0" />
            </span>
            <label className="toggle"><input type="checkbox" checked={f.enabled} onChange={set('enabled')} /> Use my key</label>
            <span><button className="btn btn--primary btn--sm" type="submit" disabled={busy}>Save</button></span>
          </form>
        )}
        {data.allowed && p && (
          <div className="keybox">
            <label htmlFor="mk-key">API key</label>
            <p className="key-state">{p.has_key ? `Set, ending in ${p.key_hint}. It cannot be shown again.` : 'Not set.'}</p>
            <span className="pair">
              <input id="mk-key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={p.has_key ? 'Replace the key' : 'Paste your key'} />
              <button className="btn btn--sm" type="button" disabled={busy || key.trim().length < 8} onClick={() => run(async () => {
                const r = await assistant('/me/provider/key', { method: 'PUT', body: { key } }); setKey(''); return `Key saved, ending in ${r.key_hint}.`;
              })}>Save key</button>
              <button className="btn btn--sm" type="button" disabled={busy || !p.has_key} onClick={() => run(async () => {
                const r = await assistant('/me/provider/test', { method: 'POST', body: {} }); return r.ok ? `Connected: ${r.model} answered in ${r.ms} ms.` : `Not connected: ${r.error}.`;
              })}>Test connection</button>
            </span>
            <p className="slot-usage">This month on your key: {usd(p.month_cost_usd)}{p.monthly_cap_usd !== null ? ` of ${usd(p.monthly_cap_usd)}` : ''}{Number(p.price_in) + Number(p.price_out) === 0 ? ' (add prices to track spending)' : ''}</p>
          </div>
        )}
        {status && <p className="slot-status" role="status">{status}</p>}
        {p && (
          <footer className="people-foot">
            <button className="btn btn--sm btn--danger" type="button"
              onClick={() => window.confirm('Take off your key and settings? Weft will answer with its own models.') && run(async () => { await assistant('/me/provider', { method: 'DELETE' }); return 'Your key is gone.'; })}>Take off my key</button>
          </footer>
        )}
      </>)}
    </dialog>
  );
}
