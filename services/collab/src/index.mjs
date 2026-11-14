// weft-collab: live co-editing of documents and wiki pages (Hocuspocus + Yjs).
//
// A document's name is its item id. Every connection carries the person's Weft token. Loads and
// saves run inside a transaction that switches to weft_user with that person's claims, so
// row-level security decides who may open, and who may change, each document:
//   not a member of its space -> the connection is refused
//   viewer                    -> read-only (the server ignores their edits)
//   editor or owner           -> read-write
// Plain text is extracted on every save (BlockNote -> Markdown) for search and the assistant.
// When someone is removed from a space, their open sessions on its documents are closed.
//
// :1235 (inside the Compose network only; nginx never routes to it) takes edits from the connector
// (services/mcp): POST /edit {token, id, mode: append|replace, markdown}. The edit runs as the person in
// the token, through a server-side connection to the live document, so anyone with it open sees the
// change at once and it is saved like any other edit (and refused if they cannot edit).
import http from 'node:http';
import { Server } from '@hocuspocus/server';
import { ServerBlockNoteEditor } from '@blocknote/server-util';
import { getDocument } from '@blocknote/server-util/dom';
import * as Y from 'yjs';
import pg from 'pg';
import { jwtVerify } from 'jose';

const env = (k, d) => { const v = process.env[k] ?? d; if (v === undefined) throw new Error(`missing ${k}`); return v; };
const JWT_SECRET = new TextEncoder().encode(env('JWT_SECRET'));
const FRAGMENT = 'document-store';
const pool = new pg.Pool({ connectionString: env('DATABASE_URL_COLLAB'), max: 6 });
const editor = ServerBlockNoteEditor.create(undefined, getDocument()); // jsdom: the server has no browser DOM
const log = (...a) => console.log(new Date().toISOString(), ...a);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Run fn(client) as the given person, under row-level security.
async function asUser(userId, fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('set local role weft_user');
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: 'weft_user', sub: userId })]);
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally { c.release(); }
}

// Text on a whiteboard: every live text element, in reading order (top to bottom, left to right).
function boardText(ydoc) {
  const els = [...ydoc.getMap('elements').values()].filter((e) => e && e.type === 'text' && !e.isDeleted && e.text);
  els.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  return els.map((e) => e.text.trim()).filter(Boolean).join('\n');
}

async function textOf(ydoc) {
  try { return (await editor.blocksToMarkdownLossy(editor.yDocToBlocks(ydoc, FRAGMENT))).trim(); } catch (e) { log('text extract failed', e.message); return null; }
}

const server = new Server({
  port: 1234,
  debounce: 2000,
  maxDebounce: 10000,
  quiet: true,

  async onAuthenticate({ token, documentName, connectionConfig }) {
    if (!UUID.test(documentName)) throw new Error('bad document');
    let claims;
    try { ({ payload: claims } = await jwtVerify(token, JWT_SECRET, { algorithms: ['HS256'] })); } catch { throw new Error('not signed in'); }
    if (claims.role !== 'weft_user' || !claims.sub) throw new Error('not a user token');
    const row = await asUser(claims.sub, async (c) => (await c.query(
      'select space_id, kind, managed, weft_private.can_edit(space_id) as can_edit from weft.items where id = $1', [documentName])).rows[0]);
    if (!row) throw new Error('no access'); // RLS: not a member of the document's space, or no such document
    if (!['document', 'wiki', 'whiteboard'].includes(row.kind)) throw new Error('not an editable document'); // files and tables have their own paths
    connectionConfig.readOnly = !row.can_edit || row.managed; // managed pages change only by publishing from the repo
    return { user: claims.sub, space: row.space_id, exp: claims.exp, doc: documentName, kind: row.kind };
  },

  async onLoadDocument({ document, documentName, context }) {
    const row = await asUser(context.user, async (c) => (await c.query(
      'select ydoc, body_text, kind from weft.items where id = $1', [documentName])).rows[0]);
    if (!row) throw new Error('no access');
    if (row.ydoc) {
      Y.applyUpdate(document, new Uint8Array(row.ydoc));
    } else if (row.kind === 'whiteboard') {
      document.getMap('elements'); // an empty board; nothing to seed
    } else {
      // No Yjs state yet. Build the starting blocks here, never in a browser: if two browsers each
      // created an empty starting block before syncing, the document would get two root block groups
      // and each browser would render a different one. Text-only documents (seeded, or written by the
      // API) become blocks; brand-new ones get a single empty paragraph.
      const blocks = row.body_text ? await editor.tryParseMarkdownToBlocks(row.body_text) : [{ type: 'paragraph' }];
      Y.applyUpdate(document, Y.encodeStateAsUpdate(editor.blocksToYDoc(blocks, FRAGMENT)));
    }
    return document;
  },

  async onStoreDocument({ document, documentName, lastContext }) {
    if (process.env.COLLAB_DEBUG) log('onStore', documentName.slice(0, 8), 'lastContext', JSON.stringify(lastContext || null).slice(0, 80));
    if (!lastContext?.user) return; // nobody edited (e.g. only loaded)
    const state = Buffer.from(Y.encodeStateAsUpdate(document));
    const text = lastContext.kind === 'whiteboard' ? boardText(document) : await textOf(document);
    // Saved as the last person who changed it; RLS refuses the write if they cannot edit.
    const n = await asUser(lastContext.user, async (c) => (await c.query(
      'update weft.items set ydoc = $2, body_text = coalesce($3, body_text) where id = $1', [documentName, state, text])).rowCount);
    if (n !== 1) log('store refused for', documentName);
    if (process.env.COLLAB_DEBUG) log('stored', documentName.slice(0, 8), 'by', lastContext.user.slice(0, 8), 'rows', n, 'text', JSON.stringify((text || '').slice(0, 80)));
  },
});

// Close sessions whose person lost access (removed from the space) or whose token expired.
function closeWhere(pred, reason) {
  for (const doc of server.hocuspocus.documents.values()) {
    for (const conn of doc.getConnections()) {
      if (pred(conn.context || {})) { log('closing session:', reason); conn.close({ code: 4403, reason }); }
    }
  }
}
setInterval(() => { const now = Date.now() / 1000; closeWhere((c) => c.exp && c.exp < now, 'token expired'); }, 15000).unref();

async function listen() {
  const client = new pg.Client({ connectionString: env('DATABASE_URL_COLLAB') });
  client.on('error', (e) => log('listen error', e.message));
  client.on('end', () => setTimeout(listen, 2000));
  client.on('notification', (m) => {
    let n; try { n = JSON.parse(m.payload); } catch { return; }
    if (n.t === 'members' && n.op === 'DELETE') closeWhere((c) => c.user === n.user && c.space === n.space, 'removed from the space');
    // A document deleted, or moved to another space: everyone reconnects and is re-checked against the new space.
    if (n.t === 'doc_reset') closeWhere((c) => c.doc === n.id, 'page republished; reconnect');
    if (n.t === 'account' && n.disabled) closeWhere((c) => c.user === n.user, 'account disabled');
    if (n.t === 'items' && n.op === 'DELETE') closeWhere((c) => c.doc === n.id, 'document deleted');
    if (n.t === 'items' && n.op === 'UPDATE') closeWhere((c) => c.doc === n.id && c.space !== n.space, 'document moved to another space');
    if (n.t === 'members' && n.op === 'UPDATE') closeWhere((c) => c.user === n.user && c.space === n.space, 'role changed; reconnect'); // reconnect re-reads the role
  });
  try { await client.connect(); await client.query('listen weft_events'); log('listening on weft_events'); } catch (e) {
    log('listen connect failed', e.message); client.removeAllListeners('end'); setTimeout(listen, 2000);
  }
}

// ---------------------------------------------------------------- edits from the connector
async function edit({ token, id, mode, markdown }) {
  if (!UUID.test(String(id || ''))) return [400, { error: 'bad document' }];
  if (typeof markdown !== 'string' || !markdown.trim() || markdown.length > 200000) return [400, { error: 'Give the Markdown to add.' }];
  let claims;
  try { ({ payload: claims } = await jwtVerify(String(token || ''), JWT_SECRET, { algorithms: ['HS256'] })); } catch { return [401, { error: 'not signed in' }]; }
  if (claims.role !== 'weft_user' || !claims.sub) return [401, { error: 'not a user token' }];
  const row = await asUser(claims.sub, async (c) => (await c.query(
    'select space_id, kind, managed, weft_private.can_edit(space_id) as can_edit from weft.items where id = $1', [id])).rows[0]);
  if (!row) return [404, { error: 'No page with that id that you can see.' }];
  if (!['document', 'wiki'].includes(row.kind)) return [400, { error: 'Only documents and wiki pages can be edited this way.' }];
  if (row.managed) return [403, { error: 'This page is managed and cannot be changed in Weft.' }];
  if (!row.can_edit) return [403, { error: 'Weft refused: you can only change pages in channels where you are an editor or owner.' }];
  const added = await editor.tryParseMarkdownToBlocks(markdown);
  const conn = await server.hocuspocus.openDirectConnection(id, { user: claims.sub, space: row.space_id, kind: row.kind, doc: id, exp: claims.exp });
  try {
    await conn.transact((doc) => {
      const frag = doc.getXmlFragment(FRAGMENT);
      const blocks = mode === 'replace' ? added : [...editor.yXmlFragmentToBlocks(frag), ...added];
      editor.blocksToYXmlFragment(blocks, frag); // a diff: unchanged blocks stay as they are for people editing
    });
  } finally {
    await conn.disconnect(); // saves as this person (onStoreDocument), refused by RLS if they cannot edit
  }
  log('edited by connector', id.slice(0, 8), mode);
  return [200, { ok: true }];
}

http.createServer(async (req, res) => {
  const reply = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.method !== 'POST' || req.url !== '/edit') return reply(404, { error: 'not found' });
  let data = '';
  req.on('data', (c) => { data += c; if (data.length > 400000) req.destroy(); });
  req.on('end', async () => {
    try { reply(...(await edit(JSON.parse(data || '{}')))); } catch (e) { log('connector edit failed', e.message); reply(500, { error: 'The page could not be changed.' }); }
  });
}).listen(1235);

server.listen().then(() => { log('weft-collab on :1234 (edits from the connector on :1235)'); listen(); });
