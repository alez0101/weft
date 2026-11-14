// Connector suite (services/mcp). Runs inside the test stack's network (tests/run.sh starts it):
//   MCP = the connector directly, WEB = nginx (to check the routes people and apps use), AUTH = test sign-in.
// Proves: discovery documents; registration only for allowed redirect addresses; the consent request is
// checked before anything is sent anywhere; codes are single-use and need PKCE; a read-only connection
// has no writing tools; tools see exactly what the person sees (Pat never sees Organizers); writes follow
// the person's role; page edits go through live co-editing; refresh tokens rotate and a reused one ends
// the connection; disconnecting and disabling the account stop it at once.
import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const MCP = process.env.MCP || 'http://mcp:8097';
const WEB = process.env.WEB || 'http://web';
const AUTH = process.env.AUTH || 'http://svc:8081';
const API = process.env.API || 'http://postgrest:3000';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const SECRET = 'HOSTDOC'; // planted in the Organizers channel only (Host contacts)
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });

async function login(email) {
  const r = await fetch(`${AUTH}/auth/test-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
  if (!r.ok) throw new Error(`login ${email}: ${r.status}`);
  return r.json();
}
async function http(path, { method = 'GET', body, headers = {}, form, base = MCP } = {}) {
  const h = { ...headers };
  let b;
  if (form) { h['Content-Type'] = 'application/x-www-form-urlencoded'; b = new URLSearchParams(form).toString(); } else if (body !== undefined) { h['Content-Type'] = 'application/json'; b = JSON.stringify(body); }
  const r = await fetch(`${base}${path}`, { method, headers: h, body: b, redirect: 'manual' });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, headers: r.headers };
}
const api = (token, path, opts = {}) => http(path, { ...opts, base: API, headers: { Authorization: `Bearer ${token}`, Prefer: 'return=representation' } });
const pkce = () => { const verifier = crypto.randomBytes(32).toString('base64url'); return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') }; };

// The whole sign-in an app does: register, the person approves, trade the code.
async function connect(person, access, { name = 'Test app', client } = {}) {
  const reg = client ? { data: client } : await http('/oauth/register', { method: 'POST', body: { client_name: name, redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' } });
  const p = pkce();
  const params = { client_id: reg.data.client_id, redirect_uri: REDIRECT, response_type: 'code', code_challenge: p.challenge, code_challenge_method: 'S256', state: 'st8', resource: `${MCP}/mcp` };
  const ok = await http('/oauth/approve', { method: 'POST', body: { ...params, decision: 'allow', access }, headers: { Authorization: `Bearer ${person.token}`, 'X-Weft-Request': '1' } });
  const code = new URL(ok.data.redirect).searchParams.get('code');
  const tok = await http('/oauth/token', { method: 'POST', form: { grant_type: 'authorization_code', code, code_verifier: p.verifier, client_id: reg.data.client_id, redirect_uri: REDIRECT } });
  return { client: reg.data, tokens: tok.data, code, verifier: p.verifier };
}
async function mcpClient(accessToken) {
  const c = new Client({ name: 'weft-test', version: '1.0.0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${MCP}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }));
  return c;
}
const call = async (c, name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  const t = r.content?.[0]?.text ?? '';
  let data; try { data = JSON.parse(t); } catch { data = t; }
  return { error: !!r.isError, text: t, data };
};
const mcpStatus = async (accessToken) => (await http('/mcp', { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json, text/event-stream' },
  body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).status;

const [alex, olive, pat] = await Promise.all(['alex.admin', 'olive.organizer', 'pat.public'].map((n) => login(`${n}@example.com`)));

// ---------- discovery, through nginx as an app sees it
{
  const pr = await http('/.well-known/oauth-protected-resource', { base: WEB });
  check('Protected-resource document names /mcp and the authorization server', pr.status === 200 && pr.data.resource === 'http://web/mcp' && pr.data.authorization_servers?.[0] === 'http://web', pr.data);
  const as = await http('/.well-known/oauth-authorization-server', { base: WEB });
  check('Authorization-server document: code + PKCE S256 + registration', as.status === 200 && as.data.code_challenge_methods_supported?.includes('S256')
    && as.data.registration_endpoint === 'http://web/oauth/register' && as.data.authorization_endpoint === 'http://web/oauth/authorize', as.data);
  const page = await http('/oauth/authorize?client_id=x', { base: WEB });
  check('/oauth/authorize is the app (consent screen), not the connector', page.status === 200 && String(page.data).includes('<div id="root"'), String(page.data).slice(0, 80));
  const un = await http('/mcp', { base: WEB, method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  check('/mcp without a token: 401 pointing at the resource document', un.status === 401 && /resource_metadata="http:\/\/web\/\.well-known\/oauth-protected-resource"/.test(un.headers.get('www-authenticate') || ''), un.headers.get('www-authenticate'));
}

// ---------- registration
{
  const evil = await http('/oauth/register', { method: 'POST', body: { client_name: 'Look-alike', redirect_uris: ['https://evil.example/cb'] } });
  check('Registration refuses a redirect host that is not allowed', evil.status === 400 && evil.data.error === 'invalid_redirect_uri', evil.data);
  const plain = await http('/oauth/register', { method: 'POST', body: { client_name: 'x', redirect_uris: ['http://claude.ai/cb'] } });
  check('Registration refuses plain http to a non-loopback host', plain.status === 400, plain.data);
  const loop = await http('/oauth/register', { method: 'POST', body: { client_name: 'Desktop app', redirect_uris: ['http://localhost:33418/callback'] } });
  check('Registration accepts a loopback redirect (desktop and command-line apps)', loop.status === 201 && loop.data.client_id, loop.data);
  const conf = await http('/oauth/register', { method: 'POST', body: { client_name: 'Confidential', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_post' } });
  check('A confidential client gets a secret', conf.status === 201 && conf.data.client_secret?.startsWith('wcs_'), conf.data);
  const p = pkce();
  const ok = await http('/oauth/approve', { method: 'POST', headers: { Authorization: `Bearer ${olive.token}`, 'X-Weft-Request': '1' },
    body: { client_id: conf.data.client_id, redirect_uri: REDIRECT, response_type: 'code', code_challenge: p.challenge, code_challenge_method: 'S256', decision: 'allow', access: 'read' } });
  const code = new URL(ok.data.redirect).searchParams.get('code');
  const noSecret = await http('/oauth/token', { method: 'POST', form: { grant_type: 'authorization_code', code, code_verifier: p.verifier, client_id: conf.data.client_id } });
  check('A confidential client without its secret is refused', noSecret.status === 401 && noSecret.data.error === 'invalid_client', noSecret.data);
}

// ---------- the consent request and approval
const reg = await http('/oauth/register', { method: 'POST', body: { client_name: 'Claude', redirect_uris: [REDIRECT] } });
const P = pkce();
const params = { client_id: reg.data.client_id, redirect_uri: REDIRECT, response_type: 'code', code_challenge: P.challenge, code_challenge_method: 'S256', state: 'abc' };
{
  const q = (o) => `/oauth/request?${new URLSearchParams(o)}`;
  const good = await http(q(params));
  check('Consent request names the app and where the answer goes', good.status === 200 && good.data.client_name === 'Claude' && good.data.redirect_host === 'claude.ai', good.data);
  const badClient = await http(q({ ...params, client_id: 'wcl_nope' }));
  check('Consent request with an unknown app is refused on screen', badClient.status === 400, badClient.data);
  const badRedirect = await http(q({ ...params, redirect_uri: 'https://claude.ai/other' }));
  check('Consent request with an unregistered redirect is refused on screen', badRedirect.status === 400, badRedirect.data);
  const noPkce = await http(q({ ...params, code_challenge_method: 'plain' }));
  check('Consent request without PKCE S256 is refused', noPkce.status === 400, noPkce.data);
  const otherResource = await http(q({ ...params, resource: 'https://elsewhere.example/mcp' }));
  check('Consent request for another server is refused', otherResource.status === 400, otherResource.data);

  const noHeader = await http('/oauth/approve', { method: 'POST', body: { ...params, decision: 'allow' }, headers: { Authorization: `Bearer ${pat.token}` } });
  check('Approval needs the app header (no cross-site form posts)', noHeader.status === 403);
  const noToken = await http('/oauth/approve', { method: 'POST', body: { ...params, decision: 'allow' }, headers: { 'X-Weft-Request': '1' } });
  check('Approval needs a signed-in person', noToken.status === 401);
  const deny = await http('/oauth/approve', { method: 'POST', body: { ...params, decision: 'deny' }, headers: { Authorization: `Bearer ${pat.token}`, 'X-Weft-Request': '1' } });
  const du = new URL(deny.data.redirect);
  check('Cancel sends the app access_denied with its state, and no code', du.searchParams.get('error') === 'access_denied' && du.searchParams.get('state') === 'abc' && !du.searchParams.get('code'), deny.data);
}

// ---------- codes and PKCE (Pat, read only)
let patRead;
{
  const ok = await http('/oauth/approve', { method: 'POST', body: { ...params, decision: 'allow', access: 'read' }, headers: { Authorization: `Bearer ${pat.token}`, 'X-Weft-Request': '1' } });
  const u = new URL(ok.data.redirect);
  const code = u.searchParams.get('code');
  check('Allow sends a code, the state and the issuer back to the registered address', u.origin + u.pathname === REDIRECT && code && u.searchParams.get('state') === 'abc' && u.searchParams.get('iss'), ok.data);
  const wrong = await http('/oauth/token', { method: 'POST', form: { grant_type: 'authorization_code', code, code_verifier: pkce().verifier, client_id: reg.data.client_id } });
  check('A code with the wrong PKCE verifier is refused', wrong.status === 400 && wrong.data.error === 'invalid_grant', wrong.data);
  const again = await http('/oauth/token', { method: 'POST', form: { grant_type: 'authorization_code', code, code_verifier: P.verifier, client_id: reg.data.client_id } });
  check('A code is single-use, even after a failed try', again.status === 400, again.data);

  patRead = await connect(pat, 'read');
  check('Code + verifier -> access and refresh tokens (read scope)', patRead.tokens.access_token?.startsWith('wat_') && patRead.tokens.refresh_token?.startsWith('wrt_') && patRead.tokens.scope === 'weft:read', patRead.tokens);
  const reuse = await http('/oauth/token', { method: 'POST', form: { grant_type: 'authorization_code', code: patRead.code, code_verifier: patRead.verifier, client_id: patRead.client.client_id } });
  check('A redeemed code cannot be redeemed again', reuse.status === 400, reuse.data);
  const otherClient = await connect(pat, 'read', { name: 'Other' });
  const steal = await http('/oauth/token', { method: 'POST', form: { grant_type: 'refresh_token', refresh_token: patRead.tokens.refresh_token, client_id: otherClient.client.client_id } });
  check('Another app cannot use this app\'s refresh token', steal.status === 400, steal.data);
}

// ---------- tools: a read-only connection as Pat (viewer in Festival only)
{
  const c = await mcpClient(patRead.tokens.access_token);
  const names = (await c.listTools()).tools.map((t) => t.name).sort();
  check('Read-only connection lists only reading tools', !names.includes('post_message') && !names.includes('create_page') && names.includes('search') && names.includes('read_item'), names);
  const who = await call(c, 'whoami');
  check('whoami names the person and read-only access', who.data.name === 'Pat Public' && who.data.access === 'read only', who.data);
  const chans = await call(c, 'list_channels');
  const chanNames = chans.data.map((s) => s.name);
  check('Pat sees Festival as a viewer, and not Organizers', chans.data.some((s) => s.name === 'festival' && s.your_role === 'viewer') && !chanNames.includes('organizers'), chanNames);
  const s1 = await call(c, 'search', { query: SECRET });
  check('Search never returns Organizers content to Pat', !s1.error && !s1.text.includes(SECRET) && Array.isArray(s1.data) && s1.data.length === 0, s1.text.slice(0, 200));
  const org = await call(c, 'read_messages', { channel: 'Organizers' });
  check('Reading Organizers by name: not found for Pat', org.error && /No channel/.test(org.text), org.text);
  const items = await call(c, 'list_items', {});
  check('list_items shows no Organizers items to Pat', !items.text.includes('"organizers"') && !items.text.includes('Host contacts'), items.text.slice(0, 200));
  const fest = await call(c, 'read_messages', { channel: '#festival', limit: 5 });
  check('Pat reads Festival messages', !fest.error && fest.data.channel === 'festival' && fest.data.messages.length > 0, fest.text.slice(0, 200));
  const blocked = await c.callTool({ name: 'post_message', arguments: { channel: 'Festival', text: 'x' } }).catch((e) => ({ thrown: e.message }));
  check('Calling a writing tool on a read-only connection fails', blocked.thrown || blocked.isError, blocked);
  const ev = await call(c, 'list_events', { from: '2020-01-01T00:00:00Z', to: '2035-01-01T00:00:00Z' });
  check('list_events shows only events Pat can see', !ev.error && ev.data.every((e) => e.channel === 'festival' || e.channel === 'Personal'), ev.text.slice(0, 200));
  await c.close();
}

// ---------- tools: read-write connections (Pat as viewer, Olive as editor)
const patWrite = await connect(pat, 'write');
const oliveWrite = await connect(olive, 'write');
let pageId;
{
  check('Read-write scope', patWrite.tokens.scope === 'weft:read weft:write', patWrite.tokens);
  const pc = await mcpClient(patWrite.tokens.access_token);
  const names = (await pc.listTools()).tools.map((t) => t.name);
  check('Read-write connection lists the writing tools, and none that delete', ['post_message', 'create_page', 'edit_page', 'create_event', 'add_task', 'set_task_done'].every((n) => names.includes(n)) && !names.some((n) => /delete|remove/.test(n)), names);
  const posted = await call(pc, 'post_message', { channel: 'Festival', text: 'connector test: hello from Pat' });
  check('A viewer can chat through the connector (as in Weft)', !posted.error && posted.data.posted, posted.text);
  const [row] = (await api(alex.token, `/messages?id=eq.${posted.data.id}&select=author_id,body`)).data;
  check('The message is Pat\'s own, under her name', row?.author_id === pat.user.id, row);
  const page = await call(pc, 'create_page', { channel: 'Festival', kind: 'document', title: 'Should fail', markdown: 'x' });
  check('A viewer cannot create a document through the connector', page.error && /refused|permission/i.test(page.text), page.text);
  const orgPost = await call(pc, 'post_message', { channel: (await api(alex.token, '/spaces?name=eq.organizers&select=id')).data[0].id, text: 'x' });
  check('Pat cannot post in Organizers even by its id', orgPost.error, orgPost.text);
  await pc.close();

  const oc = await mcpClient(oliveWrite.tokens.access_token);
  const found = await call(oc, 'search', { query: SECRET });
  check('Positive control: Olive (in Organizers) finds the same content', found.text.includes('Host contacts') || found.text.includes(SECRET), found.text.slice(0, 200));
  const created = await call(oc, 'create_page', { channel: 'Festival', kind: 'document', title: 'Connector notes', markdown: '# Plan\n\n- first point\n- second point' });
  pageId = created.data.id;
  check('An editor creates a document from Markdown, with a link', !created.error && pageId && created.data.link.includes(`doc=${pageId}`), created.text);
  const read1 = await call(oc, 'read_item', { id: pageId });
  check('The new document reads back', read1.text.includes('first point'), read1.text.slice(-120));
  const appended = await call(oc, 'edit_page', { id: pageId, mode: 'append', markdown: 'Added by the connector.' });
  check('edit_page appends through live co-editing', !appended.error, appended.text);
  const read2 = await call(oc, 'read_item', { id: pageId });
  check('The appended text is saved, and the old text kept', read2.text.includes('Added by the connector.') && read2.text.includes('second point'), read2.text.slice(-200));
  const [it] = (await api(alex.token, `/items?id=eq.${pageId}&select=ydoc`)).data;
  check('The edit is saved as live co-editing state (Yjs)', it?.ydoc && it.ydoc.length > 10);
  const replaced = await call(oc, 'edit_page', { id: pageId, mode: 'replace', markdown: 'Only this now.', title: 'Connector notes v2' });
  const read3 = await call(oc, 'read_item', { id: pageId });
  check('edit_page replaces content and renames', !replaced.error && read3.text.includes('Only this now.') && !read3.text.includes('first point') && read3.text.includes('Connector notes v2'), read3.text.slice(-200));
  const help = (await api(alex.token, '/items?managed=is.true&select=id&limit=1')).data[0];
  if (help) {
    const managed = await call(oc, 'edit_page', { id: help.id, markdown: 'x' });
    check('Managed help pages cannot be edited through the connector', managed.error && /managed/.test(managed.text), managed.text);
  }
  const ev = await call(oc, 'create_event', { channel: 'Festival', title: 'Connector meetup', starts_at: '2031-05-01T18:00:00-07:00' });
  check('An editor adds an event (default one hour)', !ev.error && ev.data.starts === '2031-05-02T01:00Z' && ev.data.ends === '2031-05-02T02:00Z', ev.text);
  const moved = await call(oc, 'update_event', { id: ev.data.id, location: 'Porch 3' });
  check('An editor changes an event', !moved.error && moved.data.location === 'Porch 3', moved.text);
  const list = await call(oc, 'create_page', { channel: 'Festival', kind: 'tasklist', title: 'Connector tasks' });
  const task = await call(oc, 'add_task', { list: list.data.id, title: 'Print flyers', due_on: '2031-04-20', assignee: 'Pat Public' });
  check('An editor adds an assigned task to a new task list', !task.error && task.data.assignee === 'Pat Public', task.text);
  await oc.close();

  const pc2 = await mcpClient(patWrite.tokens.access_token);
  const mine = await call(pc2, 'list_tasks', { mine: true });
  check('Pat sees the task assigned to her', mine.data.some((t) => t.title === 'Print flyers'), mine.text.slice(0, 200));
  const done = await call(pc2, 'set_task_done', { id: task.data.id });
  check('The assignee ticks it off, even as a viewer (as in Weft)', !done.error && done.data.done === true, done.text);
  const pevt = await call(pc2, 'update_event', { id: ev.data.id, title: 'Hijacked' });
  check('A viewer cannot change an event', pevt.error, pevt.text);
  await pc2.close();
}

// ---------- refresh rotation, theft, disconnect, disabled account
{
  const r1 = await http('/oauth/token', { method: 'POST', form: { grant_type: 'refresh_token', refresh_token: oliveWrite.tokens.refresh_token, client_id: oliveWrite.client.client_id } });
  check('A refresh gives a new pair', r1.status === 200 && r1.data.refresh_token !== oliveWrite.tokens.refresh_token, r1.data);
  check('The new access token works', await mcpStatus(r1.data.access_token) === 200);
  const replay = await http('/oauth/token', { method: 'POST', form: { grant_type: 'refresh_token', refresh_token: oliveWrite.tokens.refresh_token, client_id: oliveWrite.client.client_id } });
  check('Reusing a rotated refresh token is refused', replay.status === 400, replay.data);
  check('...and ends that connection (copied token)', await mcpStatus(r1.data.access_token) === 401);

  const list = await http('/oauth/connections', { headers: { Authorization: `Bearer ${pat.token}` } });
  const mineIds = list.data.map((g) => g.id);
  check('Pat lists her connected apps', list.status === 200 && list.data.length >= 2 && list.data.every((g) => g.client_name), list.data);
  const others = await http('/oauth/connections', { headers: { Authorization: `Bearer ${olive.token}` } });
  check('Olive does not see Pat\'s connections', others.data.every((g) => !mineIds.includes(g.id)));
  const steal = await http(`/oauth/connections/${mineIds[0]}`, { method: 'DELETE', headers: { Authorization: `Bearer ${olive.token}` } });
  check('Olive cannot disconnect Pat\'s app', steal.status === 404);
  const writeGrant = list.data.find((g) => g.access === 'write');
  const del = await http(`/oauth/connections/${writeGrant.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${pat.token}` } });
  check('Pat disconnects an app', del.status === 200);
  check('...and its access token stops working at once', await mcpStatus(patWrite.tokens.access_token) === 401);
  const ref = await http('/oauth/token', { method: 'POST', form: { grant_type: 'refresh_token', refresh_token: patWrite.tokens.refresh_token, client_id: patWrite.client.client_id } });
  check('...and so does its refresh token', ref.status === 400);

  check('Pat\'s read-only connection still works', await mcpStatus(patRead.tokens.access_token) === 200);
  await api(alex.token, '/rpc/admin_set_user', { method: 'POST', body: { p_user: pat.user.id, p_disabled: true } });
  check('Disabling the account stops its connections at once', await mcpStatus(patRead.tokens.access_token) === 401);
  const ref2 = await http('/oauth/token', { method: 'POST', form: { grant_type: 'refresh_token', refresh_token: patRead.tokens.refresh_token, client_id: patRead.client.client_id } });
  check('A disabled account cannot refresh', ref2.status === 400);
  await api(alex.token, '/rpc/admin_set_user', { method: 'POST', body: { p_user: pat.user.id, p_disabled: false } });
  check('Re-enabled: the connection works again (it was not revoked)', await mcpStatus(patRead.tokens.access_token) === 200);

  const again = await connect(pat, 'read', { client: patRead.client });
  check('Approving the same app again replaces its older connection', await mcpStatus(again.tokens.access_token) === 200 && await mcpStatus(patRead.tokens.access_token) === 401);
}

const w = Math.max(...results.map((r) => r.name.length));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(w)}  ${r.ok ? '' : r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
