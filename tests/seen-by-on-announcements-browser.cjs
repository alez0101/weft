// Seen by on announcements in real browsers, on the test stack (tests/run.sh --keep): Olive (editor) posts a
// #festival notice that asks everyone to press "Got it" and sees "0 of 3 members got it" with who has not;
// Pat (viewer) presses Got it at the top of #festival's chat and in Announcements, and Olive's count moves
// live; Alex (owner, dark mode) presses it from the Home widget and sees the tally too; Pat can undo it, sees
// no tally and no editing buttons; a notice that does not ask has no button. Screenshots to WEFT_SHOTS.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node seen-by-on-announcements-browser.cjs
const { chromium } = require('playwright');
const SHOTS = process.env.WEFT_SHOTS || require('os').tmpdir();
const BASE = process.env.WEFT_BASE || 'http://localhost:3211/';
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
  const tally = (p, title) => card(p, title).locator('.ack-tally');
  const waitTally = (p, title, text) => p.waitForFunction(([t, x]) => [...document.querySelectorAll('.notice')]
    .some((n) => n.querySelector('.notice-title')?.textContent.includes(t) && n.querySelector('.ack-tally')?.textContent.includes(x)), [title, text], { timeout: 6000 });
  const T = 'Wristbands change on Friday';
  const post = async (p, title, body, ask) => {
    await p.getByRole('button', { name: 'New announcement' }).click();
    await p.fill('#notice-new-title', title); await p.fill('#notice-new-body', body);
    if (ask) await p.locator('#notice-new-ack').check();
    await p.locator('form[aria-label="New announcement"]').getByRole('button', { name: 'Post' }).click();
    await p.waitForSelector(`ul[aria-label="Showing now"] .notice-title:has-text("${title}")`);
  };

  // Olive posts one notice that asks and one that does not.
  const olive = await open('Olive Organizer');
  await openApp(olive); await channel(olive, 'festival');
  await post(olive, 'Toilets by the main stage are out of order', 'Use the ones behind the food court.', false);
  await post(olive, T, 'Old wristbands stop working at noon on Friday. Swap yours at the info tent before then.', true);
  expect('A notice that does not ask has no Got it and no tally', await card(olive, 'Toilets by the main stage').locator('.ack-btn, .ack-tally').count() === 0);
  expect('Olive (editor) sees "0 of 3 members got it" and who has not',
    (await tally(olive, T).innerText()).includes('0 of 3 members got it') && (await tally(olive, T).innerText()).includes('Not yet: Alex (test admin), Pat Public, Vic Volunteer'),
    await tally(olive, T).innerText());
  expect('The poster gets no Got it button on their own notice', await card(olive, T).locator('.ack-btn').count() === 0);

  // Pat (viewer) presses it at the top of #festival's chat.
  const pat = await open('Pat Public');
  await chat(pat, 'festival');
  const pin = pat.locator('.pinned-note', { hasText: T });
  await pin.waitFor();
  expect('Pat sees Got it on the notice pinned at the top of the chat', await pin.getByRole('button', { name: 'Got it' }).count() === 1);
  const t0 = Date.now();
  await pin.getByRole('button', { name: 'Got it' }).click();
  await pin.locator('.ack-done').waitFor();
  expect('After pressing, Pat sees "You got it"', (await pin.locator('.ack-done').innerText()).startsWith('You got it'));
  await waitTally(olive, T, '1 of 3 members got it');
  out(`Olive saw Pat's Got it live: ${Date.now() - t0} ms`);
  expect('Olive sees the count move live, and Pat is no longer listed', !(await tally(olive, T).innerText()).includes('Pat Public'), await tally(olive, T).innerText());

  // Pat in Announcements: read-only notice, own answer, undo, no tally.
  await openApp(pat); await channel(pat, 'festival');
  expect('Pat: no tally, no editing buttons, only Undo on her own Got it', await pat.locator('.ack-tally').count() === 0
    && await card(pat, T).locator('.link-foot').getByRole('button').count() === 0
    && await card(pat, T).getByRole('button', { name: /Undo/ }).count() === 1);
  await card(pat, T).getByRole('button', { name: /Undo/ }).click();
  await card(pat, T).getByRole('button', { name: /^Got it/ }).waitFor();
  await waitTally(olive, T, '0 of 3 members got it');
  expect('Undo takes it back, live for Olive', true);
  await card(pat, T).getByRole('button', { name: /^Got it/ }).click();
  await card(pat, T).locator('.ack-done').waitFor();
  await waitTally(olive, T, '1 of 3 members got it');
  expect('Pat presses it again from Announcements', true);
  expect('Pat sees no Got it on the notice that does not ask', await card(pat, 'Toilets by the main stage').locator('.ack').count() === 0
    || (await card(pat, 'Toilets by the main stage').locator('.ack').innerText()) === '');

  // Alex (owner, dark mode) presses it from the Home widget.
  const alex = await open('Alex (test admin)', true);
  await alex.locator('#tab-home').click(); await alex.waitForSelector('.widgets-area');
  let w = alex.locator('.widget:has(h3:text-is("Announcements"))');
  if (!(await w.count())) {
    await alex.getByRole('button', { name: 'Customize' }).click();
    await alex.locator('.widget-picker label', { hasText: 'Announcements' }).locator('input').check();
    await alex.getByRole('button', { name: 'Done', exact: true }).click();
    w = alex.locator('.widget:has(h3:text-is("Announcements"))');
  }
  const wrow = w.locator('li', { hasText: T });
  await wrow.waitFor();
  expect('The Home widget offers Got it under the notice', await wrow.getByRole('button', { name: /^Got it/ }).count() === 1);
  await wrow.getByRole('button', { name: /^Got it/ }).click();
  await wrow.locator('.ack-done').waitFor();
  expect('and shows "You got it" after pressing', true);
  await waitTally(olive, T, '2 of 3 members got it');
  expect('Olive sees 2 of 3, only Vic left', (await tally(olive, T).innerText()).includes('Not yet: Vic Volunteer'), await tally(olive, T).innerText());
  await openApp(alex); await channel(alex, 'festival');
  expect('Alex (owner) sees the tally too', (await tally(alex, T).innerText()).includes('2 of 3 members got it'));

  // Screenshots: Olive in the app (light), Alex (dark), Pat's read-only view.
  await olive.waitForTimeout(300);
  await olive.screenshot({ path: `${SHOTS}/1-seen-by-olive-light.png` });
  await alex.waitForTimeout(300);
  await alex.screenshot({ path: `${SHOTS}/2-seen-by-alex-dark.png` });
  await chat(pat, 'festival'); await pat.locator('.pinned-note', { hasText: T }).locator('.ack-done').waitFor();
  await pat.waitForTimeout(300);
  await pat.screenshot({ path: `${SHOTS}/3-seen-by-pat-viewer.png` });

  // Tidy up so the other browser checks see the channel as before.
  for (const t of [T, 'Toilets by the main stage']) {
    await card(olive, t).getByRole('button', { name: 'Delete' }).click();
    await olive.waitForFunction((x) => ![...document.querySelectorAll('.notice-title')].some((e) => e.textContent.includes(x)), t, { timeout: 6000 });
  }
  expect('No page errors', errs.length === 0, errs.join('; '));
  out(failed ? `${failed} browser checks failed` : 'all browser checks passed');
  await b.close(); process.exit(failed ? 1 : 0);
})();
