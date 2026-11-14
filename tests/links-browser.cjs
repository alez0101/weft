// Links in real browsers, on the test stack (tests/run.sh --keep): Olive makes a link list in Organizers
// and one in #festival and adds links with notes and tags; Alex (dark mode) watches links arrive and
// change live; tags and words filter the list; a javascript: address is refused with the database's
// answer; Pat (viewer) reads the #festival list only, with no way to change it, and sees a delete live;
// Olive turns on the "New links" Home widget and a row opens the list.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node links-browser.cjs
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
    await p.locator('.app:has-text("Links")').click(); await p.waitForSelector('.docs-list'); return p;
  };
  const card = (p, title) => p.locator('.link', { has: p.locator('.link-title', { hasText: title }) });
  const titles = (p) => p.locator('.link-title').allInnerTexts();
  const newList = async (p, space, name) => {
    await p.selectOption('#new-linklist', { label: space });
    await p.locator('.docs-new').getByRole('button', { name: 'New link list' }).click();
    await p.waitForFunction(() => document.querySelector('#title-linklist')?.value === 'Useful links');
    await p.fill('#title-linklist', name); await p.press('#title-linklist', 'Enter');
    await p.waitForSelector(`.doc-link:has-text("${name}")`);
  };
  const addLink = async (p, { url, title = '', note = '', tags = '' }, expectTitle) => {
    await p.getByRole('button', { name: 'Add a link' }).click();
    await p.fill('#link-new-url', url); await p.fill('#link-new-title', title); await p.fill('#link-new-note', note); await p.fill('#link-new-tags', tags);
    await p.locator('form[aria-label="Add a link"]').getByRole('button', { name: 'Add link' }).click();
    if (expectTitle) await p.waitForSelector(`.link-title:has-text("${expectTitle}")`);
  };

  const olive = await open('Olive Organizer');
  await newList(olive, '#organizers', 'Caterers and venues');
  await addLink(olive, { url: 'https://example.org/caterers', title: 'Caterer price lists', note: 'Ask for the volunteer rate', tags: 'food, budget' }, 'Caterer price lists');
  await newList(olive, '#festival', 'Festival links');
  await addLink(olive, { url: 'https://example.org/site-map.pdf', title: 'Site map', note: 'Printable, A3. Gate B is the volunteer entrance.', tags: 'map, gates' }, 'Site map');
  await addLink(olive, { url: 'example.com/weather', title: 'Weather for the weekend', tags: 'weather' }, 'Weather for the weekend');
  expect('An address without https:// gets it added', await card(olive, 'Weather for the weekend').locator('a').getAttribute('href') === 'https://example.com/weather');
  await addLink(olive, { url: 'https://www.example.net/stalls' }, 'example.net');
  expect('An empty title becomes the site name', (await titles(olive)).includes('example.net'), (await titles(olive)).join(', '));

  const alex = await open('Alex (test admin)', true);
  await alex.locator('.doc-link', { hasText: 'Festival links' }).click(); await alex.waitForSelector('.link');
  const t0 = Date.now();
  await addLink(olive, { url: 'https://example.org/first-aid', title: 'First aid tent rota', note: 'Who is on when', tags: 'volunteers, safety' }, 'First aid tent rota');
  await alex.waitForSelector('.link-title:has-text("First aid tent rota")', { timeout: 6000 });
  out(`Alex saw Olive's link live: ${Date.now() - t0} ms`);
  expect('Alex sees the new link live, with who added it', (await card(alex, 'First aid tent rota').locator('.link-by').innerText()) === 'Added by Olive Organizer');
  const a = card(alex, 'Site map').locator('a.link-title');
  expect('A link opens in a new tab, without handing Weft over to the page', await a.getAttribute('target') === '_blank' && (await a.getAttribute('rel')).includes('noopener')
    && await a.getAttribute('href') === 'https://example.org/site-map.pdf');

  // Edit, live for Alex.
  await card(olive, 'example.net').getByRole('button', { name: 'Edit' }).click();
  await olive.fill('.link form input[id$="-title"]', 'Stall plan'); await olive.fill('.link form input[id$="-tags"]', 'Map, stalls');
  await olive.locator('.link form').getByRole('button', { name: 'Save' }).click();
  await alex.waitForSelector('.link-title:has-text("Stall plan")', { timeout: 6000 });
  expect('An edit shows live; tags come back lowercased', (await card(alex, 'Stall plan').locator('.link-tag').allInnerTexts()).join(',') === 'map,stalls');

  // Filters.
  await olive.locator('.links-tags .link-tag', { hasText: 'map' }).click();
  let shown = await titles(olive);
  expect('Clicking a tag shows only links with it', shown.length === 2 && shown.includes('Site map') && shown.includes('Stall plan'), shown.join(', '));
  await olive.getByRole('button', { name: 'Show all' }).click();
  await olive.fill('#links-find', 'volunteer entrance');
  shown = await titles(olive);
  expect('Words filter by title, note and tags', shown.length === 1 && shown[0] === 'Site map', shown.join(', '));
  await olive.fill('#links-find', '');

  // The database refuses an address that could run script, and the screen shows why.
  await olive.getByRole('button', { name: 'Add a link' }).click();
  await olive.fill('#link-new-url', 'javascript:alert(1)'); await olive.fill('#link-new-title', 'Sneaky');
  await olive.locator('form[aria-label="Add a link"]').getByRole('button', { name: 'Add link' }).click();
  await olive.waitForSelector('.links .send-error');
  expect('A javascript: address is refused, with the reason shown', (await olive.locator('.links .send-error').innerText()).startsWith('Could not add the link')
    && !(await titles(olive)).includes('Sneaky'));
  await olive.locator('form[aria-label="Add a link"]').getByRole('button', { name: 'Cancel' }).click();
  await olive.waitForTimeout(300);
  // Reload so the refused attempt's message is gone before the screenshot.
  await olive.locator('.doc-link', { hasText: 'Caterers and venues' }).click(); await olive.waitForSelector('.link-title:has-text("Caterer price lists")');
  await olive.locator('.doc-link', { hasText: 'Festival links' }).click(); await olive.waitForSelector('.link-title:has-text("Site map")');
  await olive.waitForTimeout(400);
  await olive.screenshot({ path: `${SHOTS}/1-links-olive-light.png` });
  await alex.waitForTimeout(400);
  await alex.screenshot({ path: `${SHOTS}/2-links-alex-dark.png` });

  // Pat (viewer in #festival only).
  const pat = await open('Pat Public');
  const lists = await pat.locator('.doc-link').allInnerTexts();
  expect('Pat sees the #festival list, not the Organizers one', lists.includes('Festival links') && !lists.includes('Caterers and venues'), lists.join(', '));
  const patSpaces = await pat.locator('#new-linklist option').allInnerTexts();
  expect('Pat can make link lists only where she edits (her personal space, not #festival)', !patSpaces.includes('#festival') && patSpaces.length >= 1, patSpaces.join(', '));
  await pat.locator('.doc-link', { hasText: 'Festival links' }).click(); await pat.waitForSelector('.link');
  expect('Pat: no Add a link, Edit, Delete or Move', await pat.getByRole('button', { name: 'Add a link' }).count() === 0
    && await pat.locator('.link').getByRole('button', { name: /^(Edit|Delete)/ }).count() === 0
    && await pat.getByRole('button', { name: 'Delete', exact: true }).count() === 0 && await pat.locator('#move-linklist').count() === 0);
  expect('Pat: the list name is read-only and the hint says why', await pat.locator('#title-linklist[readonly]').count() === 1
    && (await pat.locator('.links > .docs-hint').innerText()).includes('make you an editor'));
  expect('Pat can still open the links and filter by tag', await pat.locator('a.link-title').count() === 4 && await pat.locator('.links-tags .link-tag').count() > 0);
  await card(olive, 'Weather for the weekend').getByRole('button', { name: 'Delete' }).click();
  await pat.waitForFunction(() => ![...document.querySelectorAll('.link-title')].some((e) => e.textContent === 'Weather for the weekend'), null, { timeout: 6000 });
  expect('A delete shows live for Pat', (await titles(pat)).length === 3);
  await pat.waitForTimeout(400);
  await pat.screenshot({ path: `${SHOTS}/3-links-pat-viewer.png` });

  // Home widget: not on by default; Olive turns it on.
  await olive.locator('#tab-home').click(); await olive.waitForSelector('.widgets-area');
  await olive.getByRole('button', { name: 'Customize' }).click();
  await olive.locator('.widget-picker label', { hasText: 'New links' }).locator('input').check();
  await olive.getByRole('button', { name: 'Done', exact: true }).click();
  const w = olive.locator('.widget:has(h3:has-text("New links"))');
  await w.locator('.widget-main').first().waitFor();
  const rows = await w.locator('.widget-main').allInnerTexts();
  out('widget rows:', rows.join(' | '));
  expect('Widget: newest links first, deleted ones gone', rows[0] === 'First aid tent rota' && !rows.includes('Weather for the weekend'), rows.join(', '));
  await w.locator('.widget-row', { hasText: 'Caterer price lists' }).click();
  await olive.waitForSelector('#tab-links[aria-selected="true"]');
  await olive.waitForFunction(() => document.querySelector('#title-linklist')?.value === 'Caterers and venues');
  expect('Widget: a row opens its list in Links', true);
  const pw = await (async () => {
    await pat.locator('#tab-home').click(); await pat.waitForSelector('.widgets-area');
    await pat.getByRole('button', { name: 'Customize' }).click();
    await pat.locator('.widget-picker label', { hasText: 'New links' }).locator('input').check();
    await pat.getByRole('button', { name: 'Done', exact: true }).click();
    const pwd = pat.locator('.widget:has(h3:has-text("New links"))');
    await pwd.locator('.widget-main').first().waitFor();
    return pwd.locator('.widget-main').allInnerTexts();
  })();
  expect('Widget: Pat sees #festival links only', pw.length > 0 && !pw.includes('Caterer price lists'), pw.join(', '));

  expect('No page errors', errs.length === 0, errs.join('; '));
  out(failed ? `${failed} browser checks failed` : 'all browser checks passed');
  await b.close(); process.exit(failed ? 1 : 0);
})();
