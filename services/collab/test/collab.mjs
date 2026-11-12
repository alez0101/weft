// Phase 4 collab suite: real Hocuspocus clients against the collab server, inside the stack network.
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { ServerBlockNoteEditor } from '@blocknote/server-util';
import { getDocument } from '@blocknote/server-util/dom';
import * as Y from 'yjs';
import WebSocket from 'ws';

const API = 'http://postgrest:3000';
const AUTH = 'http://svc:8081';
const COLLAB = 'ws://collab:1234';
const FRAGMENT = 'document-store';
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const editor = ServerBlockNoteEditor.create(undefined, getDocument());

async function login(email) {
  const r = await fetch(`${AUTH}/auth/test-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
  return r.json();
}
async function api(token, path, { method = 'GET', body } = {}) {
  const r = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: body && JSON.stringify(body) });
  const t = await r.text(); return { status: r.status, rows: t ? JSON.parse(t) : null };
}

// Open a document; resolves once authenticated+synced or refused.
function open(token, name) {
  return new Promise((resolve) => {
    const doc = new Y.Doc();
    const out = { doc, scope: null, failed: null, closed: false };
    const socket = new HocuspocusProviderWebsocket({ url: COLLAB, WebSocketPolyfill: WebSocket, maxAttempts: 1 });
    const provider = new HocuspocusProvider({
      websocketProvider: socket, name, document: doc, token,
      onAuthenticated: ({ scope }) => { out.scope = scope; },
      onAuthenticationFailed: ({ reason }) => { out.failed = reason || 'refused'; resolve(out); },
      onSynced: () => resolve(out),
      onClose: () => { out.closed = true; },
    });
    if (typeof provider.attach === 'function') provider.attach();
    out.provider = provider; out.socket = socket;
    setTimeout(() => resolve(out), 5000);
  });
}
const close = (o) => { try { o.provider.destroy(); o.socket.destroy(); } catch { /* ignore */ } };
const text = (o) => o.doc.getXmlFragment(FRAGMENT).toString();
async function write(o, markdown) {
  // Append blocks made by the BlockNote server editor (same schema the browser uses).
  const blocks = await editor.tryParseMarkdownToBlocks(markdown);
  const tmp = editor.blocksToYDoc(blocks, FRAGMENT);
  const frag = o.doc.getXmlFragment(FRAGMENT);
  const src = tmp.getXmlFragment(FRAGMENT);
  // A BlockNote document is one blockGroup at the root holding blockContainers. Add the new blocks
  // inside the existing group, as the editor does; a second root group would be ignored on read.
  o.doc.transact(() => {
    const group = frag.length ? frag.get(0) : null;
    const incoming = src.get(0);
    if (!group) frag.insert(0, [incoming.clone()]);
    else group.insert(group.length, incoming.toArray().map((n) => n.clone()));
  });
}

const [alex, olive, vic, pat] = await Promise.all(['alex.admin', 'olive.organizer', 'vic.volunteer', 'pat.public'].map((n) => login(`${n}@example.com`)));
const items = Object.fromEntries((await api(alex.token, '/items?select=id,title')).rows.map((i) => [i.title, i.id]));
const spaces = Object.fromEntries((await api(alex.token, '/spaces?kind=eq.channel&select=id,name')).rows.map((s) => [s.name, s.id]));

// ---------------- who may open what
let o = await open(pat.token, items['Host contacts']);
check('Pat cannot open Host contacts (Organizers)', o.failed && !o.scope, `${o.failed} ${o.scope}`); close(o);
o = await open('not-a-token', items['Run of show']);
check('A bad token cannot open any document', o.failed && !o.scope, String(o.failed)); close(o);
o = await open(pat.token, '00000000-0000-4000-8000-000000000000');
check('A document id that does not exist is refused', o.failed, String(o.failed)); close(o);

const oliveRun = await open(olive.token, items['Run of show']);
check('Olive (editor) opens Run of show read-write', oliveRun.scope === 'read-write' && !oliveRun.failed, String(oliveRun.scope));
check('A seeded text-only document opens with its text as blocks', /info booth/i.test(text(oliveRun)), text(oliveRun).slice(0, 120));

// ---------------- viewers are read-only on the server, not just in the UI
const before = (await api(olive.token, `/items?id=eq.${items['Run of show']}&select=body_text`)).rows[0].body_text;
const vicRun = await open(vic.token, items['Run of show']);
check('Vic (viewer in #festival) opens Run of show read-only', vicRun.scope === 'readonly', String(vicRun.scope));
await write(vicRun, 'VIC-WAS-HERE-9001');
await sleep(4000);
check("Vic's edit never reaches Olive", !text(oliveRun).includes('VIC-WAS-HERE-9001'));
const after = (await api(olive.token, `/items?id=eq.${items['Run of show']}&select=body_text`)).rows[0].body_text;
check("Vic's edit is not saved", after === before && !String(after).includes('VIC-WAS-HERE'));
close(vicRun); close(oliveRun);

// ---------------- live co-editing and saving
const [created] = (await api(olive.token, '/items', { method: 'POST', body: { space_id: spaces.festival, kind: 'document', title: 'Collab test' } })).rows;
const a = await open(alex.token, created.id);
const b = await open(olive.token, created.id);
check('Two editors open the same new document', a.scope === 'read-write' && b.scope === 'read-write');
const t0 = Date.now();
await write(a, 'COLLAB-MARK-4412 written by Alex');
for (let i = 0; i < 40 && !text(b).includes('COLLAB-MARK-4412'); i++) await sleep(50);
check("Alex's text reaches Olive live", text(b).includes('COLLAB-MARK-4412'), `${Date.now() - t0} ms`);
console.log(`   (live sync took ${Date.now() - t0} ms)`);
await write(b, 'Second line from Olive');
// Saves wait for 2 s of quiet and happen at least every 10 s: poll up to 12 s.
let saved = ''; const ts = Date.now();
for (let i = 0; i < 48; i++) {
  saved = (await api(pat.token, `/items?id=eq.${created.id}&select=body_text`)).rows[0]?.body_text || '';
  if (saved.includes('Second line from Olive')) break;
  await sleep(250);
}
console.log(`   (save landed after ${Date.now() - ts} ms)`);
check('The text is saved to the database and readable by Pat through the API', saved.includes('COLLAB-MARK-4412') && saved.includes('Second line from Olive'), saved.slice(0, 160));
const searched = (await api(pat.token, `/items?body_text=fts.collab-mark-4412&select=id`)).rows;
check('The saved text is searchable', searched.length === 1, JSON.stringify(searched));
const patView = await open(pat.token, created.id);
check('Pat (viewer) opens it read-only and sees both edits', patView.scope === 'readonly' && text(patView).includes('Second line from Olive'));
close(patView); close(a); close(b);
const audit = (await api(olive.token, `/audit?row_id=eq.${created.id}&select=old_row`)).rows;
check('Live saves do not flood the audit log, and audit rows carry no Yjs state', audit.length <= 2 && audit.every((r) => !('ydoc' in r.old_row)), `${audit.length} rows`);

// ---------------- losing access closes the session
await api(alex.token, '/members', { method: 'POST', body: { space_id: spaces.volunteers, user_id: pat.user.id, role: 'viewer' } });
const patVol = await open(pat.token, items['Volunteer roles']);
check('Added to #volunteers, Pat can open Volunteer roles', patVol.scope === 'readonly', String(patVol.scope));
await api(alex.token, `/members?space_id=eq.${spaces.volunteers}&user_id=eq.${pat.user.id}`, { method: 'DELETE' });
for (let i = 0; i < 60 && !patVol.closed; i++) await sleep(50);
check('Removed from #volunteers, her open session is closed', patVol.closed);
close(patVol);
const again = await open(pat.token, items['Volunteer roles']);
check('And she cannot reopen it', again.failed && !again.scope, `${again.failed} ${again.scope}`); close(again);

const w = Math.max(...results.map((x) => x.name.length));
for (const x of results) console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name.padEnd(w)}  ${x.ok ? '' : x.detail}`);
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
