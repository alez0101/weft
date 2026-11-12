// Phase 3b assistant suite. Runs inside the stack network as container "weft-assist-test"
// (tests/run.sh), with a stand-in OpenAI-compatible model served from this process on :9009.
// The stand-in records every prompt it receives, so the checks can prove what never reached a
// model: Organizers content must not appear in prompts for Pat, nor in any channel-scoped prompt.
import http from 'node:http';

const API = 'http://postgrest:3000';
const AUTH = 'http://svc:8081';
const ASSIST = 'http://assistant:8090';
const MOCK = 'http://weft-assist-test:9009';
const SECRET = 'ORG-SECRET-7731';
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });

// ---------------- the stand-in model
const mock = { primary: 'ok', secondary: 'ok', prompts: [] };
http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => { data += c; });
  req.on('end', () => {
    const slot = req.url.startsWith('/primary') ? 'primary' : 'secondary';
    const body = JSON.parse(data || '{}');
    const user = body.messages?.find((m) => m.role === 'user')?.content || '';
    mock.prompts.push({ slot, user });
    if (mock[slot] === 'fail') { res.writeHead(500); return res.end('{"error":"down"}'); }
    const hasSource = /^\[1\] /m.test(user);
    const text = /nocite/i.test(user) || !hasSource ? 'I am not sure.' : 'Here is what I found [1].';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ model: `mock-${slot}`, choices: [{ message: { content: text } }], usage: { prompt_tokens: 1000, completion_tokens: 200 } }));
  });
}).listen(9009);

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

const w = Math.max(...results.map((x) => x.name.length));
for (const x of results) console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name.padEnd(w)}  ${x.ok ? '' : x.detail}`);
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
