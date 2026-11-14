// Glossary in real browsers, on the test stack (tests/run.sh --keep): Olive makes a glossary in Organizers and
// one in #festival and adds terms; they are listed A to Z under letter headings with a letter index; Alex
// (dark mode) watches a term arrive and change live; the find box matches terms and meanings; a term that is
// already there (in another case) is refused with the database's answer; Pat (viewer) reads the #festival
// glossary only, with no way to change it, and sees a delete live; Weft search finds the glossary by a
// meaning; Olive turns on the "New terms" Home widget and a row opens the glossary; Pat's widget shows
// #festival only.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node glossary-browser.cjs
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
    await p.locator('.app:has-text("Glossary")').click(); await p.waitForSelector('.docs-list'); return p;
  };
  const entry = (p, term) => p.locator('.glossary-entry', { has: p.locator('.glossary-term', { hasText: new RegExp(`^${term}$`) }) });
  const terms = (p) => p.locator('.glossary-term').allInnerTexts();
  const newGlossary = async (p, space, name) => {
    await p.selectOption('#new-glossary', { label: space });
    await p.locator('.docs-new').getByRole('button', { name: 'New glossary' }).click();
    await p.waitForFunction(() => document.querySelector('#title-glossary')?.value === 'Glossary');
    await p.fill('#title-glossary', name); await p.press('#title-glossary', 'Enter');
    await p.waitForSelector(`.doc-link:has-text("${name}")`);
  };
  const addTerm = async (p, term, definition, wait = true) => {
    await p.getByRole('button', { name: 'Add a term' }).click();
    await p.fill('#glossary-new-term', term); await p.fill('#glossary-new-def', definition);
    await p.locator('form[aria-label="Add a term"]').getByRole('button', { name: 'Add term' }).click();
    if (wait) await p.waitForSelector(`.glossary-term:text-is("${term}")`);
  };

  const olive = await open('Olive Organizer');
  await newGlossary(olive, '#organizers', 'Organizer words');
  await addTerm(olive, 'Rider', 'What a band asks for in its contract: drinks, towels, stage set-up. Ours are in the Riders folder.');
  await newGlossary(olive, '#festival', 'Festival words');
  await addTerm(olive, 'FOH', 'Front of house: everything the audience sees, from the gate to the bar.');
  await addTerm(olive, 'Gate B', 'The volunteer entrance, behind the car park. Show your lanyard.');
  await addTerm(olive, 'Green room', 'Where the bands wait before they play. Volunteers only with a crew pass.');
  await addTerm(olive, 'Changeover', 'The 20 minutes between two bands while the stage is reset.');
  await addTerm(olive, 'P04', 'The fourth stage, the small tent by the river (P for pavilion).');
  expect('Terms are listed A to Z', (await terms(olive)).join(',') === 'Changeover,FOH,Gate B,Green room,P04', (await terms(olive)).join(','));
  expect('Under letter headings', (await olive.locator('.glossary-letter').allInnerTexts()).join('') === 'CFGP', (await olive.locator('.glossary-letter').allInnerTexts()).join(''));
  expect('The letter index links to each heading', (await olive.locator('.glossary-index a').allInnerTexts()).join('') === 'CFGP');
  await olive.locator('.glossary-index a', { hasText: 'P' }).click();
  expect('A letter in the index brings its terms into view', await olive.locator('.glossary-letter', { hasText: /^P$/ })
    .evaluate((h) => { const r = h.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }));
  expect('Who added a term is shown', (await entry(olive, 'FOH').locator('.link-by').innerText()) === 'Added by Olive Organizer');

  const alex = await open('Alex (test admin)', true);
  await alex.locator('.doc-link', { hasText: 'Festival words' }).click(); await alex.waitForSelector('.glossary-entry');
  const t0 = Date.now();
  await addTerm(olive, 'Lanyard', 'The cord with your pass on it. Blue is crew, green is volunteer, red is press.');
  await alex.waitForSelector('.glossary-term:text-is("Lanyard")', { timeout: 6000 });
  out(`Alex saw Olive's term live: ${Date.now() - t0} ms`);
  expect('Alex sees the new term live, in its place', (await terms(alex)).join(',') === 'Changeover,FOH,Gate B,Green room,Lanyard,P04', (await terms(alex)).join(','));

  // Edit, live for Alex.
  await entry(olive, 'Changeover').getByRole('button', { name: 'Edit' }).click();
  await olive.fill('.glossary-entry form textarea', 'The 15 minutes between two bands while the stage is reset.');
  await olive.locator('.glossary-entry form').getByRole('button', { name: 'Save' }).click();
  await alex.waitForSelector('.glossary-def:has-text("The 15 minutes")', { timeout: 6000 });
  expect('An edit shows live', true);

  // The find box.
  await olive.fill('#glossary-find', 'gate');
  let shown = await terms(olive);
  expect('Find matches terms and meanings', shown.join(',') === 'FOH,Gate B', shown.join(','));
  expect('The letter index hides while finding', await olive.locator('.glossary-index').count() === 0);
  await olive.fill('#glossary-find', 'bands wait');
  shown = await terms(olive);
  expect('Every word must match', shown.join(',') === 'Green room', shown.join(','));
  await olive.fill('#glossary-find', 'nothing-like-this');
  expect('No match says so', (await olive.locator('.glossary .convo-empty').innerText()) === 'No terms match.');
  await olive.fill('#glossary-find', '');

  // The database refuses a term that is already there, whatever the case, and the screen shows why.
  await addTerm(olive, 'foh', 'Again', false);
  await olive.waitForSelector('.glossary .send-error');
  const err = await olive.locator('.glossary .send-error').innerText();
  expect('A term already in the glossary is refused, with the reason shown', err.startsWith('Could not add the term') && err.includes('already in this glossary')
    && (await terms(olive)).filter((t) => t.toLowerCase() === 'foh').length === 1, err);
  await olive.locator('form[aria-label="Add a term"]').getByRole('button', { name: 'Cancel' }).click();
  // Reload so the refused attempt's message is gone before the screenshot.
  await olive.locator('.doc-link', { hasText: 'Organizer words' }).click(); await olive.waitForSelector('.glossary-term:text-is("Rider")');
  await olive.locator('.doc-link', { hasText: 'Festival words' }).click(); await olive.waitForSelector('.glossary-term:text-is("FOH")');
  await olive.waitForTimeout(400);
  await olive.screenshot({ path: `${SHOTS}/1-glossary-olive-light.png` });
  await alex.waitForTimeout(400);
  await alex.screenshot({ path: `${SHOTS}/2-glossary-alex-dark.png` });

  // Weft search finds a glossary by a meaning (through its text).
  await olive.locator('.search input').fill('towels');
  const hit = olive.locator('.search-group:has-text("Glossaries")');
  const found = await hit.waitFor({ timeout: 6000 }).then(() => true).catch(() => false);
  expect('Weft search finds the glossary by a word in a meaning', found
    && (await olive.locator('.search-row').allInnerTexts()).some((r) => r.includes('Organizer words')));
  await olive.keyboard.press('Escape');

  // Pat (viewer in #festival only).
  const pat = await open('Pat Public');
  const lists = await pat.locator('.doc-link').allInnerTexts();
  expect('Pat sees the #festival glossary, not the Organizers one', lists.includes('Festival words') && !lists.includes('Organizer words'), lists.join(', '));
  const patSpaces = await pat.locator('#new-glossary option').allInnerTexts();
  expect('Pat can make glossaries only where she edits (not #festival)', !patSpaces.includes('#festival') && patSpaces.length >= 1, patSpaces.join(', '));
  await pat.locator('.doc-link', { hasText: 'Festival words' }).click(); await pat.waitForSelector('.glossary-entry');
  expect('Pat: no Add a term, Edit, Delete or Move', await pat.getByRole('button', { name: 'Add a term' }).count() === 0
    && await pat.locator('.glossary-entry').getByRole('button', { name: /^(Edit|Delete)/ }).count() === 0
    && await pat.getByRole('button', { name: 'Delete', exact: true }).count() === 0 && await pat.locator('#move-glossary').count() === 0);
  expect('Pat: the glossary name is read-only and the hint says why', await pat.locator('#title-glossary[readonly]').count() === 1
    && (await pat.locator('.glossary > .docs-hint').innerText()).includes('make you an editor'));
  expect('Pat can read every term and find', (await terms(pat)).length === 6 && await pat.locator('#glossary-find').count() === 1);
  await entry(olive, 'Lanyard').getByRole('button', { name: 'Delete' }).click();
  await pat.waitForFunction(() => ![...document.querySelectorAll('.glossary-term')].some((e) => e.textContent === 'Lanyard'), null, { timeout: 6000 });
  expect('A delete shows live for Pat', (await terms(pat)).length === 5);
  await pat.waitForTimeout(400);
  await pat.screenshot({ path: `${SHOTS}/3-glossary-pat-viewer.png` });

  // Home widget: not on by default; Olive turns it on.
  await olive.locator('#tab-home').click(); await olive.waitForSelector('.widgets-area');
  await olive.getByRole('button', { name: 'Customize' }).click();
  await olive.locator('.widget-picker label', { hasText: 'New terms' }).locator('input').check();
  await olive.getByRole('button', { name: 'Done', exact: true }).click();
  const w = olive.locator('.widget:has(h3:has-text("New terms"))');
  await w.locator('.widget-main').first().waitFor();
  const rows = await w.locator('.widget-main').allInnerTexts();
  out('widget rows:', rows.join(' | '));
  expect('Widget: newest terms first, deleted ones gone', rows[0] === 'P04' && !rows.includes('Lanyard'), rows.join(', '));
  await w.locator('.widget-row', { hasText: 'FOH' }).click();
  await olive.waitForSelector('#tab-glossary[aria-selected="true"]');
  await olive.waitForFunction(() => document.querySelector('#title-glossary')?.value === 'Festival words');
  expect('Widget: a row opens its glossary', true);
  await pat.locator('#tab-home').click(); await pat.waitForSelector('.widgets-area');
  await pat.getByRole('button', { name: 'Customize' }).click();
  await pat.locator('.widget-picker label', { hasText: 'New terms' }).locator('input').check();
  await pat.getByRole('button', { name: 'Done', exact: true }).click();
  const pwd = pat.locator('.widget:has(h3:has-text("New terms"))');
  await pwd.locator('.widget-main').first().waitFor();
  const pw = await pwd.locator('.widget-main').allInnerTexts();
  expect('Widget: Pat sees #festival terms only', pw.length > 0 && !pw.includes('Rider'), pw.join(', '));

  expect('No page errors', errs.length === 0, errs.join('; '));
  out(failed ? `${failed} browser checks failed` : 'all browser checks passed');
  await b.close(); process.exit(failed ? 1 : 0);
})();
