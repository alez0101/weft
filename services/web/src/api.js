// Talks to the three things behind nginx: /auth (sign-in), /api (PostgREST), /live (websocket).
// The Weft token lives in memory only and is refreshed before it expires.

let token = null;
let refreshTimer = null;
let reauth = null; // () => Promise<session>, set by signIn

export async function authMode() {
  const r = await fetch('/auth/mode');
  if (!r.ok) throw new Error('sign-in service unavailable');
  return r.json(); // { mode: 'public' | 'test', methods: ['password', 'cloudflare'] | ['test'] }
}

const errorOf = async (r, fallback) => { try { return (await r.json()).error || fallback; } catch { return fallback; } };
const post = (path, body) => fetch(path, {
  method: 'POST', credentials: 'same-origin',
  headers: { 'Content-Type': 'application/json', 'X-Weft-Request': '1' }, body: JSON.stringify(body || {}),
});

async function accessSession() {
  const r = await fetch('/auth/session', { credentials: 'same-origin' });
  if (!r.ok) throw new Error(r.status === 401 ? 'Your Cloudflare Access session was not accepted.' : 'Sign-in failed.');
  return r.json();
}
async function testSession(email) {
  const r = await post('/auth/test-login', { email });
  if (!r.ok) throw new Error(await errorOf(r, 'Test sign-in refused.'));
  return r.json();
}
// Weft accounts: the session secret lives in an HttpOnly cookie; this trades it for a fresh token.
async function refreshSession() {
  const r = await post('/auth/refresh');
  if (!r.ok) throw Object.assign(new Error('Your session has ended. Sign in again.'), { status: r.status });
  return r.json();
}
async function passwordSession({ email, password }) {
  const r = await post('/auth/login', { email, password });
  if (!r.ok) throw new Error(await errorOf(r, 'Sign-in failed.'));
  return r.json();
}
async function linkSession({ token, password, name }) {
  const r = await post(`/auth/link/${encodeURIComponent(token)}`, { password, name });
  if (!r.ok) throw new Error(await errorOf(r, 'That did not work.'));
  return r.json();
}

function schedule(session) {
  token = session.token;
  clearTimeout(refreshTimer);
  const ms = Math.max(30, session.expires_in - 60) * 1000;
  refreshTimer = setTimeout(() => reauth().then(schedule).catch(() => { token = null; }), ms);
  return session;
}

// kind: 'test' (arg: email), 'cloudflare', 'password' (arg: {email, password}), 'resume' (the cookie),
// 'link' (arg: {token, password, name}).
export async function signIn(kind, arg) {
  if (kind === 'test') reauth = () => testSession(arg);
  else if (kind === 'cloudflare') reauth = accessSession;
  else reauth = refreshSession;
  const first = kind === 'password' ? () => passwordSession(arg) : kind === 'link' ? () => linkSession(arg) : reauth;
  return schedule(await first());
}

export async function signOut() {
  clearTimeout(refreshTimer); token = null; reauth = null;
  await post('/auth/logout').catch(() => {});
}

export async function peekLink(linkToken) {
  const r = await fetch(`/auth/link/${encodeURIComponent(linkToken)}`);
  if (!r.ok) throw new Error(await errorOf(r, 'This link does not work.'));
  return r.json();
}

// Signed-in calls to the sign-in service (password change, admin links).
export async function auth(path, { method = 'GET', body } = {}) {
  const r = await fetch(`/auth${path}`, {
    method, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body),
    headers: { Authorization: `Bearer ${token}`, 'X-Weft-Request': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
  });
  let data = null;
  try { data = await r.json(); } catch { /* empty */ }
  if (!r.ok) throw new Error(data?.error || `${r.status}`);
  return data;
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
    ws.onclose = (e) => {
      if (e.code === 4003) { stopped = true; onState('disabled'); return; } // an admin disabled this account
      onState('reconnecting');
      if (!stopped) setTimeout(open, delay);
      delay = Math.min(delay * 2, 15000);
    };
  };
  open();
  return () => { stopped = true; ws?.close(); };
}

// The assistant service (asks and admin settings). Same token, same renewal.
export async function assistant(path, { method = 'GET', body } = {}) {
  const r = await fetch(`/assistant${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
  });
  if (r.status === 401 && reauth) { schedule(await reauth()); return assistant(path, { method, body }); }
  let data = null;
  try { data = await r.json(); } catch { /* empty */ }
  if (!r.ok) throw new Error(data?.error || `${r.status}`);
  return data;
}

// The connector's OAuth endpoints that the app itself calls: the consent screen and your connected apps.
export async function oauth(path, { method = 'GET', body } = {}) {
  const r = await fetch(`/oauth${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { Authorization: `Bearer ${token}`, 'X-Weft-Request': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
  });
  if (r.status === 401 && reauth) { schedule(await reauth()); return oauth(path, { method, body }); }
  let data = null;
  try { data = await r.json(); } catch { /* empty */ }
  if (!r.ok) throw new Error(data?.error || `${r.status}`);
  return data;
}

// Files: uploads and downloads go to the files service with the same token (it acts as you, so the
// database decides). Downloads come back as a Blob, shown or saved from a blob: address in the page.
export async function uploadFile(spaceId, file) {
  const r = await fetch(`/files?space=${encodeURIComponent(spaceId)}&name=${encodeURIComponent(file.name)}`, {
    method: 'POST', body: file, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
  });
  let data = null;
  try { data = await r.json(); } catch { /* empty */ }
  if (!r.ok) throw new Error(data?.error || (r.status === 413 ? 'That file is too large.' : `${r.status}`));
  return data;
}
export async function fetchFile(id, download = false) {
  const r = await fetch(`/files/${id}${download ? '?download=1' : ''}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(r.status === 404 ? 'No such file, or you cannot see it.' : `${r.status}`);
  return r.blob();
}
