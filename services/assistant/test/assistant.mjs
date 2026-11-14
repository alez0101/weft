// Phase 3b assistant suite. Runs inside the stack network as container "weft-assist-test"
// (tests/run.sh), with a stand-in OpenAI-compatible model served from this process on :9009.
// The stand-in records every prompt it receives, so the checks can prove what never reached a
// model: Organizers content must not appear in prompts for Pat, nor in any channel-scoped prompt.
import http from 'node:http';
import { SignJWT } from 'jose';

const API = 'http://postgrest:3000';
const AUTH = 'http://svc:8081';
const ASSIST = 'http://assistant:8090';
const MOCK = 'http://weft-assist-test:9009';
const SECRET = 'ORG-SECRET-7731';
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- the stand-in model
const mock = { primary: 'ok', secondary: 'ok', prompts: [], anthropic: [], embedCalls: 0 };
http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => { data += c; });
  req.on('end', () => {
    const body = JSON.parse(data || '{}');
    if (req.url.startsWith('/api/embed')) {
      // A stand-in embedder: words hashed into 768 buckets, with a few synonyms sharing a bucket, so a
      // paraphrase ("electricity") lands near the original ("power") while keyword search misses it.
      mock.embedCalls++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ embeddings: (body.input || []).map(vec) }));
    }
    if (req.url.startsWith('/anthropic')) {
      // Anthropic Messages format, so the real SDK path (tools included) is exercised.
      const user = typeof body.messages?.[0]?.content === 'string' ? body.messages[0].content : '';
      const apiKey = req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer /, '');   // the SDK sends either
      mock.anthropic.push({ user, system: body.system, tools: body.tools, key: apiKey });
      if (apiKey === 'sk-personal-bad-0000') { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })); }
      const content = [];
      const ev = /^\[(\d+)\] event "The Backyard Radio/m.exec(user) || /^\[(\d+)\] event /m.exec(user);
      if (/MOVE-IT/.test(user) && ev) {
        content.push({ type: 'text', text: 'I can change that event for you.' });
        content.push({ type: 'tool_use', id: 'toolu_1', name: 'change_event', input: { source: Number(ev[1]), title: null, location: 'Moved by the Weft test', starts_at: null, ends_at: null } });
      } else if (/ADD-IT/.test(user) && body.tools?.some((x) => x.name === 'create_event')) {
        const sp = body.tools.find((x) => x.name === 'create_event').input_schema.properties.space.enum[0];
        content.push({ type: 'text', text: 'I can add that to the calendar.' });
        content.push({ type: 'tool_use', id: 'toolu_3', name: 'create_event', input: { space: sp, title: 'Weft test meetup', starts_at: '2027-04-12T10:00:00-07:00', ends_at: '2027-04-12T11:00:00-07:00', location: null } });
      } else if (/TELL-THEM/.test(user)) {
        const ch = body.tools?.find((x) => x.name === 'send_message')?.input_schema.properties.channel.enum[0];
        content.push({ type: 'text', text: 'I can post that.' });
        content.push({ type: 'tool_use', id: 'toolu_2', name: 'send_message', input: { channel: ch, text: 'Hello from the Weft test' } });
      } else {
        const first = (/CITE-DOC/.test(user) && /^\[(\d+)\] (?:document|wiki page|table|whiteboard|file) /m.exec(user)) || /^\[(\d+)\] /m.exec(user);
        content.push({ type: 'text', text: first ? `Here is what I found [${first[1]}].` : 'NOT_FOUND' });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: 'mock-claude', content,
        stop_reason: content.some((c) => c.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: { input_tokens: 800, output_tokens: 60 } }));
    }
    const slot = req.url.startsWith('/primary') ? 'primary' : req.url.startsWith('/personal-openai') ? 'personal' : 'secondary';
    const user = body.messages?.find((m) => m.role === 'user')?.content || '';
    mock.prompts.push({ slot, user, tools: body.tools, key: (req.headers.authorization || '').replace(/^Bearer /, '') });
    if (mock[slot] === 'fail') { res.writeHead(500); return res.end('{"error":"down"}'); }
    const hasSource = /^\[1\] /m.test(user);
    const text = /nocite/i.test(user) || !hasSource ? 'I am not sure.' : 'Here is what I found [1].';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ model: `mock-${slot}`, choices: [{ message: { content: text } }], usage: { prompt_tokens: 1000, completion_tokens: 200 } }));
  });
}).listen(9009);

const SYN = { electricity: 'power', electric: 'power', outlet: 'power', generator: 'power', socket: 'power', storm: 'rain', drizzle: 'rain', downpour: 'rain' };
const CONCEPT = new Set(Object.values(SYN));
function vec(text) {
  const v = new Array(768).fill(0);
  const words = String(text).toLowerCase().replace(/^search_(document|query): /, '').match(/[a-z0-9]+/g) || [];
  for (const w0 of words) { const w = SYN[w0] || w0; let h = 0; for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0; v[h % 768] += (SYN[w0] || CONCEPT.has(w0)) ? 4 : 1; }
  const n = Math.hypot(...v) || 1; return v.map((x) => x / n);
}

// ---------------- helpers
async function login(email) {
  const r = await fetch(`${AUTH}/auth/test-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
  return r.json();
}
async function api(token, path, { method = 'GET', body } = {}) {
  const r = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: body && JSON.stringify(body) });
  const t = await r.text(); return { status: r.status, rows: t ? JSON.parse(t) : null };
}
async function assist(token, path, { method = 'GET', body } = {}) {
  const r = await fetch(`${ASSIST}${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const t = await r.text(); return { status: r.status, data: t ? JSON.parse(t) : null, raw: t };
}
async function askIn(who, spaceId, text) {
  const [msg] = (await api(who.token, '/messages', { method: 'POST', body: { space_id: spaceId, body: text } })).rows;
  const before = mock.prompts.length;
  const r = await assist(who.token, '/assistant/ask', { method: 'POST', body: { message_id: msg.id } });
  const reply = r.status === 200 ? (await api(who.token, `/messages?id=eq.${r.data.id}&select=body,author_id,space_id,meta`)).rows[0] : null;
  return { status: r.status, reply, prompts: mock.prompts.slice(before), error: r.data?.error };
}
const slotBody = (slot, extra = {}) => ({ kind: 'openai', base_url: `${MOCK}/${slot}`, model: `mock-${slot}`, price_in: 4, price_out: 20, monthly_cap_usd: 10, enabled: true, ...extra });

// ---------------- setup
const [alex, olive, vic, pat] = await Promise.all(['alex.admin', 'olive.organizer', 'vic.volunteer', 'pat.public'].map((n) => login(`${n}@example.com`)));
const spaces = Object.fromEntries((await api(alex.token, '/spaces?select=id,name,kind')).rows.filter((s) => s.kind === 'channel').map((s) => [s.name, s.id]));
const mine = async (who) => (await api(who.token, '/spaces?kind=eq.assistant&select=id')).rows[0].id;
await api(olive.token, '/messages', { method: 'POST', body: { space_id: spaces.organizers, body: `Host contacts note: P02 host phone 555-0126, code ${SECRET}` } });

// ---------------- admin settings
check('Pat (not admin) cannot read provider settings', (await assist(pat.token, '/assistant/admin/providers')).status === 403);
check('Pat cannot change provider settings', (await assist(pat.token, '/assistant/admin/providers/primary', { method: 'PUT', body: slotBody('primary') })).status === 403);
check('No token: refused', (await assist(null, '/assistant/admin/providers')).status === 401);
const initial = (await assist(alex.token, '/assistant/admin/providers')).data;
check('Starting setup is Anthropic primary and Ollama secondary', initial[0].slot === 'primary' && initial[0].kind === 'anthropic' && initial[0].model === 'claude-opus-5-5' && initial[1].kind === 'ollama', JSON.stringify(initial.map((p) => [p.slot, p.kind, p.model])));
check('Admin saves the primary slot', (await assist(alex.token, '/assistant/admin/providers/primary', { method: 'PUT', body: slotBody('primary') })).status === 200);
check('Admin saves the secondary slot', (await assist(alex.token, '/assistant/admin/providers/secondary', { method: 'PUT', body: slotBody('secondary') })).status === 200);
const KEY = 'sk-test-ABCDEFGHIJKL-9876';
check('Admin saves a key', (await assist(alex.token, '/assistant/admin/providers/primary/key', { method: 'PUT', body: { key: KEY } })).data?.key_hint === '9876');
const after = await assist(alex.token, '/assistant/admin/providers');
check('The key is write-only: settings show the last four characters, never the key', after.data[0].has_key && after.data[0].key_hint === '9876' && !after.raw.includes('ABCDEFGH') && !after.raw.includes('v1:'), after.raw.slice(0, 200));
check('Test connection reaches the stand-in model', (await assist(alex.token, '/assistant/admin/providers/primary/test', { method: 'POST', body: {} })).data?.ok === true);

// ---------------- retrieval stays inside what the asker can see
let r = await askIn(pat, spaces.festival, '@Weft what are the host contacts?');
check('Pat asks in #festival and gets an answer', r.status === 200 && r.reply?.author_id === '00000000-0000-4000-8000-00000000a001', `${r.status} ${r.error || ''}`);
check('Organizers content never reached the model for Pat in #festival', r.prompts.length > 0 && r.prompts.every((p) => !p.user.includes(SECRET) && !p.user.includes('#organizers')));
check('Answer cites only #festival messages', (r.reply?.meta?.citations || []).every((c) => c.space_id === spaces.festival) && (r.reply?.meta?.citations || []).length > 0, JSON.stringify(r.reply?.meta?.citations));
check('Answer records which model wrote it', r.reply?.meta?.served_by?.model === 'mock-primary' && r.reply?.meta?.served_by?.slot === 'primary');
check('Vic sees the answer in #festival', (await api(vic.token, `/messages?space_id=eq.${spaces.festival}&author_id=eq.00000000-0000-4000-8000-00000000a001`)).rows.length >= 1);

r = await askIn(olive, spaces.festival, '@Weft what are the host contacts?');
check('Olive (an organizer) asking in #festival: Organizers content still never reached the model', r.prompts.length > 0 && r.prompts.every((p) => !p.user.includes(SECRET)));

r = await askIn(olive, await mine(olive), 'What are the host contacts?');
check('Olive asking in her own Weft conversation: Organizers content can be used', r.prompts.some((p) => p.user.includes(SECRET)), r.prompts.map((p) => p.user.slice(0, 120)).join(' | '));
check('That answer stays in Olive\'s conversation (Pat cannot read it)', r.reply && (await api(pat.token, `/messages?space_id=eq.${r.reply.space_id}`)).rows.length === 0);

r = await askIn(pat, await mine(pat), 'What are the host contacts?');
check('Pat asking in her own Weft conversation: Organizers content never reached the model', r.prompts.length > 0 && r.prompts.every((p) => !p.user.includes(SECRET)));

// ---------------- no citation, no answer
r = await askIn(pat, spaces.festival, '@Weft nocite tell me something');
check('An answer without a citation is replaced by "couldn\'t find"', /couldn't find/i.test(r.reply?.body || ''), r.reply?.body);

// ---------------- failover and caps
mock.primary = 'fail';
r = await askIn(pat, spaces.festival, '@Weft is the schedule locked?');
check('Primary down: the secondary answers', r.reply?.meta?.served_by?.slot === 'secondary', JSON.stringify(r.reply?.meta));
check('The answer says why it fell back', /primary/.test(r.reply?.meta?.fallback || ''), r.reply?.meta?.fallback);
mock.primary = 'ok';
await assist(alex.token, '/assistant/admin/providers/primary', { method: 'PUT', body: slotBody('primary', { monthly_cap_usd: 0.01 }) });
await askIn(pat, spaces.festival, '@Weft is the schedule locked?'); // spends past the tiny cap
r = await askIn(pat, spaces.festival, '@Weft is the schedule locked?');
check('Primary over its monthly cap: the secondary answers, and says so', r.reply?.meta?.served_by?.slot === 'secondary' && /cap/.test(r.reply?.meta?.fallback || ''), JSON.stringify(r.reply?.meta));
await assist(alex.token, '/assistant/admin/providers/primary', { method: 'PUT', body: slotBody('primary', { enabled: false }) });
await assist(alex.token, '/assistant/admin/providers/secondary', { method: 'PUT', body: slotBody('secondary', { enabled: false }) });
r = await askIn(pat, spaces.festival, '@Weft anyone there?');
check('Both slots off: Weft says no model is available instead of failing silently', /no model is available/.test(r.reply?.body || ''), r.reply?.body);

// ---------------- who can ask what
const [oliveMsg] = (await api(olive.token, '/messages', { method: 'POST', body: { space_id: spaces.festival, body: '@Weft Olive question' } })).rows;
check('Pat cannot ask with Olive\'s message', (await assist(pat.token, '/assistant/ask', { method: 'POST', body: { message_id: oliveMsg.id } })).status === 403);
const [orgMsg] = (await api(olive.token, '/messages', { method: 'POST', body: { space_id: spaces.organizers, body: '@Weft organizers question' } })).rows;
check('Pat cannot ask about a message she cannot see', (await assist(pat.token, '/assistant/ask', { method: 'POST', body: { message_id: orgMsg.id } })).status === 404);
const [plain] = (await api(pat.token, '/messages', { method: 'POST', body: { space_id: spaces.festival, body: 'no mention here' } })).rows;
check('In a channel, Weft only answers when mentioned', (await assist(pat.token, '/assistant/ask', { method: 'POST', body: { message_id: plain.id } })).status === 400);

// ================================================================ Phase 6: documents, events, actions
const anthropicSlot = { kind: 'anthropic', base_url: `${MOCK}/anthropic`, model: 'mock-claude', effort: 'low', price_in: 4, price_out: 20, monthly_cap_usd: 10, enabled: true };
await assist(alex.token, '/assistant/admin/providers/primary', { method: 'PUT', body: anthropicSlot });
await assist(alex.token, '/assistant/admin/providers/primary/key', { method: 'PUT', body: { key: 'sk-test-anthropic-mock-0001' } });
await assist(alex.token, '/assistant/admin/providers/secondary', { method: 'PUT', body: slotBody('secondary') });
const items6 = Object.fromEntries((await api(alex.token, '/items?select=id,title')).rows.map((x) => [x.title, x.id]));
const DOCSECRET = 'HOSTDOC-SECRET-5512';
await api(olive.token, `/items?id=eq.${items6['Host contacts']}`, { method: 'PATCH', body: { body_text: `Host contacts list. Emergency code ${DOCSECRET}.` } });
const askA = async (who, spaceId, text) => {
  const [m] = (await api(who.token, '/messages', { method: 'POST', body: { space_id: spaceId, body: text } })).rows;
  const before = mock.anthropic.length;
  const r = await assist(who.token, '/assistant/ask', { method: 'POST', body: { message_id: m.id, tz: 'America/Los_Angeles' } });
  const reply = r.status === 200 ? (await api(who.token, `/messages?id=eq.${r.data.id}&select=body,meta,space_id`)).rows[0] : null;
  return { status: r.status, reply, calls: mock.anthropic.slice(before), error: r.data?.error };
};

// Documents: same scoping as messages.
let a6 = await askA(pat, spaces.festival, '@Weft what are the host contacts?');
check('Documents: a secret in an Organizers document never reaches the model for Pat in #festival', a6.calls.length === 1 && !a6.calls[0].user.includes(DOCSECRET), a6.error);
a6 = await askA(olive, spaces.festival, '@Weft what are the host contacts?');
check('Documents: nor for Olive asking in #festival', a6.calls.length === 1 && !a6.calls[0].user.includes(DOCSECRET));
a6 = await askA(olive, await mine(olive), 'CITE-DOC What are the host contacts?');
check('Documents: Olive in her own conversation does get it (positive control)', a6.calls[0]?.user.includes(DOCSECRET));
check('Documents: the answer cites the document as a document', a6.reply?.meta?.citations?.[0]?.type === 'item', JSON.stringify(a6.reply?.meta?.citations));

// Events: retrieved, cited as events, with times in the asker's time zone.
a6 = await askA(pat, spaces.festival, '@Weft when does The Backyard Radio play?');
check('Events: retrieved for Pat in #festival', /\] event "The Backyard Radio at P02"/.test(a6.calls[0]?.user || ''), (a6.calls[0]?.user || '').slice(0, 300));
check('Events: times are given in the asker\'s time zone', /PDT|PST/.test(a6.calls[0]?.user || ''));
const ev6 = (await api(olive.token, `/events?title=eq.The%20Backyard%20Radio%20at%20P02&select=id,location`)).rows[0];

// Tools: offered only on the Anthropic slot, scoped to the channel.
check('Tools: Claude is offered exactly send_message and change_event, no delete', JSON.stringify((a6.calls[0]?.tools || []).map((x) => x.name).sort()) === '["change_event","send_message"]');
check('Tools: in #festival, send_message can only target #festival', JSON.stringify(a6.calls[0]?.tools?.find((x) => x.name === 'send_message')?.input_schema.properties.channel.enum) === '["festival"]');

// A change waits for confirmation.
a6 = await askA(olive, spaces.festival, '@Weft MOVE-IT: change where The Backyard Radio plays');
const prop = a6.reply?.meta?.proposals?.[0];
check('Change: Weft proposes instead of acting', prop?.kind === 'change' && a6.reply.meta.asker === olive.user.id, JSON.stringify(a6.reply?.meta));
check('Change: nothing changed before confirmation', (await api(olive.token, `/events?id=eq.${ev6.id}&select=location`)).rows[0].location === ev6.location);
check('Change: Pat cannot confirm Olive\'s proposal', (await assist(pat.token, `/assistant/proposals/${prop.id}/confirm`, { method: 'POST', body: {} })).status === 403);
check('Change: Olive confirms', (await assist(olive.token, `/assistant/proposals/${prop.id}/confirm`, { method: 'POST', body: {} })).data?.status === 'done');
check('Change: the event is changed', (await api(olive.token, `/events?id=eq.${ev6.id}&select=location`)).rows[0].location === 'Moved by the Weft test');
const aud = (await api(olive.token, `/audit?row_id=eq.${ev6.id}&select=actor_role,actor_id,old_row&order=id.desc&limit=1`)).rows[0];
check('Change: audited as the assistant acting for Olive, with the old value', aud?.actor_role === 'weft_assistant' && aud.actor_id === olive.user.id && aud.old_row.location === ev6.location, JSON.stringify(aud));
check('Change: confirming twice does nothing', (await assist(olive.token, `/assistant/proposals/${prop.id}/confirm`, { method: 'POST', body: {} })).status === 409);
check('Change: Olive undoes it', (await assist(olive.token, `/assistant/proposals/${prop.id}/undo`, { method: 'POST', body: {} })).data?.status === 'undone');
check('Change: the event is back as it was', (await api(olive.token, `/events?id=eq.${ev6.id}&select=location`)).rows[0].location === ev6.location);

// A viewer's confirmed change is still refused by the database.
a6 = await askA(pat, spaces.festival, '@Weft MOVE-IT: change where The Backyard Radio plays');
const pprop = a6.reply?.meta?.proposals?.[0];
const pc = await assist(pat.token, `/assistant/proposals/${pprop?.id}/confirm`, { method: 'POST', body: {} });
check('Viewer: Pat confirms her own proposal, but the database refuses the change', pc.data?.status === 'failed', JSON.stringify(pc.data));
check('Viewer: the event is unchanged', (await api(olive.token, `/events?id=eq.${ev6.id}&select=location`)).rows[0].location === ev6.location);

// Sending a message, after confirmation, as Weft.
a6 = await askA(olive, await mine(olive), 'TELL-THEM: post a hello');
const sprop = a6.reply?.meta?.proposals?.[0];
check('Send: Weft proposes a message', sprop?.kind === 'send', JSON.stringify(a6.reply?.meta));
const beforeCount = (await api(olive.token, `/messages?space_id=eq.${spaces.festival}&body=eq.Hello%20from%20the%20Weft%20test`)).rows.length;
check('Send: nothing posted before confirmation', beforeCount === 0);
await assist(olive.token, `/assistant/proposals/${sprop.id}/confirm`, { method: 'POST', body: {} });
const posted = (await api(olive.token, `/messages?space_id=eq.${spaces.festival}&body=eq.Hello%20from%20the%20Weft%20test&select=author_id`)).rows;
check('Send: posted in #festival as Weft after confirmation', posted.length === 1 && posted[0].author_id === '00000000-0000-4000-8000-00000000a001');

// Creating an event: proposed, confirmed, and undone as the asker.
a6 = await askA(olive, spaces.festival, '@Weft ADD-IT: schedule a meetup Monday at 10');
const cprop = a6.reply?.meta?.proposals?.[0];
check('Create: Weft proposes a new event in #festival', cprop?.kind === 'create' && /#festival/.test(cprop.summary), JSON.stringify(a6.reply?.meta));
check('Create: nothing created before confirmation', (await api(olive.token, '/events?title=eq.Weft%20test%20meetup&select=id')).rows.length === 0);
await assist(olive.token, `/assistant/proposals/${cprop.id}/confirm`, { method: 'POST', body: {} });
const made = (await api(olive.token, '/events?title=eq.Weft%20test%20meetup&select=id,space_id,created_by,starts_at')).rows;
check('Create: confirmed, the event exists in #festival, created by Olive, at 10:00 Pacific', made.length === 1 && made[0].space_id === spaces.festival && made[0].created_by === olive.user.id && made[0].starts_at.startsWith('2027-04-12T17:00'), JSON.stringify(made));
check('Create: Undo removes it', (await assist(olive.token, `/assistant/proposals/${cprop.id}/undo`, { method: 'POST', body: {} })).data?.status === 'undone'
  && (await api(olive.token, '/events?title=eq.Weft%20test%20meetup&select=id')).rows.length === 0);
const del = (await api(olive.token, `/audit?row_id=eq.${made[0].id}&op=eq.DELETE&select=actor_role,actor_id`)).rows[0];
check('Create: the removal was done as Olive herself, not the assistant', del?.actor_role === 'weft_user' && del.actor_id === olive.user.id, JSON.stringify(del));
a6 = await askA(pat, spaces.festival, '@Weft ADD-IT: schedule a meetup Monday at 10');
check('Create: Pat (viewer in #festival) is not offered create_event there', !(a6.calls[0]?.tools || []).some((x) => x.name === 'create_event') && !a6.reply?.meta?.proposals);
a6 = await askA(pat, await mine(pat), 'ADD-IT: put a reminder on my calendar');
const pcre = a6.reply?.meta?.proposals?.[0];
const penum = a6.calls[0]?.tools?.find((x) => x.name === 'create_event')?.input_schema.properties.space.enum || [];
check('Create: in her own conversation Pat can add to her personal calendar, never to #festival where she only views', penum.includes('personal') && !penum.includes('festival') && pcre?.kind === 'create', JSON.stringify({ status: a6.status, err: a6.error, tools: (a6.calls[0]?.tools || []).map((x) => [x.name, x.input_schema.properties.space?.enum]), meta: a6.reply?.meta, body: a6.reply?.body }));

// Dismiss.
a6 = await askA(olive, spaces.festival, '@Weft MOVE-IT: change where The Backyard Radio plays');
const dprop = a6.reply?.meta?.proposals?.[0];
check('Dismiss: Olive dismisses a proposal', (await assist(olive.token, `/assistant/proposals/${dprop.id}/dismiss`, { method: 'POST', body: {} })).data?.status === 'dismissed');
check('Dismiss: a dismissed proposal cannot be confirmed', (await assist(olive.token, `/assistant/proposals/${dprop.id}/confirm`, { method: 'POST', body: {} })).status === 409);
check('Statuses: Pat cannot read Olive\'s proposal statuses', ((await assist(pat.token, `/assistant/proposals?ids=${dprop.id}`)).data || []).length === 0);

// Tables (version 1.5): read like documents, scoped the same way.
a6 = await askA(pat, spaces.festival, '@Weft which porches have no power?');
check('Tables: the Porches table reaches the model for Pat in #festival, labelled as a table', /\] table "Porches" in #festival: Columns: Porch/.test(a6.calls[0]?.user || ''), (a6.calls[0]?.user || '').slice(0, 200));
a6 = await askA(pat, await mine(pat), 'What is in the budget?');
check('Tables: the Organizers Budget never reaches the model for Pat', a6.calls.length === 1 && !a6.calls[0].user.includes('ORG-BUDGET-SECRET'));
a6 = await askA(olive, await mine(olive), 'CITE-DOC What is in the budget?');
check('Tables: Olive in her own conversation gets the Budget, cited as a table', a6.calls[0]?.user.includes('ORG-BUDGET-SECRET') && /^Table: /.test(a6.reply?.meta?.citations?.[0]?.label || ''), JSON.stringify(a6.reply?.meta?.citations));

// ================================================================ files
const [fileIt] = (await api(olive.token, '/items', { method: 'POST', body: { space_id: spaces.organizers, kind: 'file', title: 'Insurance.pdf', body_text: 'Insurance certificate number INS-FILE-8812 covers the stage.' } })).rows;
a6 = await askA(olive, await mine(olive), 'CITE-DOC What does the insurance certificate cover?');
check('Files: the assistant reads a file\'s text, labelled as a file', /\] file "Insurance\.pdf"/.test(a6.calls[0]?.user || '') && (a6.calls[0]?.user || '').includes('INS-FILE-8812'), (a6.calls[0]?.user || '').slice(0, 300));
check('Files: and cites it as a file', (a6.reply?.meta?.citations || []).some((c) => /^File: Insurance\.pdf/.test(c.label || '')), JSON.stringify(a6.reply?.meta?.citations));
a6 = await askA(pat, await mine(pat), 'What does the insurance certificate cover?');
check('Files: Pat never gets an Organizers file\'s text', !(a6.calls[0]?.user || '').includes('INS-FILE-8812'));

// ================================================================ glossary
// A glossary's terms reach the model as its text, labelled as a glossary, so Weft can explain the group's
// own words; an Organizers glossary never reaches it for Pat.
const [festGl] = (await api(olive.token, '/items', { method: 'POST', body: { space_id: spaces.festival, kind: 'glossary', title: 'Festival words' } })).rows;
await api(olive.token, '/glossary_terms', { method: 'POST', body: { glossary_id: festGl.id, term: 'FOH', definition: 'Front of house: everything the audience sees, from the gate to the bar.' } });
const [orgGl] = (await api(olive.token, '/items', { method: 'POST', body: { space_id: spaces.organizers, kind: 'glossary', title: 'Organizer words' } })).rows;
await api(olive.token, '/glossary_terms', { method: 'POST', body: { glossary_id: orgGl.id, term: 'Headliner cap', definition: 'GLOSS-ORG-SECRET-4410: the most we pay one act.' } });
a6 = await askA(pat, spaces.festival, '@Weft what does FOH mean?');
check('Glossary: a #festival term reaches the model for Pat in #festival, labelled as a glossary',
  /\] glossary \([^)]*\) "Festival words" in #festival: FOH: Front of house/.test(a6.calls[0]?.user || ''), (a6.calls[0]?.user || '').slice(0, 300));
a6 = await askA(pat, await mine(pat), 'What is the headliner cap?');
check('Glossary: an Organizers glossary never reaches the model for Pat', !(a6.calls[0]?.user || '').includes('GLOSS-ORG-SECRET'));
a6 = await askA(olive, spaces.festival, '@Weft what is the headliner cap?');
check('Glossary: nor for Olive in #festival (the channel scope)', !(a6.calls[0]?.user || '').includes('GLOSS-ORG-SECRET'));
a6 = await askA(olive, await mine(olive), 'What is the headliner cap?');
check('Glossary: Olive in her own conversation gets it (positive control)', (a6.calls[0]?.user || '').includes('GLOSS-ORG-SECRET-4410'), (a6.calls[0]?.user || '').slice(0, 300));
await api(olive.token, `/items?id=in.(${festGl.id},${orgGl.id})`, { method: 'DELETE' });

// ================================================================ personal keys
const pk = (who, path = '', opts = {}) => assist(who.token, `/assistant/me/provider${path}`, opts);
let pr = await pk(pat);
check('Personal keys: off by default', pr.status === 200 && pr.data.allowed === false && pr.data.provider === null, JSON.stringify(pr.data));
check('Personal keys: cannot be saved while off', (await pk(pat, '', { method: 'PUT', body: { kind: 'anthropic', model: 'mock-claude-pat' } })).status === 403);
check('Personal keys: only admins can turn them on', (await assist(pat.token, '/assistant/admin/settings', { method: 'PUT', body: { allow_personal_keys: true } })).status === 403);
pr = await assist(alex.token, '/assistant/admin/settings', { method: 'PUT', body: { allow_personal_keys: true } });
check('Personal keys: an admin turns them on', pr.status === 200 && pr.data.allow_personal_keys === true);
check('Personal keys: no custom server addresses (only Anthropic or OpenAI)', (await pk(pat, '', { method: 'PUT', body: { kind: 'ollama', model: 'x', base_url: 'http://postgres:5432' } })).status === 400);
check('Personal keys: model names are checked', (await pk(pat, '', { method: 'PUT', body: { kind: 'anthropic', model: "bad model'; drop" } })).status === 400);
check('Personal keys: a key needs a provider first', (await pk(pat, '/key', { method: 'PUT', body: { key: 'sk-personal-pat-1234' } })).status === 400);
check('Personal keys: Pat saves her provider', (await pk(pat, '', { method: 'PUT', body: { kind: 'anthropic', model: 'mock-claude-pat', effort: 'low', price_in: 1, price_out: 5 } })).status === 200);
const PATKEY = 'sk-personal-pat-ABCDEF-5678';
check('Personal keys: Pat saves her key and sees only its last four characters', (await pk(pat, '/key', { method: 'PUT', body: { key: PATKEY } })).data?.key_hint === '5678');
pr = await pk(pat);
check('Personal keys: the key is never returned', pr.data.provider?.has_key && pr.data.provider.key_hint === '5678' && !JSON.stringify(pr.data).includes('ABCDEF'), JSON.stringify(pr.data));
const tc = await pk(pat, '/test', { method: 'POST', body: {} });
check('Personal keys: test connection uses her key', tc.data?.ok === true && mock.anthropic.at(-1).key === PATKEY, JSON.stringify(tc.data));
a6 = await askA(pat, await mine(pat), 'What are the host contacts?');
check("Personal keys: Pat's question is answered with Pat's key", a6.calls[0]?.key === PATKEY && a6.reply?.meta?.served_by?.slot === 'personal' && a6.reply?.meta?.served_by?.model === 'mock-claude', JSON.stringify(a6.reply?.meta?.served_by));
check('Personal keys: an Anthropic personal key can propose actions too', (a6.calls[0]?.tools || []).length > 0);
a6 = await askA(olive, await mine(olive), 'What are the host contacts?');
check("Personal keys: Olive's question uses the workspace key, never Pat's", a6.calls[0]?.key === 'sk-test-anthropic-mock-0001' && a6.reply?.meta?.served_by?.slot === 'primary', a6.calls[0]?.key);
a6 = await askA(pat, spaces.festival, '@Weft what are the host contacts?');
check("Personal keys: Pat's @Weft in a channel uses her key, still only that channel's content", a6.calls[0]?.key === PATKEY && !(a6.calls[0]?.user || '').includes(SECRET));
const adm = await assist(alex.token, '/assistant/admin/settings');
check('Personal keys: admins see only how many exist, not whose or which', adm.data.personal_keys === 1 && !/5678|mock-claude-pat|ABCDEF/.test(JSON.stringify(adm.data)) && !JSON.stringify(adm.data).includes(pat.user.id), JSON.stringify(adm.data));
check("Personal keys: the admin provider list never includes them", !/mock-claude-pat|5678/.test(JSON.stringify((await assist(alex.token, '/assistant/admin/providers')).data)));
check("Personal keys: nobody can read someone else's (Alex sees only his own, none)", (await pk(alex)).data.provider === null);
await pk(pat, '/key', { method: 'PUT', body: { key: 'sk-personal-bad-0000' } });
a6 = await askA(pat, await mine(pat), 'What are the host contacts?');
check('Personal keys: a rejected key falls back to the workspace model, saying why', a6.reply?.meta?.served_by?.slot === 'primary' && /your own key: key rejected/.test(a6.reply?.meta?.fallback || ''), JSON.stringify(a6.reply?.meta));
await pk(pat, '/key', { method: 'PUT', body: { key: PATKEY } });
pr = await pk(pat);
check('Personal keys: her spending is tracked separately', Number(pr.data.provider.month_cost_usd) > 0, String(pr.data.provider.month_cost_usd));
await pk(pat, '', { method: 'PUT', body: { kind: 'anthropic', model: 'mock-claude-pat', price_in: 1, price_out: 5, monthly_cap_usd: 0 } });
a6 = await askA(pat, await mine(pat), 'What are the host contacts?');
check('Personal keys: at her own monthly cap, the workspace model answers', a6.reply?.meta?.served_by?.slot === 'primary' && /your own key reached its monthly cap/.test(a6.reply?.meta?.fallback || ''), JSON.stringify(a6.reply?.meta));
await pk(pat, '', { method: 'PUT', body: { kind: 'openai', model: 'mock-gpt-pat' } });
let po = await askIn(pat, await mine(pat), 'What are the host contacts?');
check('Personal keys: an OpenAI key goes to the fixed OpenAI address with her key', po.prompts.some((x) => x.slot === 'personal' && x.key === PATKEY) && po.reply?.meta?.served_by?.slot === 'personal', JSON.stringify(po.prompts.map((x) => [x.slot, x.key])));
await assist(alex.token, '/assistant/admin/settings', { method: 'PUT', body: { allow_personal_keys: false } });
po = await askIn(pat, await mine(pat), 'What are the host contacts?');
const before = mock.anthropic.length;
check('Personal keys: turned off by the admin, her key is not used', !po.prompts.some((x) => x.slot === 'personal') && po.reply?.meta?.served_by?.slot !== 'personal', JSON.stringify(po.reply?.meta?.served_by));
pr = await pk(pat);
check('Personal keys: turned off, it is kept (not deleted) and cannot be changed', pr.data.allowed === false && pr.data.provider?.has_key && (await pk(pat, '/key', { method: 'PUT', body: { key: PATKEY } })).status === 403);
check('Personal keys: she can always remove it', (await pk(pat, '', { method: 'DELETE' })).status === 200 && (await pk(pat)).data.provider === null);
void before;

// ================================================================ semantic search
const POWERMSG = 'Porch P11 lost its outlet, the band cannot plug in';
const [semMsg] = (await api(olive.token, '/messages', { method: 'POST', body: { space_id: spaces.festival, body: POWERMSG } })).rows;
const [orgSem] = (await api(olive.token, '/messages', { method: 'POST', body: { space_id: spaces.organizers, body: 'Generator rental is booked ORG-SEM-SECRET' } })).rows;
// Wait for the worker to embed them (it polls every few seconds).
let embedded = false;
for (let i = 0; i < 60 && !embedded; i++) {
  embedded = (await api(olive.token, `/embeddings?source_id=in.(${semMsg.id},${orgSem.id})&select=source_id`)).rows.length === 2;
  if (!embedded) await sleep(1000);
}
check('Semantic: the worker embedded new messages', embedded && mock.embedCalls > 0, `calls=${mock.embedCalls}`);
check('Semantic: Pat cannot read the embedding of an Organizers message', (await api(pat.token, `/embeddings?source_id=eq.${orgSem.id}`)).rows.length === 0);
const qv = `[${vec('search_query: generator').join(',')}]`;
const patHits = (await api(pat.token, '/rpc/semantic_search', { method: 'POST', body: { p_query: qv, p_limit: 20 } })).rows || [];
check('Semantic: Pat\'s vector search never returns Organizers content', patHits.length > 0 && !patHits.some((h) => h.source_id === orgSem.id || /ORG-SEM/.test(h.content)), JSON.stringify(patHits.slice(0, 2)));
const scopedTok = await new SignJWT({ role: 'weft_assistant', scope_space: spaces.festival }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
  .setSubject(olive.user?.id || JSON.parse(Buffer.from(olive.token.split('.')[1], 'base64url')).sub).setIssuedAt().setExpirationTime('120s').sign(new TextEncoder().encode(process.env.JWT_SECRET));
const scopedHits = (await api(scopedTok, '/rpc/semantic_search', { method: 'POST', body: { p_query: qv, p_limit: 20 } })).rows || [];
check('Semantic: a festival-scoped assistant search never returns Organizers content', scopedHits.length > 0 && !scopedHits.some((h) => h.source_id === orgSem.id));
// A paraphrase keyword search would miss: "electricity" vs "outlet/plug".
// In her own conversation there is no recent-channel context, so only search can bring the message in.
a6 = await askA(pat, await mine(pat), 'Any electricity trouble?');
check('Semantic: a paraphrased question finds the message ("electricity" finds "outlet")', (a6.calls[0]?.user || '').includes(POWERMSG), (a6.calls[0]?.user || '').slice(0, 400));
check('Semantic: and still no Organizers content for Pat', !(a6.calls[0]?.user || '').includes('ORG-SEM-SECRET'));
a6 = await askA(pat, spaces.festival, '@Weft any electricity trouble?');
check('Semantic: Pat asking in #festival gets no Organizers content', !(a6.calls[0]?.user || '').includes('ORG-SEM-SECRET'));
a6 = await askA(olive, spaces.festival, '@Weft any electricity trouble?');
check('Semantic: Olive asking in #festival gets no Organizers content either', !(a6.calls[0]?.user || '').includes('ORG-SEM-SECRET'));
a6 = await askA(olive, await mine(olive), 'Any electricity trouble?');
check('Semantic: Olive in her own conversation does find the Organizers note (positive control)', (a6.calls[0]?.user || '').includes('ORG-SEM-SECRET'));
const rel = (who, q) => assist(who.token, `/assistant/search/related?q=${encodeURIComponent(q)}`);
let rr = await rel(pat, 'electricity trouble');
check('Search by meaning: Pat finds the outlet message from "electricity trouble"', rr.status === 200 && rr.data.results.some((x) => x.id === semMsg.id), JSON.stringify(rr.data).slice(0, 300));
check('Search by meaning: never an Organizers note for Pat', !rr.data.results.some((x) => x.id === orgSem.id || /ORG-SEM/.test(x.snippet || '')));
rr = await rel(pat, 'generator rental booking');
check('Search by meaning: not even when Pat searches its exact words', !rr.data.results.some((x) => x.id === orgSem.id || /ORG-SEM/.test(x.snippet || '')), JSON.stringify(rr.data.results.map((x) => x.snippet)));
rr = await rel(olive, 'generator rental booking');   // her own earlier questions would crowd a query about electricity
check('Search by meaning: Olive does find the Organizers note (positive control)', rr.data.results.some((x) => x.id === orgSem.id), JSON.stringify(rr.data.results.map((x) => x.id)));
check('Search by meaning: no token, no results', (await assist(null, '/assistant/search/related?q=electricity')).status === 401);
check('Search by meaning: questions asked to Weft are not listed as related', !(await rel(pat, 'electricity trouble')).data.results.some((x) => x.space_kind === 'assistant' || /@weft/i.test(x.snippet || '')));
check('Search by meaning: very short searches return nothing', (await rel(pat, 'el')).data.results.length === 0);
await api(olive.token, `/messages?id=eq.${semMsg.id}`, { method: 'DELETE' });
check('Semantic: deleting a message deletes its embedding', (await api(olive.token, `/embeddings?source_id=eq.${semMsg.id}`)).rows.length === 0);
const prog = await assist(alex.token, '/assistant/admin/providers/embeddings');
check('Semantic: admins can see embedding progress', prog.status === 200 && prog.data.chunks > 0, JSON.stringify(prog.data));
check('Semantic: non-admins cannot', (await assist(pat.token, '/assistant/admin/providers/embeddings')).status === 403);

// The fallback answers read-only: no tools are sent to it.
await assist(alex.token, '/assistant/admin/providers/primary', { method: 'PUT', body: { ...anthropicSlot, enabled: false } });
await assist(alex.token, '/assistant/admin/providers/secondary', { method: 'PUT', body: slotBody('secondary') });
const fb0 = mock.prompts.length;
a6 = await askA(olive, spaces.festival, '@Weft MOVE-IT: change where The Backyard Radio plays');
check('Fallback: answers without tools, so it cannot propose actions', mock.prompts.slice(fb0).every((x) => !x.tools) && !a6.reply?.meta?.proposals, JSON.stringify(a6.reply?.meta));

const w = Math.max(...results.map((x) => x.name.length));
for (const x of results) console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name.padEnd(w)}  ${x.ok ? '' : x.detail}`);
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
