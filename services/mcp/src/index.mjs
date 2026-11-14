// weft-mcp: the Weft connector. An MCP server (Streamable HTTP, at /mcp) with its own OAuth 2.1
// authorization server, so an AI app such as Claude can work in Weft as the person who connected it.
//
//   /.well-known/oauth-protected-resource      which authorization server protects /mcp (RFC 9728)
//   /.well-known/oauth-authorization-server    endpoints and what they support (RFC 8414)
//   POST /oauth/register                       dynamic client registration (RFC 7591)
//   GET  /oauth/authorize                      NOT here: nginx serves the app, which signs the person in
//                                              and shows the consent screen (services/web/src/Connect.jsx)
//   GET  /oauth/request                        the consent screen checks the request and names the app
//   POST /oauth/approve                        the person's answer (with their Weft token) -> a code
//   POST /oauth/token                          code + PKCE -> tokens; refresh tokens rotate
//   GET/DELETE /oauth/connections[/id]         the person's own connected apps (with their Weft token)
//   POST /mcp                                  the tools
//
// Every tool call runs as the person: the service mints a 5-minute Weft token for them and calls the
// API (PostgREST), so row-level security decides what the app sees and may change, exactly as for the
// person. A read-only grant gets only the reading tools, and its API calls are GET only.
// Tokens, codes and client secrets are stored as SHA-256 hashes (db/migrations/025_connector.sql).
import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';
import { SignJWT, jwtVerify } from 'jose';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const env = (k, d) => { const v = process.env[k] || d; if (v === undefined) throw new Error(`missing ${k}`); return v; };
const JWT_SECRET = new TextEncoder().encode(env('JWT_SECRET'));
const POSTGREST = env('POSTGREST_URL', 'http://postgrest:3000');
const COLLAB_EDIT = env('COLLAB_EDIT_URL', 'http://collab:1235');
const ASSISTANT = env('ASSISTANT_URL', 'http://assistant:8090');
const PUBLIC_URL = env('WEFT_PUBLIC_URL', '').replace(/\/+$/, '');
// Where an app may send the person back after they approve. Loopback addresses (desktop and command-line
// apps) are always allowed; other hosts only if listed. Anyone can register an app, so this list, and the
// consent screen naming the app and its address, are what stop a look-alike from collecting approvals.
const REDIRECT_HOSTS = env('MCP_REDIRECT_HOSTS', 'claude.ai,claude.com').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const ACCESS_TTL = 3600;
const REFRESH_TTL = 30 * 86400;
const db = new pg.Pool({ connectionString: env('DATABASE_URL_MCP'), max: 4 });
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const secret = (prefix) => `${prefix}${crypto.randomBytes(32).toString('base64url')}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The address people and apps use. Set WEFT_PUBLIC_URL in production; otherwise it is read from the
// request (nginx passes Host and the scheme).
const baseOf = (req) => PUBLIC_URL || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;

// ---------------------------------------------------------------- HTTP helpers
const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
};
const readRaw = (req, limit) => new Promise((resolve, reject) => {
  let data = ''; req.on('data', (c) => { data += c; if (data.length > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } });
  req.on('end', () => resolve(data)); req.on('error', reject);
});
async function readBody(req, limit = 16384) {
  const raw = await readRaw(req, limit);
  if (!raw) return {};
  if ((req.headers['content-type'] || '').includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw));
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error('bad JSON'), { status: 400 }); }
}
const oauthError = (res, status, error, description) => send(res, status, { error, error_description: description });

// A signed-in person calling from the app (consent screen, connected apps): their Weft token.
async function weftUser(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return null;
  try {
    const { payload } = await jwtVerify(m[1], JWT_SECRET, { algorithms: ['HS256'] });
    return payload.role === 'weft_user' && payload.sub ? payload.sub : null;
  } catch { return null; }
}
const mintFor = (userId) => new SignJWT({ role: 'weft_user' })
  .setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setSubject(userId).setIssuedAt().setExpirationTime('300s').sign(JWT_SECRET);

// ---------------------------------------------------------------- OAuth
function redirectAllowed(uri) {
  let u; try { u = new URL(uri); } catch { return false; }
  if (u.hash) return false;
  const host = u.hostname.toLowerCase();
  if (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(host)) return true;
  return u.protocol === 'https:' && REDIRECT_HOSTS.includes(host);
}

async function register(req, res) {
  const b = await readBody(req);
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.map(String) : [];
  if (!uris.length || uris.length > 5) return oauthError(res, 400, 'invalid_redirect_uri', 'Give one to five redirect_uris.');
  const bad = uris.find((u) => !redirectAllowed(u));
  if (bad) return oauthError(res, 400, 'invalid_redirect_uri', `This Weft does not send approvals to ${bad}. An admin can allow its host with MCP_REDIRECT_HOSTS.`);
  const name = String(b.client_name || 'An unnamed app').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80) || 'An unnamed app';
  const method = ['client_secret_post', 'client_secret_basic'].includes(b.token_endpoint_auth_method) ? b.token_endpoint_auth_method : 'none';
  const id = secret('wcl_');
  const clientSecret = method === 'none' ? null : secret('wcs_');
  await db.query('select weft_private.mcp_client_register($1, $2, $3, $4)', [id, clientSecret && sha(clientSecret), name, uris]);
  log('app registered:', JSON.stringify(name), uris.map((u) => new URL(u).host).join(' '));
  send(res, 201, {
    client_id: id, ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
    client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name, redirect_uris: uris,
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: method,
  });
}

// Checks an authorization request. Returns { client } or { error } (shown on the consent screen; a
// request with an unknown app or redirect is never sent anywhere).
async function checkRequest(p, base) {
  const { rows: [client] } = await db.query('select * from weft_private.mcp_client($1)', [String(p.client_id || '')]);
  if (!client) return { error: 'This app is not registered with Weft. Start connecting again from the app.' };
  if (!client.redirect_uris.includes(String(p.redirect_uri || ''))) return { error: 'This request does not match how the app registered. Start again from the app.' };
  if (p.response_type !== 'code') return { error: 'Unsupported request (response_type must be code).', redirectable: true };
  if (p.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(String(p.code_challenge || ''))) return { error: 'The app must use PKCE (S256).', redirectable: true };
  if (p.resource) {
    let r; try { r = new URL(p.resource); } catch { return { error: 'Unknown resource.', redirectable: true }; }
    if (r.origin !== new URL(base).origin) return { error: 'This request is for a different server.', redirectable: true };
  }
  return { client };
}
const backTo = (uri, params) => { const u = new URL(uri); for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v); return u.toString(); };

async function authRequest(req, res, url) {
  const p = Object.fromEntries(url.searchParams);
  const r = await checkRequest(p, baseOf(req));
  if (r.error) return send(res, 400, { error: r.error });
  send(res, 200, { client_name: r.client.name, redirect_host: new URL(p.redirect_uri).host });
}

async function approve(req, res) {
  if (req.headers['x-weft-request'] !== '1') return send(res, 403, { error: 'refused' });
  const user = await weftUser(req);
  if (!user) return send(res, 401, { error: 'Sign in first.' });
  const p = await readBody(req);
  const r = await checkRequest(p, baseOf(req));
  if (r.error && !r.redirectable) return send(res, 400, { error: r.error });
  const iss = baseOf(req);
  if (r.error) return send(res, 200, { redirect: backTo(p.redirect_uri, { error: 'invalid_request', error_description: r.error, state: p.state, iss }) });
  if (p.decision !== 'allow') return send(res, 200, { redirect: backTo(p.redirect_uri, { error: 'access_denied', state: p.state, iss }) });
  const access = p.access === 'write' ? 'write' : 'read';
  const code = secret('wco_');
  try {
    await db.query('select weft_private.mcp_code_create($1, $2, $3, $4, $5, $6)', [sha(code), r.client.id, user, p.redirect_uri, p.code_challenge, access]);
  } catch (e) {
    if (e.code === 'WD001') return send(res, 403, { error: 'This account is disabled.' });
    throw e;
  }
  log('connection approved:', JSON.stringify(r.client.name), access);
  send(res, 200, { redirect: backTo(p.redirect_uri, { code, state: p.state, iss }) });
}

// The client's credentials, if it registered with a secret (public clients rely on PKCE alone).
async function clientFrom(req, b) {
  let id = b.client_id; let sec = b.client_secret;
  const basic = /^Basic (.+)$/.exec(req.headers.authorization || '');
  if (basic) { const [u, s] = Buffer.from(basic[1], 'base64').toString().split(':'); id = decodeURIComponent(u || ''); sec = decodeURIComponent(s || ''); }
  const { rows: [client] } = await db.query('select * from weft_private.mcp_client($1)', [String(id || '')]);
  if (!client) return null;
  if (client.secret_hash && !(sec && crypto.timingSafeEqual(Buffer.from(sha(String(sec))), Buffer.from(client.secret_hash)))) return null;
  return client;
}
const tokens = (access, refresh, grantAccess) => ({
  access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope: grantAccess === 'write' ? 'weft:read weft:write' : 'weft:read',
});

async function token(req, res) {
  const b = await readBody(req);
  const client = await clientFrom(req, b);
  if (!client) return oauthError(res, 401, 'invalid_client', 'Unknown app or wrong secret.');
  const access = secret('wat_'); const refresh = secret('wrt_');
  if (b.grant_type === 'authorization_code') {
    const { rows: [c] } = await db.query('select * from weft_private.mcp_code_take($1)', [sha(String(b.code || ''))]);
    if (!c || c.client_id !== client.id) return oauthError(res, 400, 'invalid_grant', 'This code is unknown, used or expired.');
    if (b.redirect_uri && b.redirect_uri !== c.redirect_uri) return oauthError(res, 400, 'invalid_grant', 'redirect_uri does not match.');
    const challenge = crypto.createHash('sha256').update(String(b.code_verifier || '')).digest('base64url');
    if (!b.code_verifier || challenge !== c.code_challenge) return oauthError(res, 400, 'invalid_grant', 'PKCE check failed.');
    await db.query('select weft_private.mcp_grant_start($1, $2, $3, $4, $5, $6, $7)', [c.user_id, client.id, c.access, sha(access), sha(refresh), ACCESS_TTL, REFRESH_TTL]);
    return send(res, 200, tokens(access, refresh, c.access));
  }
  if (b.grant_type === 'refresh_token') {
    const { rows: [g] } = await db.query('select * from weft_private.mcp_refresh($1, $2, $3, $4, $5, $6)',
      [sha(String(b.refresh_token || '')), client.id, sha(access), sha(refresh), ACCESS_TTL, REFRESH_TTL]);
    if (!g) return oauthError(res, 400, 'invalid_grant', 'This refresh token is unknown, expired or revoked.');
    if (g.replayed) { log('a used refresh token was presented again; that connection is ended'); return oauthError(res, 400, 'invalid_grant', 'This refresh token was already used. Connect again.'); }
    return send(res, 200, tokens(access, refresh, g.access));
  }
  oauthError(res, 400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
}

async function connections(req, res, id) {
  const user = await weftUser(req);
  if (!user) return send(res, 401, { error: 'Sign in first.' });
  if (req.method === 'GET' && !id) return send(res, 200, (await db.query('select * from weft_private.mcp_grants_of($1)', [user])).rows);
  if (req.method === 'DELETE' && id && UUID.test(id)) {
    const { rows: [r] } = await db.query('select weft_private.mcp_grant_revoke($1, $2) as ok', [user, id]);
    return r.ok ? send(res, 200, { ok: true }) : send(res, 404, { error: 'No such connection.' });
  }
  send(res, 404, { error: 'not found' });
}

// ---------------------------------------------------------------- acting as the person
class Refused extends Error {}

// The API as the person. A read-only grant can only read (GET), whatever a tool asks for.
async function rest(ctx, path, { method = 'GET', body, prefer } = {}) {
  if (ctx.access !== 'write' && method !== 'GET') throw new Refused('This connection is read-only. Reconnect Weft with read and write access to make changes.');
  const headers = { Authorization: `Bearer ${await mintFor(ctx.user)}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(`${POSTGREST}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    const msg = data?.message || `${r.status}`;
    if (r.status === 401 || r.status === 403 || /row-level security|permission denied/i.test(msg)) {
      throw new Refused('Weft refused: you do not have permission for that here (viewers can read and chat, editors and owners can change things).');
    }
    throw new Refused(`Weft said no: ${msg}`);
  }
  return data;
}

const fmtTime = (t) => (t ? new Date(t).toISOString().replace(/:00\.000Z$/, 'Z').replace('.000Z', 'Z') : null);
const enc = encodeURIComponent;
const VIEW = { document: ['documents', 'doc'], wiki: ['wiki', 'page'], whiteboard: ['whiteboard', 'board'], table: ['sheets', 'sheet'],
  tasklist: ['tasks', 'list'], poll: ['polls', 'poll'], linklist: ['links', 'links'], addressbook: ['contacts', 'book'], decisionlog: ['decisions', 'log'], qa: ['qa', 'qa'], meeting: ['meetings', 'meeting'], file: ['files', 'file'] };
function linkTo(base, kind, id) {
  if (kind === 'event') return `${base}/#tabs=calendar&active=calendar&event=${id}`;
  if (kind === 'message') return null;
  const [tab, key] = VIEW[kind] || VIEW.document;
  return `${base}/#tabs=${tab}&active=${tab}&${key}=${id}`;
}

// A channel by id, by name (with or without #), or "personal" for the person's own space.
async function spaceOf(ctx, ref) {
  ref = String(ref || '').trim().replace(/^#/, '');
  if (!ref) throw new Refused('Say which channel.');
  if (UUID.test(ref)) {
    const [s] = await rest(ctx, `/spaces?id=eq.${ref}&select=id,name,kind`);
    if (!s) throw new Refused('No channel with that id that you can see.');
    return s;
  }
  if (/^personal$/i.test(ref)) {
    const [s] = await rest(ctx, `/spaces?kind=eq.personal&created_by=eq.${ctx.user}&select=id,name,kind`);
    if (s) return s;
  }
  const all = await rest(ctx, '/spaces?kind=in.(channel,dm,personal)&select=id,name,kind');
  const exact = all.filter((s) => s.name.toLowerCase() === ref.toLowerCase());
  const hits = exact.length ? exact : all.filter((s) => s.name.toLowerCase().includes(ref.toLowerCase()));
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new Refused(`No channel called "${ref}" that you can see. Use list_channels.`);
  throw new Refused(`More than one channel matches "${ref}": ${hits.map((s) => `${s.name} (${s.id})`).join(', ')}. Use the id.`);
}
async function personByName(ctx, name) {
  const all = await rest(ctx, '/users?select=id,display_name&is_assistant=is.false');
  const n = String(name).trim().toLowerCase();
  const hits = all.filter((u) => u.display_name.toLowerCase() === n);
  const loose = hits.length ? hits : all.filter((u) => u.display_name.toLowerCase().includes(n));
  if (loose.length === 1) return loose[0];
  throw new Refused(loose.length ? `More than one person matches "${name}".` : `Nobody called "${name}" shares a channel with you.`);
}

const text = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 1) }] });
const READ = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const EDIT = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const chan = z.string().min(1).max(200).describe('Channel id, or its name (e.g. "general" or "#general"), or "personal" for your own space');

function buildServer(ctx) {
  const server = new McpServer({ name: 'weft', title: 'Weft', version: '1.0.0' }, {
    instructions: `Weft is a team workspace (chat channels, documents, wiki, whiteboards, tables, task lists, polls, files, calendar). You act as ${ctx.name}, and see only what they can see. `
      + `Everything is organised in channels (spaces); "personal" is their own space. Search first when you do not know where something is. `
      + `Give people the links in results so they can open things in Weft.${ctx.access === 'write' ? ' Anything you post or create appears under their name, so say what you are about to change before changing it unless they asked you to.' : ' This connection is read-only.'}`,
  });
  const tool = (name, meta, schema, fn) => server.registerTool(name, { ...meta, inputSchema: schema }, async (args) => {
    try { return await fn(args); } catch (e) {
      if (e instanceof Refused) return { ...text(e.message), isError: true };
      log('tool error', name, e.message);
      return { ...text('Weft hit an error doing that.'), isError: true };
    }
  });
  const base = ctx.base;

  tool('whoami', { title: 'Who am I in Weft', description: 'Who this connection acts as, and whether it can make changes.', annotations: READ }, {}, async () =>
    text({ name: ctx.name, user_id: ctx.user, access: ctx.access === 'write' ? 'read and write' : 'read only', weft: base }));

  tool('list_channels', { title: 'List channels', description: 'The channels, direct messages and personal space you are in, with your role in each (owner, editor or viewer).', annotations: READ }, {}, async () => {
    const [spaces, mine] = await Promise.all([
      rest(ctx, '/spaces?kind=in.(channel,dm,personal)&select=id,kind,name&order=name'),
      rest(ctx, `/members?user_id=eq.${ctx.user}&select=space_id,role`),
    ]);
    const role = Object.fromEntries(mine.map((m) => [m.space_id, m.role]));
    return text(spaces.map((s) => ({ id: s.id, name: s.name, kind: s.kind, your_role: role[s.id] || 'viewer' })));
  });

  tool('read_messages', {
    title: 'Read messages', annotations: READ,
    description: 'Recent chat messages in a channel, newest last. Give thread (a message id) to read one thread.',
  }, {
    channel: chan,
    limit: z.number().int().min(1).max(100).default(30).describe('How many messages (default 30)'),
    before: z.string().optional().describe('Only messages before this time (ISO 8601), to page back'),
    thread: z.string().regex(UUID).optional().describe('A message id: read that message and its replies'),
  }, async ({ channel, limit, before, thread }) => {
    const s = await spaceOf(ctx, channel);
    let q = `/messages?space_id=eq.${s.id}&select=id,body,created_at,edited_at,thread_root_id,author:users(display_name)&order=created_at.desc&limit=${limit}`;
    if (before) q += `&created_at=lt.${enc(new Date(before).toISOString())}`;
    if (thread) q += `&or=(id.eq.${thread},thread_root_id.eq.${thread})`;
    const rows = (await rest(ctx, q)).reverse();
    return text({ channel: s.name, messages: rows.map((m) => ({ id: m.id, from: m.author?.display_name, at: fmtTime(m.created_at), ...(m.thread_root_id ? { reply_to: m.thread_root_id } : {}), text: m.body })) });
  });

  tool('search', {
    title: 'Search Weft', annotations: READ,
    description: 'Search messages, documents, wiki pages, files, tables, tasks and events you can see. "words" matches the words (fast, exact); "meaning" finds things about the same topic even with different words.',
  }, {
    query: z.string().min(2).max(200),
    by: z.enum(['words', 'meaning']).default('words'),
    limit: z.number().int().min(1).max(25).default(10),
  }, async ({ query, by, limit }) => {
    let rows;
    if (by === 'meaning') {
      const r = await fetch(`${ASSISTANT}/assistant/search/related?q=${enc(query)}`, { headers: { Authorization: `Bearer ${await mintFor(ctx.user)}` } });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.enabled === false) throw new Refused('Search by meaning is not turned on in this Weft. Search by words instead.');
      rows = d.results || [];
    } else {
      rows = await rest(ctx, `/rpc/search?p_q=${enc(query)}&p_limit=${limit}`);
    }
    return text(rows.slice(0, limit).map((h) => ({
      kind: h.kind, id: h.id, title: h.title || undefined, channel: h.space_name, channel_id: h.space_id,
      snippet: (h.snippet || '').replace(/[«»]/g, ''), at: fmtTime(h.at), link: linkTo(base, h.kind, h.id) || undefined,
    })));
  });

  tool('list_items', {
    title: 'List documents and other items', annotations: READ,
    description: 'Documents, wiki pages, whiteboards, tables, task lists, polls, link lists, address books, decision logs, Q and A boards, meetings and files, most recently changed first.',
  }, {
    channel: chan.optional(),
    kind: z.enum(['document', 'wiki', 'whiteboard', 'table', 'tasklist', 'poll', 'linklist', 'addressbook', 'decisionlog', 'qa', 'meeting', 'file']).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }, async ({ channel, kind, limit }) => {
    let q = `/items?select=id,kind,title,parent_id,updated_at,space:spaces(name)&order=updated_at.desc&limit=${limit}`;
    if (channel) q += `&space_id=eq.${(await spaceOf(ctx, channel)).id}`;
    if (kind) q += `&kind=eq.${kind}`;
    const rows = await rest(ctx, q);
    return text(rows.map((i) => ({ id: i.id, kind: i.kind, title: i.title, channel: i.space?.name, ...(i.parent_id ? { parent_page: i.parent_id } : {}), updated: fmtTime(i.updated_at), link: linkTo(base, i.kind, i.id) })));
  });

  tool('read_item', {
    title: 'Read a document or item', annotations: READ,
    description: 'The content of a document, wiki page, whiteboard (its text), table (columns and rows), task list (its tasks), poll (choices and votes) or file (its text).',
  }, { id: z.string().regex(UUID) }, async ({ id }) => {
    const [i] = await rest(ctx, `/items?id=eq.${id}&select=id,kind,title,body_text,parent_id,managed,updated_at,space_id,space:spaces(name)`);
    if (!i) throw new Refused('No item with that id that you can see.');
    const head = { id: i.id, kind: i.kind, title: i.title, channel: i.space?.name, channel_id: i.space_id, updated: fmtTime(i.updated_at), link: linkTo(base, i.kind, i.id), ...(i.managed ? { note: 'managed page: read-only in Weft' } : {}) };
    if (i.kind === 'table') {
      const [cols, rows] = await Promise.all([
        rest(ctx, `/table_columns?table_id=eq.${id}&select=id,name,type&order=position`),
        rest(ctx, `/table_rows?table_id=eq.${id}&select=id,cells&order=position&limit=500`),
      ]);
      return text({ ...head, columns: cols.map((c) => `${c.name} (${c.type})`), rows: rows.map((r) => Object.fromEntries(cols.map((c) => [c.name, r.cells?.[c.id] ?? null]))) });
    }
    if (i.kind === 'tasklist') {
      const ts = await rest(ctx, `/tasks?list_id=eq.${id}&select=id,title,done,due_on,assignee:users!assignee_id(display_name)&order=position`);
      return text({ ...head, tasks: ts.map((t) => ({ id: t.id, title: t.title, done: t.done, ...(t.due_on ? { due: t.due_on } : {}), ...(t.assignee ? { assignee: t.assignee.display_name } : {}) })) });
    }
    if (i.kind === 'poll') {
      const [p, cs, vs] = await Promise.all([
        rest(ctx, `/polls?id=eq.${id}&select=closed`), rest(ctx, `/poll_choices?poll_id=eq.${id}&select=id,label&order=position`),
        rest(ctx, `/poll_votes?poll_id=eq.${id}&select=choice_id`),
      ]);
      return text({ ...head, closed: !!p[0]?.closed, choices: cs.map((c) => ({ label: c.label, votes: vs.filter((v) => v.choice_id === c.id).length })) });
    }
    return text(`${JSON.stringify(head, null, 1)}\n\n${i.body_text || '(empty)'}`);
  });

  tool('list_events', {
    title: 'List calendar events', annotations: READ,
    description: 'Calendar events between two times (default: the next 30 days).',
  }, {
    from: z.string().optional().describe('ISO 8601 start (default now)'),
    to: z.string().optional().describe('ISO 8601 end (default 30 days after from)'),
    channel: chan.optional(),
  }, async ({ from, to, channel }) => {
    const f = from ? new Date(from) : new Date();
    const t = to ? new Date(to) : new Date(f.getTime() + 30 * 86400e3);
    if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) throw new Refused('from and to must be ISO 8601 times.');
    let q = `/events?select=id,title,starts_at,ends_at,location,space:spaces(name)&starts_at=lt.${enc(t.toISOString())}&ends_at=gte.${enc(f.toISOString())}&order=starts_at&limit=200`;
    if (channel) q += `&space_id=eq.${(await spaceOf(ctx, channel)).id}`;
    const rows = await rest(ctx, q);
    return text(rows.map((e) => ({ id: e.id, title: e.title, starts: fmtTime(e.starts_at), ends: fmtTime(e.ends_at), ...(e.location ? { location: e.location } : {}), channel: e.space?.name, link: linkTo(base, 'event', e.id) })));
  });

  tool('list_tasks', {
    title: 'List tasks', annotations: READ,
    description: 'Tasks from task lists, open ones by default. Narrow to a channel, or to tasks assigned to you.',
  }, {
    channel: chan.optional(),
    mine: z.boolean().default(false).describe('Only tasks assigned to you'),
    include_done: z.boolean().default(false),
  }, async ({ channel, mine, include_done }) => {
    let q = '/tasks?select=id,title,done,due_on,list_id,assignee:users!assignee_id(display_name),list:items(title,space:spaces(name))&order=due_on.asc.nullslast,position&limit=300';
    if (!include_done) q += '&done=is.false';
    if (mine) q += `&assignee_id=eq.${ctx.user}`;
    if (channel) {
      const s = await spaceOf(ctx, channel);
      const lists = await rest(ctx, `/items?space_id=eq.${s.id}&kind=eq.tasklist&select=id`);
      if (!lists.length) return text([]);
      q += `&list_id=in.(${lists.map((l) => l.id).join(',')})`;
    }
    const rows = await rest(ctx, q);
    return text(rows.map((t) => ({ id: t.id, title: t.title, done: t.done, ...(t.due_on ? { due: t.due_on } : {}), ...(t.assignee ? { assignee: t.assignee.display_name } : {}), list: t.list?.title, list_id: t.list_id, channel: t.list?.space?.name })));
  });

  if (ctx.access !== 'write') return server;

  // ---------- light writes: post, create, edit, schedule, tick off. Nothing deletes.
  tool('post_message', {
    title: 'Post a message', annotations: WRITE,
    description: 'Post a chat message in a channel as you. Give reply_to (a message id) to answer in its thread.',
  }, {
    channel: chan,
    text: z.string().min(1).max(20000),
    reply_to: z.string().regex(UUID).optional(),
  }, async ({ channel, text: body, reply_to }) => {
    const s = await spaceOf(ctx, channel);
    const [m] = await rest(ctx, '/messages?select=id,created_at', { method: 'POST', body: { space_id: s.id, body, thread_root_id: reply_to || null }, prefer: 'return=representation' });
    return text({ posted: true, id: m.id, channel: s.name, at: fmtTime(m.created_at) });
  });

  tool('create_page', {
    title: 'Create a document, wiki page or task list', annotations: WRITE,
    description: 'Create a document or wiki page from Markdown (headings, lists, bold, links, tables), or an empty task list. Wiki pages can sit under a parent page.',
  }, {
    channel: chan,
    kind: z.enum(['document', 'wiki', 'tasklist']),
    title: z.string().min(1).max(200),
    markdown: z.string().max(200000).default('').describe('The content (ignored for a task list)'),
    parent_page: z.string().regex(UUID).optional().describe('Wiki only: the page to put it under'),
  }, async ({ channel, kind, title, markdown, parent_page }) => {
    const s = await spaceOf(ctx, channel);
    const row = { space_id: s.id, kind, title, body_text: kind === 'tasklist' ? null : markdown || null, parent_id: kind === 'wiki' ? parent_page || null : null };
    const [i] = await rest(ctx, '/items?select=id,kind,title', { method: 'POST', body: row, prefer: 'return=representation' });
    return text({ created: true, id: i.id, kind: i.kind, title: i.title, channel: s.name, link: linkTo(base, i.kind, i.id) });
  });

  tool('edit_page', {
    title: 'Edit a document or wiki page', annotations: EDIT,
    description: 'Add Markdown to the end of a document or wiki page, or replace its whole content, and/or rename it. People who have it open see the change live. Read it first.',
  }, {
    id: z.string().regex(UUID),
    mode: z.enum(['append', 'replace']).default('append'),
    markdown: z.string().max(200000).optional(),
    title: z.string().min(1).max(200).optional().describe('A new title'),
  }, async ({ id, mode, markdown, title }) => {
    if (!markdown && !title) throw new Refused('Give markdown, a title, or both.');
    const [i] = await rest(ctx, `/items?id=eq.${id}&select=id,kind,title,managed`);
    if (!i) throw new Refused('No page with that id that you can see.');
    if (!['document', 'wiki'].includes(i.kind)) throw new Refused(`edit_page changes documents and wiki pages; this is a ${i.kind}.`);
    if (i.managed) throw new Refused('This page is managed (it comes from Weft\'s own docs) and cannot be changed in Weft.');
    if (title && title !== i.title) {
      const r = await rest(ctx, `/items?id=eq.${id}&select=id`, { method: 'PATCH', body: { title }, prefer: 'return=representation' });
      if (!r.length) throw new Refused('Weft refused: you can only change pages in channels where you are an editor or owner.');
    }
    if (markdown) {
      const r = await fetch(`${COLLAB_EDIT}/edit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: await mintFor(ctx.user), id, mode, markdown }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Refused(d.error || 'The page could not be changed.');
    }
    return text({ changed: true, id, mode: markdown ? mode : undefined, title: title || i.title, link: linkTo(base, i.kind, id) });
  });

  tool('create_event', {
    title: 'Add a calendar event', annotations: WRITE,
    description: 'Add an event to a channel\'s calendar. Times are ISO 8601 with a time zone offset (e.g. 2026-12-01T18:00:00-08:00).',
  }, {
    channel: chan,
    title: z.string().min(1).max(200),
    starts_at: z.string(),
    ends_at: z.string().optional().describe('Default: one hour after the start'),
    location: z.string().max(200).optional(),
  }, async ({ channel, title, starts_at, ends_at, location }) => {
    const s = await spaceOf(ctx, channel);
    const st = new Date(starts_at); const en = ends_at ? new Date(ends_at) : new Date(st.getTime() + 3600e3);
    if (Number.isNaN(st.getTime()) || Number.isNaN(en.getTime())) throw new Refused('starts_at and ends_at must be ISO 8601 times.');
    if (en < st) throw new Refused('The event ends before it starts.');
    const [e] = await rest(ctx, '/events?select=id,title,starts_at,ends_at', { method: 'POST', body: { space_id: s.id, title, starts_at: st.toISOString(), ends_at: en.toISOString(), location: location || null }, prefer: 'return=representation' });
    return text({ created: true, id: e.id, title: e.title, starts: fmtTime(e.starts_at), ends: fmtTime(e.ends_at), channel: s.name, link: linkTo(base, 'event', e.id) });
  });

  tool('update_event', {
    title: 'Change a calendar event', annotations: EDIT,
    description: 'Rename, move or relocate an event. Give only what changes.',
  }, {
    id: z.string().regex(UUID),
    title: z.string().min(1).max(200).optional(),
    starts_at: z.string().optional(),
    ends_at: z.string().optional(),
    location: z.string().max(200).optional(),
  }, async ({ id, title, starts_at, ends_at, location }) => {
    const patch = {};
    if (title) patch.title = title;
    if (location !== undefined) patch.location = location || null;
    for (const [k, v] of [['starts_at', starts_at], ['ends_at', ends_at]]) {
      if (v) { const d = new Date(v); if (Number.isNaN(d.getTime())) throw new Refused(`${k} must be an ISO 8601 time.`); patch[k] = d.toISOString(); }
    }
    if (!Object.keys(patch).length) throw new Refused('Nothing to change.');
    const r = await rest(ctx, `/events?id=eq.${id}&select=id,title,starts_at,ends_at,location`, { method: 'PATCH', body: patch, prefer: 'return=representation' });
    if (!r.length) throw new Refused('No event with that id that you can change (you need to be an editor or owner in its channel).');
    return text({ changed: true, id, title: r[0].title, starts: fmtTime(r[0].starts_at), ends: fmtTime(r[0].ends_at), location: r[0].location, link: linkTo(base, 'event', id) });
  });

  tool('add_task', {
    title: 'Add a task', annotations: WRITE,
    description: 'Add a task to a task list (find lists with list_items kind "tasklist", or make one with create_page).',
  }, {
    list: z.string().regex(UUID).describe('The task list id'),
    title: z.string().min(1).max(300),
    due_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD'),
    assignee: z.string().max(80).optional().describe('A person\'s name in Weft'),
  }, async ({ list, title, due_on, assignee }) => {
    const [l] = await rest(ctx, `/items?id=eq.${list}&kind=eq.tasklist&select=id,title`);
    if (!l) throw new Refused('No task list with that id that you can see.');
    const who = assignee ? await personByName(ctx, assignee) : null;
    const [t] = await rest(ctx, '/tasks?select=id,title', { method: 'POST', body: { list_id: list, title, due_on: due_on || null, assignee_id: who?.id || null, position: Date.now() }, prefer: 'return=representation' });
    return text({ created: true, id: t.id, title: t.title, list: l.title, ...(who ? { assignee: who.display_name } : {}), link: linkTo(base, 'tasklist', list) });
  });

  tool('set_task_done', {
    title: 'Tick off a task', annotations: { ...WRITE, idempotentHint: true },
    description: 'Mark a task done, or not done.',
  }, { id: z.string().regex(UUID), done: z.boolean().default(true) }, async ({ id, done }) => {
    const r = await rest(ctx, `/tasks?id=eq.${id}&select=id,title,done`, { method: 'PATCH', body: { done }, prefer: 'return=representation' });
    if (!r.length) throw new Refused('No task with that id that you can change.');
    return text({ changed: true, id, title: r[0].title, done: r[0].done });
  });

  return server;
}

// ---------------------------------------------------------------- /mcp
async function mcp(req, res) {
  const base = baseOf(req);
  const challenge = { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` };
  const m = /^Bearer (\S+)$/.exec(req.headers.authorization || '');
  const { rows: [g] } = m ? await db.query('select * from weft_private.mcp_token_use($1)', [sha(m[1])]) : { rows: [] };
  if (!g) return send(res, 401, { error: 'invalid_token', error_description: 'Connect Weft again.' }, challenge);
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' }, { Allow: 'POST' }); // stateless: no stream to resume, no session to end
  const body = await readBody(req, 1024 * 1024);
  const server = buildServer({ user: g.user_id, access: g.access, name: g.display_name, base });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

// ---------------------------------------------------------------- routes
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  try {
    if (path === '/healthz') return send(res, 200, { ok: true });
    if (req.method === 'GET' && (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp')) {
      const base = baseOf(req);
      return send(res, 200, { resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ['header'], scopes_supported: ['weft:read', 'weft:write'], resource_name: 'Weft' });
    }
    if (req.method === 'GET' && path.startsWith('/.well-known/oauth-authorization-server')) {
      const base = baseOf(req);
      return send(res, 200, {
        issuer: base, authorization_endpoint: `${base}/oauth/authorize`, token_endpoint: `${base}/oauth/token`, registration_endpoint: `${base}/oauth/register`,
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'], scopes_supported: ['weft:read', 'weft:write'],
        authorization_response_iss_parameter_supported: true,
      });
    }
    if (req.method === 'POST' && path === '/oauth/register') return await register(req, res);
    if (req.method === 'GET' && path === '/oauth/request') return await authRequest(req, res, url);
    if (req.method === 'POST' && path === '/oauth/approve') return await approve(req, res);
    if (req.method === 'POST' && path === '/oauth/token') return await token(req, res);
    const c = /^\/oauth\/connections(?:\/([^/]+))?$/.exec(path);
    if (c) return await connections(req, res, c[1]);
    if (path === '/mcp') return await mcp(req, res);
    send(res, 404, { error: 'not found' });
  } catch (e) {
    log('error', path, e.message);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'the connector hit an error' });
  }
}).listen(8097, () => log('weft-mcp on :8097'));

setInterval(() => db.query('select weft_private.mcp_cleanup()').catch((e) => log('cleanup failed', e.message)), 3600e3).unref();
