// Personal agents suite (067). Runs inside the stack network as container "weft-agents-test" (tests/run.sh),
// with a stand-in agent (OpenAI-compatible, like Hermes Agent's API server) served from this process on
// :9010. The stand-in records every request, so the checks can prove who could reach an agent and what it
// was sent: only its owner asks it, a channel question carries only that channel, and each conversation is
// its own session.
import http from 'node:http';

const API = 'http://postgrest:3000';
const AUTH = 'http://svc:8081';
const ASSIST = 'http://assistant:8090';
const AGENT = 'http://weft-agents-test:9010/v1';
const SECRET = 'AGENT-ORG-SECRET-4410';
const KEY = 'hermes-test-key-ABCDEFGH-2468';
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- the stand-in agent
const agent = { calls: [], mode: 'ok' };
http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => { data += c; });
  req.on('end', () => {
    const auth = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (auth !== KEY) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"error":{"message":"bad key"}}'); }
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'hermes-agent', object: 'model' }] }));
    }
    const body = JSON.parse(data || '{}');
    agent.calls.push({ session: req.headers['x-hermes-session-id'], model: body.model, messages: body.messages, url: req.url });
    if (agent.mode === 'fail') { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end('{"error":{"message":"agent down"}}'); }
    const last = body.messages?.at(-1)?.content || '';
    const reply = () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion', model: 'hermes-agent',
        choices: [{ index: 0, message: { role: 'assistant', content: `Agent heard: ${last.split('\n').at(-1).slice(0, 80)}` }, finish_reason: 'stop' }] }));
    };
    if (agent.mode === 'slow') setTimeout(reply, 1500); else reply();
  });
}).listen(9010);

// ---------------- helpers
async function login(email) {
  const r = await fetch(`${AUTH}/auth/test-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
  return r.json();
}
async function api(token, path, { method = 'GET', body } = {}) {
  const r = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: body && JSON.stringify(body) });
  const t = await r.text(); let rows = null; try { rows = t ? JSON.parse(t) : null; } catch { rows = t; }
  return { status: r.status, rows };
}
async function assist(token, path, { method = 'GET', body } = {}) {
  const r = await fetch(`${ASSIST}${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const t = await r.text(); let data = null; try { data = t ? JSON.parse(t) : null; } catch { data = t; }
  return { status: r.status, data, raw: t };
}
const post = async (who, spaceId, text) => (await api(who.token, '/messages', { method: 'POST', body: { space_id: spaceId, body: text } })).rows?.[0];
// Ask, then wait for the agent's reply to land in the space (the answer arrives after the 202).
async function askAgent(who, spaceId, text, agentId) {
  const msg = await post(who, spaceId, text);
  const before = agent.calls.length;
  const r = await assist(who.token, '/assistant/agents/ask', { method: 'POST', body: { message_id: msg.id } });
  let reply = null;
  if (r.status === 202) {
    for (let i = 0; i < 50 && !reply; i++) {
      await sleep(100);
      reply = (await api(who.token, `/messages?space_id=eq.${spaceId}&author_id=eq.${agentId}&created_at=gt.${encodeURIComponent(msg.created_at)}&select=id,body,author_id,meta&order=created_at.desc&limit=1`)).rows?.[0] || null;
    }
  }
  return { status: r.status, error: r.data?.error, reply, calls: agent.calls.slice(before), msg };
}
const rpc = (who, fn, body = {}) => api(who.token, `/rpc/${fn}`, { method: 'POST', body });

// ---------------- setup
const [alex, olive, vic, pat] = await Promise.all(['alex.admin', 'olive.organizer', 'vic.volunteer', 'pat.public'].map((n) => login(`${n}@example.com`)));
const spaces = Object.fromEntries((await api(alex.token, '/spaces?select=id,name,kind')).rows.filter((s) => s.kind === 'channel').map((s) => [s.name, s.id]));
await post(olive, spaces.organizers, `Organizers only: the gate code is ${SECRET}`);
await post(vic, spaces.festival, 'Festival note: porch P03 needs a second extension cord');
const agentBody = (extra = {}) => ({ display_name: "Olive's agent", handle: 'olive-bot', owner_id: olive.user.id, base_url: AGENT, model: 'hermes-agent', ...extra });

// ---------------- admin: adding an agent
check('No token: refused', (await assist(null, '/assistant/admin/agents')).status === 401);
check('Pat (not admin) cannot list agents', (await assist(pat.token, '/assistant/admin/agents')).status === 403);
check('Pat cannot add an agent', (await assist(pat.token, '/assistant/admin/agents', { method: 'POST', body: agentBody({ owner_id: pat.user.id, handle: 'pat-bot' }) })).status === 403);
check('Olive (not admin) cannot add herself an agent', (await assist(olive.token, '/assistant/admin/agents', { method: 'POST', body: agentBody() })).status === 403);
check('An address that is not http(s) is refused', (await assist(alex.token, '/assistant/admin/agents', { method: 'POST', body: agentBody({ base_url: 'file:///etc/passwd' }) })).status === 400);
check('An address with a password in it is refused', (await assist(alex.token, '/assistant/admin/agents', { method: 'POST', body: agentBody({ base_url: 'http://u:p@host/v1' }) })).status === 400);
check('The @name "weft" is refused', (await assist(alex.token, '/assistant/admin/agents', { method: 'POST', body: agentBody({ handle: 'weft' }) })).status === 400);
check('A bad @name is refused', (await assist(alex.token, '/assistant/admin/agents', { method: 'POST', body: agentBody({ handle: 'Has Spaces' }) })).status === 400);
let r = await assist(alex.token, '/assistant/admin/agents', { method: 'POST', body: agentBody() });
check('Admin adds an agent for Olive', r.status === 200 && r.data?.id, r.raw);
const OLIVE_AGENT = r.data?.id;
check('The same @name twice is refused', (await assist(alex.token, '/assistant/admin/agents', { method: 'POST', body: agentBody({ display_name: 'Copy' }) })).status === 409);
check('Test connection fails without the key', (await assist(alex.token, `/assistant/admin/agents/${OLIVE_AGENT}/test`, { method: 'POST', body: {} })).data?.ok === false);
check('Admin saves the key', (await assist(alex.token, `/assistant/admin/agents/${OLIVE_AGENT}/key`, { method: 'PUT', body: { key: KEY } })).data?.key_hint === '2468');
r = await assist(alex.token, '/assistant/admin/agents');
check('The key is write-only: the list shows the last four characters, never the key', r.data?.[0]?.has_key && r.data[0].key_hint === '2468' && !r.raw.includes('ABCDEFGH') && !r.raw.includes('v1:'), r.raw.slice(0, 300));
check('The list says whose agent it is', r.data?.[0]?.owner_id === olive.user.id && r.data[0].handle === 'olive-bot');
r = await assist(alex.token, `/assistant/admin/agents/${OLIVE_AGENT}/test`, { method: 'POST', body: {} });
check('Test connection reaches the stand-in and finds the model', r.data?.ok === true && r.data.has_model === true, r.raw);
check('Testing did not start a conversation on the agent', agent.calls.length === 0);

// ---------------- the agent's user row
r = await api(pat.token, `/users?id=eq.${OLIVE_AGENT}&select=id,display_name,is_assistant`);
check('Everyone can see the agent\'s name (so its replies have an author)', r.rows?.[0]?.is_assistant === true && r.rows[0].display_name === "Olive's agent");
check('Agents are not listed among people', !(await api(alex.token, '/rpc/admin_users', { method: 'POST', body: {} })).rows?.some?.((u) => u.id === OLIVE_AGENT));
check('Nobody can read the agents table through the API', [404, 401, 403].includes((await api(alex.token, '/agents')).status));

// ---------------- who sees it
r = await rpc(olive, 'my_agents');
check('Olive sees her agent (name and @name only)', r.rows?.length === 1 && r.rows[0].handle === 'olive-bot' && !('base_url' in r.rows[0]), JSON.stringify(r.rows));
check('Pat sees no agents', (await rpc(pat, 'my_agents')).rows?.length === 0);
check('Alex (admin) has no agents of his own in the chat list', (await rpc(alex, 'my_agents')).rows?.length === 0);

// ---------------- conversations
r = await rpc(olive, 'create_agent_conversation', { p_agent: OLIVE_AGENT });
check('Olive starts a conversation with her agent', r.status === 200 && typeof r.rows === 'string', JSON.stringify(r.rows));
const C1 = r.rows;
const C2 = (await rpc(olive, 'create_agent_conversation', { p_agent: OLIVE_AGENT, p_name: 'Packing list' })).rows;
check('She can have several conversations', typeof C2 === 'string' && C2 !== C1);
r = await api(olive.token, `/spaces?kind=eq.agent&select=id,name,agent_id&order=created_at`);
check('Her conversations are spaces of kind agent, named, tied to the agent', r.rows?.length === 2 && r.rows.every((s) => s.agent_id === OLIVE_AGENT) && r.rows.some((s) => s.name === 'New conversation') && r.rows.some((s) => s.name === 'Packing list'), JSON.stringify(r.rows));
check('Pat cannot start a conversation with Olive\'s agent', (await rpc(pat, 'create_agent_conversation', { p_agent: OLIVE_AGENT })).status >= 400);
check('Nobody can make an agent conversation with a plain insert', (await api(olive.token, '/spaces', { method: 'POST', body: { kind: 'agent', name: 'x', agent_id: OLIVE_AGENT } })).status >= 400);
check('Pat cannot read Olive\'s conversation', (await api(pat.token, `/spaces?id=eq.${C1}`)).rows?.length === 0);
check('Pat cannot post in it', (await api(pat.token, '/messages', { method: 'POST', body: { space_id: C1, body: 'hi' } })).status >= 400);

// ---------------- asking in a conversation
let a = await askAgent(olive, C1, 'What should I pack for Saturday?', OLIVE_AGENT);
check('Olive asks her agent: accepted at once (202)', a.status === 202, `${a.status} ${a.error || ''}`);
check('The reply arrives in the conversation, written by the agent', a.reply?.author_id === OLIVE_AGENT && /Agent heard: What should I pack/.test(a.reply.body), JSON.stringify(a.reply));
check('The reply is marked as an agent reply for Olive', a.reply?.meta?.agent === true && a.reply.meta.asker === olive.user.id);
check('The agent got exactly her message, nothing else', a.calls.length === 1 && a.calls[0].messages.length === 1 && a.calls[0].messages[0].content === 'What should I pack for Saturday?', JSON.stringify(a.calls[0]?.messages));
check('With the model set by the admin', a.calls[0]?.model === 'hermes-agent');
check('The conversation is its own session on the agent', a.calls[0]?.session === `weft-${C1}`);
const a2 = await askAgent(olive, C2, 'Start the packing list', OLIVE_AGENT);
check('A second conversation is a different session', a2.calls[0]?.session === `weft-${C2}` && a2.reply?.body);
check('Nothing from Organizers reached the agent in a conversation', agent.calls.every((c) => !JSON.stringify(c.messages).includes(SECRET)));

// ---------------- only the owner
const pm = await post(pat, spaces.festival, '@olive-bot what is the gate code?');
const callsBefore = agent.calls.length;
r = await assist(pat.token, '/assistant/agents/ask', { method: 'POST', body: { message_id: pm.id } });
check('Pat mentions Olive\'s agent in #festival: refused, the agent is not called', r.status === 400 && agent.calls.length === callsBefore, `${r.status} ${agent.calls.length}`);
const om = await post(olive, spaces.festival, 'a message from Olive');
check('Pat cannot ask with Olive\'s message', (await assist(pat.token, '/assistant/agents/ask', { method: 'POST', body: { message_id: om.id } })).status >= 403);
check('Pat cannot ask in Olive\'s conversation (cannot even see the message)', (await assist(pat.token, '/assistant/agents/ask', { method: 'POST', body: { message_id: a.msg.id } })).status === 404);
check('Pat cannot post as Olive\'s agent', (await api(pat.token, '/messages', { method: 'POST', body: { space_id: spaces.festival, body: 'fake', author_id: OLIVE_AGENT } })).status >= 400);

// ---------------- @mention in a channel
a = await askAgent(olive, spaces.festival, '@olive-bot what does P03 need?', OLIVE_AGENT);
check('Olive mentions her agent in #festival: it answers there', a.status === 202 && a.reply?.author_id === OLIVE_AGENT, `${a.status} ${a.error || ''}`);
const sent = a.calls[0]?.messages?.[0]?.content || '';
check('It was sent the recent #festival messages', sent.includes('porch P03 needs a second extension cord') && sent.includes('#festival'), sent.slice(0, 300));
check('Without the @name, as Olive asking', /\nOlive[^\n]* asks you: what does P03 need\?$/.test(sent), sent.slice(-120));
check('Organizers content never reached it from #festival', !sent.includes(SECRET));
check('The channel is its own session', a.calls[0]?.session === `weft-${spaces.festival}`);
check('Vic sees the agent\'s reply in #festival', (await api(vic.token, `/messages?space_id=eq.${spaces.festival}&author_id=eq.${OLIVE_AGENT}`)).rows?.length >= 1);
check('A channel message without a mention is not a question', (await assist(olive.token, '/assistant/agents/ask', { method: 'POST', body: { message_id: om.id } })).status === 400);

// ---------------- busy, failing, turned off
agent.mode = 'slow';
const s1 = await post(olive, C1, 'slow one');
const first = await assist(olive.token, '/assistant/agents/ask', { method: 'POST', body: { message_id: s1.id } });
const s2 = await post(olive, C1, 'and another');
const second = await assist(olive.token, '/assistant/agents/ask', { method: 'POST', body: { message_id: s2.id } });
check('One question at a time per conversation', first.status === 202 && second.status === 429, `${first.status} ${second.status}`);
const s3 = await post(olive, C2, 'meanwhile here');
check('...but another conversation can ask at the same time', (await assist(olive.token, '/assistant/agents/ask', { method: 'POST', body: { message_id: s3.id } })).status === 202);
await sleep(2500);
agent.mode = 'fail';
a = await askAgent(olive, C1, 'are you there?', OLIVE_AGENT);
check('When the agent fails, a short error reply arrives instead of silence', /couldn't answer/i.test(a.reply?.body || '') && a.reply?.meta?.error === true, a.reply?.body);
r = await assist(alex.token, '/assistant/admin/agents');
check('Admins see the last error', /HTTP 500/.test(r.data?.[0]?.last_error || ''), r.data?.[0]?.last_error);
agent.mode = 'ok';
await assist(alex.token, `/assistant/admin/agents/${OLIVE_AGENT}`, { method: 'PUT', body: agentBody({ enabled: false }) });
const off = await post(olive, C1, 'hello?');
check('A turned-off agent is not asked', (await assist(olive.token, '/assistant/agents/ask', { method: 'POST', body: { message_id: off.id } })).status === 409);
check('...and no new conversation can start', (await rpc(olive, 'create_agent_conversation', { p_agent: OLIVE_AGENT })).status >= 400);
await assist(alex.token, `/assistant/admin/agents/${OLIVE_AGENT}`, { method: 'PUT', body: agentBody({ enabled: true, display_name: 'Olive helper' }) });
check('Renamed by the admin: the new name shows', (await rpc(olive, 'my_agents')).rows?.[0]?.display_name === 'Olive helper');

// ---------------- the owner manages her conversations
check('Olive renames a conversation', (await api(olive.token, `/spaces?id=eq.${C2}`, { method: 'PATCH', body: { name: 'Saturday packing' } })).rows?.[0]?.name === 'Saturday packing');
check('Olive deletes a conversation', (await api(olive.token, `/spaces?id=eq.${C2}`, { method: 'DELETE' })).status < 300 && (await api(olive.token, `/spaces?id=eq.${C2}`)).rows.length === 0);

// ---------------- a new owner, then removal
await assist(alex.token, `/assistant/admin/agents/${OLIVE_AGENT}`, { method: 'PUT', body: agentBody({ owner_id: vic.user.id, display_name: 'Olive helper' }) });
check('Given to Vic: Olive no longer has it', (await rpc(olive, 'my_agents')).rows?.length === 0 && (await rpc(vic, 'my_agents')).rows?.length === 1);
check('...and Olive\'s conversations with it are gone (Vic does not inherit them)', (await api(alex.token, `/rpc/admin_users`, { method: 'POST', body: {} })).status === 200
  && (await api(olive.token, `/spaces?kind=eq.agent`)).rows.length === 0 && (await api(vic.token, `/spaces?kind=eq.agent`)).rows.length === 0);
const VC = (await rpc(vic, 'create_agent_conversation', { p_agent: OLIVE_AGENT })).rows;
check('Vic can start his own conversation', typeof VC === 'string');
r = await assist(alex.token, `/assistant/admin/agents/${OLIVE_AGENT}`, { method: 'DELETE' });
check('Admin removes the agent', r.status === 200 && (await assist(alex.token, '/assistant/admin/agents')).data?.length === 0);
check('Its conversations go with it', (await api(vic.token, `/spaces?kind=eq.agent`)).rows.length === 0 && (await rpc(vic, 'my_agents')).rows.length === 0);
check('Its old channel replies stay, marked removed', (await api(vic.token, `/messages?space_id=eq.${spaces.festival}&author_id=eq.${OLIVE_AGENT}&select=author:users(display_name)`)).rows?.[0]?.author?.display_name === 'Olive helper (removed)');

// ---------------- report
const failed = results.filter((x) => !x.ok);
for (const x of results) console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${x.ok || !x.detail ? '' : `  -- ${x.detail}`}`);
console.log(`\nagents: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
