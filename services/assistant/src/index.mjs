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
const ISELECT = 'id,space_id,kind,title,body_text,space:spaces(name,kind)';
const ESELECT = 'id,space_id,title,location,starts_at,ends_at,space:spaces(name,kind)';
const TIMEY = /\b(when|schedule|calendar|event|events|meeting|set|sets|shift|shifts|today|tomorrow|saturday|sunday|week|time|move|reschedule|start|starts)\b/i;
const where = (s) => (s?.kind === 'channel' ? `#${s.name}` : s?.kind === 'personal' ? 'your personal space' : s?.kind === 'dm' ? 'a direct message' : 'your Weft conversation');

// A short excerpt of a document: the paragraphs that mention the question's words, else its start.
function excerpt(text, terms, max = 1200) {
  const paras = String(text || '').split(/\n+/).map((x) => x.trim()).filter(Boolean);
  const hits = paras.filter((x) => terms.some((w) => x.toLowerCase().includes(w)));
  return (hits.length ? hits : paras).join(' / ').slice(0, max);
}

// Messages, documents and events matching the question, all read with the assistant token, so
// row-level security (and, in a channel, the scope_space claim) bounds what can be found.
async function retrieve(token, question, spaceId, scoped, excludeId) {
  const terms = [...new Set(question.toLowerCase().replace(/@weft\b/g, ' ').match(/[a-z0-9][a-z0-9'-]{1,}/g) || [])]
    .filter((w) => !STOP.has(w)).slice(0, 8);
  const out = new Map();
  const put = (key, v) => { if (!out.has(key)) out.set(key, v); };
  const msg = (r) => { if (!r.author?.is_assistant && r.space?.kind !== 'assistant' && r.id !== excludeId && !/@weft\b/i.test(r.body)) put(`m${r.id}`, { type: 'message', ...r }); };
  const q = terms.length ? encodeURIComponent(`"${terms.join(' or ').replace(/"/g, '')}"`) : null;
  if (q) {
    (await rest(token, `/messages?select=${SELECT}&body=wfts(english).${encodeURIComponent(terms.join(' or '))}&order=created_at.desc&limit=12`)).forEach(msg);
    (await rest(token, `/items?select=${ISELECT}&or=(title.wfts(english).${q},body_text.wfts(english).${q})&limit=6`))
      .forEach((r) => put(`i${r.id}`, { type: 'item', ...r, text: excerpt(r.body_text, terms) }));
    (await rest(token, `/events?select=${ESELECT}&or=(title.wfts(english).${q},location.wfts(english).${q})&order=starts_at&limit=10`))
      .forEach((r) => put(`e${r.id}`, { type: 'event', ...r }));
  }
  if (scoped) (await rest(token, `/messages?select=${SELECT}&space_id=eq.${spaceId}&order=created_at.desc&limit=15`)).forEach(msg);
  if (TIMEY.test(question)) {
    (await rest(token, `/events?select=${ESELECT}&ends_at=gte.${new Date().toISOString()}&order=starts_at&limit=10`)).forEach((r) => put(`e${r.id}`, { type: 'event', ...r }));
  }
  const rank = { message: 0, item: 1, event: 2 };
  return [...out.values()].sort((a, b) => rank[a.type] - rank[b.type] || String(a.created_at || a.starts_at).localeCompare(String(b.created_at || b.starts_at))).slice(-28);
}

const SYSTEM = `You are Weft, the assistant inside a small team's workspace. Answer questions about the team's work using only the numbered items provided (chat messages, documents and calendar events) and cite every fact with its number in square brackets, like [2]. If those items do not contain the answer, reply with exactly NOT_FOUND and nothing else; do not guess. Never invent items you were not given. When you talk to the person, call the numbered items "what I can see here" or name them (a message, a document, an event); never say "sources". Address the person as you. Keep answers short and plain: one or two full sentences.

If the person asks about you or what you can do, answer that directly and without citations: you answer from the messages, documents and events they can open (in a channel, only from that channel, because the whole channel reads the answer); you can propose posting a message, creating an event and changing an event; nothing happens until they confirm; and you cannot delete anything.

Example. Sources: [1] message in #festival, Olive, 2026-04-01 09:00: The info booth opens at 11:00. Question: When does the info booth open? Answer: The info booth opens at 11:00 [1].`;

const ACT = `\n\nIf the person asks you to do something, you may propose it with a tool: send_message to post in a channel, create_event to add a new calendar event, or change_event to change an event among the numbered items. A proposal does nothing until the person confirms it, so say in one sentence what you are proposing. Only propose what was asked. Use the person's time zone for times they mention. You cannot delete anything.`;

function fmtTime(iso, tz) {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(iso)); }
  catch { return iso; }
}

function prompt(question, sources, tz) {
  const lines = sources.map((s, i) => {
    const n = `[${i + 1}]`;
    if (s.type === 'item') return `${n} ${s.kind === 'wiki' ? 'wiki page' : 'document'} "${s.title}" in ${where(s.space)}: ${s.text || '(empty)'}`;
    if (s.type === 'event') return `${n} event "${s.title}" in ${where(s.space)}, ${fmtTime(s.starts_at, tz)} to ${fmtTime(s.ends_at, tz)}${s.location ? `, at ${s.location}` : ''}`;
    return `${n} message in ${where(s.space)}, ${s.author?.display_name}, ${s.created_at.slice(0, 16).replace('T', ' ')}: ${s.body}`;
  });
  return `Sources:\n${lines.join('\n') || '(none)'}\n\nThe person's time zone is ${tz}. Question: ${question}`;
}

const label = (s) => (s.type === 'item' ? `${s.kind === 'wiki' ? 'Wiki' : 'Document'}: ${s.title}`
  : s.type === 'event' ? `Event: ${s.title}` : `${where(s.space)}, ${s.author?.display_name}`);

function tools(channels, creatable = []) {
  const nullable = (desc) => ({ anyOf: [{ type: 'string' }, { type: 'null' }], description: desc });
  return [
    {
      name: 'send_message', strict: true,
      description: 'Propose posting a message in a channel. Nothing is sent until the person confirms.',
      input_schema: { type: 'object', additionalProperties: false, required: ['channel', 'text'], properties: {
        channel: { type: 'string', enum: channels.length ? channels : ['(none)'], description: 'Channel name, without #.' },
        text: { type: 'string', description: 'The message to post.' } } },
    },
    {
      name: 'change_event', strict: true,
      description: 'Propose changing a calendar event that appears in the sources. Nothing changes until the person confirms. Use null for anything that stays the same.',
      input_schema: { type: 'object', additionalProperties: false, required: ['source', 'title', 'location', 'starts_at', 'ends_at'], properties: {
        source: { type: 'integer', description: 'The [n] number of the event in the sources.' },
        title: nullable('New title, or null.'), location: nullable('New location, or null.'),
        starts_at: nullable('New start as ISO 8601 with offset, or null.'), ends_at: nullable('New end as ISO 8601 with offset, or null.') } },
    },
    ...(creatable.length ? [{
      name: 'create_event', strict: true,
      description: 'Propose adding a new calendar event. Nothing is created until the person confirms.',
      input_schema: { type: 'object', additionalProperties: false, required: ['space', 'title', 'starts_at', 'ends_at', 'location'], properties: {
        space: { type: 'string', enum: creatable, description: 'Where the event goes: a channel name without #, or "personal".' },
        title: { type: 'string', description: 'Event title.' },
        starts_at: { type: 'string', description: 'Start as ISO 8601 with offset.' },
        ends_at: { type: 'string', description: 'End as ISO 8601 with offset.' },
        location: nullable('Location, or null.') } },
    }] : []),
  ];
}

// ---------------------------------------------------------------- providers
class Unavailable extends Error {}

async function callProvider(p, system, user, toolDefs = null) {
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
        ...(toolDefs ? { tools: toolDefs, tool_choice: { type: 'auto' } } : {}),
      });
      if (r.stop_reason === 'refusal') return { refused: true, text: '', model: r.model, inTok: r.usage.input_tokens, outTok: r.usage.output_tokens, ms: Date.now() - t0 };
      const text = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      const calls = r.content.filter((b) => b.type === 'tool_use').map((b) => ({ name: b.name, input: b.input }));
      return { text, calls, model: r.model, inTok: r.usage.input_tokens, outTok: r.usage.output_tokens, ms: Date.now() - t0 };
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
async function answer(ctx, system, user, toolDefs = null) {
  const { rows: providers } = await db.query('select * from weft_private.providers_for_call()');
  let reason = null;
  for (const p of providers) {
    if (!p.enabled) { reason = reason || `${p.slot} disabled`; continue; }
    if (p.monthly_cap_usd !== null) {
      const { rows } = await db.query('select weft_private.month_cost($1) as c', [p.slot]);
      if (Number(rows[0].c) >= Number(p.monthly_cap_usd)) { reason = reason || `${p.slot} reached its monthly cap`; continue; }
    }
    try {
      // Only Anthropic models get the action tools; the fallback answers read-only.
      const r = await callProvider(p, p.kind === 'anthropic' && toolDefs ? system + ACT : system, user, p.kind === 'anthropic' ? toolDefs : null);
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
const validTz = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return 'UTC'; } };

async function ask(user, messageId, tzIn) {
  if (!/^[0-9a-f-]{36}$/.test(messageId || '')) return [400, { error: 'message_id required' }];
  const tz = validTz(tzIn || 'UTC');
  // Read the question as the asker: RLS decides whether it exists for them.
  const [q] = await rest(user.token, `/messages?id=eq.${messageId}&select=id,space_id,author_id,body,space:spaces(kind,name)`);
  if (!q) return [404, { error: 'no such message' }];
  if (q.author_id !== user.id) return [403, { error: 'you can only ask with your own message' }];
  const inAssistant = q.space.kind === 'assistant';
  if (!inAssistant && !/@weft\b/i.test(q.body)) return [400, { error: 'mention @Weft to ask in a channel' }];
  if (inflight.has(user.id)) return [429, { error: 'Weft is still answering your last question' }];
  inflight.add(user.id);
  try {
    // In a channel the whole channel reads the answer, so everything is scoped to that channel.
    const scope = inAssistant ? null : q.space_id;
    const token = await assistantToken(user.id, scope);
    const question = q.body.replace(/@weft\b/gi, '').trim() || q.body;
    const sources = await retrieve(token, question, q.space_id, !inAssistant, q.id);
    // Channels a proposal may post to: in a channel, only that channel; in your Weft conversation,
    // the channels you are in. (Execution re-checks membership and scope in the database.)
    const chans = await rest(token, '/spaces?kind=eq.channel&select=id,name&order=name');
    // Where a new event could go: spaces in scope where the asker is an owner or editor.
    const mineRoles = await rest(token, `/members?user_id=eq.${user.id}&role=in.(owner,editor)&select=space_id,space:spaces(id,kind,name)`);
    const creatable = mineRoles.map((m) => m.space).filter((s) => s && (s.kind === 'channel' || s.kind === 'personal'))
      .map((s) => ({ id: s.id, name: s.kind === 'personal' ? 'personal' : s.name }));
    const result = await answer({ asker: user.id, space: q.space_id, question: q.id }, SYSTEM, prompt(question, sources, tz),
      tools(chans.map((c) => c.name), creatable.map((c) => c.name)));

    let body; let citations = []; const proposals = [];
    if (result.unavailable) {
      body = `I can't answer right now: no model is available (${result.fallback}).`;
    } else if (result.refused) {
      body = "I can't help with that one.";
    } else {
      for (const c of result.calls || []) {
        const prop = await proposalFrom(c, sources, chans, user.id, q.space_id, scope, tz, creatable);
        if (prop) proposals.push(prop);
      }
      const notFound = /^\W*NOT_FOUND\W*$/i.test(result.text) || result.text.includes('NOT_FOUND');
      const used = notFound ? [] : [...new Set([...result.text.matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1])))].filter((n) => n >= 1 && n <= sources.length);
      const order = new Map(used.map((n, i) => [n, i + 1]));
      if (used.length) {
        body = result.text.replace(/\[(\d{1,2})\]/g, (all, n) => (order.has(Number(n)) ? `[${order.get(Number(n))}]` : ''));
        if (!/[a-z]{3,}/i.test(body.replace(/\[\d+\]/g, ''))) body = `Here is what I found: ${used.map((n) => `[${order.get(n)}]`).join(' ')}`;
        citations = used.map((n) => { const s = sources[n - 1]; return { type: s.type, id: s.id, space_id: s.space_id, label: label(s) }; });
      } else if (proposals.length) {
        body = result.text && !notFound ? result.text.replace(/\[\d{1,2}\]/g, '').trim() : 'Here is what I can do. Nothing happens until you confirm.';
      } else {
        body = "I couldn't find anything about that in what you can see.";
      }
    }
    const meta = {
      citations, ...(proposals.length ? { proposals, asker: user.id } : {}),
      ...(result.unavailable ? {} : { served_by: { slot: result.slot, kind: result.kind, model: result.model } }),
      ...(result.fallback ? { fallback: result.fallback } : {}),
      question_id: q.id,
    };
    const [reply] = await rest(token, '/messages', { method: 'POST', body: { space_id: q.space_id, author_id: ASSISTANT_ID, body, meta } });
    return [200, { id: reply.id, sources: sources.length, proposals: proposals.length }];
  } finally { inflight.delete(user.id); }
}

// Turn a model tool call into a stored proposal, or drop it if it does not hold up.
async function proposalFrom(call, sources, chans, asker, spaceId, scope, tz, creatable = []) {
  const i = call.input || {};
  if (call.name === 'create_event') {
    const sp = creatable.find((c) => c.name === i.space);
    const title = String(i.title || '').trim().slice(0, 200);
    const s = new Date(i.starts_at); const e = new Date(i.ends_at);
    if (!sp || !title || Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e < s) return null;
    const location = i.location ? String(i.location).slice(0, 200) : null;
    const summary = `Add "${title}" to ${sp.name === 'personal' ? 'your personal calendar' : `#${sp.name}`}: ${fmtTime(s.toISOString(), tz)} to ${fmtTime(e.toISOString(), tz)}${location ? `, at ${location}` : ''}`;
    const id = (await db.query('select weft_private.proposal_create($1,$2,$3,$4,$5,$6) as id',
      [asker, spaceId, scope, 'create', { space_id: sp.id, title, starts_at: s.toISOString(), ends_at: e.toISOString(), location }, summary])).rows[0].id;
    return { id, kind: 'create', summary };
  }
  if (call.name === 'send_message') {
    const ch = chans.find((c) => c.name === i.channel);
    const text = String(i.text || '').trim().slice(0, 2000);
    if (!ch || !text) return null;
    const summary = `Post in #${ch.name}: "${text}"`;
    const id = (await db.query('select weft_private.proposal_create($1,$2,$3,$4,$5,$6) as id',
      [asker, spaceId, scope, 'send', { space_id: ch.id, text }, summary])).rows[0].id;
    return { id, kind: 'send', summary };
  }
  if (call.name === 'change_event') {
    const s = sources[Number(i.source) - 1];
    if (!s || s.type !== 'event') return null;
    const set = {};
    if (i.title) set.title = String(i.title).slice(0, 200);
    if (i.location) set.location = String(i.location).slice(0, 200);
    for (const k of ['starts_at', 'ends_at']) if (i[k]) { const d = new Date(i[k]); if (Number.isNaN(d.getTime())) return null; set[k] = d.toISOString(); }
    if (!Object.keys(set).length) return null;
    const starts = set.starts_at || s.starts_at; let ends = set.ends_at || s.ends_at;
    if (set.starts_at && !set.ends_at) { ends = new Date(new Date(set.starts_at).getTime() + (new Date(s.ends_at) - new Date(s.starts_at))).toISOString(); set.ends_at = ends; }
    if (new Date(ends) < new Date(starts)) return null;
    const parts = [];
    if (set.title) parts.push(`rename it "${set.title}"`);
    if (set.starts_at) parts.push(`move it to ${fmtTime(set.starts_at, tz)} to ${fmtTime(ends, tz)}`);
    if (set.location) parts.push(`set the location to ${set.location}`);
    const summary = `Change "${s.title}": ${parts.join(', ')}`;
    const id = (await db.query('select weft_private.proposal_create($1,$2,$3,$4,$5,$6) as id',
      [asker, spaceId, scope, 'change', { event_id: s.id, set }, summary])).rows[0].id;
    return { id, kind: 'change', summary };
  }
  return null;
}

// ---------------------------------------------------------------- proposals: confirm, dismiss, undo
// Only the asker may decide. Execution runs as the assistant acting for the asker, with the original
// scope, through PostgREST: row-level security decides whether the action is allowed at all.
async function proposals(user, method, parts, url) {
  if (method === 'GET' && parts.length === 0) {
    const ids = (url.searchParams.get('ids') || '').split(',').filter((x) => /^[0-9a-f-]{36}$/.test(x)).slice(0, 50);
    if (!ids.length) return [200, []];
    return [200, (await db.query('select * from weft_private.proposal_statuses($1, $2::uuid[])', [user.id, ids])).rows];
  }
  const [id, action] = parts;
  if (!/^[0-9a-f-]{36}$/.test(id || '') || method !== 'POST') return [404, { error: 'not found' }];
  const [p] = (await db.query('select * from weft_private.proposal_get($1)', [id])).rows;
  if (!p || p.asker !== user.id) return [403, { error: 'only the person who asked can decide this' }];
  const move = (from, to, result = null, before = null) =>
    db.query('select weft_private.proposal_transition($1,$2,$3,$4,$5,$6) as ok', [id, user.id, from, to, result, before]).then((r) => r.rows[0].ok);

  if (action === 'dismiss') return (await move('pending', 'dismissed')) ? [200, { status: 'dismissed' }] : [409, { error: 'already decided' }];

  const token = await assistantToken(user.id, p.scope_space);
  if (action === 'confirm') {
    if (Date.now() - new Date(p.created_at).getTime() > 30 * 60 * 1000) { await move('pending', 'failed', 'expired'); return [409, { error: 'this proposal expired; ask again' }]; }
    if (!(await move('pending', 'done', 'running'))) return [409, { error: 'already decided' }];
    try {
      if (p.kind === 'send') {
        const r = await rest(token, '/messages', { method: 'POST', body: { space_id: p.payload.space_id, author_id: ASSISTANT_ID, body: p.payload.text, meta: { sent_for: user.id, proposal_id: id } } }).catch(() => null);
        if (!r?.length) { await move('done', 'failed', 'Not allowed: you can only post where you are a member.'); return [200, { status: 'failed' }]; }
        await move('done', 'done', 'Sent.');
        return [200, { status: 'done' }];
      }
      if (p.kind === 'create') {
        const r = await rest(token, '/events', { method: 'POST', body: p.payload }).catch(() => null);
        if (!r?.length) { await move('done', 'failed', "Not allowed: you can't add events there."); return [200, { status: 'failed' }]; }
        await move('done', 'done', 'Added.', { event_id: r[0].id });
        return [200, { status: 'done' }];
      }
      const [ev] = await rest(token, `/events?id=eq.${p.payload.event_id}&select=title,location,starts_at,ends_at`);
      if (!ev) { await move('done', 'failed', 'That event is gone, or you can no longer see it.'); return [200, { status: 'failed' }]; }
      const before = Object.fromEntries(Object.keys(p.payload.set).map((k) => [k, ev[k]]));
      const changed = await rest(token, `/events?id=eq.${p.payload.event_id}`, { method: 'PATCH', body: p.payload.set });
      if (!changed?.length) { await move('done', 'failed', "Not allowed: you can't change events in that space."); return [200, { status: 'failed' }]; }
      await move('done', 'done', 'Changed.', before);
      return [200, { status: 'done' }];
    } catch (e) { await move('done', 'failed', 'Something went wrong; nothing was changed.'); throw e; }
  }
  if (action === 'undo') {
    if (!['change', 'create'].includes(p.kind) || p.status !== 'done' || !p.before) return [409, { error: 'only a confirmed event change or new event can be undone' }];
    if (p.kind === 'create') {
      // Removing it is a delete, which the assistant can never do; it runs with the person's own token.
      const gone = await rest(user.token, `/events?id=eq.${p.before.event_id}`, { method: 'DELETE' }).catch(() => null);
      if (!gone?.length) return [409, { error: 'could not remove it; it may already be gone' }];
      await move('done', 'undone', 'Removed.');
      return [200, { status: 'undone' }];
    }
    if (Date.now() - new Date(p.decided_at).getTime() > 24 * 3600 * 1000) return [409, { error: 'too late to undo (24 hours)' }];
    const reverted = await rest(token, `/events?id=eq.${p.payload.event_id}`, { method: 'PATCH', body: p.before }).catch(() => null);
    if (!reverted?.length) return [409, { error: 'could not undo; the event may be gone' }];
    await move('done', 'undone', 'Undone.');
    return [200, { status: 'undone' }];
  }
  return [404, { error: 'not found' }];
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
    if (req.method === 'POST' && url.pathname === '/assistant/ask') return send(res, ...(await ask(user, body.message_id, body.tz)));
    const pm = /^\/assistant\/proposals(?:\/(.*))?$/.exec(url.pathname);
    if (pm) return send(res, ...(await proposals(user, req.method, (pm[1] || '').split('/').filter(Boolean), url)));
    const m = /^\/assistant\/admin\/providers(?:\/(.*))?$/.exec(url.pathname);
    if (m) return send(res, ...(await admin(user, req.method, (m[1] || '').split('/').filter(Boolean), body)));
    send(res, 404, { error: 'not found' });
  } catch (e) {
    log('error', url.pathname, e.message);
    send(res, e.status === 404 ? 404 : 500, { error: 'the assistant hit an error' });
  }
}).listen(8090, () => log('weft-assistant on :8090'));
