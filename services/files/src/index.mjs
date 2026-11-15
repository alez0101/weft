// weft-files: upload, text extraction and download for the Files app.
//
//   POST   /files?space=<id>&name=<file name>   body: the file's bytes. Creates a file item in that space
//                                               (you must be able to edit it) and returns {id, title, ...}.
//   GET    /files/<item id>                     the file. Images, PDFs and plain text open in the browser;
//                                               everything else downloads. Add ?download=1 to always download.
//
// Spreadsheets (only when the spreadsheet engine is set up, OFFICE_JWT_SECRET):
//   GET    /files/office                        {enabled, ready}: is the engine set up, and is it running?
//   POST   /files/spreadsheets?space=&name=     a new spreadsheet; with a body (.xlsx, .xls, .ods, .csv or
//                                               .tsv, by the name's extension), made from that file.
//   GET    /files/<id>/editor                   the signed editor configuration (edit or view, as decided by
//                                               row-level security), for the engine's editor in the page.
//   GET    /files/<id>/office-file?t=           \ called by the engine only, on the private network (the web
//   POST   /files/<id>/office-save?t=           / front door never serves them): the bytes, and saves.
//
// Every database step runs as the person (role weft_user with their claims), so row-level security
// decides who may upload where and who may read what, exactly as for everything else in Weft. The text
// of PDFs, Word documents and plain-text files goes into the item's body_text, which makes it searchable
// and readable by the assistant (only for people who can see the file). Deleting, moving and sharing a
// file are ordinary item operations through the API.
import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';
import { jwtVerify, SignJWT } from 'jose';
import mammoth from 'mammoth';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { unzipSync, strFromU8 } from 'fflate';
import { readFileSync } from 'node:fs';

const env = (k, d) => { const v = process.env[k] || d; if (v === undefined) throw new Error(`missing ${k}`); return v; };
const JWT_SECRET = new TextEncoder().encode(env('JWT_SECRET'));
const MAX_BYTES = Number(env('FILE_MAX_MB', '25')) * 1024 * 1024;
const MAX_TEXT = 300000;   // characters of extracted text kept per file
const pool = new pg.Pool({ connectionString: env('DATABASE_URL_FILES'), max: 4 });
const log = (...a) => console.log(new Date().toISOString(), ...a);
// The spreadsheet engine (OnlyOffice Docs). Off unless OFFICE_JWT_SECRET is set.
const OFFICE_SECRET = process.env.OFFICE_JWT_SECRET ? new TextEncoder().encode(process.env.OFFICE_JWT_SECRET) : null;
const OFFICE_INTERNAL = process.env.OFFICE_INTERNAL_URL || 'http://office';
const FILES_INTERNAL = process.env.FILES_INTERNAL_URL || 'http://files:8095';
const BLANK_XLSX = readFileSync(new URL('./blank.xlsx', import.meta.url));
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const FORCESAVE_MS = Number(process.env.OFFICE_FORCESAVE_MINUTES || 5) * 60000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

async function who(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return null;
  try {
    const { payload } = await jwtVerify(m[1], JWT_SECRET, { algorithms: ['HS256'] });
    return payload.role === 'weft_user' && payload.sub && !payload.scope_space ? payload.sub : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- types and text
const EXT_MIME = {
  pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json',
  log: 'text/plain', xml: 'text/plain', yaml: 'text/plain', yml: 'text/plain', sql: 'text/plain',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
};
const TEXTY = new Set(['txt', 'md', 'csv', 'tsv', 'json', 'log', 'xml', 'yaml', 'yml', 'sql']);
// What the browser may show in place. Never HTML or SVG (they could run scripts), which download instead.
const INLINE = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain', 'text/markdown', 'text/csv', 'text/tab-separated-values', 'application/json']);
const extOf = (name) => (/\.([a-z0-9]{1,8})$/i.exec(name)?.[1] || '').toLowerCase();
// The type is decided from the name and checked against the bytes, never taken from the browser.
function mimeOf(name, bytes) {
  const ext = extOf(name);
  const head = bytes.subarray(0, 8).toString('latin1');
  if (ext === 'pdf') return head.startsWith('%PDF') ? EXT_MIME.pdf : 'application/octet-stream';
  if (['docx', 'xlsx', 'pptx', 'zip'].includes(ext)) return head.startsWith('PK') ? EXT_MIME[ext] : 'application/octet-stream';
  if (ext === 'png') return head.startsWith('\x89PNG') ? EXT_MIME.png : 'application/octet-stream';
  if (ext === 'jpg' || ext === 'jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 ? EXT_MIME.jpg : 'application/octet-stream';
  if (ext === 'gif') return head.startsWith('GIF8') ? EXT_MIME.gif : 'application/octet-stream';
  if (ext === 'webp') return bytes.subarray(8, 12).toString('latin1') === 'WEBP' ? EXT_MIME.webp : 'application/octet-stream';
  if (TEXTY.has(ext)) return bytes.includes(0) ? 'application/octet-stream' : EXT_MIME[ext];
  return 'application/octet-stream';
}

async function pdfText(bytes) {
  const doc = await getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
  const pages = [];
  try {
    for (let i = 1; i <= Math.min(doc.numPages, 500); i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      pages.push(tc.items.map((it) => it.str + (it.hasEOL ? '\n' : ' ')).join('').replace(/[ \t]+\n/g, '\n').trim());
      if (pages.join('\n\n').length > MAX_TEXT) break;
    }
  } finally { await doc.destroy(); }
  return pages.filter(Boolean).join('\n\n');
}

// Returns [text, note]: the text, or null and the reason there is none.
async function extract(name, mime, bytes) {
  try {
    let text = null;
    if (mime === EXT_MIME.pdf) text = await withTimeout(pdfText(bytes), 30000);
    else if (mime === XLSX) text = xlsxText(bytes);
    else if (mime === EXT_MIME.docx) text = (await withTimeout(mammoth.extractRawText({ buffer: bytes }), 30000)).value;
    else if (mime.startsWith('text/') || mime === 'application/json') text = bytes.toString('utf8');
    else return [null, mime.startsWith('image/') ? 'Pictures are stored, but their text is not read.' : 'Weft cannot read text from this kind of file. It is stored and can be downloaded.'];
    text = (text || '').replace(/\u0000/g, '').trim();
    if (!text) return [null, 'No text was found in this file (it may be scanned images).'];
    return [text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n[the rest of the text was not kept]` : text, text.length > MAX_TEXT ? 'Only the first part of the text was kept.' : null];
  } catch (e) {
    log('extract failed', name.slice(0, 40), e.message);
    return [null, 'The text could not be read from this file. It is stored and can be downloaded.'];
  }
}
// Every cell's shown value, one row per line (cells separated by tabs), each sheet under its name.
const unxml = (t) => t.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&');
const attr = (tag, name) => new RegExp(`(?:^|\\s)(?:[\\w-]+:)?${name}="([^"]*)"`).exec(tag)?.[1];
const XLSX_PART_MAX = 40 * 1024 * 1024;   // decompressed bytes per part, and in total (a zip bomb stops here)
function xlsxText(bytes) {
  let total = 0;
  const z = unzipSync(new Uint8Array(bytes), {
    filter: (f) => {
      if (!/^xl\/(sharedStrings\.xml|styles\.xml|workbook\.xml|_rels\/workbook\.xml\.rels|worksheets\/[^/]+\.xml)$/.test(f.name)) return false;
      total += f.originalSize;
      if (f.originalSize > XLSX_PART_MAX || total > XLSX_PART_MAX * 2) throw new Error('workbook too large to read');
      return true;
    },
  });
  const get = (n) => (z[n] ? strFromU8(z[n]) : '');
  // Namespace prefixes (x:si, x:t, ...) are allowed everywhere.
  const P = '(?:[\\w-]+:)?';
  const shared = [...get('xl/sharedStrings.xml').matchAll(new RegExp(`<${P}si\\b[^>]*>([\\s\\S]*?)</${P}si>`, 'g'))]
    .map((m) => unxml([...m[1].matchAll(new RegExp(`<${P}t\\b[^>]*>([\\s\\S]*?)</${P}t>`, 'g'))].map((t) => t[1]).join('')));
  // Which cell styles show a date or time (built-in formats 14-22 and 45-47, or a custom code with d, y, or h and m).
  const fmts = Object.fromEntries([...get('xl/styles.xml').matchAll(new RegExp(`<${P}numFmt\\b([^>]*)/?>`, 'g'))].map((m) => [attr(m[1], 'numFmtId'), unxml(attr(m[1], 'formatCode') || '')]));
  const isDate = (id) => {
    const n = Number(id);
    if ((n >= 14 && n <= 22) || (n >= 45 && n <= 47)) return true;
    const code = (fmts[id] || '').replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
    return /[dy]/i.test(code) || (/h/i.test(code) && /m/i.test(code));
  };
  const xfs = new RegExp(`<${P}cellXfs\\b[^>]*>([\\s\\S]*?)</${P}cellXfs>`).exec(get('xl/styles.xml'))?.[1] || '';
  const dateStyle = [...xfs.matchAll(new RegExp(`<${P}xf\\b([^>]*?)/?>`, 'g'))].map((m) => isDate(attr(m[1], 'numFmtId') || '0'));
  const asDate = (v) => {
    const x = Number(v); if (!Number.isFinite(x) || x < 0 || x > 2958465) return v;
    const iso = new Date(Math.round((x - 25569) * 86400000)).toISOString();
    return x < 1 ? iso.slice(11, 16) : Number.isInteger(x) ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
  };
  const rels = {};
  for (const m of get('xl/_rels/workbook.xml.rels').matchAll(/<(?:[\w-]+:)?Relationship\b([^>]*)>/g)) {
    const id = attr(m[1], 'Id'), target = attr(m[1], 'Target');
    if (id && target) rels[id] = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  }
  const out = [];
  for (const m of get('xl/workbook.xml').matchAll(new RegExp(`<${P}sheet\\b([^>]*)/?>`, 'g'))) {
    const xml = get(rels[attr(m[1], 'id')] || '');
    const lines = [];
    for (const row of xml.matchAll(new RegExp(`<${P}row\\b[^>]*>([\\s\\S]*?)</${P}row>`, 'g'))) {
      const cells = [];
      for (const c of row[1].matchAll(new RegExp(`<${P}c\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${P}c>)`, 'g'))) {
        const t = attr(c[1], 't'); const body = c[2] || '';
        const v = new RegExp(`<${P}v>([\\s\\S]*?)</${P}v>`).exec(body)?.[1];
        const val = t === 's' ? shared[+v] : t === 'inlineStr' ? unxml(new RegExp(`<${P}is>([\\s\\S]*?)</${P}is>`).exec(body)?.[1] || '')
          : v === undefined ? '' : (!t || t === 'n') && dateStyle[Number(attr(c[1], 's') || 0)] ? asDate(v) : unxml(v);
        if (val !== undefined && val !== '') cells.push(val);
      }
      if (cells.length) lines.push(cells.join('\t'));
    }
    if (lines.length) out.push(`${unxml(attr(m[1], 'name') || 'Sheet')}\n${lines.join('\n')}`);
  }
  return out.join('\n\n');
}
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), ms))]);

// ---------------------------------------------------------------- HTTP
const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
function readBytes(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_BYTES) { reject(Object.assign(new Error('too large'), { status: 413 })); return; }
    const parts = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > MAX_BYTES) { req.destroy(); reject(Object.assign(new Error('too large'), { status: 413 })); } else parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f\u007f/\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
const asciiName = (s) => s.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');

// ---------------------------------------------------------------- storing
// A new item with its bytes, in one transaction, as the person (row-level security decides where).
async function storeNew(user, { space, kind, title, text, bytes, mime, note = null }) {
  return asUser(user, async (c) => {
    const { rows: [item] } = await c.query(
      'insert into weft.items (space_id, kind, title, body_text) values ($1, $2, $3, $4) returning id, space_id, title, created_at',
      [space, kind, title, text]);
    await c.query('insert into weft.file_blobs (item_id, bytes, mime, size, sha256, text_note) values ($1, $2, $3, $4, $5, $6)',
      [item.id, bytes, mime, bytes.length, sha256(bytes), note]);
    return item;
  });
}

// ---------------------------------------------------------------- the spreadsheet engine
// GET /files/<id>/editor: the signed configuration the browser hands to the engine's editor. Edit or view
// is decided here, by row-level security (can the person edit the item's space?), and the engine refuses
// any configuration not signed with the shared secret, so the browser cannot promote itself to editor.
// The engine then fetches the bytes from /office-file and posts saves to /office-save on the private
// network, each with a short-lived Weft token naming the item and the person.
const sign = (payload, ttl) => new SignJWT(payload).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime(ttl).sign(OFFICE_SECRET);
async function editorConfig(res, user, id, url) {
  const row = await asUser(user, async (c) => (await c.query(
    `select i.title, i.kind, b.version, weft_private.can_edit(i.space_id) as can_edit, u.display_name
       from weft.items i join weft.file_blobs b on b.item_id = i.id
       left join weft.users u on u.id = weft_private.uid()
      where i.id = $1`, [id])).rows[0]);
  if (!row || row.kind !== 'spreadsheet') return send(res, 404, { error: 'No such spreadsheet, or you cannot see it.' });
  const edit = !!row.can_edit;
  const config = {
    document: {
      // Everyone who opens the same version joins the same live session.
      fileType: 'xlsx', key: `${id}-v${row.version}`, title: `${row.title}.xlsx`,
      url: `${FILES_INTERNAL}/files/${id}/office-file?t=${await sign({ item: id, sub: user, use: 'file' }, '1d')}`,
      permissions: { edit, download: true, print: true, comment: edit, review: false, copy: true, chat: false },
    },
    documentType: 'cell',
    editorConfig: {
      mode: edit ? 'edit' : 'view',
      lang: (url.searchParams.get('lang') || 'en').replace(/[^A-Za-z-]/g, '').slice(0, 10) || 'en',
      user: { id: user, name: row.display_name || 'Someone' },
      callbackUrl: `${FILES_INTERNAL}/files/${id}/office-save?t=${await sign({ item: id, sub: user, use: 'save' }, '7d')}`,
      // No plugins (that includes the engine's AI assistant), so nothing in a sheet is sent anywhere else.
      customization: { autosave: true, forcesave: false, compactHeader: true, feedback: false, help: false, plugins: false, chat: false,
        uiTheme: url.searchParams.get('dark') === '1' ? 'theme-dark' : 'theme-light' },
      coEditing: { mode: 'fast', change: false },
    },
  };
  // Good for opening the editor for a few minutes only: someone who loses access cannot reopen it with an old one.
  config.token = await new SignJWT(config).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('10m').sign(OFFICE_SECRET);
  return send(res, 200, { config, edit });
}

async function officeToken(url, id, use) {
  try {
    const { payload } = await jwtVerify(url.searchParams.get('t') || '', OFFICE_SECRET, { algorithms: ['HS256'] });
    return payload.item === id && payload.use === use && UUID.test(payload.sub) ? payload.sub : null;
  } catch { return null; }
}

// Fetch a file the engine made (a save or a conversion). Only ever from the engine itself, whatever host
// the address names, only from its cache, size-capped like uploads.
async function fromEngine(address) {
  const u = new URL(address);
  const path = u.pathname.replace(/^\/office(?=\/)/, '');
  if (!/^\/cache\/files\//.test(path)) throw new Error(`unexpected address ${path.slice(0, 60)}`);
  const r = await fetch(`${OFFICE_INTERNAL}${path}${u.search}`, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`engine said ${r.status}`);
  if (Number(r.headers.get('content-length') || 0) > MAX_BYTES) throw new Error('too large');
  const parts = []; let n = 0;
  for await (const chunk of r.body) { n += chunk.length; if (n > MAX_BYTES) throw new Error('too large'); parts.push(chunk); }
  return Buffer.concat(parts);
}

// Something signed for the engine's own APIs (with JWT_IN_BODY, the token goes in the body).
async function engineCall(path, body, ms) {
  const r = await fetch(`${OFFICE_INTERNAL}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ ...body, token: await new SignJWT(body).setProtectedHeader({ alg: 'HS256' }).sign(OFFICE_SECRET) }),
    signal: AbortSignal.timeout(ms),
  });
  return r.json();
}

// Convert an item's stored bytes (csv, tsv, xls, ods) to xlsx with the engine.
async function convert(id, user, ext) {
  const t = await sign({ item: id, sub: user, use: 'file' }, '10m');
  const j = await engineCall('/converter', {
    async: false, filetype: ext, outputtype: 'xlsx', key: `conv-${id}-${Date.now()}`, title: `source.${ext}`,
    url: `${FILES_INTERNAL}/files/${id}/office-file?t=${t}`, codePage: 65001,
    ...(ext === 'csv' ? { delimiter: 4 } : ext === 'tsv' ? { delimiter: 1 } : {}),
  }, 120000);
  if (!j.endConvert || !j.fileUrl) throw new Error(`conversion failed (${j.error ?? 'no file'})`);
  return fromEngine(j.fileUrl);
}

// Open editing sessions (document key -> when the engine last told us about it). Every few minutes each
// gets a "save now", so a restart of the engine mid-session loses at most those minutes of work.
const sessions = new Map();
if (OFFICE_SECRET) {
  setInterval(async () => {
    for (const [key, seen] of sessions) {
      if (Date.now() - seen > 86400000) { sessions.delete(key); continue; }
      try {
        const j = await engineCall('/command', { c: 'forcesave', key }, 15000);
        if (j.error === 1) sessions.delete(key);   // the engine no longer has this session
      } catch (e) { log('forcesave failed', e.message); }
    }
  }, FORCESAVE_MS).unref();
}

async function office(req, res, id, what, url) {
  const user = await officeToken(url, id, what);
  if (!user) return send(res, 403, { error: 'bad token' });
  if (what === 'file' && req.method === 'GET') {
    const row = await asUser(user, async (c) => (await c.query('select b.bytes, b.size from weft.file_blobs b join weft.items i on i.id = b.item_id where b.item_id = $1', [id])).rows[0]);
    if (!row) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': row.size, 'Cache-Control': 'no-store' });
    return res.end(row.bytes);
  }
  if (what === 'save' && req.method === 'POST') {
    // The engine signs what it posts (JWT in the body); anything unsigned is refused.
    let body;
    try {
      const raw = JSON.parse((await readBytes(req)).toString('utf8') || '{}');
      body = (await jwtVerify(raw.token || '', OFFICE_SECRET, { algorithms: ['HS256'] })).payload;
    } catch { return send(res, 403, { error: 1 }); }
    if (typeof body.key === 'string' && body.key.startsWith(`${id}-`)) {
      if (body.status === 1) sessions.set(body.key, Date.now());
      else if (body.status !== 6) sessions.delete(body.key);
    }
    // 2: everyone closed, final save. 6: a save while people are still editing (the session goes on).
    if (body.status !== 2 && body.status !== 6) return send(res, 200, { error: 0 });   // 1 editing, 4 closed unchanged
    const candidates = [...new Set([...(Array.isArray(body.users) ? body.users : []), user].filter((u) => typeof u === 'string' && UUID.test(u)))];
    let bytes;
    try { bytes = await fromEngine(String(body.url || '')); } catch (e) { log('office save: fetch failed', e.message); return send(res, 200, { error: 1 }); }
    const [text, note] = await extract('sheet.xlsx', XLSX, bytes);
    try {
      // Saved as the most recent editor who can still edit (row-level security decides each try). A final
      // save starts a new version, so the next person to open it starts a fresh session from these bytes.
      let n = 0;
      for (const editor of candidates) {
        n = await asUser(editor, async (c) => {
          const u = await c.query(
            'update weft.file_blobs set bytes = $2, size = $3, sha256 = $4, text_note = $5, updated_at = now(), version = version + $6 where item_id = $1',
            [id, bytes, bytes.length, sha256(bytes), note, body.status === 2 ? 1 : 0]);
          if (u.rowCount) await c.query('update weft.items set body_text = $2 where id = $1', [id, text || '']);
          return u.rowCount;
        });
        if (n) break;
      }
      if (!n) { log('office save refused (nobody in the session can still edit)', id); return send(res, 200, { error: 1 }); }
      log(body.status === 2 ? 'office save' : 'office save (session goes on)', id, bytes.length, 'bytes', text ? `${text.length} chars of text` : 'no text');
      return send(res, 200, { error: 0 });
    } catch (e) { log('office save failed', e.message); return send(res, 200, { error: 1 }); }
  }
  return send(res, 405, { error: 'not allowed' });
}

const SHEET_FROM = new Set(['xlsx', 'xls', 'ods', 'csv', 'tsv']);
async function newSpreadsheet(req, res, user, url) {
  const space = url.searchParams.get('space') || '';
  const raw = cleanName(url.searchParams.get('name'));
  const ext = extOf(raw);
  const name = (SHEET_FROM.has(ext) ? raw.slice(0, -(ext.length + 1)) : raw).trim() || 'Untitled spreadsheet';
  if (!UUID.test(space)) return send(res, 400, { error: 'say which space' });
  let bytes;
  try { bytes = await readBytes(req); } catch (e) { return send(res, e.status || 400, { error: e.status === 413 ? `Files can be at most ${MAX_BYTES / 1048576} MB.` : 'upload failed' }); }
  if (bytes.length && !SHEET_FROM.has(ext)) return send(res, 400, { error: 'Weft can open .xlsx, .xls, .ods, .csv and .tsv files as spreadsheets.' });
  const direct = !bytes.length || ext === 'xlsx';
  const first = bytes.length ? bytes : BLANK_XLSX;
  let item;
  try {
    item = await storeNew(user, { space, kind: 'spreadsheet', title: name, text: '', bytes: first, mime: direct ? XLSX : mimeOf(raw, first) });
  } catch (e) {
    if (e.code === '42501') return send(res, 403, { error: 'You can only add spreadsheets where you can edit.' });
    throw e;
  }
  let xlsx = first;
  if (!direct) {
    try { xlsx = await convert(item.id, user, ext); } catch (e) {
      log('conversion failed', ext, e.message);
      await asUser(user, (c) => c.query('delete from weft.items where id = $1', [item.id])).catch(() => {});
      return send(res, 422, { error: `Weft could not open that .${ext} file as a spreadsheet.` });
    }
  }
  const [text, note] = bytes.length ? await extract('sheet.xlsx', XLSX, xlsx) : ['', null];
  if (bytes.length) {
    await asUser(user, async (c) => {
      await c.query('update weft.file_blobs set bytes = $2, size = $3, sha256 = $4, mime = $5, text_note = $6, updated_at = now() where item_id = $1',
        [item.id, xlsx, xlsx.length, sha256(xlsx), XLSX, note]);
      await c.query('update weft.items set body_text = $2 where id = $1', [item.id, text || '']);
    });
  }
  log('new spreadsheet', direct ? (bytes.length ? 'from xlsx' : 'blank') : `from ${ext}`, xlsx.length, 'bytes');
  return send(res, 201, item);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/files/healthz') return send(res, 200, { ok: true });
    const om = /^\/files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/office-(file|save)$/.exec(url.pathname);
    if (om && OFFICE_SECRET) return await office(req, res, om[1], om[2], url);
    const user = await who(req);
    if (!user) return send(res, 401, { error: 'not signed in' });

    if (req.method === 'GET' && url.pathname === '/files/office') {
      if (!OFFICE_SECRET) return send(res, 200, { enabled: false, ready: false });
      const ready = await fetch(`${OFFICE_INTERNAL}/healthcheck`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok && r.text()).then((t) => t === 'true').catch(() => false);
      return send(res, 200, { enabled: true, ready });
    }
    if (req.method === 'POST' && url.pathname === '/files/spreadsheets' && OFFICE_SECRET) return await newSpreadsheet(req, res, user, url);

    const em = /^\/files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/editor$/.exec(url.pathname);
    if (req.method === 'GET' && em && OFFICE_SECRET) return await editorConfig(res, user, em[1], url);

    if (req.method === 'POST' && url.pathname === '/files') {
      const space = url.searchParams.get('space') || '';
      const name = cleanName(url.searchParams.get('name'));
      if (!UUID.test(space) || !name) return send(res, 400, { error: 'say which space, and the file name' });
      let bytes;
      try { bytes = await readBytes(req); } catch (e) { return send(res, e.status || 400, { error: e.status === 413 ? `Files can be at most ${MAX_BYTES / 1048576} MB.` : 'upload failed' }); }
      if (!bytes.length) return send(res, 400, { error: 'The file is empty.' });
      const mime = mimeOf(name, bytes);
      const [text, note] = await extract(name, mime, bytes);
      try {
        const row = await storeNew(user, { space, kind: 'file', title: name, text, bytes, mime, note });
        log('stored a file', mime, bytes.length, 'bytes', text ? `${text.length} chars of text` : 'no text');
        return send(res, 201, { ...row, mime, size: bytes.length, has_text: !!text, text_note: note });
      } catch (e) {
        if (e.code === '42501') return send(res, 403, { error: 'You can only add files where you can edit.' });
        throw e;
      }
    }

    const m = /^\/files\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (req.method === 'GET' && m) {
      const row = await asUser(user, async (c) => (await c.query(
        'select i.title, i.kind, b.bytes, b.mime, b.size from weft.items i join weft.file_blobs b on b.item_id = i.id where i.id = $1', [m[1]])).rows[0]);
      if (row && row.kind === 'spreadsheet' && !/\.xlsx$/i.test(row.title)) row.title += '.xlsx';
      if (!row) return send(res, 404, { error: 'No such file, or you cannot see it.' });   // RLS: not a member
      const inline = INLINE.has(row.mime) && url.searchParams.get('download') !== '1';
      res.writeHead(200, {
        'Content-Type': row.mime.startsWith('text/') ? `${row.mime}; charset=utf-8` : row.mime,
        'Content-Length': row.size,
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${asciiName(row.title)}"; filename*=UTF-8''${encodeURIComponent(row.title)}`,
        'X-Content-Type-Options': 'nosniff',
        // A file never runs scripts or loads anything, even if the browser shows it.
        'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
        'Cache-Control': 'private, no-store',
      });
      return res.end(row.bytes);
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    log('error', url.pathname, e.message);
    if (!res.headersSent) send(res, 500, { error: 'internal error' });
  }
}).listen(8095, () => log('weft-files on :8095'));
