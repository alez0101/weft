// Talks to the three things behind nginx: /auth (sign-in), /api (PostgREST), /live (websocket).
// The Weft token lives in memory only and is refreshed before it expires.

let token = null;
let refreshTimer = null;
let reauth = null; // () => Promise<session>, set by signIn

export async function authMode() {
  const r = await fetch('/auth/mode');
  if (!r.ok) throw new Error('sign-in service unavailable');
  return (await r.json()).mode;
}

async function accessSession() {
  const r = await fetch('/auth/session', { credentials: 'same-origin' });
  if (!r.ok) throw new Error(r.status === 401 ? 'Your Cloudflare Access session was not accepted.' : 'Sign-in failed.');
  return r.json();
}

async function testSession(email) {
  const r = await fetch('/auth/test-login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
  });
  if (!r.ok) throw new Error('Test sign-in refused.');
  return r.json();
}

function schedule(session) {
  token = session.token;
  clearTimeout(refreshTimer);
  const ms = Math.max(30, session.expires_in - 60) * 1000;
  refreshTimer = setTimeout(() => reauth().then(schedule).catch(() => { token = null; }), ms);
  return session;
}

export async function signIn(mode, email) {
  reauth = mode === 'test' ? () => testSession(email) : accessSession;
  return schedule(await reauth());
}

export const currentToken = () => token;

export async function api(path, { method = 'GET', body, prefer } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (r.status === 401 && reauth) { // token expired between refreshes: renew once and retry
    schedule(await reauth());
    return api(path, { method, body, prefer });
  }
  if (!r.ok) {
    let msg = `${r.status}`;
    try { msg = (await r.json()).message || msg; } catch { /* keep status */ }
    throw new Error(msg);
  }
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

// Live notices. Reconnects with a fresh token; the server closes sockets whose token expired.
export function connectLive(onNotice, onState) {
  let ws; let stopped = false; let delay = 1000;
  const open = () => {
    if (stopped) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/live?token=${encodeURIComponent(token)}`);
    ws.onopen = () => { delay = 1000; onState('live'); };
    ws.onmessage = (e) => { try { onNotice(JSON.parse(e.data)); } catch { /* ignore */ } };
    ws.onclose = () => {
      onState('reconnecting');
      if (!stopped) setTimeout(open, delay);
      delay = Math.min(delay * 2, 15000);
    };
  };
  open();
  return () => { stopped = true; ws?.close(); };
}
