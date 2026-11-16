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
  // 070: a connected app reads what the person can see but changes things only in their personal space.
  const posted = await call(pc, 'post_message', { channel: 'Festival', text: 'connector test: hello from Pat' });
  check('The connector cannot post in a channel, even where the person may chat; it says to use Personal',
    posted.error && /Personal space/.test(posted.text) && (await api(alex.token, `/messages?body=eq.${encodeURIComponent('connector test: hello from Pat')}`)).data.length === 0, posted.text);
  const home = await call(pc, 'post_message', { channel: 'personal', text: 'connector test: a note to myself' });
  check('Positive control: the connector posts in Pat\'s personal space', !home.error && home.data.posted, home.text);
  const [row] = (await api(pat.token, `/messages?id=eq.${home.data?.id}&select=author_id,body`)).data;
  check('The message is Pat\'s own, under her name', row?.author_id === pat.user.id, row);
  const page = await call(pc, 'create_page', { channel: 'Festival', kind: 'document', title: 'Should fail', markdown: 'x' });
  check('The connector cannot create a document in a channel', page.error && /Personal space/.test(page.text), page.text);
  const orgPost = await call(pc, 'post_message', { channel: (await api(alex.token, '/spaces?name=eq.organizers&select=id')).data[0].id, text: 'x' });
  check('Pat cannot post in Organizers even by its id', orgPost.error, orgPost.text);
  await pc.close();

  const oc = await mcpClient(oliveWrite.tokens.access_token);
  const found = await call(oc, 'search', { query: SECRET });
  check('Positive control: Olive (in Organizers) finds the same content', found.text.includes('Host contacts') || found.text.includes(SECRET), found.text.slice(0, 200));
  // Records (048): a kudos is found with a link to its channel's wall; Olive's journal never reaches a connected app.
  const fid = (await api(alex.token, '/spaces?name=eq.festival&select=id')).data[0].id;
  const kd = await api(olive.token, '/kudos', { method: 'POST', body: { space_id: fid, to_user: pat.user.id, message: 'MCPKUDOS thanks for the flyers' } });
  const jp = await api(olive.token, '/journal_entries', { method: 'POST', body: { day: '2026-02-04', body: 'MCPJOURNAL a private thought' } });
  check('Records: Olive gives a kudos and writes a journal page (positive control)', kd.status === 201 && jp.status === 201, `${kd.status} ${jp.status}`);
  const fk = await call(oc, 'search', { query: 'MCPKUDOS' });
  check('Records: connector search finds the kudos, linked to the channel\'s kudos wall', !fk.error && fk.data.some((h) => h.kind === 'kudos' && h.link.includes(`active=kudos&kudos=${fid}`)), fk.text.slice(0, 300));
  const fj = await call(oc, 'search', { query: 'MCPJOURNAL' });
  check('Records: connector search never returns a journal page, not even its writer\'s own', !fj.error && !fj.text.includes('MCPJOURNAL') && fj.data.length === 0, fj.text.slice(0, 200));
  const pcRec = await mcpClient(patRead.tokens.access_token);
  const pk = await call(pcRec, 'search', { query: 'MCPKUDOS' });
  await pcRec.close();
  check('Records: Pat (in #festival) finds that kudos too; it is for her (positive control)', !pk.error && pk.data.some((h) => h.kind === 'kudos'), pk.text.slice(0, 200));
  const created = await call(oc, 'create_page', { channel: 'personal', kind: 'document', title: 'Connector notes', markdown: '# Plan\n\n- first point\n- second point' });
  pageId = created.data?.id;
  check('Olive\'s connector creates a document from Markdown in her personal space, with a link', !created.error && pageId && created.data.link.includes(`doc=${pageId}`), created.text);
  const read1 = await call(oc, 'read_item', { id: pageId });
  check('The new document reads back', read1.text.includes('first point'), read1.text.slice(-120));
  const appended = await call(oc, 'edit_page', { id: pageId, mode: 'append', markdown: 'Added by the connector.' });
  check('edit_page appends through live co-editing', !appended.error, appended.text);
  const read2 = await call(oc, 'read_item', { id: pageId });
  check('The appended text is saved, and the old text kept', read2.text.includes('Added by the connector.') && read2.text.includes('second point'), read2.text.slice(-200));
  const [it] = (await api(olive.token, `/items?id=eq.${pageId}&select=ydoc`)).data;
  check('The edit is saved as live co-editing state (Yjs)', it?.ydoc && it.ydoc.length > 10);
  const replaced = await call(oc, 'edit_page', { id: pageId, mode: 'replace', markdown: 'Only this now.', title: 'Connector notes v2' });
  const read3 = await call(oc, 'read_item', { id: pageId });
  check('edit_page replaces content and renames', !replaced.error && read3.text.includes('Only this now.') && !read3.text.includes('first point') && read3.text.includes('Connector notes v2'), read3.text.slice(-200));
  const fdoc = (await api(olive.token, '/items', { method: 'POST', body: { space_id: fid, kind: 'document', title: 'Festival plan by Olive', body_text: 'untouched' } })).data[0];
  const fedit = await call(oc, 'edit_page', { id: fdoc.id, mode: 'append', markdown: 'CONNECTOR-EDIT-IN-FESTIVAL' });
  const fren = await call(oc, 'edit_page', { id: fdoc.id, title: 'Renamed by the connector' });
  const [fdoc2] = (await api(olive.token, `/items?id=eq.${fdoc.id}&select=title,body_text`)).data;
  check('The connector cannot edit or rename a #festival document, though Olive edits there herself',
    fedit.error && fren.error && fdoc2.title === 'Festival plan by Olive' && !String(fdoc2.body_text).includes('CONNECTOR-EDIT'), `${fedit.text} | ${fren.text}`);
  const helpSpace = (await api(alex.token, '/spaces?name=eq.help&select=id')).data[0];
  const help = helpSpace && (await api(alex.token, `/items?managed=is.true&space_id=eq.${helpSpace.id}&select=id&limit=1`)).data[0]; // the help wiki: everyone reads it
  check('A managed help page exists to try', !!help);
  if (help) {
    const managed = await call(oc, 'edit_page', { id: help.id, markdown: 'x' });
    check('Managed help pages cannot be edited through the connector', managed.error && /managed/.test(managed.text), managed.text);
  }
  const ev = await call(oc, 'create_event', { channel: 'personal', title: 'Connector meetup', starts_at: '2031-05-01T18:00:00-07:00' });
  check('The connector adds an event in Personal (default one hour)', !ev.error && ev.data.starts === '2031-05-02T01:00Z' && ev.data.ends === '2031-05-02T02:00Z', ev.text);
  const moved = await call(oc, 'update_event', { id: ev.data.id, location: 'Porch 3' });
  check('The connector changes its event in Personal', !moved.error && moved.data.location === 'Porch 3', moved.text);
  const fev = await call(oc, 'create_event', { channel: 'Festival', title: 'CONNECTOR-EVENT', starts_at: '2031-05-01T18:00:00-07:00' });
  check('The connector cannot add an event to a channel calendar', fev.error && /Personal space/.test(fev.text), fev.text);
  const list = await call(oc, 'create_page', { channel: 'personal', kind: 'tasklist', title: 'Connector tasks' });
  const task = await call(oc, 'add_task', { list: list.data.id, title: 'Print flyers', due_on: '2031-04-20' });
  check('The connector adds a task to a new list in Personal', !task.error && task.data.title === 'Print flyers', task.text);
  // A #festival task assigned to Pat, made in Weft itself.
  const flist = (await api(olive.token, '/items', { method: 'POST', body: { space_id: fid, kind: 'tasklist', title: 'Festival jobs' } })).data[0];
  const ftask = (await api(olive.token, '/tasks', { method: 'POST', body: { list_id: flist.id, title: 'Hang banners', assignee_id: pat.user.id, position: 1 } })).data[0];
  const fadd = await call(oc, 'add_task', { list: flist.id, title: 'CONNECTOR-TASK' });
  check('The connector cannot add a task to a #festival list', fadd.error, fadd.text);
  // A channel closed to AI apps disappears from the connector.
  await api(alex.token, '/space_rules', { method: 'POST', body: { space_id: fid } });   // may already exist
  await api(alex.token, `/space_rules?space_id=eq.${fid}`, { method: 'PATCH', body: { agents_may_read: false } });
  const chans = await call(oc, 'list_channels', {});
  const hidden = await call(oc, 'read_messages', { channel: fid });
  check('When #festival is closed to AI apps, the connector no longer lists or reads it', !chans.text.includes(fid) && hidden.error, `${chans.text.slice(0, 200)} | ${hidden.text}`);
  await api(alex.token, `/space_rules?space_id=eq.${fid}`, { method: 'PATCH', body: { agents_may_read: true } });
  const chans2 = await call(oc, 'list_channels', {});
  check('Opened again: the connector lists #festival (positive control)', chans2.text.includes(fid), chans2.text.slice(0, 200));
  await oc.close();

  const pc2 = await mcpClient(patWrite.tokens.access_token);
  const mine = await call(pc2, 'list_tasks', { mine: true });
  check('Pat\'s connector sees the #festival task assigned to her (reading is allowed)', mine.data.some((t) => t.title === 'Hang banners'), mine.text.slice(0, 200));
  const done = await call(pc2, 'set_task_done', { id: ftask.id });
  const [still] = (await api(pat.token, `/tasks?id=eq.${ftask.id}&select=done`)).data;
  check('...but cannot tick it off: that is a change in a channel', done.error && still?.done === false, done.text);
  const pevt = await call(pc2, 'update_event', { id: ev.data.id, title: 'Hijacked' });
  check('Pat cannot change Olive\'s event', pevt.error, pevt.text);
  await pc2.close();
}

// ---------- projects (069) through the connector
{
  const fid = (await api(alex.token, '/spaces?name=eq.festival&select=id')).data[0].id;
  const [fp] = (await api(alex.token, '/projects', { method: 'POST', body: { space_id: fid, name: 'Connector drive', instructions: 'MCP-PROJECT-RULE: pickup questions go to Olive.' } })).data;
  const fdoc = (await api(olive.token, '/items', { method: 'POST', body: { space_id: fid, project_id: fp.id, kind: 'document', title: 'Drive routes', body_text: 'routes' } })).data[0];
  await api(alex.token, '/project_pins', { method: 'POST', body: { project_id: fp.id, item_id: fdoc.id } });
  await api(pat.token, '/messages', { method: 'POST', body: { space_id: fid, project_id: fp.id, body: 'MCP-PROJECT-CHAT: who has boxes?' } });
  const ohome = (await api(olive.token, `/spaces?kind=eq.personal&created_by=eq.${olive.user.id}&select=id`)).data[0].id;
  const [pp] = (await api(olive.token, '/projects', { method: 'POST', body: { space_id: ohome, name: 'Drafts' } })).data;
  const oc = await mcpClient(oliveWrite.tokens.access_token);
  const lc = await call(oc, 'list_channels', {});
  check('Projects: list_channels shows the projects inside each channel', lc.data.some((c) => c.id === fid && c.projects?.some((p) => p.name === 'Connector drive')), lc.text.slice(0, 300));
  const rp = await call(oc, 'read_project', { channel: 'festival', project: 'connector drive' });
  check('Projects: read_project returns the instructions, the pinned document and the project chat',
    !rp.error && rp.data.project_instructions.includes('MCP-PROJECT-RULE') && rp.data.pinned.some((i) => i.id === fdoc.id) && rp.data.recent_chat.some((m) => m.text.includes('MCP-PROJECT-CHAT')), rp.text.slice(0, 400));
  const rm = await call(oc, 'read_messages', { channel: 'festival', project: fp.id });
  const rg = await call(oc, 'read_messages', { channel: 'festival' });
  check('Projects: read_messages reads one project\'s chat, and the general chat leaves it out',
    rm.data.messages.some((m) => m.text.includes('MCP-PROJECT-CHAT')) && !rg.data.messages.some((m) => m.text.includes('MCP-PROJECT-CHAT')));
  const li = await call(oc, 'list_items', { channel: 'festival', project: 'Connector drive' });
  check('Projects: list_items filters by project', !li.error && li.data.length === 1 && li.data[0].id === fdoc.id && li.data[0].project === 'Connector drive', li.text.slice(0, 300));
  const bad = await call(oc, 'read_project', { channel: 'festival', project: 'No such thing' });
  check('Projects: an unknown project is a clear refusal', bad.error && /No project called/.test(bad.text), bad.text);
  const made = await call(oc, 'create_page', { channel: 'personal', project: 'Drafts', kind: 'document', title: 'Draft in a project', markdown: 'hello' });
  const [mrow] = (await api(olive.token, `/items?id=eq.${made.data?.id}&select=project_id,space_id`)).data;
  check('Projects: the connector creates a page in one of Olive\'s personal projects (positive control)', !made.error && mrow?.project_id === pp.id && mrow.space_id === ohome, made.text);
  const fmade = await call(oc, 'create_page', { channel: 'festival', project: 'Connector drive', kind: 'document', title: 'MCP-IN-FESTIVAL-PROJECT', markdown: 'x' });
  check('Projects: ...but not in a channel\'s project (the fence holds)', fmade.error && /Personal space/.test(fmade.text), fmade.text);
  const pev = await call(oc, 'create_event', { channel: 'personal', project: 'Drafts', title: 'Draft meetup', starts_at: '2031-06-01T18:00:00-07:00' });
  check('Project calendars: the connector adds an event to a personal project', !pev.error && pev.data.project === 'Drafts', pev.text);
  await api(olive.token, '/events', { method: 'POST', body: { space_id: fid, project_id: fp.id, title: 'Connector drive day', starts_at: '2031-06-02T16:00:00Z', ends_at: '2031-06-02T17:00:00Z' } });
  await api(olive.token, '/events', { method: 'POST', body: { space_id: fid, title: 'Festival general day', starts_at: '2031-06-02T18:00:00Z', ends_at: '2031-06-02T19:00:00Z' } });
  const lev = await call(oc, 'list_events', { from: '2031-06-01T00:00:00Z', to: '2031-06-05T00:00:00Z', channel: 'festival', project: 'Connector drive' });
  check('Project calendars: list_events filters by project', !lev.error && lev.data.length === 1 && lev.data[0].title === 'Connector drive day' && lev.data[0].project === 'Connector drive', lev.text);
  const fpost = await call(oc, 'post_message', { channel: 'personal', project: 'Drafts', text: 'note in a project' });
  check('Projects: the connector posts in a personal project\'s chat', !fpost.error && fpost.data.project === 'Drafts', fpost.text);
  await oc.close();
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

// ---------- a personal agent's own key (075): an admin gives it, it acts for the owner like Claude does
{
  const ASSIST = 'http://assistant:8090';
  const adm = (path, method = 'GET', body) => http(path, { base: ASSIST, method, body, headers: { Authorization: `Bearer ${alex.token}` } });
  const made = await adm('/assistant/admin/agents', 'POST', { display_name: 'Olive Helper', handle: 'olive-helper', owner_id: olive.user.id, base_url: 'http://agent-nowhere:1/v1', model: 'm' });
  const agentId = made.data?.id;
  check('Agent key: Pat (not admin) cannot give an agent Weft access', (await http(`/assistant/admin/agents/${agentId}/connect`, { base: ASSIST, method: 'POST', body: {}, headers: { Authorization: `Bearer ${pat.token}` } })).status === 403);
  const k = await adm(`/assistant/admin/agents/${agentId}/connect`, 'POST', { days: 30 });
  const key = k.data?.token;
  check('Agent key: an admin gets a key once, for /mcp', /^weft_agent_[\w-]{40,}$/.test(key || '') && k.data.path === '/mcp', k.data);
  const listed = (await adm('/assistant/admin/agents')).data?.find((x) => x.id === agentId);
  check('Agent key: the admin list shows it connected, with an end date about 30 days out', listed?.weft_access?.connected === true && Math.abs(new Date(listed.weft_access.expires_at) - Date.now() - 30 * 86400e3) < 3600e3, listed?.weft_access);
  const ac = await mcpClient(key);
  const who = await call(ac, 'whoami');
  check('Agent key: the agent acts as its owner, Olive, with read and write access', who.data.name === 'Olive Organizer' && /write/.test(who.data.access), who.data);
  const mine = await call(ac, 'create_page', { channel: 'personal', kind: 'document', title: 'Agent note', markdown: 'Written by the agent.' });
  check('Agent key: it can create a page in Olive\'s Personal space', !mine.error && mine.data.created === true, mine.text);
  const fest = await call(ac, 'create_page', { channel: 'festival', kind: 'document', title: 'Agent in festival', markdown: 'x' });
  check('Agent key: it cannot create in a channel, even where Olive is an owner (the AI-app fence)', fest.error, fest.text);
  const found = await call(ac, 'search', { query: 'Run of show' });
  check('Agent key: it can search what Olive can see', !found.error && /Run of show/.test(found.text), found.text.slice(0, 200));
  const conns = await http('/oauth/connections', { headers: { Authorization: `Bearer ${olive.token}` } });
  check('Agent key: Olive sees it under Connected apps, by the agent\'s name', Array.isArray(conns.data) && conns.data.some((x) => /Olive Helper/.test(JSON.stringify(x))), conns.data);
  check('Agent key: Pat does not see Olive\'s agent connection', !JSON.stringify((await http('/oauth/connections', { headers: { Authorization: `Bearer ${pat.token}` } })).data).includes('Olive Helper'));
  const olivesConn = (await http('/oauth/connections', { headers: { Authorization: `Bearer ${olive.token}` } })).data.find((x) => x.client_name === 'Olive Helper');
  await http(`/oauth/connections/${olivesConn?.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${olive.token}` } });
  check('Agent key: Olive can disconnect her agent herself', await mcpStatus(key) === 401 && (await adm('/assistant/admin/agents')).data?.find((x) => x.id === agentId)?.weft_access?.connected === false);
  const k2 = await adm(`/assistant/admin/agents/${agentId}/connect`, 'POST', {});
  const k2b = await adm(`/assistant/admin/agents/${agentId}/connect`, 'POST', {});
  check('Agent key: a new key replaces the old one (the old one stops working)', await mcpStatus(k2b.data.token) === 200 && await mcpStatus(k2.data.token) === 401);
  k2.data.token = k2b.data.token;
  await adm(`/assistant/admin/agents/${agentId}/connect`, 'DELETE');
  check('Agent key: Disconnect ends it', await mcpStatus(k2.data.token) === 401 && (await adm('/assistant/admin/agents')).data?.find((x) => x.id === agentId)?.weft_access?.connected === false);
  const k3 = await adm(`/assistant/admin/agents/${agentId}/connect`, 'POST', {});
  await adm(`/assistant/admin/agents/${agentId}`, 'PUT', { display_name: 'Olive Helper', handle: 'olive-helper', owner_id: pat.user.id, base_url: 'http://agent-nowhere:1/v1', model: 'm' });
  check('Agent key: giving the agent to another owner ends its key (it acted for the old owner)', await mcpStatus(k3.data.token) === 401);
  const k4 = await adm(`/assistant/admin/agents/${agentId}/connect`, 'POST', {});
  check('Agent key: ...and a new key acts for the new owner', (await call(await mcpClient(k4.data.token), 'whoami')).data.name === 'Pat Public');
  await adm(`/assistant/admin/agents/${agentId}`, 'DELETE');
  check('Agent key: removing the agent ends its key', await mcpStatus(k4.data.token) === 401);
}

const w = Math.max(...results.map((r) => r.name.length));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(w)}  ${r.ok ? '' : r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
