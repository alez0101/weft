// weft-files: upload, text extraction and download for the Files app.
//
//   POST   /files?space=<id>&name=<file name>   body: the file's bytes. Creates a file item in that space
//                                               (you must be able to edit it) and returns {id, title, ...}.
//   GET    /files/<item id>                     the file. Images, PDFs and plain text open in the browser;
//                                               everything else downloads. Add ?download=1 to always download.
//
// Every database step runs as the person (role weft_user with their claims), so row-level security
// decides who may upload where and who may read what, exactly as for everything else in Weft. The text
// of PDFs, Word documents and plain-text files goes into the item's body_text, which makes it searchable
// and readable by the assistant (only for people who can see the file). Deleting, moving and sharing a
// file are ordinary item operations through the API.
import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';
import { jwtVerify } from 'jose';
import mammoth from 'mammoth';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const env = (k, d) => { const v = process.env[k] || d; if (v === undefined) throw new Error(`missing ${k}`); return v; };
const JWT_SECRET = new TextEncoder().encode(env('JWT_SECRET'));
const MAX_BYTES = Number(env('FILE_MAX_MB', '25')) * 1024 * 1024;
const MAX_TEXT = 300000;   // characters of extracted text kept per file
const pool = new pg.Pool({ connectionString: env('DATABASE_URL_FILES'), max: 4 });
const log = (...a) => console.log(new Date().toISOString(), ...a);
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

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/files/healthz') return send(res, 200, { ok: true });
    const user = await who(req);
    if (!user) return send(res, 401, { error: 'not signed in' });

    if (req.method === 'POST' && url.pathname === '/files') {
      const space = url.searchParams.get('space') || '';
      const name = cleanName(url.searchParams.get('name'));
      if (!UUID.test(space) || !name) return send(res, 400, { error: 'say which space, and the file name' });
      let bytes;
      try { bytes = await readBytes(req); } catch (e) { return send(res, e.status || 400, { error: e.status === 413 ? `Files can be at most ${MAX_BYTES / 1048576} MB.` : 'upload failed' }); }
      if (!bytes.length) return send(res, 400, { error: 'The file is empty.' });
      const mime = mimeOf(name, bytes);
      const [text, note] = await extract(name, mime, bytes);
      const sha = crypto.createHash('sha256').update(bytes).digest('hex');
      try {
        const row = await asUser(user, async (c) => {
          const { rows: [item] } = await c.query(
            "insert into weft.items (space_id, kind, title, body_text) values ($1, 'file', $2, $3) returning id, space_id, title, created_at",
            [space, name, text]);
          await c.query('insert into weft.file_blobs (item_id, bytes, mime, size, sha256, text_note) values ($1, $2, $3, $4, $5, $6)',
            [item.id, bytes, mime, bytes.length, sha, note]);
          return item;
        });
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
        'select i.title, b.bytes, b.mime, b.size from weft.items i join weft.file_blobs b on b.item_id = i.id where i.id = $1', [m[1]])).rows[0]);
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
