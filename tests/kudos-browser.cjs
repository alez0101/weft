// Kudos in real browsers, on the test stack (tests/run.sh --keep): Olive thanks Alex in #organizers and
// Pat and Vic in #festival; the wall is newest first and says who gave each kudos; Alex (dark mode) sees a
// new kudos and an edit arrive live; a kudos for someone who is not in the channel is refused and the
// database's answer is shown; Alex (owner) may delete Olive's kudos but not edit it; Pat (viewer) reads the
// #festival wall only, with her kudos marked "you" and no way to give, change or delete; the Home widget
// "Recent kudos" lists kudos from the person's channels and a row opens that channel's wall.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node kudos-browser.cjs
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
  const openApp = async (p) => { await p.locator('.app:has-text("Kudos")').click(); await p.waitForSelector('.docs-list[aria-label="Channels"]'); };
  const channel = async (p, name) => {
    await p.locator('.docs-list .doc-link', { hasText: `#${name}` }).click();
    await p.waitForSelector(`.kudos-head:has-text("#${name}")`);
    await p.waitForSelector('.kudos-wall, .links > .convo-empty');
  };
  const wall = (p) => p.locator('.kudos-wall .kudos-message').allInnerTexts();
  const card = (p, text) => p.locator('.kudos-card', { has: p.locator('.kudos-message', { hasText: text }) });
  const give = async (p, to, message, wait = true) => {
    await p.selectOption('#kudos-new-to', { label: to });
    await p.fill('#kudos-new-message', message);
    await p.locator('form[aria-label="Give kudos"]').getByRole('button', { name: 'Give kudos' }).click();
    if (wait) await p.waitForSelector(`.kudos-wall .kudos-message:has-text("${message}")`);
  };

  const olive = await open('Olive Organizer');
  await openApp(olive);
  await channel(olive, 'organizers');
  expect('An empty wall says so', (await olive.locator('.links > .convo-empty').innerText()).includes('No kudos yet'));
  await give(olive, 'Alex (test admin)', 'Thank you for sorting out the insurance in one afternoon.');
  await channel(olive, 'festival');
  const opts = await olive.locator('#kudos-new-to option').allInnerTexts();
  expect('The "For" list has the other members of the channel, not Olive herself', opts.includes('Pat Public') && opts.includes('Vic Volunteer') && !opts.includes('Olive Organizer'), opts.join(', '));
  const patId = await olive.locator('#kudos-new-to option', { hasText: 'Pat Public' }).getAttribute('value');
  await give(olive, 'Vic Volunteer', 'Vic carried every chair back to the hall after the rain.');
  await give(olive, 'Pat Public', 'Pat handed out 300 maps at Gate B and knew every answer.');
  expect('Olive thanks Pat and Vic in #festival; newest first', (await wall(olive)).join('|') === 'Pat handed out 300 maps at Gate B and knew every answer.|Vic carried every chair back to the hall after the rain.', (await wall(olive)).join('|'));
  expect('A card says who it is for and who gave it', (await card(olive, 'Pat handed out').locator('.kudos-to').innerText()) === 'For Pat Public'
    && (await card(olive, 'Pat handed out').locator('.kudos-from').innerText()).startsWith('From Olive Organizer'));
  expect('The header counts the thank-yous', (await olive.locator('.docs-meta').innerText()).includes('2 thank-yous'));

  // The database refuses a kudos for someone who is not in the channel, and the screen says why. (The
  // screen only offers members, so the request is changed on its way out, as a stale screen could send it.)
  await channel(olive, 'organizers');
  await olive.route('**/kudos', async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.continue();
    await route.continue({ postData: JSON.stringify({ ...JSON.parse(req.postData()), to_user: patId }) });
  });
  await give(olive, 'Alex (test admin)', 'This should not arrive', false);
  await olive.waitForSelector('.links .send-error');
  expect('A kudos for someone outside the channel is refused, with the reason shown', (await olive.locator('.links .send-error').innerText()).includes('member of this channel')
    && !(await wall(olive)).includes('This should not arrive'), await olive.locator('.links .send-error').innerText());
  await olive.unroute('**/kudos');
  await olive.fill('#kudos-new-message', '');
  await channel(olive, 'festival');

  // Alex watches #festival.
  const alex = await open('Alex (test admin)', true);
  await openApp(alex); await channel(alex, 'festival');
  const t0 = Date.now();
  await give(olive, 'Alex (test admin)', 'Alex fixed the sound desk ten minutes before the first act.');
  await alex.waitForSelector('.kudos-message:has-text("Alex fixed the sound desk")', { timeout: 6000 });
  out(`Alex saw Olive's kudos live: ${Date.now() - t0} ms`);
  expect('Alex sees a new kudos live, at the top, marked as for him', (await wall(alex))[0].startsWith('Alex fixed the sound desk')
    && (await card(alex, 'Alex fixed the sound desk').locator('.kudos-you').count()) === 1);
  // Olive rewords her own; Alex sees it live.
  await card(olive, 'Vic carried every chair').getByRole('button', { name: 'Edit' }).click();
  await olive.fill('.kudos-card form textarea', 'Vic carried every chair and table back to the hall after the rain.');
  await olive.locator('.kudos-card form').getByRole('button', { name: 'Save' }).click();
  await alex.waitForSelector('.kudos-message:has-text("chair and table")', { timeout: 6000 });
  expect('An edit shows live, marked as edited', (await card(alex, 'chair and table').locator('.kudos-from').innerText()).includes('(edited)'));
  // Alex (owner) may delete Olive's kudos, not edit it.
  expect('Alex (owner) gets Delete but not Edit on Olive\'s kudos', await card(alex, 'Pat handed out').getByRole('button', { name: /^Delete/ }).count() === 1
    && await card(alex, 'Pat handed out').getByRole('button', { name: /^Edit/ }).count() === 0);
  await give(alex, 'Olive Organizer', 'Olive kept the volunteer rota on one page, and it worked.');
  await give(olive, 'Vic Volunteer', 'Oops, a duplicate to tidy up');
  await alex.waitForSelector('.kudos-message:has-text("a duplicate to tidy up")', { timeout: 6000 });
  await card(alex, 'a duplicate to tidy up').getByRole('button', { name: /^Delete/ }).click();
  await olive.waitForFunction(() => ![...document.querySelectorAll('.kudos-message')].some((e) => e.textContent.includes('duplicate')), null, { timeout: 6000 });
  expect('Alex deletes it, and it goes for Olive live', true);
  await olive.waitForTimeout(500);
  await olive.screenshot({ path: `${SHOTS}/1-kudos-olive-light.png` });
  await alex.waitForTimeout(500);
  await alex.screenshot({ path: `${SHOTS}/2-kudos-alex-dark.png` });

  // Pat (viewer in #festival only).
  const pat = await open('Pat Public');
  await openApp(pat);
  const chans = await pat.locator('.docs-list .doc-link').allInnerTexts();
  expect('Pat sees #festival in the app, not #organizers', chans.includes('#festival') && !chans.includes('#organizers'), chans.join(', '));
  await channel(pat, 'festival');
  expect('Pat reads the #festival wall, newest first', (await wall(pat)).length === 4 && (await wall(pat))[0].startsWith('Olive kept the volunteer rota'), (await wall(pat)).join('|'));
  expect('Pat: no form, no Edit or Delete', await pat.locator('form[aria-label="Give kudos"]').count() === 0 && await pat.locator('.kudos-card').getByRole('button').count() === 0);
  expect('Pat: the hint says why, and the header says view only', (await pat.locator('.links > .docs-hint').innerText()).includes('make you an editor')
    && (await pat.locator('.docs-meta').innerText()).includes('View only'));
  expect('Pat\'s kudos is marked "you"', (await card(pat, 'Pat handed out').locator('.kudos-you').count()) === 1);
  await pat.waitForTimeout(400);
  await pat.screenshot({ path: `${SHOTS}/3-kudos-pat-viewer.png` });

  // Home widget (opt-in).
  const widget = async (p) => {
    await p.locator('#tab-home').click(); await p.waitForSelector('.widgets-area');
    let w = p.locator('.widget:has(h3:text-is("Recent kudos"))');
    if (!(await w.count())) {
      await p.getByRole('button', { name: 'Customize' }).click();
      await p.locator('.widget-picker label', { hasText: 'Recent kudos' }).locator('input').check();
      await p.getByRole('button', { name: 'Done', exact: true }).click();
      w = p.locator('.widget:has(h3:text-is("Recent kudos"))');
    }
    await w.locator('.widget-main').first().waitFor();
    return w;
  };
  const ow = await widget(olive);
  const onotes = await ow.locator('.widget-note').allInnerTexts();
  expect('Widget: Olive sees kudos from #festival and #organizers', onotes.some((n) => n.includes('insurance')) && onotes.some((n) => n.includes('volunteer rota')) && !onotes.some((n) => n.includes('duplicate')), onotes.join(' | '));
  const pw = await widget(pat);
  const pnotes = await pw.locator('.widget-note').allInnerTexts();
  expect('Widget: Pat sees #festival kudos only', pnotes.length === 4 && !pnotes.some((n) => n.includes('insurance')), pnotes.join(' | '));
  await ow.locator('.widget-row', { hasText: 'insurance' }).click();
  await olive.waitForSelector('#tab-kudos[aria-selected="true"]');
  await olive.waitForSelector('.kudos-head:has-text("#organizers")');
  expect('Widget: a row opens Kudos on its channel', (await wall(olive)).some((m) => m.includes('insurance')));

  expect('No page errors', errs.length === 0, errs.join('; '));
  out(failed ? `${failed} browser checks failed` : 'all browser checks passed');
  await b.close(); process.exit(failed ? 1 : 0);
})();
