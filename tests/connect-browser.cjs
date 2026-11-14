// The connector's consent screen and Connected apps, in real browsers, on the test stack (tests/run.sh --keep):
// an app registers, Olive opens the consent screen signed out, signs in, sees the app's name and where the
// answer goes, chooses read and write, and is sent back with a code that trades for working tokens; Cancel
// sends access_denied; an unregistered request shows an error and goes nowhere; Connected apps lists the app
// (dark mode) and Disconnect ends it.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node connect-browser.cjs
const crypto = require('crypto');
const { chromium } = require('playwright');
const SHOTS = process.env.WEFT_SHOTS || require('os').tmpdir();
const BASE = (process.env.WEFT_BASE || 'http://localhost:3211/').replace(/\/$/, '');
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
(async () => {
  const b = await chromium.launch(); const errs = []; const out = (...a) => console.log(...a); let failed = 0;
  const expect = (name, ok, detail = '') => { out(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (${detail})`}`); if (!ok) failed += 1; };
  const post = async (path, body, form) => {
    const r = await fetch(`${BASE}${path}`, form
      ? { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  };
  const reg = await post('/oauth/register', { client_name: 'Claude', redirect_uris: [REDIRECT] });
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const q = new URLSearchParams({ client_id: reg.data.client_id, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz' });

  const page = async (dark) => {
    const p = await (await b.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: dark ? 'dark' : 'light' })).newPage();
    p.on('pageerror', (e) => errs.push(e.message));
    let landed = null;
    await p.route('https://claude.ai/**', (route) => { landed = route.request().url(); route.fulfill({ status: 200, contentType: 'text/html', body: '<p>back in the app</p>' }); });
    return { p, landed: () => landed };
  };

  // Allow, read and write
  const a = await page(false);
  await a.p.goto(`${BASE}/oauth/authorize?${q}`, { waitUntil: 'networkidle' });
  expect('Signed out: the sign-in says an app is being connected', await a.p.getByText('Sign in to connect an app').isVisible());
  await a.p.getByRole('button', { name: 'Olive Organizer' }).click();
  await a.p.waitForSelector('.connect-title');
  expect('Consent names the app', (await a.p.locator('.connect-title').innerText()).includes('Connect Claude to Weft'));
  expect('Consent names the person and where the answer goes', (await a.p.locator('.connect').innerText()).includes('Olive Organizer') && (await a.p.locator('.connect-note').innerText()).includes('claude.ai'));
  expect('Read only is chosen by default', await a.p.getByRole('radio', { name: /Read only/ }).isChecked());
  await a.p.getByRole('radio', { name: /Read and write/ }).check();
  await a.p.screenshot({ path: `${SHOTS}/1-connect-consent-light.png` });
  await a.p.getByRole('button', { name: 'Allow' }).click();
  await a.p.waitForFunction(() => document.body.innerText.includes('back in the app'), null, { timeout: 8000 }).catch(() => {});
  const back = new URL(a.landed() || 'https://x/');
  expect('Allow sends Olive back to the app with a code and the state', back.searchParams.get('code') && back.searchParams.get('state') === 'xyz', a.landed());
  const tok = await post('/oauth/token', { grant_type: 'authorization_code', code: back.searchParams.get('code'), code_verifier: verifier, client_id: reg.data.client_id, redirect_uri: REDIRECT }, true);
  expect('The code trades for read-and-write tokens', tok.status === 200 && tok.data.scope === 'weft:read weft:write', JSON.stringify(tok.data));

  // Cancel
  const c = await page(true);
  await c.p.goto(`${BASE}/oauth/authorize?${q}`, { waitUntil: 'networkidle' });
  await c.p.getByRole('button', { name: 'Olive Organizer' }).click();
  await c.p.waitForSelector('.connect-title');
  await c.p.screenshot({ path: `${SHOTS}/2-connect-consent-dark.png` });
  await c.p.getByRole('button', { name: 'Cancel' }).click();
  await c.p.waitForFunction(() => document.body.innerText.includes('back in the app'), null, { timeout: 8000 }).catch(() => {});
  const denied = new URL(c.landed() || 'https://x/');
  expect('Cancel sends access_denied and no code', denied.searchParams.get('error') === 'access_denied' && !denied.searchParams.get('code'), c.landed());

  // A request from an app Weft does not know
  await c.p.goto(`${BASE}/oauth/authorize?${new URLSearchParams({ ...Object.fromEntries(q), client_id: 'wcl_unknown' })}`, { waitUntil: 'networkidle' });
  if (await c.p.getByRole('button', { name: 'Olive Organizer' }).count()) await c.p.getByRole('button', { name: 'Olive Organizer' }).click(); // test sign-ins keep no session
  await c.p.waitForSelector('.signin-error');
  expect('An unknown app gets an error on screen, and no buttons', (await c.p.locator('.signin-error').innerText()).includes('not registered') && !(await c.p.getByRole('button', { name: 'Allow' }).count()));

  // Connected apps in the account menu (dark mode)
  await c.p.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  if (await c.p.getByRole('button', { name: 'Olive Organizer' }).count()) await c.p.getByRole('button', { name: 'Olive Organizer' }).click();
  await c.p.waitForSelector('.rail-title');
  await c.p.locator('.avatar').click();
  await c.p.getByRole('button', { name: 'Connected apps' }).click();
  await c.p.waitForSelector('#ca-title');
  await c.p.waitForSelector('.person-name:has-text("Claude")');
  const row = await c.p.locator('.person-name:has-text("Claude")').innerText();
  expect('Connected apps lists Claude with read and write', row.includes('Read and write'), row);
  expect('Connected apps shows the address to connect', (await c.p.locator('dialog code').innerText()).endsWith('/mcp'));
  await c.p.screenshot({ path: `${SHOTS}/3-connected-apps-dark.png` });
  await c.p.locator('.person', { hasText: 'Claude' }).getByRole('button', { name: 'Disconnect' }).click();
  await c.p.waitForSelector('text=Claude is disconnected.');
  const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${tok.data.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  expect('Disconnect ends the connection at once', r.status === 401, r.status);

  expect('No page errors', !errs.length, errs.join(' | '));
  await b.close();
  out(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})();
