// Journal in real browsers, on the test stack (tests/run.sh --keep): Olive writes today's page and two earlier
// ones; the list is newest first with each page's first line; search finds words in her own pages; her
// second browser (dark mode) shows the page and picks up a change live; a page for a future day is refused
// and the database's answer is shown; she deletes a page; Pat opens Journal and sees only her own (empty)
// journal, none of Olive's words, not even through search; the Home widget "Your journal" lists Olive's
// latest pages and a row opens that day.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node journal-browser.cjs
const { chromium } = require('playwright');
const SHOTS = process.env.WEFT_SHOTS || require('os').tmpdir();
const BASE = process.env.WEFT_BASE || 'http://localhost:3211/';
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const ago = (n) => { const d = new Date(); d.setHours(12); d.setDate(d.getDate() - n); return dayKey(d); };
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
  const openApp = async (p) => { await p.locator('.app:has-text("Journal")').click(); await p.waitForSelector('.journal-list'); await p.waitForSelector('.journal-list ul, .journal-list .convo-empty'); };
  const list = (p) => p.locator('.journal-list .journal-link-line').allInnerTexts();
  const write = async (p, text) => {
    await p.fill('#journal-text', text);
    await p.locator('.journal-actions .btn--primary').click();
    await p.waitForSelector('.journal-status:text-is("Saved")');
  };
  const gotoDay = async (p, day) => { await p.fill('#journal-day', day); await p.waitForFunction((d) => document.querySelector('#journal-day').value === d, day); };

  const olive = await open('Olive Organizer');
  await openApp(olive);
  expect('An empty journal says so, and that it is private', (await olive.locator('.journal-list .convo-empty').innerText()).includes('No pages yet')
    && (await olive.locator('.journal-list .docs-hint').innerText()).includes('Only you can read your journal'));
  expect('It opens on today, with Next day off', (await olive.locator('#journal-day').inputValue()) === ago(0)
    && await olive.getByRole('button', { name: 'Next day' }).isDisabled());
  await write(olive, 'Walked the site with the fire officer. Gate B needs a second steward.\n\nFelt good about the plan for once.');
  expect('Today\'s page is saved and listed as Today', (await olive.locator('.journal-link.is-active .journal-link-day').innerText()) === 'Today'
    && (await list(olive))[0].startsWith('Walked the site'));
  await olive.getByRole('button', { name: 'Previous day' }).click();
  await olive.waitForFunction((d) => document.querySelector('#journal-day').value === d, ago(1));
  expect('An earlier day without a page is empty', (await olive.locator('#journal-text').inputValue()) === ''
    && (await olive.locator('.docs-meta').innerText()).includes('No page for this day yet'));
  await write(olive, 'Rain all day. Budget call ran long; we cut the second stage.');
  await gotoDay(olive, ago(3));
  await write(olive, 'Quiet day. A draft to delete.');
  expect('Three pages, newest first', (await list(olive)).map((l) => l.split(' ')[0]).join('|') === 'Walked|Rain|Quiet', (await list(olive)).join('|'));

  // Search her own pages.
  await olive.fill('#journal-search', 'budget');
  await olive.waitForFunction(() => document.querySelectorAll('.journal-list .journal-link').length === 1);
  expect('Search finds the page with the word', (await list(olive))[0].includes('Budget call'));
  await olive.fill('#journal-search', 'trombone');
  await olive.waitForSelector('.journal-list .convo-empty:has-text("No page has those words")');
  expect('A search with no match says so', true);
  await olive.fill('#journal-search', '');
  await olive.waitForFunction(() => document.querySelectorAll('.journal-list .journal-link').length === 3);

  // Her second browser, in dark mode, sees today's page, and a change arrives live.
  const olive2 = await open('Olive Organizer', true);
  await openApp(olive2);
  expect('Her other browser shows today\'s page', (await olive2.locator('#journal-text').inputValue()).startsWith('Walked the site'));
  await olive.locator('.journal-link', { hasText: 'Walked the site' }).click();
  const t0 = Date.now();
  await write(olive, 'Walked the site with the fire officer. Gate B needs a second steward.\n\nFelt good about the plan for once. Called Vic about chairs.');
  await olive2.waitForFunction(() => document.querySelector('#journal-text').value.includes('Called Vic'), null, { timeout: 6000 });
  out(`The other browser saw the change live: ${Date.now() - t0} ms`);
  expect('A change shows live in her other browser', true);

  // The database refuses a page for a future day (the screen never offers one, so the request is changed on its way).
  await gotoDay(olive, ago(2));
  await olive.route('**/journal_entries', async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.continue();
    await route.continue({ postData: JSON.stringify({ ...JSON.parse(req.postData()), day: '2999-01-01' }) });
  });
  await olive.fill('#journal-text', 'From the future');
  await olive.locator('.journal-actions .btn--primary').click();
  await olive.waitForSelector('.journal-page .send-error');
  expect('A page for a future day is refused, with the reason shown', (await olive.locator('.journal-page .send-error').innerText()).includes('between 1900 and today')
    && !(await list(olive)).some((l) => l.includes('future')), await olive.locator('.journal-page .send-error').innerText());
  await olive.unroute('**/journal_entries');
  await olive.fill('#journal-text', '');

  // Delete a page.
  await olive.locator('.journal-link', { hasText: 'A draft to delete' }).click();
  await olive.getByRole('button', { name: 'Delete page' }).click();
  await olive.waitForSelector('.journal-status:text-is("Deleted")');
  expect('A deleted page leaves the list', (await list(olive)).length === 2 && !(await list(olive)).some((l) => l.includes('draft')), (await list(olive)).join('|'));
  await olive.locator('.journal-link', { hasText: 'Walked the site' }).click();
  await olive.waitForTimeout(400);
  await olive.screenshot({ path: `${SHOTS}/1-journal-olive-light.png` });
  await olive2.locator('.journal-link', { hasText: 'Rain all day' }).click();
  await olive2.waitForTimeout(400);
  await olive2.screenshot({ path: `${SHOTS}/2-journal-olive-dark.png` });

  // Pat: her own journal only.
  const pat = await open('Pat Public');
  await openApp(pat);
  expect('Pat sees an empty journal of her own, none of Olive\'s pages', (await pat.locator('.journal-list .journal-link').count()) === 0
    && (await pat.locator('#journal-text').inputValue()) === '' && !(await pat.content()).includes('fire officer'));
  await pat.fill('#journal-search', 'Gate B');
  await pat.waitForSelector('.journal-list .convo-empty:has-text("No page has those words")');
  expect('Pat\'s search finds nothing of Olive\'s', true);
  await pat.fill('#journal-search', '');
  await pat.waitForSelector('.journal-list .convo-empty:has-text("No pages yet")');
  await pat.fill('#journal-text', 'Handed out maps at Gate B.');
  await pat.waitForTimeout(300);
  await pat.screenshot({ path: `${SHOTS}/3-journal-pat-own.png` });
  await pat.fill('#journal-text', '');
  // Weft search does not show journal pages.
  await olive.fill('.search input', 'fire officer');
  await olive.waitForTimeout(1200);
  const res = await olive.locator('.search').innerText();
  expect('Weft search does not show journal pages, even to their writer', !res.includes('Walked the site'), res);
  await olive.fill('.search input', ''); await olive.keyboard.press('Escape');

  // Home widget (opt-in).
  await olive.locator('#tab-home').click(); await olive.waitForSelector('.widgets-area');
  let w = olive.locator('.widget:has(h3:text-is("Your journal"))');
  if (!(await w.count())) {
    await olive.getByRole('button', { name: 'Customize' }).click();
    await olive.locator('.widget-picker label', { hasText: 'Your journal' }).locator('input').check();
    await olive.getByRole('button', { name: 'Done', exact: true }).click();
    w = olive.locator('.widget:has(h3:text-is("Your journal"))');
  }
  await w.locator('.widget-main').first().waitFor();
  const mains = await w.locator('.widget-main').allInnerTexts();
  expect('Widget: Olive\'s latest pages, today first', mains.length === 2 && mains[0] === 'Today', mains.join(' | '));
  await w.locator('.widget-row', { hasText: 'Rain all day' }).click();
  await olive.waitForSelector('#tab-journal[aria-selected="true"]');
  await olive.waitForFunction((d) => document.querySelector('#journal-day')?.value === d, ago(1));
  expect('Widget: a row opens that day\'s page', (await olive.locator('#journal-text').inputValue()).startsWith('Rain all day'));
  await pat.locator('#tab-home').click(); await pat.waitForSelector('.widgets-area');
  expect('Widget: Pat\'s Home has no trace of Olive\'s journal', !(await pat.content()).includes('fire officer'));

  expect('No page errors', errs.length === 0, errs.join('; '));
  out(failed ? `${failed} browser checks failed` : 'all browser checks passed');
  await b.close(); process.exit(failed ? 1 : 0);
})();
