// Jumping to a message from search, in real browsers, on the test stack (tests/run.sh --keep): a result for a message
// in a project's chat says which project and opens that project's chat with the message highlighted, even when you
// were looking at General; a message older than the latest 200 in a conversation opens with the messages around it
// and a way back to the latest; a message deleted after it was found says so instead of doing nothing.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node search-jump-browser.cjs
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const path = require('path');
const SHOTS = process.env.WEFT_SHOTS || require('os').tmpdir();
const BASE = process.env.WEFT_BASE || 'http://localhost:3211/';
const API = process.env.WEFT_API || 'http://127.0.0.1:3200';
const TAG = Date.now().toString(36).slice(-5);
const P = `Jump ${TAG}`;
const token = execFileSync('python3', ['-I', path.join(__dirname, '..', 'tools', 'mint_token.py'), 'u-alex'], { encoding: 'utf8' }).trim();
const api = async (p, method = 'GET', body) => {
  const r = await fetch(`${API}${p}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: body && JSON.stringify(body) });
  const t = await r.text(); return t ? JSON.parse(t) : null;
};
(async () => {
  const b = await chromium.launch(); const errs = []; const out = (...a) => console.log(...a); let failed = 0;
  const expect = (name, ok, detail = '') => { out(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (${detail})`}`); if (!ok) failed += 1; };
  const search = async (p, words) => {
    await p.fill('.search input', ''); await p.fill('.search input', words);
    await p.waitForSelector('.search-row', { timeout: 15000 });
  };
  const chip = (p, name) => p.locator('.project-strip .link-tag', { hasText: name });
  try {
    // Data, made as Alex through the API: a project with a message in its chat; a long General chat whose first
    // message is older than the latest 200; a message that is deleted after it was found.
    const fest = (await api('/spaces?kind=eq.channel&name=eq.festival&select=id'))[0].id;
    const [proj] = await api('/projects', 'POST', { space_id: fest, name: P });
    await api('/messages', 'POST', { space_id: fest, project_id: proj.id, body: `projectjump${TAG} boxes go to the hall` });
    await api('/messages', 'POST', { space_id: fest, body: `oldjump${TAG} the very first word` });
    await api('/messages', 'POST', Array.from({ length: 205 }, (_, n) => ({ space_id: fest, body: `filler ${TAG} ${n}` })));
    const [gone] = await api('/messages', 'POST', { space_id: fest, body: `gonejump${TAG} soon deleted` });

    const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(BASE, { waitUntil: 'networkidle' }); await p.getByRole('button', { name: 'Alex (test admin)' }).click(); await p.waitForSelector('.rail-title');
    await p.locator('.convos .convo', { hasText: 'festival' }).first().click();
    await p.waitForSelector('.project-strip');
    await p.locator('.messages').getByText(`gonejump${TAG}`).waitFor({ timeout: 15000 });   // the latest is in
    expect('General opens on its latest messages, not its oldest', (await p.locator('.messages').getByText(`gonejump${TAG}`).count()) === 1
      && !(await p.locator('.messages').getByText(`oldjump${TAG}`).count()));

    // A project message from search, while General is open.
    await search(p, `projectjump${TAG}`);
    const row = p.locator('.search-row').filter({ hasText: P }).first();
    expect('The search result says which project the message is in', await row.isVisible(), await p.locator('.search-panel').innerText());
    await row.dispatchEvent('mousedown');
    await p.waitForSelector(`.project-strip .link-tag[aria-pressed="true"]:has-text("${P}")`, { timeout: 15000 });
    await p.waitForSelector(`.msg.is-focus:has-text("projectjump${TAG}")`, { timeout: 15000 });
    expect('It opens the project\'s chat with the message highlighted', true);
    await p.screenshot({ path: `${SHOTS}/search-jump-project.png` });

    // An old message, beyond the latest 200.
    await search(p, `oldjump${TAG}`);
    await p.locator('.search-row').first().dispatchEvent('mousedown');
    await p.waitForSelector(`.msg.is-focus:has-text("oldjump${TAG}")`, { timeout: 15000 });
    expect('An old message opens in General, with the messages around it', await chip(p, 'General').getAttribute('aria-pressed') === 'true');
    expect('...and a way back to the latest', await p.locator('.around-bar').isVisible());
    await p.screenshot({ path: `${SHOTS}/search-jump-old.png` });
    await p.locator('.around-bar button').click();
    await p.locator('.messages').getByText(`gonejump${TAG}`).waitFor({ timeout: 5000 });
    expect('Back to the latest shows the newest messages again', !(await p.locator('.around-bar').count()));

    // A message deleted after it was found.
    await search(p, `gonejump${TAG}`);
    await api(`/messages?id=eq.${gone.id}`, 'DELETE');
    await p.locator('.search-row').first().dispatchEvent('mousedown');
    await p.waitForSelector('.thinking:has-text("no longer here")', { timeout: 15000 });
    expect('A message deleted in the meantime says so', true);
  } catch (e) {
    failed += 1; out(`FAIL ${e.message.split('\n')[0]}`);
    for (const [i, pg] of b.contexts().flatMap((c) => c.pages()).entries()) await pg.screenshot({ path: `${SHOTS}/search-jump-failed-${i}.png` }).catch(() => {});
  }
  expect('No page errors', errs.length === 0, errs.join(' | '));
  await b.close();
  out(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
