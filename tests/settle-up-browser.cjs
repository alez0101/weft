// Settle up in one press, in real browsers, on the test stack (tests/run.sh --keep): Olive makes a "Weekend
// trip" list in #festival and adds an even split, so Alex, Pat and Vic each owe her; every line under To
// settle up has a Record payment button for her and for Alex (dark mode), none for Pat (viewer). Olive records
// Pat's payment: the pay-back expense appears, Pat's line goes, and Alex and Pat see it live. Then Olive and
// Alex press Record payment on Vic's line at the same moment: one payment is written, the other press shows
// the database's reason. Screenshots go to WEFT_SHOTS.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node settle-up-browser.cjs
const { chromium } = require('playwright');
const SHOTS = process.env.WEFT_SHOTS || require('os').tmpdir();
const BASE = process.env.WEFT_BASE || 'http://localhost:3211/';
const LIST = 'Weekend trip';
(async () => {
  const b = await chromium.launch(); const errs = []; const out = (...a) => console.log(...a); let failed = 0;
  const expect = (name, ok, detail = '') => { out(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (${detail})`}`); if (!ok) failed += 1; };
  const open = async (who, dark) => {
    const p = await (await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: dark ? 'dark' : 'light', locale: 'en-US' })).newPage();
    p.on('pageerror', (e) => errs.push(`${who}: ${e.message}`));
    p.on('dialog', (d) => d.accept());
    await p.goto(BASE, { waitUntil: 'networkidle' }); await p.getByRole('button', { name: who }).click(); await p.waitForSelector('.rail-title');
    await p.locator('.app:has-text("Expenses")').click(); await p.waitForSelector('.docs-list'); return p;
  };
  const openList = async (p) => { await p.locator('.doc-link', { hasText: LIST }).first().click(); await p.waitForSelector('.expenses'); };
  const flat = (a) => a.map((s) => s.replace(/\s+/g, ' ').trim());
  const settle = async (p) => flat(await p.locator('.exp-settle li .exp-settle-who').allInnerTexts());
  const line = (p, who) => p.locator('.exp-settle li', { hasText: `${who} pays` });
  const payBtn = (p, who) => line(p, who).getByRole('button', { name: /^Record payment/ });
  const balance = (p, name) => p.locator('.exp-bal', { hasText: name }).locator('.exp-bal-net').innerText();

  const olive = await open('Olive Organizer');
  await olive.selectOption('#new-expenselist', { label: '#festival' });
  await olive.locator('.docs-new').getByRole('button', { name: 'New expense list' }).click();
  await olive.waitForFunction(() => document.querySelector('#title-expenselist')?.value === 'Shared costs');
  await olive.fill('#title-expenselist', LIST); await olive.press('#title-expenselist', 'Enter');
  await olive.waitForSelector(`.doc-link:has-text("${LIST}")`);
  expect('An empty list has nothing to settle and no Record payment button', await olive.locator('.exp-settle').count() === 0
    && await olive.getByRole('button', { name: /^Record payment/ }).count() === 0);
  await olive.getByRole('button', { name: 'Add an expense' }).click();
  const f = olive.locator('form[aria-label="Add an expense"]');
  await f.getByLabel('What for').fill('Cabin');
  await f.getByLabel('Amount', { exact: true }).fill('90');
  await f.getByRole('button', { name: 'Add expense' }).click();
  await olive.waitForSelector('.exp-title:has-text("Cabin")');
  const s0 = await settle(olive);
  expect('To settle up: Alex, Pat and Vic each pay Olive', s0.length === 3 && s0.every((s) => s.endsWith('pays Olive Organizer')), s0.join(' | '));
  expect('Olive (editor) has a Record payment button on every line', await olive.getByRole('button', { name: /^Record payment/ }).count() === 3);
  expect('The button names the payment for screen readers', await olive.getByRole('button', { name: 'Record payment: Pat Public pays Olive Organizer 22.50' }).count() === 1);

  const alex = await open('Alex (test admin)', true);
  await openList(alex);
  const pat = await open('Pat Public');
  await openList(pat);
  expect('Pat (viewer) sees the suggestions but no Record payment button', (await settle(pat)).length === 3
    && await pat.getByRole('button', { name: /^Record payment/ }).count() === 0);
  expect('Pat\'s hint does not offer to record', !(await pat.locator('.exp-balances .docs-hint').innerText()).includes('Record payment'));

  // Olive records Pat's payment; Alex and Pat see it live.
  const t0 = Date.now();
  await payBtn(olive, 'Pat Public').click();
  await olive.waitForSelector('.exp-title:has-text("Pat Public paid Olive Organizer back")', { timeout: 6000 });
  expect('The pay-back is written as an expense: paid by Pat, all of it to Olive', flat([await olive.locator('.expense', { hasText: 'paid Olive Organizer back' }).locator('.exp-meta').innerText()])[0]
    .includes('Paid by Pat Public, split by amounts: Olive Organizer 22.50'));
  expect('Pat\'s line is gone from To settle up', !(await settle(olive)).some((s) => s.startsWith('Pat Public')) && (await settle(olive)).length === 2);
  expect('Olive is now owed 45.00, Pat is even', (await balance(olive, 'Olive')) === 'is owed 45.00' && (await olive.locator('.exp-bal', { hasText: 'Pat' }).locator('.exp-bal-net').innerText()) === 'even');
  await pat.waitForSelector('.exp-title:has-text("Pat Public paid Olive Organizer back")', { timeout: 6000 });
  out(`Pat saw the payment live: ${Date.now() - t0} ms`);
  await alex.waitForFunction(() => document.querySelectorAll('.exp-settle li').length === 2, null, { timeout: 6000 });
  expect('Alex and Pat see it live, and the settle-up list shrinks for both', (await settle(pat)).length === 2 && (await settle(alex)).length === 2);
  expect('Pat\'s own balance reads even', (await pat.locator('.exp-bal', { hasText: 'Pat' }).innerText()).includes('(you)')
    && (await pat.locator('.exp-bal', { hasText: 'Pat' }).locator('.exp-bal-net').innerText()) === 'even');

  await olive.mouse.click(5, 895);
  await olive.waitForTimeout(400);
  await olive.screenshot({ path: `${SHOTS}/1-settle-up-olive-light.png` });
  await pat.waitForTimeout(300);
  await pat.screenshot({ path: `${SHOTS}/3-settle-up-pat-viewer.png` });

  // Olive and Alex press on Vic's line at the same moment: one payment, one refusal with the reason.
  await Promise.all([payBtn(olive, 'Vic Volunteer').click(), payBtn(alex, 'Vic Volunteer').click()]);
  await olive.waitForFunction(() => document.querySelectorAll('.exp-settle li').length === 1, null, { timeout: 6000 });
  await alex.waitForFunction(() => document.querySelectorAll('.exp-settle li').length === 1, null, { timeout: 6000 });
  await olive.waitForTimeout(800);
  const vicPays = await olive.locator('.exp-title', { hasText: 'Vic Volunteer paid Olive Organizer back' }).count();
  const alerts = flat([...(await olive.locator('.expenses > .send-error').allInnerTexts()), ...(await alex.locator('.expenses > .send-error').allInnerTexts())]);
  expect('Two presses at once write one payment', vicPays === 1, String(vicPays));
  expect('The other press shows the database\'s reason', alerts.length === 1 && alerts[0].startsWith('The payment was not recorded') && alerts[0].includes('Vic Volunteer owes nothing now'), alerts.join(' | '));
  expect('Only Alex is left to settle up', (await settle(alex)).join() === 'Alex (test admin) pays Olive Organizer');
  await alex.mouse.click(5, 895);
  await alex.waitForTimeout(400);
  await alex.screenshot({ path: `${SHOTS}/2-settle-up-alex-dark.png` });

  // Undo: deleting the payment brings the suggestion back.
  await olive.locator('.expense', { hasText: 'Vic Volunteer paid Olive Organizer back' }).getByRole('button', { name: /^Delete/ }).click();
  await alex.waitForFunction(() => [...document.querySelectorAll('.exp-settle li')].some((e) => e.textContent.includes('Vic Volunteer pays')), null, { timeout: 6000 });
  expect('Deleting the payment brings the suggestion back, live', (await settle(alex)).length === 2);

  expect('No page errors', errs.length === 0, errs.join('; '));
  out(failed ? `${failed} browser checks failed` : 'all browser checks passed');
  await b.close(); process.exit(failed ? 1 : 0);
})();
