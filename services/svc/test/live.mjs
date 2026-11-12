// Phase 3 live-channel suite. Runs inside the stack network (tests/run.sh starts it):
//   API  = PostgREST, AUTH = weft-svc test listener, LIVE = weft-svc test listener websocket.
// Checks that notices reach members only, carry no content, follow membership changes,
// and that bad or expired tokens cannot open a socket.
import WebSocket from 'ws';
import { SignJWT } from 'jose';

const API = process.env.API || 'http://postgrest:3000';
const AUTH = process.env.AUTH || 'http://svc:8081';
const LIVE = process.env.LIVE || 'ws://svc:8081/live';
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(email) {
  const r = await fetch(`${AUTH}/auth/test-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
  if (!r.ok) throw new Error(`login ${email}: ${r.status}`);
  return r.json();
}
async function api(token, path, { method = 'GET', body } = {}) {
  const r = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: body && JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, rows: text ? JSON.parse(text) : null };
}
function socket(token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${LIVE}?token=${encodeURIComponent(token)}`);
    const inbox = [];
    ws.on('message', (d) => inbox.push(JSON.parse(d)));
    ws.on('open', () => setTimeout(() => resolve({ ws, inbox, ok: true }), 200));
    ws.on('unexpected-response', (_req, res) => resolve({ ws, inbox, ok: false, status: res.statusCode }));
    ws.on('error', () => resolve({ ws, inbox, ok: false }));
  });
}
const got = (s, pred) => s.inbox.filter((n) => n.t !== 'hello' && pred(n));
const clear = (...ss) => ss.forEach((s) => { s.inbox.length = 0; });

const [alex, olive, vic, pat] = await Promise.all(
  ['alex.admin', 'olive.organizer', 'vic.volunteer', 'pat.public'].map((n) => login(`${n}@example.com`)));
const spaces = Object.fromEntries((await api(alex.token, '/spaces?select=id,name')).rows.map((s) => [s.name, s.id]));
const [sOlive, sVic, sPat] = await Promise.all([socket(olive.token), socket(vic.token), socket(pat.token)]);
check('Olive, Vic and Pat open live sockets', sOlive.ok && sVic.ok && sPat.ok);
check('Each socket says hello', [sOlive, sVic, sPat].every((s) => s.inbox.some((n) => n.t === 'hello')));

// Organizers: only members hear about it.
clear(sOlive, sVic, sPat);
const orgMsg = (await api(olive.token, '/messages', { method: 'POST', body: { space_id: spaces.organizers, body: 'live test: organizers only' } })).rows[0];
await sleep(1200);
check('Olive (organizer) is notified of an organizers message', got(sOlive, (n) => n.id === orgMsg.id).length === 1);
check('Pat is not notified of an organizers message', got(sPat, () => true).length === 0, JSON.stringify(sPat.inbox));
check('Vic is not notified of an organizers message', got(sVic, () => true).length === 0, JSON.stringify(sVic.inbox));
check('Pat cannot fetch that message even knowing its id', (await api(pat.token, `/messages?id=eq.${orgMsg.id}`)).rows.length === 0);

// Festival: everyone in it hears, and the notice carries no content.
clear(sOlive, sVic, sPat);
const festMsg = (await api(olive.token, '/messages', { method: 'POST', body: { space_id: spaces.festival, body: 'live test: festival' } })).rows[0];
await sleep(1200);
const patNotice = got(sPat, (n) => n.id === festMsg.id)[0];
check('Pat and Vic are notified of a festival message', patNotice && got(sVic, (n) => n.id === festMsg.id).length === 1);
check('A notice carries only table, op, id and space (no content)',
  patNotice && Object.keys(patNotice).sort().join(',') === 'id,op,space,t', JSON.stringify(patNotice));
check('Pat fetches the festival message through the API', (await api(pat.token, `/messages?id=eq.${festMsg.id}&select=body`)).rows[0]?.body === 'live test: festival');

// Membership changes take effect on the open socket, both ways.
clear(sPat);
const add = await api(alex.token, '/members', { method: 'POST', body: { space_id: spaces.volunteers, user_id: pat.user.id, role: 'viewer' } });
await sleep(1200);
check('Alex (owner) adds Pat to volunteers', add.status === 201, String(add.status));
check('Pat is told her memberships changed', got(sPat, (n) => n.t === 'members' && n.space === spaces.volunteers).length >= 1);
clear(sPat);
const volMsg = (await api(olive.token, '/messages', { method: 'POST', body: { space_id: spaces.volunteers, body: 'live test: volunteers, Pat in' } })).rows[0];
await sleep(1200);
check('Once added, Pat is notified of volunteers messages', got(sPat, (n) => n.id === volMsg.id).length === 1);
await api(alex.token, `/members?space_id=eq.${spaces.volunteers}&user_id=eq.${pat.user.id}`, { method: 'DELETE' });
await sleep(1200);
clear(sPat);
const volMsg2 = (await api(olive.token, '/messages', { method: 'POST', body: { space_id: spaces.volunteers, body: 'live test: volunteers, Pat out' } })).rows[0];
await sleep(1200);
check('After removal, Pat is no longer notified of volunteers messages', got(sPat, (n) => n.id === volMsg2.id).length === 0, JSON.stringify(sPat.inbox));
check('After removal, Pat cannot read volunteers messages', (await api(pat.token, `/messages?space_id=eq.${spaces.volunteers}`)).rows.length === 0);

// Calendar notices follow the same rule.
clear(sOlive, sVic, sPat);
const [ev] = (await api(olive.token, '/events', { method: 'POST', body: { space_id: spaces.organizers, title: 'live test: organizers meeting', starts_at: '2027-04-10T17:00:00Z', ends_at: '2027-04-10T18:00:00Z' } })).rows;
const [ev2] = (await api(olive.token, '/events', { method: 'POST', body: { space_id: spaces.festival, title: 'live test: festival walkthrough', starts_at: '2027-04-10T19:00:00Z', ends_at: '2027-04-10T20:00:00Z' } })).rows;
await sleep(1200);
check('An organizers event notifies Olive but not Pat or Vic', got(sOlive, (n) => n.id === ev.id).length === 1 && got(sPat, (n) => n.id === ev.id).length === 0 && got(sVic, (n) => n.id === ev.id).length === 0);
check('A festival event notifies Pat and Vic', got(sPat, (n) => n.id === ev2.id).length === 1 && got(sVic, (n) => n.id === ev2.id).length === 1);

// Bad tokens never get a socket.
const bad = await socket('not-a-token');
check('A garbage token cannot open a socket', !bad.ok, String(bad.status));
const forged = await new SignJWT({ role: 'weft_user' }).setProtectedHeader({ alg: 'HS256' }).setSubject(pat.user.id)
  .setExpirationTime('5m').sign(new TextEncoder().encode('not-the-secret'));
check('A token signed with the wrong secret cannot open a socket', !(await socket(forged)).ok);
const assistantLike = await new SignJWT({ role: 'weft_assistant' }).setProtectedHeader({ alg: 'HS256' }).setSubject(pat.user.id)
  .setExpirationTime('5m').sign(new TextEncoder().encode(process.env.JWT_SECRET));
check('Only user tokens open sockets (an assistant token is refused)', !(await socket(assistantLike)).ok);
const expired = await new SignJWT({ role: 'weft_user' }).setProtectedHeader({ alg: 'HS256' }).setSubject(pat.user.id)
  .setExpirationTime(Math.floor(Date.now() / 1000) - 60).sign(new TextEncoder().encode(process.env.JWT_SECRET));
check('An expired token cannot open a socket', !(await socket(expired)).ok);

[sOlive, sVic, sPat].forEach((s) => s.ws.close());
const w = Math.max(...results.map((r) => r.name.length));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(w)}  ${r.ok ? '' : r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
