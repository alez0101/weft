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

// ---------------- a disabled account loses its open sessions
const vicOpen = await open(vic.token, items['Run of show']);
await api(alex.token, '/rpc/admin_set_user', { method: 'POST', body: { p_user: vic.user.id, p_disabled: true } });
for (let i = 0; i < 60 && !vicOpen.closed; i++) await sleep(50);
check('Disabling Vic closes his open document session', vicOpen.closed); close(vicOpen);
const vicAgain = await open(vic.token, items['Run of show']);
check('And his unexpired token cannot reopen it', vicAgain.failed && !vicAgain.scope, `${vicAgain.failed} ${vicAgain.scope}`); close(vicAgain);
await api(alex.token, '/rpc/admin_set_user', { method: 'POST', body: { p_user: vic.user.id, p_disabled: false } });

// ---------------- files and tables are not documents
const [fileItem] = (await api(olive.token, '/items', { method: 'POST', body: { space_id: spaces.festival, kind: 'file', title: 'notes.txt', body_text: 'FILE-TEXT-ONLY' } })).rows;
const fo = await open(olive.token, fileItem.id);
check('The collab server refuses to open a file as a document (its text changes only by upload)', fo.failed && !fo.scope, `${fo.failed} ${fo.scope}`); close(fo);
const [listItem] = (await api(olive.token, '/items', { method: 'POST', body: { space_id: spaces.festival, kind: 'tasklist', title: 'Collab task list' } })).rows;
const lo = await open(olive.token, listItem.id);
check('Nor a task list (its text is its tasks)', lo.failed && !lo.scope, `${lo.failed} ${lo.scope}`); close(lo);
const [pollItem] = (await api(olive.token, '/items', { method: 'POST', body: { space_id: spaces.festival, kind: 'poll', title: 'Collab poll' } })).rows;
const po = await open(olive.token, pollItem.id);
check('Nor a poll (its text is its votes)', po.failed && !po.scope, `${po.failed} ${po.scope}`); close(po);
const [formItem] = (await api(olive.token, '/items', { method: 'POST', body: { space_id: spaces.festival, kind: 'form', title: 'Collab form' } })).rows;
const fm = await open(olive.token, formItem.id);
check('Nor a form (its text is its questions)', fm.failed && !fm.scope, `${fm.failed} ${fm.scope}`); close(fm);

// ---------------- moving or deleting a document closes its sessions
const [mv] = (await api(olive.token, '/items', { method: 'POST', body: { space_id: spaces.festival, kind: 'document', title: 'Move test' } })).rows;
const patMv = await open(pat.token, mv.id);
check('Pat opens a #festival document', patMv.scope === 'readonly', String(patMv.scope));
await api(olive.token, `/items?id=eq.${mv.id}`, { method: 'PATCH', body: { space_id: spaces.organizers } });
for (let i = 0; i < 60 && !patMv.closed; i++) await sleep(50);
check('Moved into #organizers, Pat\'s open session is closed', patMv.closed); close(patMv);
const patMv2 = await open(pat.token, mv.id);
check('And she cannot reopen it', patMv2.failed && !patMv2.scope); close(patMv2);
const oliveMv = await open(olive.token, mv.id);
check('Olive (in both spaces) reopens it after the move', oliveMv.scope === 'read-write');
await api(olive.token, `/items?id=eq.${mv.id}`, { method: 'DELETE' });
for (let i = 0; i < 60 && !oliveMv.closed; i++) await sleep(50);
check('Deleted, the open session is closed', oliveMv.closed); close(oliveMv);
const gone = await open(olive.token, mv.id);
check('A deleted document cannot be reopened', gone.failed && !gone.scope); close(gone);

// ---------------- whiteboards (version 1.5)
const el = (id, extra = {}) => ({ id, type: 'rectangle', x: 10, y: 10, width: 100, height: 60, version: 1, versionNonce: 1, isDeleted: false, index: 'a0', ...extra });
const [wb] = (await api(olive.token, '/items', { method: 'POST', body: { space_id: spaces.festival, kind: 'whiteboard', title: 'Board test' } })).rows;
const wa = await open(alex.token, wb.id); const wo = await open(olive.token, wb.id);
check('Whiteboard: two editors open a new board read-write', wa.scope === 'read-write' && wo.scope === 'read-write');
const tw = Date.now();
wa.doc.transact(() => { wa.doc.getMap('elements').set('r1', el('r1')); });
for (let i = 0; i < 40 && !wo.doc.getMap('elements').get('r1'); i++) await sleep(50);
check("Whiteboard: Alex's rectangle reaches Olive live", !!wo.doc.getMap('elements').get('r1'), `${Date.now() - tw} ms`);
wo.doc.transact(() => { wo.doc.getMap('elements').set('t1', el('t1', { type: 'text', text: 'BOARD-MARK-7781 porch map', x: 0, y: 200, index: 'a1' })); });
const wv = await open(vic.token, wb.id);
check('Whiteboard: Vic (viewer) opens it read-only and sees both elements', wv.scope === 'readonly' && wv.doc.getMap('elements').size === 2);
wv.doc.transact(() => { wv.doc.getMap('elements').set('v1', el('v1', { x: 500 })); });
await sleep(1500);
check("Whiteboard: Vic's drawing never reaches the editors", !wa.doc.getMap('elements').get('v1') && !wo.doc.getMap('elements').get('v1'));
let bsaved = ''; for (let i = 0; i < 48; i++) { bsaved = (await api(pat.token, `/items?id=eq.${wb.id}&select=body_text`)).rows[0]?.body_text || ''; if (bsaved.includes('BOARD-MARK')) break; await sleep(250); }
check('Whiteboard: text on the board is saved for search and the assistant', bsaved.includes('BOARD-MARK-7781') && (await api(pat.token, '/items?body_text=fts.board-mark-7781&select=id')).rows.length === 1, bsaved);
close(wa); close(wo); close(wv);
await api(olive.token, `/items?id=eq.${wb.id}`, { method: 'PATCH', body: { space_id: spaces.organizers } });
const wp = await open(pat.token, wb.id);
check('Whiteboard: once it is in #organizers, Pat cannot open it', wp.failed && !wp.scope); close(wp);

const w = Math.max(...results.map((x) => x.name.length));
for (const x of results) console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name.padEnd(w)}  ${x.ok ? '' : x.detail}`);
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
