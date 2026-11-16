// How to plug a Weft key into an AI agent (076): ready-to-paste setup for common MCP clients, and a plain JSON
// block for any other. Shown once, next to the key, wherever a key is made.
import { useState } from 'react';

const RECIPES = [
  { id: 'claude', label: 'Claude Code', note: 'Run this in a terminal.',
    text: (url, key) => `claude mcp add --transport http weft ${url} --header "Authorization: Bearer ${key}"` },
  { id: 'hermes', label: 'Hermes Agent', note: 'Add this to config.yaml in the Hermes data folder, then restart Hermes.',
    text: (url, key) => `mcp_servers:\n  weft:\n    url: "${url}"\n    headers:\n      Authorization: "Bearer ${key}"` },
  { id: 'openclaw', label: 'OpenClaw', note: 'Run these on the OpenClaw host; no restart needed.',
    text: (url, key) => `openclaw mcp add weft --url ${url} --header "Authorization=Bearer ${key}"\nopenclaw mcp reload` },
  { id: 'other', label: 'Other', note: 'Most MCP clients take a block like this (Streamable HTTP, with the key as a Bearer token).',
    text: (url, key) => JSON.stringify({ mcpServers: { weft: { type: 'http', url, headers: { Authorization: `Bearer ${key}` } } } }, null, 2) },
];

export default function AgentSetup({ url, token }) {
  const [tab, setTab] = useState('claude');
  const [copied, setCopied] = useState('');
  const r = RECIPES.find((x) => x.id === tab);
  const text = r.text(url, token);
  const copy = async (what, value) => {
    try { await navigator.clipboard.writeText(value); setCopied(what); setTimeout(() => setCopied(''), 2000); } catch { setCopied(''); }
  };
  return (
    <div className="agent-setup">
      <p className="key-state"><b>Copy this now: the key is not shown again.</b></p>
      <dl className="agent-setup-pair">
        <dt>Address</dt><dd><code>{url}</code> <button className="btn btn--sm" type="button" onClick={() => copy('url', url)}>{copied === 'url' ? 'Copied' : 'Copy'}</button></dd>
        <dt>Key</dt><dd><code className="agent-setup-key">{token}</code> <button className="btn btn--sm" type="button" onClick={() => copy('key', token)}>{copied === 'key' ? 'Copied' : 'Copy'}</button></dd>
      </dl>
      <div className="agent-setup-tabs" role="group" aria-label="Set up in">
        {RECIPES.map((x) => (
          <button key={x.id} type="button" aria-pressed={tab === x.id} className={`btn btn--sm${tab === x.id ? ' btn--primary' : ''}`} onClick={() => setTab(x.id)}>{x.label}</button>
        ))}
      </div>
      <p className="admin-lead">{r.note}</p>
      <pre className="agent-setup-code"><code>{text}</code></pre>
      <button className="btn btn--sm" type="button" onClick={() => copy('recipe', text)}>{copied === 'recipe' ? 'Copied' : 'Copy setup'}</button>
    </div>
  );
}
