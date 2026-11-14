// Shift sign-up in real browsers, on the test stack (tests/run.sh --keep): Olive adds two #festival shifts
// for tomorrow (Bar with two places, Gate with one); Alex (dark mode, owner) sees them arrive live; Olive
// takes a place on Bar and Alex sees her name and the open count change live; Pat (viewer in #festival only)
// takes the one place on Gate and has no way to add, change or delete shifts or take anyone off; Alex finds
// Gate full and fills Bar; Olive is refused lowering Bar to one place, with the database's answer; the
// filters; Olive's Home widget lists her shift; Olive takes Pat off Gate and Pat sees it open again live.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node shifts-browser.cjs
const { chromium } = require('playwright');
const SHOTS = process.env.WEFT_SHOTS || require('os').tmpdir();
const BASE = process.env.WEFT_BASE || 'http://localhost:3211/';
(async () => {
  const b = await chromium.launch(); const errs = []; const out = (...a) => console.log(...a); let failed = 0;
  const expect = (name, ok, detail = '') => { out(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (${detail})`}`); if (!ok) failed += 1; };
  const open = async (who, dark) => {
    const p = await (await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: dark ? 'dark' : 'light', locale: 'en-GB' })).newPage();
    p.on('pageerror', (e) => errs.push(`${who}: ${e.message}`));
    p.on('dialog', (d) => d.accept());
    await p.goto(BASE, { waitUntil: 'networkidle' }); await p.getByRole('button', { name: who }).click(); await p.waitForSelector('.rail-title');
    return p;
  };
  const openApp = async (p) => { await p.locator('.app:has-text("Shifts")').click(); await p.waitForSelector('.docs-list[aria-label="Show shifts"]'); await p.waitForSelector('.shift-head'); await p.waitForTimeout(400); };
  const card = (p, title) => p.locator('li.shift', { has: p.locator('.shift-title', { hasText: new RegExp(`^${title}$`) }) });
  const count = (p, title) => card(p, title).locator('.shift-count').innerText();
  const who = (p, title) => card(p, title).locator('.shift-who').innerText();
  const pad = (n) => String(n).padStart(2, '0');
  const d = new Date(); d.setDate(d.getDate() + 1);
  const TOMORROW = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  // Start clean: Alex (owner of #festival) deletes Bar and Gate if an earlier run left them.
  const alex = await open('Alex (test admin)', true);
  await openApp(alex);
  for (const title of ['Bar', 'Gate']) {
    while (await card(alex, title).count()) {
      await card(alex, title).first().getByRole('button', { name: /^Delete/ }).click();
      await alex.waitForTimeout(600);
    }
  }

  const olive = await open('Olive Organizer');
  await openApp(olive);
  for (const [title, from, to, places, note] of [['Bar', '18:00', '22:00', '2', 'Main tent. Wear the festival T-shirt.'], ['Gate', '10:00', '14:00', '1', '']]) {
    await olive.getByRole('button', { name: 'New shift' }).click();
    await olive.locator('#sh-new-space').selectOption({ label: '#festival' });
    await olive.locator('#sh-new-title').fill(title);
    await olive.locator('#sh-new-day').fill(TOMORROW);
    await olive.locator('#sh-new-from').fill(from); await olive.locator('#sh-new-to').fill(to);
    await olive.locator('#sh-new-places').fill(places);
    if (note) await olive.locator('#sh-new-note').fill(note);
    await olive.locator('form[aria-label="New shift"]').getByRole('button', { name: 'Add shift' }).click();
    await card(olive, title).waitFor();
  }
  expect('Olive adds Bar (2 places) and Gate (1 place) to #festival', (await count(olive, 'Bar')) === '2 of 2 open' && (await count(olive, 'Gate')) === '1 of 1 open',
    `${await count(olive, 'Bar')} / ${await count(olive, 'Gate')}`);
  expect('Bar shows its time and channel', (await card(olive, 'Bar').locator('.shift-when').innerText()) === '18:00 to 22:00' && (await card(olive, 'Bar').locator('.link-by').innerText()) === '#festival');
  await card(alex, 'Gate').waitFor({ timeout: 6000 });
  expect('Alex sees the new shifts live', await card(alex, 'Bar').count() === 1);

  // Olive takes a place; Alex sees it live.
  const t0 = Date.now();
  await card(olive, 'Bar').getByRole('button', { name: /^Take a place/ }).click();
  await card(olive, 'Bar').getByRole('button', { name: /^Give back my place/ }).waitFor();
  expect('Olive takes a place on Bar', (await who(olive, 'Bar')) === 'On this shift: You' && (await count(olive, 'Bar')) === '1 of 2 open', await who(olive, 'Bar'));
  await alex.waitForFunction(() => [...document.querySelectorAll('li.shift')].some((li) => li.querySelector('.shift-title')?.textContent === 'Bar' && li.querySelector('.shift-who')?.textContent.includes('Olive Organizer')), null, { timeout: 6000 });
  out(`Alex saw Olive's sign-up live: ${Date.now() - t0} ms`);
  expect('Alex sees her name and one place open, live', (await count(alex, 'Bar')) === '1 of 2 open');

  // Pat (viewer) signs herself up for Gate; she cannot manage shifts.
  const pat = await open('Pat Public');
  await openApp(pat);
  await card(pat, 'Gate').getByRole('button', { name: /^Take a place/ }).click();
  await card(pat, 'Gate').getByRole('button', { name: /^Give back my place/ }).waitFor();
  expect('Pat (viewer) takes the only place on Gate', (await count(pat, 'Gate')) === 'Full, 1 of 1', await count(pat, 'Gate'));
  expect('Pat\'s #festival shifts are read-only apart from her own place: no Change, Delete or take-off buttons',
    await pat.locator('li.shift').getByRole('button', { name: /^(Change|Delete)/ }).count() === 0 && await pat.locator('.shift-off').count() === 0);
  // The permission suite may have made Pat an editor of a channel of its own; #festival is never offered to her.
  if (await pat.getByRole('button', { name: 'New shift' }).count()) {
    await pat.getByRole('button', { name: 'New shift' }).click();
    const opts = await pat.locator('#sh-new-space option').allInnerTexts();
    expect('Pat cannot add a shift to #festival', !opts.includes('#festival'), opts.join('|'));
    await pat.locator('form[aria-label="New shift"]').getByRole('button', { name: 'Cancel' }).click();
  } else expect('Pat cannot add a shift to #festival (no New shift button)', true);
  expect('Pat sees only #festival shifts', (await pat.locator('li.shift .link-by').allInnerTexts()).every((c) => c === '#festival'));
  await pat.locator('.docs-list').getByRole('button', { name: /^Your shifts/ }).click();
  const patMine = await pat.locator('li.shift .shift-title').allInnerTexts();
  expect('Pat\'s "Your shifts" lists only Gate', patMine.join('|') === 'Gate', patMine.join('|'));
  await pat.locator('.docs-list').getByRole('button', { name: /^All upcoming/ }).click();

  // Alex: Gate is full; he fills Bar.
  await alex.waitForFunction(() => [...document.querySelectorAll('li.shift')].some((li) => li.querySelector('.shift-title')?.textContent === 'Gate' && li.querySelector('.shift-count')?.textContent.startsWith('Full')), null, { timeout: 6000 });
  expect('Alex sees Gate full, live, and cannot take a place', await card(alex, 'Gate').getByRole('button', { name: /^Full/ }).isDisabled());
  await card(alex, 'Bar').getByRole('button', { name: /^Take a place/ }).click();
  await card(alex, 'Bar').getByRole('button', { name: /^Give back my place/ }).waitFor();
  expect('Alex takes the last place on Bar', (await count(alex, 'Bar')) === 'Full, 2 of 2' && (await who(alex, 'Bar')).startsWith('On this shift: You'), await who(alex, 'Bar'));
  await olive.waitForFunction(() => [...document.querySelectorAll('li.shift')].some((li) => li.querySelector('.shift-title')?.textContent === 'Bar' && li.querySelector('.shift-count')?.textContent.startsWith('Full')), null, { timeout: 6000 });
  expect('Olive sees Bar full, live', (await who(olive, 'Bar')) === 'On this shift: You, Alex (test admin)×', await who(olive, 'Bar'));

  // The database's answer: places cannot drop below the people signed up.
  await card(olive, 'Bar').getByRole('button', { name: /^Change/ }).click();
  await olive.locator('form[aria-label="Change shift"] input[id$="-places"]').fill('1');
  await olive.locator('form[aria-label="Change shift"]').getByRole('button', { name: 'Save' }).click();
  await olive.waitForSelector('li.shift .send-error[role="alert"]');
  const refusal = await olive.locator('li.shift .send-error').innerText();
  expect('Olive is refused lowering Bar to one place, with the reason', refusal.includes('at least 2 places'), refusal);
  await olive.locator('form[aria-label="Change shift"] input[id$="-places"]').fill('3');
  await olive.locator('form[aria-label="Change shift"]').getByRole('button', { name: 'Save' }).click();
  await olive.locator('form[aria-label="Change shift"]').waitFor({ state: 'detached' });
  expect('Raising it to three places works', (await count(olive, 'Bar')) === '1 of 3 open', await count(olive, 'Bar'));
  await olive.locator('.docs-list').getByRole('button', { name: /^Still open/ }).click();
  const openList = await olive.locator('li.shift .shift-title').allInnerTexts();
  expect('"Still open" lists Bar but not the full Gate', openList.includes('Bar') && !openList.includes('Gate'), openList.join('|'));
  await olive.locator('.docs-list').getByRole('button', { name: /^All upcoming/ }).click();
  await olive.waitForTimeout(400);
  await olive.screenshot({ path: `${SHOTS}/1-shifts-olive-light.png` });
  await alex.waitForFunction(() => [...document.querySelectorAll('li.shift .shift-count')].some((c) => c.textContent === '1 of 3 open'), null, { timeout: 6000 });
  await alex.waitForTimeout(300);
  await alex.screenshot({ path: `${SHOTS}/2-shifts-alex-dark.png` });
  await pat.waitForTimeout(300);
  await pat.screenshot({ path: `${SHOTS}/3-shifts-pat-viewer.png` });

  // Home widget (on by default; turned on if this person saved a layout before it existed).
  await olive.locator('#tab-home').click(); await olive.waitForSelector('.widgets-area');
  let w = olive.locator('.widget:has(h3:text-is("Your shifts"))');
  if (!(await w.count())) {
    await olive.getByRole('button', { name: 'Customize' }).click();
    await olive.locator('.widget-picker label', { hasText: 'Your shifts' }).locator('input').check();
    await olive.getByRole('button', { name: 'Done', exact: true }).click();
    w = olive.locator('.widget:has(h3:text-is("Your shifts"))');
  }
  await w.locator('.widget-main').first().waitFor();
  const rows = await w.locator('.widget-row').allInnerTexts();
  expect('Widget: Olive\'s shift is listed (only hers)', rows.length === 1 && rows[0].includes('Bar') && rows[0].includes('18:00 to 22:00') && rows[0].includes('2 of 3 places taken'), rows.join(' / '));
  await w.locator('.widget-row').first().click();
  await olive.waitForSelector('#tab-shifts[aria-selected="true"]');
  await card(olive, 'Gate').waitFor();
  expect('Widget: a row opens Shifts', true);

  // Olive (editor) takes Pat off Gate; Pat sees it open again live.
  await card(olive, 'Gate').getByRole('button', { name: 'Take Pat Public off Gate' }).click();
  await pat.waitForFunction(() => [...document.querySelectorAll('li.shift')].some((li) => li.querySelector('.shift-title')?.textContent === 'Gate' && li.querySelector('.shift-count')?.textContent === '1 of 1 open'), null, { timeout: 6000 });
  expect('Olive takes Pat off Gate and Pat sees it open again, live', await card(pat, 'Gate').getByRole('button', { name: /^Take a place/ }).isEnabled());

  expect('No page errors', errs.length === 0, errs.join('; '));
  out(failed ? `${failed} browser checks failed` : 'all browser checks passed');
  await b.close(); process.exit(failed ? 1 : 0);
})();
