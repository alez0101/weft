// Announcements in real browsers, on the test stack (tests/run.sh --keep): Olive posts notices in
// #organizers and #festival; Alex (dark mode) sees a new one arrive live in the app and pinned at the top
// of #festival's chat; an end time in the past is refused with the database's answer; End now moves a
// notice to Ended (and off the chat strip, live), Show for a week brings it back; Pat (viewer) reads the
// #festival notices only, with no way to change them; the Home widget lists current notices and a row
// opens Announcements on that channel.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node announcements-browser.cjs
const { chromium } = require('playwright');
const SHOTS = process.env.WEFT_SHOTS || require('os').tmpdir();
const BASE = process.env.WEFT_BASE || 'http://localhost:3211/';
const local = (ms) => { const d = new Date(Date.now() + ms); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
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
  const openApp = async (p) => { await p.locator('.app:has-text("Announcements")').click(); await p.waitForSelector('.docs-list[aria-label="Channels"]'); };
  const channel = async (p, name) => { await p.locator('.notice-channel', { hasText: `#${name}` }).click(); await p.waitForSelector(`.notice-head:has-text("#${name}")`); await p.waitForSelector('.notice-group'); };
  const chat = async (p, name) => { await p.locator(`.convo[aria-label="${name}"]`).click(); await p.waitForSelector(`.thread-head h3:has-text("# ${name}")`); };
  const card = (p, title) => p.locator('.notice', { has: p.locator('.notice-title', { hasText: title }) });
  const showing = (p) => p.locator('ul[aria-label="Showing now"] .notice-title').allInnerTexts();
  const ended = (p) => p.locator('ul[aria-label="Ended"] .notice-title').allInnerTexts();
  const pinned = (p) => p.locator('.pinned .pinned-title').allInnerTexts();
  const post = async (p, { title, body = '', until }, wait = true) => {
    await p.getByRole('button', { name: 'New announcement' }).click();
    await p.fill('#notice-new-title', title); await p.fill('#notice-new-body', body);
    if (until) await p.fill('#notice-new-until', until);
    await p.locator('form[aria-label="New announcement"]').getByRole('button', { name: 'Post' }).click();
    if (wait) await p.waitForSelector(`ul[aria-label="Showing now"] .notice-title:has-text("${title}")`);
  };

  const olive = await open('Olive Organizer');
  await openApp(olive);
  await channel(olive, 'organizers');
  await post(olive, { title: 'Budget freeze until Friday', body: 'No new spending without asking Alex.' });
  await channel(olive, 'festival');
  await post(olive, { title: 'Gates open at 9 on Saturday', body: 'Volunteers: come in through Gate B and pick up your badge at the info tent.', until: local(5 * 86400000) });
  await post(olive, { title: 'Car park C is closed', body: 'Use the park and ride from the station.', until: local(2 * 86400000) });
  expect('Olive posts in #festival; newest first', (await showing(olive)).join('|') === 'Car park C is closed|Gates open at 9 on Saturday', (await showing(olive)).join('|'));
  expect('A notice shows who posted it and until when', (await card(olive, 'Car park C is closed').locator('.link-by').innerText()) === 'Posted by Olive Organizer'
    && (await card(olive, 'Car park C is closed').locator('.notice-when').innerText()).startsWith('Showing until'));
  expect('The channel list counts what is showing', (await olive.locator('.notice-channel', { hasText: '#festival' }).locator('.convo-count').innerText()) === '2'
    && (await olive.locator('.notice-channel', { hasText: '#organizers' }).locator('.convo-count').innerText()) === '1');

  // The database refuses an end in the past, and the screen says why.
  await post(olive, { title: 'Already over', until: local(-3600000) }, false);
  await olive.waitForSelector('.links .send-error');
  expect('An end time in the past is refused, with the reason shown', (await olive.locator('.links .send-error').innerText()).includes('must end in the future')
    && !(await showing(olive)).includes('Already over'));
  await olive.locator('form[aria-label="New announcement"]').getByRole('button', { name: 'Cancel' }).click();

  // Alex watches #festival in the app and in chat.
  const alex = await open('Alex (test admin)', true);
  await chat(alex, 'festival');
  await openApp(alex); await channel(alex, 'festival');
  expect('Alex sees #festival notices pinned at the top of its chat', (await pinned(alex)).join('|') === 'Car park C is closed|Gates open at 9 on Saturday', (await pinned(alex)).join('|'));
  const t0 = Date.now();
  await post(olive, { title: 'Lost and found is at the info tent', body: 'Open 9 to 6 both days.' });
  await alex.waitForSelector('ul[aria-label="Showing now"] .notice-title:has-text("Lost and found")', { timeout: 6000 });
  out(`Alex saw Olive's notice live: ${Date.now() - t0} ms`);
  expect('Alex sees a new notice live in the app', true);
  await alex.waitForFunction(() => document.querySelector('.pinned .pinned-title')?.textContent.includes('Lost and found'), null, { timeout: 6000 });
  expect('and at the top of the chat, with a link for the rest', (await pinned(alex)).length === 2 && (await alex.locator('.pinned-all').innerText()) === '1 more in Announcements');

  // End now and Show for a week, live for Alex.
  await card(olive, 'Car park C is closed').getByRole('button', { name: 'End now' }).click();
  await olive.waitForSelector('ul[aria-label="Ended"] .notice-title:has-text("Car park C is closed")');
  expect('End now moves a notice to Ended', !(await showing(olive)).includes('Car park C is closed') && (await ended(olive)).includes('Car park C is closed'));
  await alex.waitForSelector('ul[aria-label="Ended"] .notice-title:has-text("Car park C is closed")', { timeout: 6000 });
  expect('Alex sees it end live', !(await pinned(alex)).includes('Car park C is closed') && (await alex.locator('.pinned-all').innerText()) === 'Open in Announcements', (await pinned(alex)).join('|'));
  await card(olive, 'Car park C is closed').getByRole('button', { name: 'Show for a week' }).click();
  await olive.waitForSelector('ul[aria-label="Showing now"] .notice-title:has-text("Car park C is closed")');
  expect('Show for a week brings it back', (await ended(olive)).length === 0);

  // Edit.
  await card(olive, 'Gates open at 9 on Saturday').getByRole('button', { name: 'Edit' }).click();
  await olive.fill('.notice form input[id$="-title"]', 'Gates open at 8:30 on Saturday');
  await olive.locator('.notice form').getByRole('button', { name: 'Save' }).click();
  await alex.waitForSelector('.notice-title:has-text("Gates open at 8:30")', { timeout: 6000 });
  expect('An edit shows live', true);
  // End one so the screenshots show both groups.
  await card(olive, 'Car park C is closed').getByRole('button', { name: 'End now' }).click();
  await olive.waitForSelector('ul[aria-label="Ended"] .notice-title:has-text("Car park C is closed")');
  await chat(olive, 'festival'); await olive.waitForSelector('.pinned');
  await olive.waitForTimeout(400);
  await olive.screenshot({ path: `${SHOTS}/1-announcements-olive-light.png` });
  await alex.waitForSelector('ul[aria-label="Ended"] .notice-title:has-text("Car park C is closed")', { timeout: 6000 });
  await alex.waitForTimeout(400);
  await alex.screenshot({ path: `${SHOTS}/2-announcements-alex-dark.png` });

  // Pat (viewer in #festival only).
  const pat = await open('Pat Public');
  await chat(pat, 'festival');
  expect('Pat sees the #festival notices pinned in its chat', (await pinned(pat)).join('|') === 'Lost and found is at the info tent|Gates open at 8:30 on Saturday', (await pinned(pat)).join('|'));
  await openApp(pat);
  const chans = await pat.locator('.notice-channel').allInnerTexts();
  expect('Pat sees #festival in the app, not #organizers', chans.some((c) => c.includes('#festival')) && !chans.some((c) => c.includes('#organizers')), chans.join(', '));
  await channel(pat, 'festival');
  expect('Pat: no New announcement, Edit, End now, Show again or Delete', await pat.getByRole('button', { name: 'New announcement' }).count() === 0
    && await pat.locator('.notice').getByRole('button').count() === 0);
  expect('Pat: the hint says why, and the header says view only', (await pat.locator('.links > .docs-hint').innerText()).includes('make you an editor')
    && (await pat.locator('.docs-meta').innerText()).includes('View only'));
  expect('Pat reads the current and ended notices', (await showing(pat)).length === 2 && (await ended(pat)).includes('Car park C is closed'));
  await card(olive, 'Lost and found is at the info tent').getByRole('button', { name: 'Delete' }).click();
  await pat.waitForFunction(() => ![...document.querySelectorAll('.notice-title')].some((e) => e.textContent.includes('Lost and found')), null, { timeout: 6000 });
  expect('A delete shows live for Pat, in the app and the chat strip', (await showing(pat)).length === 1 && (await pinned(pat)).join('|') === 'Gates open at 8:30 on Saturday', (await pinned(pat)).join('|'));
  await pat.waitForTimeout(400);
  await pat.screenshot({ path: `${SHOTS}/3-announcements-pat-viewer.png` });

  // Home widget (on by default; turned on if this person saved a layout before it existed).
  const widget = async (p) => {
    await p.locator('#tab-home').click(); await p.waitForSelector('.widgets-area');
    let w = p.locator('.widget:has(h3:text-is("Announcements"))');
    if (!(await w.count())) {
      await p.getByRole('button', { name: 'Customize' }).click();
      await p.locator('.widget-picker label', { hasText: 'Announcements' }).locator('input').check();
      await p.getByRole('button', { name: 'Done', exact: true }).click();
      w = p.locator('.widget:has(h3:text-is("Announcements"))');
    }
    await w.locator('.widget-main').first().waitFor();
    return w;
  };
  const ow = await widget(olive);
  const orows = await ow.locator('.widget-main').allInnerTexts();
  out('Olive widget rows:', orows.join(' | '));
  expect('Widget: Olive sees current notices from both channels, not ended or deleted ones', orows.includes('Budget freeze until Friday') && orows.includes('Gates open at 8:30 on Saturday')
    && !orows.includes('Car park C is closed') && !orows.some((r) => r.includes('Lost and found')), orows.join(', '));
  const pw = await widget(pat);
  const prows = await pw.locator('.widget-main').allInnerTexts();
  expect('Widget: Pat sees #festival notices only', prows.join('|') === 'Gates open at 8:30 on Saturday', prows.join(', '));
  await ow.locator('.widget-row', { hasText: 'Budget freeze' }).click();
  await olive.waitForSelector('#tab-announcements[aria-selected="true"]');
  await olive.waitForSelector('.notice-head:has-text("#organizers")');
  expect('Widget: a row opens Announcements on its channel', (await showing(olive)).includes('Budget freeze until Friday'));

  expect('No page errors', errs.length === 0, errs.join('; '));
  out(failed ? `${failed} browser checks failed` : 'all browser checks passed');
  await b.close(); process.exit(failed ? 1 : 0);
})();
