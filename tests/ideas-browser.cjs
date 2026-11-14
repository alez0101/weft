// Ideas in real browsers, on the test stack (tests/run.sh --keep): Olive makes an ideas board in Organizers
// and one in #festival and suggests ideas; Alex (owner, dark mode) watches an idea arrive and a vote count
// change live, and marks ideas planned, done and declined, which Olive sees live; Olive (editor) has no
// status menu; the filters, sort and find box; voting is closed on a declined idea; Pat (viewer in #festival
// only) reads the #festival board, votes, and has no way to suggest, edit, delete or set a status; a delete
// shows live for Pat; Weft search finds the board by an idea's words; the "Top ideas" Home widget (opt-in)
// lists open ideas by votes and a row opens the board; Pat's widget shows #festival only.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node ideas-browser.cjs
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
    await p.locator('.app:has-text("Ideas")').click(); await p.waitForSelector('.docs-list'); return p;
  };
  const idea = (p, title) => p.locator('.idea', { has: p.locator('.qa-title', { hasText: new RegExp(`^${title}$`) }) });
  const titles = (p) => p.locator('.idea .qa-title').allInnerTexts();
  const votes = async (p, title) => Number(await idea(p, title).locator('.qa-votes').innerText());
  const newBoard = async (p, space, name) => {
    await p.selectOption('#new-ideaboard', { label: space });
    await p.locator('.docs-new').getByRole('button', { name: 'New ideas board' }).click();
    await p.waitForFunction(() => document.querySelector('#title-ideaboard')?.value === 'Ideas');
    await p.fill('#title-ideaboard', name); await p.press('#title-ideaboard', 'Enter');
    await p.waitForSelector(`.doc-link:has-text("${name}")`);
  };
  const suggest = async (p, title, details = '') => {
    await p.getByRole('button', { name: 'Suggest an idea' }).click();
    await p.fill('#idea-new-title', title); if (details) await p.fill('#idea-new-details', details);
    await p.locator('form[aria-label="Suggest an idea"]').getByRole('button', { name: 'Add idea' }).click();
    await p.waitForSelector(`.idea .qa-title:text-is("${title}")`);
  };

  const olive = await open('Olive Organizer');
  await newBoard(olive, '#organizers', 'Organizer ideas');
  await suggest(olive, 'Move the headliner to Saturday', 'More people come on Saturdays.');
  await newBoard(olive, '#festival', 'Festival ideas');
  await suggest(olive, 'Water refill point by the main stage', 'People queue at the bar just for water. A tap and a sign would do.');
  await suggest(olive, 'Quiet tent for families', 'Somewhere calm with beanbags for small children.');
  await suggest(olive, 'Glow sticks at the gate');
  expect('A new idea shows as New, with who suggested it', (await idea(olive, 'Quiet tent for families').locator('.idea-status').innerText()) === 'New'
    && (await idea(olive, 'Quiet tent for families').locator('.link-by').innerText()).startsWith('Suggested by Olive Organizer'));
  expect('An editor gets no status menu', await olive.locator('select.idea-status').count() === 0);

  const alex = await open('Alex (test admin)', true);
  await alex.locator('.doc-link', { hasText: 'Festival ideas' }).click(); await alex.waitForSelector('.idea');
  const t0 = Date.now();
  await suggest(olive, 'Bike racks by gate B', 'Last year bikes were chained to the fence.');
  await alex.waitForSelector('.idea .qa-title:text-is("Bike racks by gate B")', { timeout: 6000 });
  out(`Alex saw Olive's idea live: ${Date.now() - t0} ms`);
  expect('Alex sees a new idea live', true);

  // Votes, live both ways.
  await idea(olive, 'Water refill point by the main stage').locator('.qa-vote').click();
  await alex.waitForFunction(() => [...document.querySelectorAll('.idea')].some((e) => e.querySelector('.qa-title').textContent.startsWith('Water') && e.querySelector('.qa-votes').textContent === '1'), null, { timeout: 6000 });
  await idea(alex, 'Water refill point by the main stage').locator('.qa-vote').click();
  await idea(alex, 'Quiet tent for families').locator('.qa-vote').click();
  await olive.waitForFunction(() => [...document.querySelectorAll('.idea')].some((e) => e.querySelector('.qa-title').textContent.startsWith('Water') && e.querySelector('.qa-votes').textContent === '2'), null, { timeout: 6000 });
  expect('Votes show live for both', await votes(olive, 'Water refill point by the main stage') === 2 && await votes(alex, 'Quiet tent for families') === 1);
  expect('A vote is marked as yours', await idea(olive, 'Water refill point by the main stage').locator('.qa-vote[aria-pressed="true"]').count() === 1);
  expect('Most votes first', (await titles(olive))[0] === 'Water refill point by the main stage' && (await titles(olive))[1] === 'Quiet tent for families', (await titles(olive)).join(', '));
  await olive.selectOption('#ideas-sort', 'new');
  expect('Sort by newest', (await titles(olive))[0] === 'Bike racks by gate B', (await titles(olive)).join(', '));
  await olive.selectOption('#ideas-sort', 'votes');

  // Alex (owner) sets statuses; Olive sees them live.
  expect('An owner gets a status menu', await alex.locator('select.idea-status').count() === 4);
  await alex.selectOption('select[aria-label="Status of Water refill point by the main stage"]', 'planned');
  await olive.waitForFunction(() => [...document.querySelectorAll('.idea.is-planned .qa-title')].some((e) => e.textContent.startsWith('Water')), null, { timeout: 6000 });
  expect('A status change shows live', (await idea(olive, 'Water refill point by the main stage').locator('.idea-status').innerText()) === 'Planned');
  await alex.selectOption('select[aria-label="Status of Glow sticks at the gate"]', 'declined');
  await alex.getByRole('button', { name: /^All/ }).click();
  await alex.waitForSelector('.idea.is-declined');
  await alex.getByRole('button', { name: /^Open/ }).click();
  await olive.waitForFunction(() => ![...document.querySelectorAll('.idea .qa-title')].some((e) => e.textContent === 'Glow sticks at the gate'), null, { timeout: 6000 });
  expect('Open (the default) hides declined ideas', !(await titles(olive)).includes('Glow sticks at the gate'), (await titles(olive)).join(', '));
  await olive.getByRole('button', { name: /^Declined/ }).click();
  expect('The Declined filter shows it', (await titles(olive)).join(',') === 'Glow sticks at the gate', (await titles(olive)).join(','));
  expect('Voting is closed on a declined idea', await idea(olive, 'Glow sticks at the gate').locator('.qa-vote').isDisabled());
  await olive.getByRole('button', { name: /^Planned/ }).click();
  expect('The Planned filter', (await titles(olive)).join(',') === 'Water refill point by the main stage', (await titles(olive)).join(','));
  await olive.getByRole('button', { name: /^Open/ }).click();
  expect('Filter counts', (await olive.getByRole('button', { name: /^Open/ }).innerText()).replace(/\s+/g, ' ') === 'Open 3'
    && (await olive.getByRole('button', { name: /^All/ }).innerText()).replace(/\s+/g, ' ') === 'All 4');

  // Edit your own idea.
  await idea(olive, 'Bike racks by gate B').getByRole('button', { name: 'Edit' }).click();
  await olive.fill('.idea form textarea', 'Last year bikes were chained to the fence. Ten racks would do.');
  await olive.locator('.idea form').getByRole('button', { name: 'Save' }).click();
  await alex.waitForSelector('.link-note:has-text("Ten racks")', { timeout: 6000 });
  expect('An edit shows live', true);
  expect('Alex cannot edit Olive\'s idea (no Edit button)', await idea(alex, 'Bike racks by gate B').getByRole('button', { name: 'Edit' }).count() === 0);

  // The find box.
  await olive.fill('#ideas-find', 'gate');
  expect('Find matches title and details', (await titles(olive)).join(',') === 'Bike racks by gate B', (await titles(olive)).join(','));
  await olive.fill('#ideas-find', 'nothing-like-this');
  expect('No match says so', (await olive.locator('.ideas .convo-empty').innerText()) === 'No ideas match.');
  await olive.fill('#ideas-find', '');

  await olive.waitForTimeout(400);
  await olive.screenshot({ path: `${SHOTS}/1-ideas-olive-light.png` });
  await alex.waitForTimeout(400);
  await alex.screenshot({ path: `${SHOTS}/2-ideas-alex-dark.png` });

  // Weft search finds a board by an idea's words (through its text).
  await olive.locator('.search input').fill('headliner');
  const hit = olive.locator('.search-group:has-text("Ideas")');
  const found = await hit.waitFor({ timeout: 6000 }).then(() => true).catch(() => false);
  expect('Weft search finds the board by a word in an idea', found
    && (await olive.locator('.search-row').allInnerTexts()).some((r) => r.includes('Organizer ideas')));
  await olive.keyboard.press('Escape');

  // Pat (viewer in #festival only).
  const pat = await open('Pat Public');
  const lists = await pat.locator('.doc-link').allInnerTexts();
  expect('Pat sees the #festival board, not the Organizers one', lists.includes('Festival ideas') && !lists.includes('Organizer ideas'), lists.join(', '));
  await pat.locator('.doc-link', { hasText: 'Festival ideas' }).click(); await pat.waitForSelector('.idea');
  expect('Pat: no Suggest, Edit, Delete, status menu or Move', await pat.getByRole('button', { name: 'Suggest an idea' }).count() === 0
    && await pat.locator('.idea').getByRole('button', { name: /^(Edit|Delete)/ }).count() === 0
    && await pat.locator('select.idea-status').count() === 0 && await pat.locator('#move-ideaboard').count() === 0);
  expect('Pat: the board name is read-only and the hint says why', await pat.locator('#title-ideaboard[readonly]').count() === 1
    && (await pat.locator('.ideas > .docs-hint').innerText()).includes('make you an editor'));
  await idea(pat, 'Bike racks by gate B').locator('.qa-vote').click();
  await olive.waitForFunction(() => [...document.querySelectorAll('.idea')].some((e) => e.querySelector('.qa-title').textContent.startsWith('Bike') && e.querySelector('.qa-votes').textContent === '1'), null, { timeout: 6000 });
  expect('Pat (viewer) votes, and Olive sees it live', await votes(pat, 'Bike racks by gate B') === 1);
  await idea(olive, 'Quiet tent for families').getByRole('button', { name: 'Delete' }).click();
  await pat.waitForFunction(() => ![...document.querySelectorAll('.idea .qa-title')].some((e) => e.textContent === 'Quiet tent for families'), null, { timeout: 6000 });
  expect('A delete shows live for Pat', (await titles(pat)).length === 2, (await titles(pat)).join(', '));
  await pat.waitForTimeout(400);
  await pat.screenshot({ path: `${SHOTS}/3-ideas-pat-viewer.png` });

  // Home widget: not on by default; Olive turns it on.
  await olive.locator('#tab-home').click(); await olive.waitForSelector('.widgets-area');
  await olive.getByRole('button', { name: 'Customize' }).click();
  await olive.locator('.widget-picker label', { hasText: 'Top ideas' }).locator('input').check();
  await olive.getByRole('button', { name: 'Done', exact: true }).click();
  const w = olive.locator('.widget:has(h3:has-text("Top ideas"))');
  await w.locator('.widget-main').first().waitFor();
  const rows = await w.locator('.widget-main').allInnerTexts();
  out('widget rows:', rows.join(' | '));
  expect('Widget: open ideas by votes, declined and deleted ones gone', rows[0] === 'Water refill point by the main stage'
    && !rows.includes('Glow sticks at the gate') && !rows.includes('Quiet tent for families') && rows.includes('Move the headliner to Saturday'), rows.join(', '));
  await w.locator('.widget-row', { hasText: 'Bike racks' }).click();
  await olive.waitForSelector('#tab-ideas[aria-selected="true"]');
  await olive.waitForFunction(() => document.querySelector('#title-ideaboard')?.value === 'Festival ideas');
  expect('Widget: a row opens its board', true);
  await pat.locator('#tab-home').click(); await pat.waitForSelector('.widgets-area');
  await pat.getByRole('button', { name: 'Customize' }).click();
  await pat.locator('.widget-picker label', { hasText: 'Top ideas' }).locator('input').check();
  await pat.getByRole('button', { name: 'Done', exact: true }).click();
  const pwd = pat.locator('.widget:has(h3:has-text("Top ideas"))');
  await pwd.locator('.widget-main').first().waitFor();
  const pw = await pwd.locator('.widget-main').allInnerTexts();
  expect('Widget: Pat sees #festival ideas only', pw.length === 2 && !pw.includes('Move the headliner to Saturday'), pw.join(', '));

  expect('No page errors', errs.length === 0, errs.join('; '));
  out(failed ? `${failed} browser checks failed` : 'all browser checks passed');
  await b.close(); process.exit(failed ? 1 : 0);
})();
