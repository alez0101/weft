// weft-svc: sign-in and live notifications.
//
// Two HTTP listeners, so the test sign-in can never be reached from outside the machine:
//   :8080 public  sign-in by the methods in AUTH_METHODS (below), /live
//   :8081 test    POST /auth/test-login (seeded example.com accounts only), /live
// nginx serves :8080 as the app's port and :8081 on 127.0.0.1 only.
//
// Sign-in methods (AUTH_METHODS, comma separated; default "password"):
//   password    Weft's own accounts. Email + password (scrypt), single-use invite and reset links that
//               admins make, and sessions kept as a rotating secret in an HttpOnly cookie.
//   cloudflare  Cloudflare Access in front of Weft: GET /auth/session trusts its signed header.
// Either way the browser ends up with the same short-lived Weft token for the API.
//
// Live: LISTEN weft_events. A notice carries table, op, id and space, never content. It is sent
// only to sockets whose user is a member of that space; the browser then fetches the row through
// PostgREST, so row-level security still decides what anyone sees.
import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';
import { WebSocketServer } from 'ws';
import { createRemoteJWKSet, jwtVerify, SignJWT } from 'jose';

const env = (k, d) => { const v = process.env[k] || d; if (v === undefined) throw new Error(`missing ${k}`); return v; };
const JWT_SECRET = new TextEncoder().encode(env('JWT_SECRET'));
const TOKEN_TTL = Number(env('TOKEN_TTL', '900'));
const METHODS = env('AUTH_METHODS', 'password').split(',').map((s) => s.trim()).filter(Boolean);
const BOOTSTRAP = env('BOOTSTRAP_ADMIN_EMAIL', '').toLowerCase();
const SESSION_DAYS = Number(env('SESSION_DAYS', '30'));
const COOKIE_SECURE = env('COOKIE_SECURE', 'true') !== 'false';
for (const m of METHODS) if (!['password', 'cloudflare'].includes(m)) throw new Error(`unknown sign-in method ${m}`);
let TEAM = null; let AUD = null; let accessKeys = null;
if (METHODS.includes('cloudflare')) {
  TEAM = env('ACCESS_TEAM_DOMAIN'); AUD = env('ACCESS_AUD');
  accessKeys = createRemoteJWKSet(new URL(`https://${TEAM}/cdn-cgi/access/certs`));
}

const authDb = new pg.Pool({ connectionString: env('DATABASE_URL_AUTH'), max: 4 });
const notifyDbUrl = env('DATABASE_URL_NOTIFY');
const notifyPool = new pg.Pool({ connectionString: notifyDbUrl, max: 4 });

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------- tokens
async function mintWeftToken(userId) {
  return new SignJWT({ role: 'weft_user' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_TTL}s`)
    .sign(JWT_SECRET);
}

async function verifyWeftToken(token) {
  const { payload } = await jwtVerify(token, JWT_SECRET, { algorithms: ['HS256'] });
  if (payload.role !== 'weft_user' || !payload.sub) throw new Error('not a user token');
  return payload;
}
const bearer = async (req) => {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return null;
  try { return await verifyWeftToken(m[1]); } catch { return null; }
};

// ---------------------------------------------------------------- Cloudflare Access (optional)
// Access puts its signed token in this header on every request it lets through; the cookie is the
// fallback when a browser calls us directly on the protected hostname.
function accessJwtFrom(req) {
  const h = req.headers['cf-access-jwt-assertion'];
  if (h) return h;
  const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
async function verifyAccess(jwt) {
  const { payload } = await jwtVerify(jwt, accessKeys, { issuer: `https://${TEAM}`, audience: AUD });
  if (!payload.email) throw new Error('Access token has no email');
  return payload;
}

// ---------------------------------------------------------------- passwords
// scrypt N=2^15, r=8, p=1 (32 MiB, about 0.1 s here). At most two hashes run at once, so a flood of
// sign-in attempts queues instead of exhausting memory.
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
let hashing = 0; const waiting = [];
async function slot(fn) {
  if (hashing >= 2) await new Promise((r) => waiting.push(r));
  hashing++;
  try { return await fn(); } finally { hashing--; waiting.shift()?.(); }
}
const scrypt = (pw, salt, o) => new Promise((res, rej) => crypto.scrypt(pw, salt, 32, o, (e, k) => (e ? rej(e) : res(k))));
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await slot(() => scrypt(pw.normalize('NFKC'), salt, SCRYPT));
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}
const DUMMY = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
async function checkPassword(pw, stored) {
  const [kind, N, r, p, salt, key] = (stored || DUMMY).split('$');
  if (kind !== 'scrypt') return false;
  const got = await slot(() => scrypt(String(pw).normalize('NFKC'), Buffer.from(salt, 'base64'), { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem }));
  const want = Buffer.from(key, 'base64');
  return stored !== null && stored !== undefined && got.length === want.length && crypto.timingSafeEqual(got, want);
}
function passwordProblem(pw, email) {
  if (typeof pw !== 'string' || pw.length < 12) return 'Use at least 12 characters.';
  if (pw.length > 200) return 'Use at most 200 characters.';
  if (!pw.trim() || (email && pw.toLowerCase().includes(String(email).toLowerCase().split('@')[0]) && pw.length < 20)) return 'Choose a password that does not contain your name or email.';
  return null;
}

// ---------------------------------------------------------------- secrets and cookies
const secret = () => crypto.randomBytes(32).toString('base64url');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const COOKIE = 'weft_session';
const cookieOf = (req) => (new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.cookie || '') || [])[1] || null;
const setCookie = (value, maxAge) => `${COOKIE}=${value}; Path=/auth; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${COOKIE_SECURE ? '; Secure' : ''}`;

// ---------------------------------------------------------------- rate limits (in memory, per process)
const buckets = new Map();
function limited(key, max, windowMs) {
  const now = Date.now(); let b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.n++;
  return b.n > max;
}
const clear = (key) => buckets.delete(key);
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 60000).unref();
// nginx passes the visitor's address (Cloudflare's CF-Connecting-IP when present) as X-Client-IP.
const clientIp = (req) => String(req.headers['x-client-ip'] || req.socket.remoteAddress || '?').slice(0, 64);
const WINDOW = 15 * 60 * 1000;

// ---------------------------------------------------------------- HTTP
const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
};
const readBody = (req) => new Promise((resolve, reject) => {
  let data = '';
  req.on('data', (c) => { data += c; if (data.length > 4096) reject(new Error('too large')); });
  req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
});

async function issue(res, row, extraHeaders = {}) {
  const token = await mintWeftToken(row.id ?? row.user_id);
  send(res, 200, { token, expires_in: TOKEN_TTL, user: { id: row.id ?? row.user_id, display_name: row.display_name } }, extraHeaders);
}
// A new session: its secret goes only into the HttpOnly cookie.
async function startSession(req, res, row) {
  const s = secret();
  await authDb.query('select weft_private.auth_session_create($1, $2, $3, $4)', [sha(s), row.user_id, SESSION_DAYS, String(req.headers['user-agent'] || '')]);
  await authDb.query('select weft_private.auth_signed_in($1)', [row.user_id]);
  return issue(res, row, { 'Set-Cookie': setCookie(s, SESSION_DAYS * 86400) });
}
// State-changing cookie requests must carry this header, which another site cannot add without
// passing CORS (and Weft allows no cross-origin requests), on top of SameSite=Strict.
const fromApp = (req) => req.headers['x-weft-request'] === '1';

function handler(mode) {
  return async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    const ip = clientIp(req);
    try {
      if (req.method === 'GET' && path === '/auth/mode') return send(res, 200, { mode: mode === 'test' ? 'test' : 'public', methods: mode === 'test' ? ['test'] : METHODS });
      if (req.method === 'GET' && path === '/healthz') return send(res, 200, { ok: true, sockets: sockets.size });

      if (mode === 'test') {
        if (req.method === 'POST' && path === '/auth/test-login') {
          const { email } = await readBody(req);
          const { rows } = await authDb.query('select * from weft_private.test_user($1)', [String(email || '')]);
          if (!rows.length) return send(res, 403, { error: 'not a test account' });
          return issue(res, rows[0]);
        }
        return send(res, 404, { error: 'not found' });
      }

      // ---------- Cloudflare Access
      if (req.method === 'GET' && path === '/auth/session') {
        if (!METHODS.includes('cloudflare')) return send(res, 404, { error: 'not found' });
        const jwt = accessJwtFrom(req);
        if (!jwt) return send(res, 401, { error: 'no Cloudflare Access session' });
        let claims;
        try { claims = await verifyAccess(jwt); } catch (e) {
          log('access verify failed:', e.code || e.message);
          return send(res, 401, { error: 'Cloudflare Access token rejected' });
        }
        const email = String(claims.email).toLowerCase();
        const { rows } = await authDb.query('select * from weft_private.provision_user($1, $2, $3)',
          [email, email.split('@')[0], BOOTSTRAP !== '' && email === BOOTSTRAP]);
        return issue(res, rows[0]);
      }

      if (!METHODS.includes('password') || !path.startsWith('/auth/')) return send(res, 404, { error: 'not found' });

      // ---------- password sign-in
      if (req.method === 'POST' && path === '/auth/login') {
        if (!fromApp(req)) return send(res, 403, { error: 'refused' });
        const { email, password } = await readBody(req);
        const who = String(email || '').trim().toLowerCase().slice(0, 254);
        if (limited(`ip:${ip}`, 30, WINDOW) || limited(`email:${who}`, 8, WINDOW)) {
          log('sign-in rate limited', ip, who ? `${who.slice(0, 2)}…` : '');
          return send(res, 429, { error: 'Too many attempts. Wait 15 minutes and try again.' });
        }
        const { rows } = await authDb.query('select * from weft_private.auth_lookup($1)', [who]);
        const ok = await checkPassword(String(password || ''), rows[0]?.hash ?? null);
        if (!ok) return send(res, 401, { error: 'That email and password do not match.' });
        if (rows[0].disabled) return send(res, 403, { error: 'This account is disabled. Ask a Weft admin.' });
        clear(`email:${who}`);
        return startSession(req, res, rows[0]);
      }

      if (req.method === 'POST' && path === '/auth/refresh') {
        if (!fromApp(req)) return send(res, 403, { error: 'refused' });
        const old = cookieOf(req);
        if (!old) return send(res, 401, { error: 'not signed in' });
        const next = secret();
        const { rows } = await authDb.query('select * from weft_private.auth_session_rotate($1, $2)', [sha(old), sha(next)]);
        if (!rows.length) {
          const { rows: [r] } = await authDb.query('select weft_private.auth_session_replayed($1) as replayed', [sha(old)]);
          if (r.replayed) log('a used session secret was presented again; that session is ended');
          return send(res, 401, { error: 'not signed in' }, { 'Set-Cookie': setCookie('', 0) });
        }
        return issue(res, rows[0], { 'Set-Cookie': setCookie(next, SESSION_DAYS * 86400) });
      }

      if (req.method === 'POST' && path === '/auth/logout') {
        if (!fromApp(req)) return send(res, 403, { error: 'refused' });
        const old = cookieOf(req);
        if (old) await authDb.query('select weft_private.auth_session_revoke($1)', [sha(old)]);
        return send(res, 200, { ok: true }, { 'Set-Cookie': setCookie('', 0) });
      }

      // ---------- invite and reset links
      const link = /^\/auth\/link\/([A-Za-z0-9_-]{20,100})$/.exec(path);
      if (link) {
        if (limited(`link:${ip}`, 30, WINDOW)) return send(res, 429, { error: 'Too many attempts. Wait 15 minutes and try again.' });
        const h = sha(link[1]);
        if (req.method === 'GET') {
          const { rows } = await authDb.query('select * from weft_private.auth_link_peek($1)', [h]);
          if (!rows.length) return send(res, 410, { error: 'This link has expired or was already used. Ask a Weft admin for a new one.' });
          return send(res, 200, rows[0]);
        }
        if (req.method === 'POST') {
          if (!fromApp(req)) return send(res, 403, { error: 'refused' });
          const { password, name } = await readBody(req);
          const { rows: peek } = await authDb.query('select * from weft_private.auth_link_peek($1)', [h]);
          if (!peek.length) return send(res, 410, { error: 'This link has expired or was already used. Ask a Weft admin for a new one.' });
          const problem = passwordProblem(password, peek[0].email);
          if (problem) return send(res, 400, { error: problem });
          const hash = await hashPassword(password);
          let rows;
          try {
            ({ rows } = await authDb.query('select * from weft_private.auth_link_redeem($1, $2, $3, $4)', [h, hash, String(name || '').slice(0, 80), BOOTSTRAP]));
          } catch (e) {
            if (e.code === 'WD010') return send(res, 410, { error: 'This link has expired or was already used. Ask a Weft admin for a new one.' });
            if (e.code === 'WD001') return send(res, 403, { error: 'This account is disabled. Ask a Weft admin.' });
            throw e;
          }
          log('password set through a', peek[0].purpose, 'link');
          return startSession(req, res, rows[0]);
        }
      }

      // ---------- signed in: change password
      if (req.method === 'POST' && path === '/auth/password') {
        const me = await bearer(req);
        if (!me) return send(res, 401, { error: 'not signed in' });
        if (limited(`pw:${me.sub}`, 8, WINDOW)) return send(res, 429, { error: 'Too many attempts. Wait 15 minutes and try again.' });
        const { current, next } = await readBody(req);
        const { rows } = await authDb.query('select * from weft_private.auth_lookup_id($1)', [me.sub]);
        if (!rows.length || !(await checkPassword(String(current || ''), rows[0].hash ?? null))) return send(res, 401, { error: 'Your current password is not right.' });
        const problem = passwordProblem(next, null);
        if (problem) return send(res, 400, { error: problem });
        const cur = cookieOf(req);
        await authDb.query('select weft_private.auth_set_password($1, $2, $3)', [me.sub, await hashPassword(next), cur ? sha(cur) : null]);
        return send(res, 200, { ok: true });
      }

      // ---------- admins: links
      if (path === '/auth/admin/links' || path.startsWith('/auth/admin/links/')) {
        const me = await bearer(req);
        if (!me) return send(res, 401, { error: 'not signed in' });
        const { rows: [a] } = await authDb.query('select weft_private.assist_is_admin($1) as ok', [me.sub]);
        if (!a.ok) return send(res, 403, { error: 'admins only' });
        if (req.method === 'GET' && path === '/auth/admin/links') {
          const { rows } = await authDb.query('select * from weft_private.auth_links_open($1)', [me.sub]);
          return send(res, 200, rows);
        }
        if (req.method === 'POST' && path === '/auth/admin/links') {
          const { email, purpose, hours } = await readBody(req);
          const s = secret();
          try {
            const { rows: [r] } = await authDb.query('select * from weft_private.auth_link_create($1, $2, $3, $4, $5)',
              [sha(s), String(email || '').trim().toLowerCase(), purpose === 'reset' ? 'reset' : 'invite', me.sub, Number(hours) || 72]);
            return send(res, 200, { ...r, token: s });   // shown once; only its hash is stored
          } catch (e) {
            if (['22023', 'WD005', 'WD009'].includes(e.code)) return send(res, 400, { error: e.message });
            throw e;
          }
        }
        const del = /^\/auth\/admin\/links\/(\d+)$/.exec(path);
        if (req.method === 'DELETE' && del) {
          await authDb.query('select weft_private.auth_link_revoke($1, $2)', [me.sub, Number(del[1])]);
          return send(res, 200, { ok: true });
        }
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      if (e.code === 'WD001') return send(res, 403, { error: 'This account is disabled. Ask a Weft admin.' });
      if (e.message === 'too large' || e instanceof SyntaxError) return send(res, 400, { error: 'bad request' });
      log('error', path, e.message);
      send(res, 500, { error: 'internal error' });
    }
  };
}

// ---------------------------------------------------------------- live
const sockets = new Map(); // ws -> { user, spaces: Set }

async function spacesOf(user) {
  const { rows } = await notifyPool.query('select weft_private.memberships($1) as s', [user]);
  return new Set(rows.map((r) => r.s));
}

function attachLive(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/live') return socket.destroy();
    let claims;
    try { claims = await verifyWeftToken(url.searchParams.get('token') || ''); } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, async (ws) => {
      const entry = { user: claims.sub, spaces: await spacesOf(claims.sub), exp: claims.exp };
      sockets.set(ws, entry);
      ws.send(JSON.stringify({ t: 'hello', spaces: entry.spaces.size }));
      ws.on('close', () => sockets.delete(ws));
      ws.on('message', () => {}); // clients only listen
    });
  });
}

// Drop sockets whose token has expired; the client reconnects with a fresh token.
setInterval(() => {
  const now = Date.now() / 1000;
  for (const [ws, e] of sockets) if (e.exp && e.exp < now) ws.close(4001, 'token expired');
}, 15000).unref();

async function deliver(notice) {
  if (notice.t === 'members') {
    // Membership changed: refresh that user's spaces, then tell them and the space's members.
    for (const [ws, e] of sockets) {
      if (e.user === notice.user) e.spaces = await spacesOf(e.user);
    }
  }
  if (notice.t === 'account') {
    // An admin disabled (or enabled) an account: its sockets close now; the client's reconnect is refused
    // at sign-in. Nothing about it is sent to anyone else.
    for (const [ws, e] of sockets) if (e.user === notice.user && notice.disabled) ws.close(4003, 'account disabled');
    return;
  }
  const text = JSON.stringify(notice);
  for (const [ws, e] of sockets) {
    if (e.spaces.has(notice.space) || (notice.t === 'members' && e.user === notice.user)) ws.send(text);
  }
}

async function listen() {
  const client = new pg.Client({ connectionString: notifyDbUrl });
  client.on('error', (e) => log('listen error', e.message));
  client.on('end', () => { log('listen connection ended, reconnecting'); setTimeout(listen, 2000); });
  client.on('notification', (m) => {
    let n; try { n = JSON.parse(m.payload); } catch { return; }
    deliver(n).catch((e) => log('deliver error', e.message));
  });
  try {
    await client.connect();
    await client.query('listen weft_events');
    log('listening on weft_events');
    // Re-read memberships after a reconnect, in case notices were missed while down.
    for (const e of sockets.values()) e.spaces = await spacesOf(e.user);
  } catch (e) {
    log('listen connect failed', e.message);
    client.removeAllListeners('end');
    setTimeout(listen, 2000);
  }
}

// ---------------------------------------------------------------- start
for (const [port, mode] of [[8080, 'public'], [8081, 'test']]) {
  const server = http.createServer(handler(mode));
  attachLive(server);
  server.listen(port, () => log(`weft-svc ${mode} listener on :${port}`));
}
listen();
