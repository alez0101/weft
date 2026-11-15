// Projects inside channels in real browsers, on the test stack (tests/run.sh --keep): Alex (owner of #festival) makes
// a project, writes its instructions and chats in it; the "Weft follows" line names it; General leaves the project's
// chat out; Pat (viewer, dark mode) sees the project, reads its chat live and its instructions read-only, with no way
// to make or change projects; Alex makes a document in the project from Documents, where it is grouped under the
// project, and pins it for Weft; the pin shows in Project settings; Alex closes the channel to AI agents; Personal
// is in the chat list; "Your rules for Weft" saves from the account menu.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node projects-browser.cjs
const { chromium } = require('playwright');
const SHOTS = process.env.WEFT_SHOTS || require('os').tmpdir();
const BASE = process.env.WEFT_BASE || 'http://localhost:3211/';
const P = `Camp ${Date.now().toString(36).slice(-5)}`;   // a new project name each run
(async () => {
  const b = await chromium.launch(); const errs = []; const out = (...a) => console.log(...a); let failed = 0;
  const expect = (name, ok, detail = '') => { out(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (${detail})`}`); if (!ok) failed += 1; };
  const open = async (who, dark) => {
    const p = await (await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: dark ? 'dark' : 'light' })).newPage();
    p.on('pageerror', (e) => errs.push(`${who}: ${e.message}`));
    p.on('dialog', (d) => d.accept());
    await p.goto(BASE, { waitUntil: 'networkidle' }); await p.getByRole('button', { name: who }).click(); await p.waitForSelector('.rail-title');
    return p;
  };
  const convo = async (p, name) => { await p.locator('.convos .convo', { hasText: name }).first().click(); await p.waitForSelector('.project-strip'); };
  const chip = (p, name) => p.locator('.project-strip .link-tag', { hasText: name });
  const say = async (p, text) => { await p.fill('#compose', text); await p.press('#compose', 'Enter'); await p.waitForSelector(`.messages .msg:has-text("${text}")`); };
  const shot = (p, name) => p.screenshot({ path: `${SHOTS}/projects-${name}.png` });

  try {
    const alex = await open('Alex (test admin)');
    await convo(alex, 'festival');
    expect('A channel shows General, pressed, with + Project for an owner',
      await chip(alex, 'General').getAttribute('aria-pressed') === 'true' && await alex.locator('.project-add').isVisible());
    await alex.locator('.project-add').click();
    await alex.fill('#project-name', `${P}`);
    await alex.getByRole('button', { name: 'Make project' }).click();
    await alex.waitForSelector(`.project-strip .link-tag[aria-pressed="true"]:has-text("${P}")`);
    expect('Making a project switches to its chat', (await alex.locator('.messages').innerText()).includes(`No messages in ${P} yet`));
    await alex.locator('.project-rules-btn').click();
    await alex.locator('.project-panel textarea').fill('Pickup is Sunday at nine. Answer as the food drive lead.');
    await alex.locator('.project-panel').getByRole('button', { name: 'Save' }).click();
    await alex.waitForSelector('.project-panel .slot-status:has-text("Saved")');
    expect('The "Weft follows" line names the project', await alex.locator(`.project-following:has-text("${P}")`).isVisible(),
      await alex.locator('.project-following').allInnerTexts().then((t) => t.join('|')));
    await shot(alex, 'settings');
    await alex.locator('.project-panel').getByRole('button', { name: 'Close' }).click();
    await say(alex, 'Boxes go to the church hall on Friday.');
    await chip(alex, 'General').click();
    await alex.waitForSelector('.messages');
    await alex.waitForTimeout(400);
    expect('General leaves the project chat out', !(await alex.locator('.messages').innerText()).includes('church hall'));
    await chip(alex, `${P}`).click();
    await alex.waitForSelector('.messages .msg:has-text("church hall")');
    expect('The composer says where the message goes', ((await alex.getAttribute('#compose', 'placeholder')) || '').includes(`${P}`));
    await shot(alex, 'chat');

    const pat = await open('Pat Public', true);
    await convo(pat, 'festival');
    expect('Pat (viewer) sees the project, with no + Project', await chip(pat, `${P}`).isVisible() && !(await pat.locator('.project-add').count()));
    await chip(pat, `${P}`).click();
    await pat.waitForSelector('.messages .msg:has-text("church hall")');
    await say(alex, 'Bring tape too.');
    await pat.waitForSelector('.messages .msg:has-text("Bring tape too.")', { timeout: 8000 });
    expect('Pat sees a new project message arrive live', true);
    await pat.locator('.project-rules-btn').click();
    await pat.waitForSelector('.project-panel');
    expect('Pat reads the instructions, read-only, with no Save or Archive',
      (await pat.locator('.project-readonly').innerText()).includes('Pickup is Sunday') && !(await pat.locator('.project-panel textarea').count())
      && !(await pat.locator('.project-panel button:has-text("Save")').count()) && !(await pat.locator('.project-panel button:has-text("Archive")').count()));
    await shot(pat, 'viewer-dark');
    await pat.locator('.project-panel').getByRole('button', { name: 'Close' }).click();
    await say(pat, 'I can drop off on Saturday.');
    expect('Pat chats in the project (positive control)', true);

    // Documents: make one in the project; it is grouped under it; pin it.
    await alex.locator('.app:has-text("Documents")').click();
    await alex.waitForSelector('.docs-new select');
    const place = await alex.locator('.docs-new select option', { hasText: `#festival › ${P}` }).getAttribute('value');
    await alex.selectOption('.docs-new select', place);
    await alex.getByRole('button', { name: 'New document' }).click();
    await alex.waitForSelector('.docs-title');
    await alex.fill('.docs-title', `${P} routes`); await alex.press('.docs-title', 'Enter');
    await alex.waitForSelector(`.docs-project .doc-link:has-text("${P} routes")`);
    expect('The new document is listed under its project', (await alex.locator('.docs-project', { has: alex.locator('.doc-link', { hasText: `${P} routes` }) }).locator('.tree-project').innerText()) === `${P}`);
    expect('Its header names the channel and the project', (await alex.locator('.docs-meta').innerText()).includes(`#festival › ${P}`));
    await alex.getByRole('button', { name: 'Pin for Weft' }).click();
    await alex.waitForSelector('button:has-text("Unpin for Weft")');
    expect('Pinning says Weft will always read it', (await alex.locator('.docs-head .slot-status').innerText()).includes('Pinned'));
    await shot(alex, 'documents');
    await alex.locator('.project-rules-btn').click();
    await alex.waitForSelector(`.project-pins li:has-text("${P} routes")`);
    expect('Project settings list the pinned document', true);
    await alex.locator('.project-panel').getByRole('button', { name: 'Close' }).click();

    // The channel's rules: close it to AI agents.
    await chip(alex, 'General').click();
    await alex.locator('.project-rules-btn').click();
    const box = alex.locator('.project-panel input[type="checkbox"]');
    expect('A channel starts open to AI agents', await box.isChecked());
    await box.uncheck();
    await alex.locator('.project-panel textarea').fill('Keep answers friendly.');
    await alex.locator('.project-panel').getByRole('button', { name: 'Save' }).click();
    await alex.waitForSelector('.project-panel .slot-status');
    await alex.locator('.project-panel').getByRole('button', { name: 'Close' }).click();
    await alex.locator('.project-rules-btn').click();
    expect('The switch stays off after saving', !(await alex.locator('.project-panel input[type="checkbox"]').isChecked()));
    expect('General follows the channel rules', (await alex.locator('.project-following').innerText()).includes('#festival rules'));
    await alex.locator('.project-panel input[type="checkbox"]').check();   // leave the channel open again for later runs
    await alex.locator('.project-panel').getByRole('button', { name: 'Save' }).click();
    await alex.waitForSelector('.project-panel .slot-status:has-text("Saved")');
    await alex.locator('.project-panel').getByRole('button', { name: 'Close' }).click();

    // Personal is a conversation of its own; your own rules save from the account menu.
    await convo(alex, 'Personal');
    expect('Personal is in the chat list, with General', await chip(alex, 'General').isVisible() && (await alex.locator('.thread-sub').first().innerText()).includes('Only you'));
    await alex.locator('.avatar').click();
    await alex.getByRole('button', { name: 'Your rules for Weft' }).click();
    await alex.waitForSelector('#myrules-title');
    await alex.locator('dialog textarea').fill('Two sentences at most.');
    await alex.locator('dialog').getByRole('button', { name: 'Save' }).click();
    await alex.waitForSelector('dialog .slot-status:has-text("Saved")');
    expect('Your rules for Weft save', true);
    await shot(alex, 'my-rules');
  } catch (e) {
    failed += 1; out(`FAIL ${e.message.split('\n')[0]}`);
    for (const [i, pg] of b.contexts().flatMap((c) => c.pages()).entries()) await pg.screenshot({ path: `${SHOTS}/projects-failed-${i}.png` }).catch(() => {});
  }
  expect('No page errors', errs.length === 0, errs.join(' | '));
  await b.close();
  out(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
