// weft-assistant: answers @Weft questions, and the admin provider settings.
//
//   POST /assistant/ask                      {message_id}  the asker's Weft token
//   GET  /assistant/admin/providers          admin only; never returns a key
//   PUT  /assistant/admin/providers/:slot    admin only; settings
//   PUT  /assistant/admin/providers/:slot/key    admin only; {key} write-only, encrypted here
//   DELETE /assistant/admin/providers/:slot/key  admin only
//   POST /assistant/admin/providers/:slot/test   admin only; a tiny live call
//
// The assistant never reads the database directly. For each question it mints a short-lived
// weft_assistant token for the asker (and, in a channel, scoped to that channel) and goes through
// PostgREST, so row-level security bounds everything it can see or write.
import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';
import Anthropic from '@anthropic-ai/sdk';
import { jwtVerify, SignJWT } from 'jose';

const env = (k, d) => { const v = process.env[k] ?? d; if (v === undefined) throw new Error(`missing ${k}`); return v; };
const JWT_SECRET = new TextEncoder().encode(env('JWT_SECRET'));
const MASTER = Buffer.from(env('ASSIST_MASTER_KEY'), 'hex');
if (MASTER.length !== 32) throw new Error('ASSIST_MASTER_KEY must be 32 bytes of hex');
const API = env('POSTGREST_URL', 'http://postgrest:3000');
const ASSISTANT_ID = '00000000-0000-4000-8000-00000000a001';
const CALL_TIMEOUT_MS = Number(env('CALL_TIMEOUT_MS', '60000'));
const db = new pg.Pool({ connectionString: env('DATABASE_URL_ASSIST'), max: 4 });
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------- keys at rest
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', MASTER, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}
function decrypt(blob) {
  const [v, iv, tag, ct] = blob.split(':');
  if (v !== 'v1') throw new Error('unknown key format');
  const d = crypto.createDecipheriv('aes-256-gcm', MASTER, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

// ---------------------------------------------------------------- tokens and the API
async function userFrom(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return null;
  try {
    const { payload } = await jwtVerify(m[1], JWT_SECRET, { algorithms: ['HS256'] });
    return payload.role === 'weft_user' && payload.sub ? { id: payload.sub, token: m[1] } : null;
  } catch { return null; }
}
const assistantToken = (sub, scope) => new SignJWT({ role: 'weft_assistant', ...(scope ? { scope_space: scope } : {}) })
  .setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setSubject(sub).setIssuedAt().setExpirationTime('120s').sign(JWT_SECRET);

async function rest(token, path, { method = 'GET', body } = {}) {
  const r = await fetch(`${API}${path}`, {
    method, body: body && JSON.stringify(body),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
  });
  const text = await r.text();
  if (!r.ok) throw Object.assign(new Error(`API ${r.status}: ${text.slice(0, 200)}`), { status: r.status });
  return text ? JSON.parse(text) : null;
}

// ---------------------------------------------------------------- retrieval
const STOP = new Set('a an and are as at be but by can could do does for from has have how i in is it me my of on or our please should so tell than that the their them there these they this to was we what when where which who why will with would you your weft'.split(' '));
const SELECT = 'id,space_id,body,created_at,author:users(display_name,is_assistant),space:spaces(name,kind)';

async function retrieve(token, question, spaceId, scoped, excludeId) {
  const terms = [...new Set(question.toLowerCase().replace(/@weft\b/g, ' ').match(/[a-z0-9][a-z0-9'-]{1,}/g) || [])]
    .filter((w) => !STOP.has(w)).slice(0, 8);
  const found = new Map();
  const add = (rows) => rows.forEach((r) => { if (!r.author?.is_assistant && r.space?.kind !== 'assistant' && r.id !== excludeId) found.set(r.id, r); });
  if (terms.length) {
    const q = encodeURIComponent(terms.join(' or '));
    add(await rest(token, `/messages?select=${SELECT}&body=wfts(english).${q}&order=created_at.desc&limit=12`));
  }
  if (scoped) add(await rest(token, `/messages?select=${SELECT}&space_id=eq.${spaceId}&order=created_at.desc&limit=15`));
  return [...found.values()].sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(-20);
}

const SYSTEM = `You are Weft, the assistant inside a small team's workspace. Answer the question using only the numbered sources provided. Cite every fact with its source number in square brackets, like [2]. If the sources do not answer the question, say that you could not find it in what this person can see, and do not guess. Never mention, invent or speculate about sources you were not given. Keep answers short and plain.`;

function prompt(question, sources) {
  const lines = sources.map((s, i) => `[${i + 1}] ${s.space.kind === 'channel' ? `#${s.space.name}` : 'direct message'}, ${s.author?.display_name}, ${s.created_at.slice(0, 16).replace('T', ' ')}: ${s.body}`);
  return `Sources:\n${lines.join('\n') || '(none)'}\n\nQuestion: ${question}`;
}

// ---------------------------------------------------------------- providers
class Unavailable extends Error {}

async function callProvider(p, system, user) {
  const t0 = Date.now();
  const key = p.key_ciphertext ? decrypt(p.key_ciphertext) : null;
  if (p.kind === 'anthropic') {
    if (!key) throw new Unavailable('no key set');
    const client = new Anthropic({ apiKey: key, timeout: CALL_TIMEOUT_MS, maxRetries: 1, ...(p.base_url ? { baseURL: p.base_url } : {}) });
    try {
      // Server-side refusal fallback on by default, per Anthropic's guidance for this model family.
      const r = await client.beta.messages.create({
        model: p.model, max_tokens: 2000, system,
        output_config: { effort: p.effort || 'low' },
        betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
        messages: [{ role: 'user', content: user }],
      });
      if (r.stop_reason === 'refusal') return { refused: true, text: '', model: r.model, inTok: r.usage.input_tokens, outTok: r.usage.output_tokens, ms: Date.now() - t0 };
      const text = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      return { text, model: r.model, inTok: r.usage.input_tokens, outTok: r.usage.output_tokens, ms: Date.now() - t0 };
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) throw new Unavailable('rate limited');
      if (e instanceof Anthropic.AuthenticationError) throw new Unavailable('key rejected');
      if (e instanceof Anthropic.APIConnectionError) throw new Unavailable('could not connect');
      if (e instanceof Anthropic.APIError) throw new Unavailable(`API error ${e.status}`);
      throw new Unavailable(e.message);
    }
  }
  // Ollama and OpenAI-compatible endpoints: plain HTTP.
  const ctl = AbortSignal.timeout(CALL_TIMEOUT_MS);
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  let r;
  try {
    r = p.kind === 'ollama'
      ? await fetch(`${p.base_url}/api/chat`, { method: 'POST', signal: ctl, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: p.model, messages, stream: false }) })
      : await fetch(`${p.base_url}/chat/completions`, { method: 'POST', signal: ctl, headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify({ model: p.model, messages }) });
  } catch (e) { throw new Unavailable(e.name === 'TimeoutError' ? 'timed out' : 'could not connect'); }
  if (!r.ok) throw new Unavailable(`HTTP ${r.status}`);
  const d = await r.json();
  return p.kind === 'ollama'
    ? { text: (d.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim(), model: p.model, inTok: d.prompt_eval_count || 0, outTok: d.eval_count || 0, ms: Date.now() - t0 }
    : { text: (d.choices?.[0]?.message?.content || '').trim(), model: d.model || p.model, inTok: d.usage?.prompt_tokens || 0, outTok: d.usage?.completion_tokens || 0, ms: Date.now() - t0 };
}

const cost = (p, r) => (r.inTok * Number(p.price_in) + r.outTok * Number(p.price_out)) / 1e6;

// Primary, then secondary. Failover on unavailability (no key, cap reached, timeouts, rate limits,
// server errors), never on a refusal: a declined question is not re-asked elsewhere.
async function answer(ctx, system, user) {
  const { rows: providers } = await db.query('select * from weft_private.providers_for_call()');
  let reason = null;
  for (const p of providers) {
    if (!p.enabled) { reason = reason || `${p.slot} disabled`; continue; }
    if (p.monthly_cap_usd !== null) {
      const { rows } = await db.query('select weft_private.month_cost($1) as c', [p.slot]);
      if (Number(rows[0].c) >= Number(p.monthly_cap_usd)) { reason = reason || `${p.slot} reached its monthly cap`; continue; }
    }
    try {
      const r = await callProvider(p, system, user);
      const c = cost(p, r);
      await db.query('select weft_private.run_log($1,$2,$3,$4,$5,$6,true,$7,$8,$9,$10,$11,null)',
        [ctx.asker, ctx.space, ctx.question, p.slot, p.kind, r.model, reason, r.inTok, r.outTok, c, r.ms]);
      return { ...r, slot: p.slot, kind: p.kind, fallback: reason };
    } catch (e) {
      if (!(e instanceof Unavailable)) throw e;
      await db.query('select weft_private.run_log($1,$2,$3,$4,$5,$6,false,null,null,null,null,null,$7)',
        [ctx.asker, ctx.space, ctx.question, p.slot, p.kind, p.model, e.message]);
      reason = reason || `${p.slot} ${e.message}`;
    }
  }
  return { unavailable: true, fallback: reason };
}

// ---------------------------------------------------------------- ask
const inflight = new Set();

async function ask(user, messageId) {
  if (!/^[0-9a-f-]{36}$/.test(messageId || '')) return [400, { error: 'message_id required' }];
  // Read the question as the asker: RLS decides whether it exists for them.
  const [q] = await rest(user.token, `/messages?id=eq.${messageId}&select=id,space_id,author_id,body,space:spaces(kind,name)`);
  if (!q) return [404, { error: 'no such message' }];
  if (q.author_id !== user.id) return [403, { error: 'you can only ask with your own message' }];
  const inAssistant = q.space.kind === 'assistant';
  if (!inAssistant && !/@weft\b/i.test(q.body)) return [400, { error: 'mention @Weft to ask in a channel' }];
  if (inflight.has(user.id)) return [429, { error: 'Weft is still answering your last question' }];
  inflight.add(user.id);
  try {
    // In a channel the whole channel reads the answer, so retrieval is scoped to that channel.
    const token = await assistantToken(user.id, inAssistant ? null : q.space_id);
    const sources = await retrieve(token, q.body.replace(/@weft\b/gi, '').trim() || q.body, q.space_id, !inAssistant, q.id);
    const result = await answer({ asker: user.id, space: q.space_id, question: q.id }, SYSTEM, prompt(q.body, sources));

    let body; let citations = [];
    if (result.unavailable) {
      body = `I can't answer right now: no model is available (${result.fallback}).`;
    } else if (result.refused) {
      body = "I can't help with that one.";
    } else {
      const used = [...new Set([...result.text.matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1])))].filter((n) => n >= 1 && n <= sources.length);
      if (!used.length) {
        body = "I couldn't find anything about that in what you can see.";
      } else {
        // Renumber the citations in order of first use so the chips read 1, 2, 3.
        const order = new Map(used.map((n, i) => [n, i + 1]));
        body = result.text.replace(/\[(\d{1,2})\]/g, (all, n) => (order.has(Number(n)) ? `[${order.get(Number(n))}]` : ''));
        citations = used.map((n) => {
          const s = sources[n - 1];
          return { id: s.id, space_id: s.space_id, label: `${s.space.kind === 'channel' ? `#${s.space.name}` : 'direct message'}, ${s.author?.display_name}` };
        });
      }
    }
    const meta = {
      citations,
      ...(result.unavailable ? {} : { served_by: { slot: result.slot, kind: result.kind, model: result.model } }),
      ...(result.fallback ? { fallback: result.fallback } : {}),
      question_id: q.id,
    };
    const [reply] = await rest(token, '/messages', { method: 'POST', body: { space_id: q.space_id, author_id: ASSISTANT_ID, body, meta } });
    return [200, { id: reply.id, sources: sources.length }];
  } finally { inflight.delete(user.id); }
}

// ---------------------------------------------------------------- admin
const SLOTS = new Set(['primary', 'secondary']);
const KINDS = new Set(['anthropic', 'openai', 'ollama']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

async function admin(user, method, parts, body) {
  const { rows } = await db.query('select weft_private.assist_is_admin($1) as a', [user.id]);
  if (!rows[0].a) return [403, { error: 'admins only' }];
  if (method === 'GET' && parts.length === 0) {
    const { rows: p } = await db.query('select * from weft_private.providers_public()');
    return [200, p];
  }
  const slot = parts[0];
  if (!SLOTS.has(slot)) return [404, { error: 'no such slot' }];
  if (method === 'PUT' && parts.length === 1) {
    const b = body || {};
    if (!KINDS.has(b.kind) || !b.model) return [400, { error: 'kind and model are required' }];
    if (b.kind !== 'anthropic' && !/^https?:\/\//.test(b.base_url || '')) return [400, { error: 'base URL required for this provider' }];
    if (b.effort && !EFFORTS.has(b.effort)) return [400, { error: 'bad effort' }];
    const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
    await db.query('select weft_private.provider_save($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [slot, b.kind, b.base_url || null, String(b.model), b.kind === 'anthropic' ? (b.effort || 'low') : null,
        num(b.monthly_cap_usd), num(b.price_in) ?? 0, num(b.price_out) ?? 0, b.enabled !== false, user.id]);
    return [200, { ok: true }];
  }
  if (parts[1] === 'key' && method === 'PUT') {
    const key = String(body?.key || '').trim();
    if (key.length < 8) return [400, { error: 'that does not look like a key' }];
    await db.query('select weft_private.provider_set_key($1,$2,$3,$4)', [slot, encrypt(key), key.slice(-4), user.id]);
    return [200, { ok: true, key_hint: key.slice(-4) }];
  }
  if (parts[1] === 'key' && method === 'DELETE') {
    await db.query('select weft_private.provider_set_key($1,null,null,$2)', [slot, user.id]);
    return [200, { ok: true }];
  }
  if (parts[1] === 'test' && method === 'POST') {
    const { rows: ps } = await db.query('select * from weft_private.providers_for_call() where slot = $1', [slot]);
    try {
      const r = await callProvider(ps[0], 'Reply with the single word OK.', 'Say OK.');
      return [200, { ok: true, model: r.model, ms: r.ms, reply: r.text.slice(0, 40) }];
    } catch (e) { return [200, { ok: false, error: e.message }]; }
  }
  return [404, { error: 'not found' }];
}

// ---------------------------------------------------------------- HTTP
const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve, reject) => {
  let data = ''; req.on('data', (c) => { data += c; if (data.length > 8192) reject(new Error('too large')); });
  req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
});

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/healthz') return send(res, 200, { ok: true });
    const user = await userFrom(req);
    if (!user) return send(res, 401, { error: 'sign in first' });
    const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : null;
    if (req.method === 'POST' && url.pathname === '/assistant/ask') return send(res, ...(await ask(user, body.message_id)));
    const m = /^\/assistant\/admin\/providers(?:\/(.*))?$/.exec(url.pathname);
    if (m) return send(res, ...(await admin(user, req.method, (m[1] || '').split('/').filter(Boolean), body)));
    send(res, 404, { error: 'not found' });
  } catch (e) {
    log('error', url.pathname, e.message);
    send(res, e.status === 404 ? 404 : 500, { error: 'the assistant hit an error' });
  }
}).listen(8090, () => log('weft-assistant on :8090'));
