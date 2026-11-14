// Decisions in real browsers, on the test stack (tests/run.sh --keep): Olive makes a decision log in
// Organizers and one in #festival and writes decisions down, one replacing another; Alex (dark mode)
// watches decisions arrive and change live; "Replaced by" jumps to the newer decision; "Hide replaced"
// and the filter narrow the list; a loop of replacements is refused with the database's answer; Pat
// (viewer) reads the #festival log only, with no way to change it, and sees a delete live; Weft search
// finds a decision's log; Olive turns on the "Recent decisions" Home widget and a row opens the log.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node decisions-browser.cjs
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
    await p.locator('.app:has-text("Decisions")').click(); await p.waitForSelector('.docs-list'); return p;
  };
  const card = (p, title) => p.locator('.decision', { has: p.locator('.decision-title', { hasText: title }) });
  const titles = (p) => p.locator('.decision-title').allInnerTexts();
  const newLog = async (p, space, name) => {
    await p.selectOption('#new-decisionlog', { label: space });
    await p.locator('.docs-new').getByRole('button', { name: 'New decision log' }).click();
    await p.waitForFunction(() => document.querySelector('#title-decisionlog')?.value === 'Decisions');
    await p.fill('#title-decisionlog', name); await p.press('#title-decisionlog', 'Enter');
    await p.waitForSelector(`.doc-link:has-text("${name}")`);
  };
  // Pick a "Replaces" option by the decision's title (the date in front of it follows the browser's locale).
  const pickReplaces = async (p, sel, title) => {
    const opts = await p.locator(`${sel} option`).allInnerTexts();
    await p.selectOption(sel, { index: opts.findIndex((o) => o.endsWith(`: ${title}`)) });
  };
  const addDecision = async (p, { title, context = '', by = '', on = '', replaces = '' }, wait = true) => {
    await p.getByRole('button', { name: 'Add a decision' }).click();
    await p.fill('#decision-new-title', title); await p.fill('#decision-new-context', context); await p.fill('#decision-new-by', by);
    if (on) await p.fill('#decision-new-on', on);
    if (replaces) await pickReplaces(p, '#decision-new-replaces', replaces);
    await p.locator('form[aria-label="Add a decision"]').getByRole('button', { name: 'Add decision' }).click();
    if (wait) await p.waitForSelector(`.decision-title:has-text("${title}")`);
  };

  const olive = await open('Olive Organizer');
  await newLog(olive, '#organizers', 'Budget decisions');
  await addDecision(olive, { title: 'Cap the stage budget at 4,000', context: 'Sponsor money arrives late; we keep a reserve for weather.', by: 'Organizers meeting', on: '2026-10-01' });
  await newLog(olive, '#festival', 'Festival decisions');
  await addDecision(olive, { title: 'Gates open at 10:00', context: 'Matches last year and the bus timetable.', by: 'Organizers meeting', on: '2026-09-12' });
  await addDecision(olive, { title: 'No single-use cups', context: 'Hire washable cups from the council; deposit of 1 per cup.', by: 'Volunteer vote', on: '2026-09-20' });
  await addDecision(olive, { title: 'Volunteers park behind the school', context: 'The field car park floods after rain.', by: 'Sam (site lead)', on: '2026-10-04' });
  expect('Decisions are newest first', (await titles(olive)).join(',') === 'Volunteers park behind the school,No single-use cups,Gates open at 10:00', (await titles(olive)).join(','));

  const alex = await open('Alex (test admin)', true);
  await alex.locator('.doc-link', { hasText: 'Festival decisions' }).click(); await alex.waitForSelector('.decision');
  const t0 = Date.now();
  await addDecision(olive, { title: 'Gates open at 9:30', context: 'Neighbours asked for the first band to start earlier; 9:30 gives security time to check bags.', by: 'Council and organizers', on: '2026-11-02', replaces: 'Gates open at 10:00' });
  await alex.waitForSelector('.decision-title:has-text("Gates open at 9:30")', { timeout: 6000 });
  out(`Alex saw Olive's decision live: ${Date.now() - t0} ms`);
  expect('Alex sees the new decision live, with who wrote it down', (await card(alex, 'Gates open at 9:30').locator('.link-by').innerText()) === 'Written down by Olive Organizer');
  expect('The replaced decision is marked live for Alex', await card(alex, 'Gates open at 10:00').locator('.decision-state').count() === 1
    && (await card(alex, 'Gates open at 10:00').locator('.decision-links').innerText()).includes('Replaced by Gates open at 9:30'));
  expect('The new one says what it replaces', (await card(olive, 'Gates open at 9:30').locator('.decision-links').innerText()).startsWith('Replaces Gates open at 10:00'));
  expect('The count says how many are in force', (await olive.locator('.decisions .task-count').innerText()) === '4 decisions, 3 in force', await olive.locator('.decisions .task-count').innerText());

  // Edit, live for Alex.
  await card(olive, 'No single-use cups').getByRole('button', { name: 'Edit' }).click();
  await olive.fill('.decision form input[id$="-by"]', 'Volunteer vote (31 for, 4 against)');
  await olive.locator('.decision form').getByRole('button', { name: 'Save' }).click();
  await alex.waitForSelector('.decision-by:has-text("31 for, 4 against")', { timeout: 6000 });
  expect('An edit shows live', true);

  // A loop is refused by the database, and the screen shows why.
  await card(olive, 'Gates open at 10:00').getByRole('button', { name: 'Edit' }).click();
  await pickReplaces(olive, '.decision form select', 'Gates open at 9:30');
  await olive.locator('.decision form').getByRole('button', { name: 'Save' }).click();
  await olive.waitForSelector('.decisions .send-error');
  expect('A loop of replacements is refused, with the reason shown', (await olive.locator('.decisions .send-error').innerText()).includes('cannot replace one that replaces it'),
    await olive.locator('.decisions .send-error').innerText());
  await olive.locator('.decision form').getByRole('button', { name: 'Cancel' }).click();

  // Jump from the old decision to the one that replaced it.
  await card(olive, 'Gates open at 10:00').getByRole('button', { name: 'Gates open at 9:30' }).click();
  expect('"Replaced by" moves focus to the newer decision', await olive.evaluate(() => document.activeElement?.querySelector('.decision-title')?.textContent) === 'Gates open at 9:30');

  // Filter and hide replaced.
  await olive.check('.decisions .toggle input');
  let shown = await titles(olive);
  expect('Hide replaced shows only what is in force', shown.length === 3 && !shown.includes('Gates open at 10:00'), shown.join(', '));
  await olive.uncheck('.decisions .toggle input');
  await olive.fill('#decisions-find', 'floods');
  shown = await titles(olive);
  expect('Words filter by context', shown.length === 1 && shown[0] === 'Volunteers park behind the school', shown.join(', '));
  await olive.fill('#decisions-find', 'volunteer vote');
  shown = await titles(olive);
  expect('Words filter by who decided', shown.length === 1 && shown[0] === 'No single-use cups', shown.join(', '));
  await olive.fill('#decisions-find', 'nothing-like-this');
  expect('No match says so', (await olive.locator('.decisions .convo-empty').innerText()) === 'No decisions match.');
  await olive.fill('#decisions-find', '');

  // Reload so the refused attempt's message is gone before the screenshot.
  await olive.locator('.doc-link', { hasText: 'Budget decisions' }).click(); await olive.waitForSelector('.decision-title:has-text("Cap the stage budget")');
  await olive.locator('.doc-link', { hasText: 'Festival decisions' }).click(); await olive.waitForSelector('.decision-title:has-text("Gates open at 9:30")');
  await olive.mouse.click(5, 895);
  await olive.waitForTimeout(400);
  await olive.screenshot({ path: `${SHOTS}/1-decisions-olive-light.png` });
  await alex.waitForTimeout(400);
  await alex.screenshot({ path: `${SHOTS}/2-decisions-alex-dark.png` });

  // Weft search finds a decision (through the log's text).
  await olive.locator('.search input').fill('stage budget');
  const hit = olive.locator('.search-group:has-text("Decision logs")');
  const found = await hit.waitFor({ timeout: 6000 }).then(() => true).catch(() => false);
  expect('Weft search finds the decision log by a decision\'s words', found
    && (await olive.locator('.search-row').allInnerTexts()).some((r) => r.includes('Budget decisions')));
  await olive.keyboard.press('Escape');

  // Pat (viewer in #festival only).
  const pat = await open('Pat Public');
  const logs = await pat.locator('.doc-link').allInnerTexts();
  expect('Pat sees the #festival log, not the Organizers one', logs.includes('Festival decisions') && !logs.includes('Budget decisions'), logs.join(', '));
  const patSpaces = await pat.locator('#new-decisionlog option').allInnerTexts();
  expect('Pat can make decision logs only where she edits (not #festival)', !patSpaces.includes('#festival') && patSpaces.length >= 1, patSpaces.join(', '));
  await pat.locator('.doc-link', { hasText: 'Festival decisions' }).click(); await pat.waitForSelector('.decision');
  expect('Pat: no Add a decision, Edit, Delete or Move', await pat.getByRole('button', { name: 'Add a decision' }).count() === 0
    && await pat.locator('.decision').getByRole('button', { name: /^(Edit|Delete)/ }).count() === 0
    && await pat.getByRole('button', { name: 'Delete', exact: true }).count() === 0 && await pat.locator('#move-decisionlog').count() === 0);
  expect('Pat: the log name is read-only and the hint says why', await pat.locator('#title-decisionlog[readonly]').count() === 1
    && (await pat.locator('.decisions > .docs-hint').innerText()).includes('make you an editor'));
  expect('Pat can still follow what replaced what', await pat.locator('.decision-links .link-btn').count() === 2);
  await card(olive, 'Volunteers park behind the school').getByRole('button', { name: 'Delete' }).click();
  await pat.waitForFunction(() => ![...document.querySelectorAll('.decision-title')].some((e) => e.textContent === 'Volunteers park behind the school'), null, { timeout: 6000 });
  expect('A delete shows live for Pat', (await titles(pat)).length === 3);
  await pat.waitForTimeout(400);
  await pat.screenshot({ path: `${SHOTS}/3-decisions-pat-viewer.png` });

  // Home widget: not on by default; Olive turns it on.
  await olive.locator('#tab-home').click(); await olive.waitForSelector('.widgets-area');
  await olive.getByRole('button', { name: 'Customize' }).click();
  await olive.locator('.widget-picker label', { hasText: 'Recent decisions' }).locator('input').check();
  await olive.getByRole('button', { name: 'Done', exact: true }).click();
  const w = olive.locator('.widget:has(h3:has-text("Recent decisions"))');
  await w.locator('.widget-main').first().waitFor();
  const rows = await w.locator('.widget-main').allInnerTexts();
  out('widget rows:', rows.join(' | '));
  expect('Widget: most recently decided first, deleted ones gone', rows[0] === 'Gates open at 9:30' && !rows.includes('Volunteers park behind the school'), rows.join(', '));
  await w.locator('.widget-row', { hasText: 'Cap the stage budget' }).click();
  await olive.waitForSelector('#tab-decisions[aria-selected="true"]');
  await olive.waitForFunction(() => document.querySelector('#title-decisionlog')?.value === 'Budget decisions');
  expect('Widget: a row opens its log in Decisions', true);
  await pat.locator('#tab-home').click(); await pat.waitForSelector('.widgets-area');
  await pat.getByRole('button', { name: 'Customize' }).click();
  await pat.locator('.widget-picker label', { hasText: 'Recent decisions' }).locator('input').check();
  await pat.getByRole('button', { name: 'Done', exact: true }).click();
  const pwd = pat.locator('.widget:has(h3:has-text("Recent decisions"))');
  await pwd.locator('.widget-main').first().waitFor();
  const pw = await pwd.locator('.widget-main').allInnerTexts();
  expect('Widget: Pat sees #festival decisions only', pw.length > 0 && !pw.some((r) => r.startsWith('Cap the stage budget')), pw.join(', '));

  expect('No page errors', errs.length === 0, errs.join('; '));
  out(failed ? `${failed} browser checks failed` : 'all browser checks passed');
  await b.close(); process.exit(failed ? 1 : 0);
})();
