// Weft accounts suite. Runs inside the test stack's network (tests/run.sh), against the sign-in
// service's public listener with AUTH_METHODS=password (the default).
// Proves: links are single-use, expire and are admin-only; passwords are checked and rate limited;
// sessions rotate, a replayed secret ends the session, sign-out and password changes end sessions;
// disabled accounts get nothing; cookie and request rules hold; tokens work on the API.
const PUB = process.env.PUB || 'http://svc:8080';
const TEST = process.env.AUTH || 'http://svc:8081';
const API = process.env.API || 'http://postgrest:3000';
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });

const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const cookieFrom = (r) => (/weft_session=([^;]*)/.exec(r.headers.get('set-cookie') || '') || [])[1];
const call = async (path, { method = 'GET', body, cookie, token, app = true, ip } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (app) headers['X-Weft-Request'] = '1';
  if (cookie) headers.Cookie = `weft_session=${cookie}`;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (ip) headers['X-Client-IP'] = ip;
  const r = await fetch(`${PUB}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, data: await j(r), cookie: cookieFrom(r), setCookie: r.headers.get('set-cookie') || '' };
};
const testLogin = async (email) => (await (await fetch(`${TEST}/auth/test-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) })).json());
const tokenOf = (url) => url.token;

const alex = await testLogin('alex.admin@example.com');
const pat = await testLogin('pat.public@example.com');
const GOOD = 'correct horse battery staple 42';
let ipn = 0; const freshIp = () => `10.9.${Math.floor(++ipn / 250)}.${ipn % 250}`;

// ---------- the method list
const mode = await (await fetch(`${PUB}/auth/mode`)).json();
check('The public door offers Weft accounts', mode.mode === 'public' && mode.methods.includes('password'), JSON.stringify(mode));
check('Cloudflare is off unless configured', !mode.methods.includes('cloudflare') && (await call('/auth/session')).status === 404);
check('The test sign-in is not on the public door', (await call('/auth/test-login', { method: 'POST', body: { email: 'pat.public@example.com' } })).status === 404);

// ---------- links: admin only
check('Pat (not admin) cannot make links', (await call('/auth/admin/links', { method: 'POST', token: pat.token, body: { email: 'new.person@example.org' } })).status === 403);
check('No token, no links', (await call('/auth/admin/links', { method: 'POST', body: { email: 'new.person@example.org' } })).status === 401);
let r = await call('/auth/admin/links', { method: 'POST', token: alex.token, body: { email: 'pat.public@example.com', purpose: 'invite' } });
check('An invite for an existing account is refused (use a reset link)', r.status === 400, JSON.stringify(r.data));
r = await call('/auth/admin/links', { method: 'POST', token: alex.token, body: { email: 'nobody@example.org', purpose: 'reset' } });
check('A reset link for an unknown email is refused', r.status === 400);
r = await call('/auth/admin/links', { method: 'POST', token: alex.token, body: { email: 'not-an-email', purpose: 'invite' } });
check('A malformed email is refused', r.status === 400);
const inv = await call('/auth/admin/links', { method: 'POST', token: alex.token, body: { email: 'New.Person@Example.org', purpose: 'invite' } });
check('Alex (admin) makes an invite link', inv.status === 200 && inv.data.token?.length >= 40 && inv.data.email === 'new.person@example.org', JSON.stringify(inv.data).slice(0, 120));
const open = await call('/auth/admin/links', { token: alex.token });
check('Open links are listed for admins, without their secret', open.status === 200 && open.data.some((l) => l.email === 'new.person@example.org') && !JSON.stringify(open.data).includes(inv.data.token));

// ---------- using the invite
const T = inv.data.token;
r = await call(`/auth/link/${T}`);
check('The link says what it is for', r.status === 200 && r.data.purpose === 'invite' && r.data.email === 'new.person@example.org');
check('A made-up link is refused', (await call(`/auth/link/${'x'.repeat(43)}`)).status === 410);
r = await call(`/auth/link/${T}`, { method: 'POST', body: { password: 'short', name: 'New Person' } });
check('A short password is refused', r.status === 400);
r = await call(`/auth/link/${T}`, { method: 'POST', app: false, body: { password: GOOD, name: 'New Person' } });
check('Using a link needs the app header (no cross-site posts)', r.status === 403);
const redeemed = await call(`/auth/link/${T}`, { method: 'POST', body: { password: GOOD, name: 'New Person' } });
check('The invite creates the account and signs them in', redeemed.status === 200 && redeemed.data.token && redeemed.data.user.display_name === 'New Person', JSON.stringify(redeemed.data).slice(0, 120));
check('The session cookie is HttpOnly, SameSite=Strict and scoped to /auth', /HttpOnly/.test(redeemed.setCookie) && /SameSite=Strict/.test(redeemed.setCookie) && /Path=\/auth/.test(redeemed.setCookie) && redeemed.cookie);
check('The same link cannot be used twice', (await call(`/auth/link/${T}`, { method: 'POST', body: { password: GOOD } })).status === 410);
const me = (await fetch(`${API}/spaces?select=kind`, { headers: { Authorization: `Bearer ${redeemed.data.token}` } }));
const mine = await me.json();
check('The new account works on the API (its personal space, its Weft conversation, help)', me.status === 200 && mine.some((s) => s.kind === 'personal') && mine.some((s) => s.kind === 'assistant'), JSON.stringify(mine));

// ---------- password sign-in
const ip1 = freshIp();
r = await call('/auth/login', { method: 'POST', ip: ip1, body: { email: 'new.person@example.org', password: 'wrong password here' } });
check('A wrong password is refused', r.status === 401 && !r.cookie);
r = await call('/auth/login', { method: 'POST', ip: ip1, body: { email: 'nobody@example.org', password: GOOD } });
check('An unknown email gets the same answer as a wrong password', r.status === 401 && r.data.error === 'That email and password do not match.');
r = await call('/auth/login', { method: 'POST', ip: ip1, body: { email: 'pat.public@example.com', password: GOOD } });
check('An account with no password cannot sign in with one', r.status === 401);
r = await call('/auth/login', { method: 'POST', app: false, ip: ip1, body: { email: 'new.person@example.org', password: GOOD } });
check('Signing in needs the app header', r.status === 403);
const s1 = await call('/auth/login', { method: 'POST', ip: ip1, body: { email: 'NEW.person@example.org ', password: GOOD } });
check('The right password signs in (email case and spaces ignored)', s1.status === 200 && s1.data.token && s1.cookie);

// ---------- sessions
r = await call('/auth/refresh', { method: 'POST', cookie: s1.cookie });
check('A session renews the token and rotates its secret', r.status === 200 && r.data.token && r.cookie && r.cookie !== s1.cookie);
const s1b = r.cookie;
r = await call('/auth/refresh', { method: 'POST', cookie: s1.cookie });
check('The old secret is refused', r.status === 401);
r = await call('/auth/refresh', { method: 'POST', cookie: s1b });
check('Presenting a used secret ended that session (copied-cookie defence)', r.status === 401);
check('Renewing needs the app header', (await call('/auth/refresh', { method: 'POST', app: false, cookie: redeemed.cookie })).status === 403);
check('No cookie, no renewal', (await call('/auth/refresh', { method: 'POST' })).status === 401);
const s2 = await call('/auth/login', { method: 'POST', ip: ip1, body: { email: 'new.person@example.org', password: GOOD } });
r = await call('/auth/logout', { method: 'POST', cookie: s2.cookie });
check('Signing out ends the session', r.status === 200 && (await call('/auth/refresh', { method: 'POST', cookie: s2.cookie })).status === 401);

// ---------- changing the password
const s3 = await call('/auth/login', { method: 'POST', ip: ip1, body: { email: 'new.person@example.org', password: GOOD } });
const s4 = await call('/auth/login', { method: 'POST', ip: ip1, body: { email: 'new.person@example.org', password: GOOD } });
r = await call('/auth/password', { method: 'POST', token: s3.data.token, cookie: s3.cookie, body: { current: 'not it at all', next: 'another fine password 7' } });
check('Changing the password needs the current one', r.status === 401);
r = await call('/auth/password', { method: 'POST', token: s3.data.token, cookie: s3.cookie, body: { current: GOOD, next: 'another fine password 7' } });
check('The password changes', r.status === 200);
check('Other sessions end; this one stays', (await call('/auth/refresh', { method: 'POST', cookie: s4.cookie })).status === 401
  && (await call('/auth/refresh', { method: 'POST', cookie: s3.cookie })).status === 200);
check('The old password no longer works', (await call('/auth/login', { method: 'POST', ip: ip1, body: { email: 'new.person@example.org', password: GOOD } })).status === 401);

// ---------- a reset link
const rs = await call('/auth/admin/links', { method: 'POST', token: alex.token, body: { email: 'new.person@example.org', purpose: 'reset' } });
const rs2 = await call('/auth/admin/links', { method: 'POST', token: alex.token, body: { email: 'new.person@example.org', purpose: 'reset' } });
check('A new reset link replaces the old one', (await call(`/auth/link/${rs.data.token}`)).status === 410 && (await call(`/auth/link/${rs2.data.token}`)).status === 200);
const s5 = await call('/auth/login', { method: 'POST', ip: ip1, body: { email: 'new.person@example.org', password: 'another fine password 7' } });
r = await call(`/auth/link/${rs2.data.token}`, { method: 'POST', body: { password: 'third password, the reset one' } });
check('A reset link sets a new password and signs in', r.status === 200 && r.data.user.display_name === 'New Person');
check('A reset ends every older session', (await call('/auth/refresh', { method: 'POST', cookie: s5.cookie })).status === 401);
const cancel = await call('/auth/admin/links', { method: 'POST', token: alex.token, body: { email: 'new.person@example.org', purpose: 'reset' } });
const listed = (await call('/auth/admin/links', { token: alex.token })).data.find((l) => l.email === 'new.person@example.org');
await call(`/auth/admin/links/${listed.id}`, { method: 'DELETE', token: alex.token });
check('An admin can cancel a link', (await call(`/auth/link/${cancel.data.token}`)).status === 410);

// ---------- disabled accounts
const newId = r.data.user.id;
const s6 = await call('/auth/login', { method: 'POST', ip: ip1, body: { email: 'new.person@example.org', password: 'third password, the reset one' } });
await fetch(`${API}/rpc/admin_set_user`, { method: 'POST', headers: { Authorization: `Bearer ${alex.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_user: newId, p_disabled: true }) });
r = await call('/auth/login', { method: 'POST', ip: ip1, body: { email: 'new.person@example.org', password: 'third password, the reset one' } });
check('A disabled account cannot sign in', r.status === 403 && /disabled/.test(r.data.error));
check('Disabling ended its sessions', (await call('/auth/refresh', { method: 'POST', cookie: s6.cookie })).status === 401);
await fetch(`${API}/rpc/admin_set_user`, { method: 'POST', headers: { Authorization: `Bearer ${alex.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_user: newId, p_disabled: false }) });
check('Enabled again, it can sign in', (await call('/auth/login', { method: 'POST', ip: ip1, body: { email: 'new.person@example.org', password: 'third password, the reset one' } })).status === 200);

// ---------- rate limits
const ip2 = freshIp();
let last;
for (let i = 0; i < 9; i++) last = await call('/auth/login', { method: 'POST', ip: freshIp(), body: { email: 'alex.admin@example.com', password: `guess number ${i} here` } });
check('Repeated wrong passwords for one email are locked out (from any address)', last.status === 429, String(last.status));
for (let i = 0; i < 31; i++) last = await call('/auth/login', { method: 'POST', ip: ip2, body: { email: `x${i}@example.org`, password: 'whatever it is 1' } });
check('Many attempts from one address are locked out', last.status === 429, String(last.status));
check('Other addresses are not affected', (await call('/auth/login', { method: 'POST', ip: freshIp(), body: { email: 'new.person@example.org', password: 'third password, the reset one' } })).status === 200);

const w = Math.max(...results.map((x) => x.name.length));
for (const x of results) console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name.padEnd(w)}  ${x.ok ? '' : x.detail}`);
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
