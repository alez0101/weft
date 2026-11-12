// weft-svc: sign-in and live notifications.
//
// Two HTTP listeners, so the test sign-in can never be reached through the tunnel:
//   :8080 public  GET /auth/mode, GET /auth/session (Cloudflare Access -> Weft token), /live
//   :8081 test    GET /auth/mode, POST /auth/test-login (seeded example.com users only), /live
// nginx exposes :8080 on the Weft server port 3010 (LAN + tunnel) and :8081 on 127.0.0.1:3011 only.
//
// Live: LISTEN weft_events. A notice carries table, op, id and space, never content. It is sent
// only to sockets whose user is a member of that space; the browser then fetches the row through
// PostgREST, so row-level security still decides what anyone sees.
import http from 'node:http';
import pg from 'pg';
import { WebSocketServer } from 'ws';
import { createRemoteJWKSet, jwtVerify, SignJWT } from 'jose';

const env = (k, d) => { const v = process.env[k] ?? d; if (v === undefined) throw new Error(`missing ${k}`); return v; };
const JWT_SECRET = new TextEncoder().encode(env('JWT_SECRET'));
const TOKEN_TTL = Number(env('TOKEN_TTL', '900'));
const TEAM = env('ACCESS_TEAM_DOMAIN');
const AUD = env('ACCESS_AUD');
const BOOTSTRAP = env('BOOTSTRAP_ADMIN_EMAIL', '').toLowerCase();
const accessKeys = createRemoteJWKSet(new URL(`https://${TEAM}/cdn-cgi/access/certs`));

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

// Cloudflare Access puts its signed token in this header on every request it lets through.
// The cookie is the fallback when a browser calls us directly on the protected hostname.
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

// ---------------------------------------------------------------- HTTP
const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
const readBody = (req) => new Promise((resolve, reject) => {
  let data = '';
  req.on('data', (c) => { data += c; if (data.length > 4096) reject(new Error('too large')); });
  req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
});

async function issue(res, row) {
  const token = await mintWeftToken(row.id);
  send(res, 200, { token, expires_in: TOKEN_TTL, user: { id: row.id, display_name: row.display_name } });
}

function handler(mode) {
  return async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (req.method === 'GET' && url.pathname === '/auth/mode') return send(res, 200, { mode });

      if (mode === 'access' && req.method === 'GET' && url.pathname === '/auth/session') {
        const jwt = accessJwtFrom(req);
        if (!jwt) return send(res, 401, { error: 'no Cloudflare Access session' });
        let claims;
        try { claims = await verifyAccess(jwt); } catch (e) {
          log('access verify failed:', e.code || e.message);
          return send(res, 401, { error: 'Cloudflare Access token rejected' });
        }
        const email = String(claims.email).toLowerCase();
        const name = email.split('@')[0];
        const { rows } = await authDb.query('select * from weft_private.provision_user($1, $2, $3)',
          [email, name, BOOTSTRAP !== '' && email === BOOTSTRAP]);
        return issue(res, rows[0]);
      }

      if (mode === 'test' && req.method === 'POST' && url.pathname === '/auth/test-login') {
        const { email } = await readBody(req);
        const { rows } = await authDb.query('select * from weft_private.test_user($1)', [String(email || '')]);
        if (!rows.length) return send(res, 403, { error: 'not a test account' });
        return issue(res, rows[0]);
      }

      if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true, sockets: sockets.size });
      send(res, 404, { error: 'not found' });
    } catch (e) {
      if (e.code === 'WD001') return send(res, 403, { error: 'This account is disabled. Ask a Weft admin.' });
      log('error', url.pathname, e.message);
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
for (const [port, mode] of [[8080, 'access'], [8081, 'test']]) {
  const server = http.createServer(handler(mode));
  attachLive(server);
  server.listen(port, () => log(`weft-svc ${mode} listener on :${port}`));
}
listen();
