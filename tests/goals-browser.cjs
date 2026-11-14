// Goals in real browsers, on the test stack (tests/run.sh --keep): Olive makes a goal set in Organizers and
// one in #festival, adds goals with key results (one counting down), and the progress view works out each
// key result, each goal and the whole set; Alex (dark mode) watches a value updated by hand arrive live, with
// who updated it; a goal reaches 100 % and is marked Reached; a number the database refuses shows its answer;
// a target equal to the start cannot be submitted; Pat (viewer) reads the #festival set only, with no way to
// change it, and sees an update live; Weft search finds the set by a key result; Olive turns on the "Goal
// progress" Home widget and a row opens the set; Pat's widget shows #festival only.
// Run from a dir with playwright:  WEFT_SHOTS=<dir> node goals-browser.cjs
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
    await p.locator('.app:has-text("Goals")').click(); await p.waitForSelector('.docs-list'); return p;
  };
  const goal = (p, title) => p.locator('.goal', { has: p.locator('.goal-title', { hasText: title }) });
  const kr = (p, title) => p.locator('.goal-kr', { has: p.locator('.goal-kr-title', { hasText: title }) });
  const pctOf = async (loc) => (await loc.locator('.goal-pct').first().innerText()).trim();
  const overall = (p) => p.locator('.goal-overall .goal-pct').innerText();
  const newSet = async (p, space, name) => {
    await p.selectOption('#new-goalset', { label: space });
    await p.locator('.docs-new').getByRole('button', { name: 'New goal set' }).click();
    await p.waitForFunction(() => document.querySelector('#title-goalset')?.value === 'Goals');
    await p.fill('#title-goalset', name); await p.press('#title-goalset', 'Enter');
    await p.waitForSelector(`.doc-link:has-text("${name}")`);
  };
  const addGoal = async (p, { title, note = '', due = '' }) => {
    await p.getByRole('button', { name: 'Add a goal' }).click();
    await p.fill('#goal-new-title', title); await p.fill('#goal-new-note', note);
    if (due) await p.fill('#goal-new-due', due);
    await p.locator('form[aria-label="Add a goal"]').getByRole('button', { name: 'Add goal' }).click();
    await p.waitForSelector(`.goal-title:has-text("${title}")`);
  };
  const addKr = async (p, g, { title, from = '0', target, now = '0', unit = '' }) => {
    await goal(p, g).getByRole('button', { name: `Add a key result to ${g}` }).click();
    const f = p.locator(`form[aria-label="Add a key result to ${g}"]`);
    await f.locator('input[id$="-title"]').fill(title); await f.locator('input[id$="-start"]').fill(from);
    await f.locator('input[id$="-target"]').fill(target); await f.locator('input[id$="-now"]').fill(now); await f.locator('input[id$="-unit"]').fill(unit);
    await f.getByRole('button', { name: 'Add key result' }).click();
    await p.waitForSelector(`.goal-kr-title:has-text("${title}")`);
  };
  const update = async (p, title, v) => {
    await kr(p, title).locator('.goal-update input').fill(String(v));
    await kr(p, title).locator('.goal-update').getByRole('button', { name: /^Update/ }).click();
  };

  const olive = await open('Olive Organizer');
  await newSet(olive, '#organizers', 'Board goals');
  await addGoal(olive, { title: 'Secure three sponsors', note: 'The board wants the budget covered before March.' });
  await addKr(olive, 'Secure three sponsors', { title: 'Sponsors signed', target: '3', now: '1', unit: 'sponsors' });
  expect('Empty overall turns into the set\'s progress (1 of 3 = 33%)', (await overall(olive)) === '33%', await overall(olive));

  await newSet(olive, '#festival', 'Festival goals 2027');
  expect('A new set starts empty, with no progress yet', (await overall(olive)) === '–' && (await olive.locator('.goals .convo-empty').innerText()).startsWith('No goals yet'));
  await addGoal(olive, { title: 'Sell out the festival', note: 'Last year we sold 310.', due: '2027-06-01' });
  await addKr(olive, 'Sell out the festival', { title: 'Tickets sold', target: '400', now: '120', unit: 'tickets' });
  await addKr(olive, 'Sell out the festival', { title: 'Volunteers signed up', target: '60', now: '45', unit: 'people' });
  await addGoal(olive, { title: 'Cut waste', note: 'Washable cups and a sorting station at each bar.' });
  await addKr(olive, 'Cut waste', { title: 'Waste to landfill', from: '500', target: '300', now: '450', unit: 'kg' });
  expect('A key result shows current of target with its unit', (await kr(olive, 'Tickets sold').locator('.goal-kr-value').innerText()) === '120 of 400 tickets',
    await kr(olive, 'Tickets sold').locator('.goal-kr-value').innerText());
  expect('Key result progress: 120 of 400 is 30%, 45 of 60 is 75%', (await pctOf(kr(olive, 'Tickets sold'))) === '30%' && (await pctOf(kr(olive, 'Volunteers signed up'))) === '75%');
  expect('Counting down: 500 to 300 kg, now 450, is 25% and says where it started', (await pctOf(kr(olive, 'Waste to landfill'))) === '25%'
    && (await kr(olive, 'Waste to landfill').locator('.goal-kr-value').innerText()).includes('(from 500)'));
  expect('A goal is the average of its key results (30% and 75% make 53%)', (await pctOf(goal(olive, 'Sell out the festival'))) === '53%', await pctOf(goal(olive, 'Sell out the festival')));
  expect('The set is the average of its goals (52.5% and 25% make 39%)', (await overall(olive)) === '39%', await overall(olive));
  expect('The bars carry the numbers for screen readers', (await olive.locator('.goal-overall [role="progressbar"]').getAttribute('aria-valuenow')) === '39');
  expect('Counts under the overall bar', (await olive.locator('.goal-overall .goal-meta').innerText()) === '2 goals, 3 key results, 0 reached',
    await olive.locator('.goal-overall .goal-meta').innerText());

  // Alex watches; Olive updates by hand.
  const alex = await open('Alex (test admin)', true);
  await alex.locator('.doc-link', { hasText: 'Festival goals 2027' }).click(); await alex.waitForSelector('.goal-kr');
  const t0 = Date.now();
  await update(olive, 'Tickets sold', 200);
  await alex.waitForFunction(() => [...document.querySelectorAll('.goal-kr')].some((k) => k.textContent.includes('200 of 400 tickets')), null, { timeout: 6000 });
  out(`Alex saw Olive's update live: ${Date.now() - t0} ms`);
  expect('Alex sees the new value live, with who updated it', (await kr(alex, 'Tickets sold').locator('.link-by').innerText()).endsWith('by Olive Organizer')
    && (await pctOf(kr(alex, 'Tickets sold'))) === '50%', await kr(alex, 'Tickets sold').locator('.link-by').innerText());
  expect('The goal and the set move with it (63% and 44%)', (await pctOf(goal(alex, 'Sell out the festival'))) === '63%' && (await overall(alex)) === '44%',
    `${await pctOf(goal(alex, 'Sell out the festival'))} ${await overall(alex)}`);

  // Reaching a goal.
  await update(olive, 'Waste to landfill', 280);
  await olive.waitForSelector('.goal.is-reached');
  expect('Past the target counts as 100% and the goal is marked Reached', (await pctOf(goal(olive, 'Cut waste'))) === '100%'
    && (await goal(olive, 'Cut waste').locator('.goal-state').innerText()) === 'Reached');
  await alex.waitForSelector('.goal.is-reached', { timeout: 6000 });
  expect('Reached shows live for Alex', true);

  // The database's answer when it refuses; a target equal to the start cannot be sent at all.
  await update(olive, 'Volunteers signed up', '10000000000000');
  await olive.waitForSelector('.goals .send-error');
  expect('A value the database refuses shows its answer', (await olive.locator('.goals .send-error').innerText()).startsWith('Could not update Volunteers signed up:'),
    await olive.locator('.goals .send-error').innerText());
  expect('And the value stays as it was', (await kr(olive, 'Volunteers signed up').locator('.goal-kr-value').innerText()).startsWith('45 of 60'));
  await kr(olive, 'Volunteers signed up').getByRole('button', { name: /^Edit/ }).click();
  const ef = olive.locator('form[aria-label="Edit Volunteers signed up"]');
  await ef.locator('input[id$="-target"]').fill('0');
  expect('A target equal to the start: Save is off and the form says why', await ef.getByRole('button', { name: 'Save' }).isDisabled()
    && (await ef.locator('.goal-kr-hint').innerText()).includes('has to differ'));
  await ef.locator('input[id$="-target"]').fill('50');
  await ef.getByRole('button', { name: 'Save' }).click();
  await olive.waitForFunction(() => [...document.querySelectorAll('.goal-kr-value')].some((e) => e.textContent.startsWith('45 of 50')));
  expect('Editing a key result\'s target changes its progress (45 of 50 = 90%)', (await pctOf(kr(olive, 'Volunteers signed up'))) === '90%');

  // Reload so the refused attempt's message is gone before the screenshots.
  await olive.locator('.doc-link', { hasText: 'Board goals' }).click(); await olive.waitForSelector('.goal-title:has-text("Secure three sponsors")');
  await olive.locator('.doc-link', { hasText: 'Festival goals 2027' }).click(); await olive.waitForSelector('.goal-title:has-text("Cut waste")');
  await olive.mouse.click(5, 895);
  await olive.waitForTimeout(400);
  await olive.screenshot({ path: `${SHOTS}/1-goals-olive-light.png` });
  await alex.waitForTimeout(400);
  await alex.screenshot({ path: `${SHOTS}/2-goals-alex-dark.png` });

  // Weft search finds a key result (through the set's text).
  await olive.locator('.search input').fill('landfill');
  const hit = olive.locator('.search-group:has-text("Goals")');
  const found = await hit.waitFor({ timeout: 6000 }).then(() => true).catch(() => false);
  expect('Weft search finds the goal set by a key result\'s words', found
    && (await olive.locator('.search-row').allInnerTexts()).some((r) => r.includes('Festival goals 2027')));
  await olive.keyboard.press('Escape');

  // Pat (viewer in #festival only).
  const pat = await open('Pat Public');
  const sets = await pat.locator('.doc-link').allInnerTexts();
  expect('Pat sees the #festival set, not the Organizers one', sets.includes('Festival goals 2027') && !sets.includes('Board goals'), sets.join(', '));
  const patSpaces = await pat.locator('#new-goalset option').allInnerTexts();
  expect('Pat can make goal sets only where she edits (not #festival)', !patSpaces.includes('#festival') && patSpaces.length >= 1, patSpaces.join(', '));
  await pat.locator('.doc-link', { hasText: 'Festival goals 2027' }).click(); await pat.waitForSelector('.goal-kr');
  expect('Pat: no Add a goal, Update, Edit, Delete or Move', await pat.getByRole('button', { name: /^(Add a goal|Add a key result)/ }).count() === 0
    && await pat.locator('.goal-update').count() === 0 && await pat.locator('.goal').getByRole('button', { name: /^(Edit|Delete)/ }).count() === 0
    && await pat.getByRole('button', { name: 'Delete', exact: true }).count() === 0 && await pat.locator('#move-goalset').count() === 0);
  expect('Pat: the set name is read-only and the hint says why', await pat.locator('#title-goalset[readonly]').count() === 1
    && (await pat.locator('.goals > .docs-hint').innerText()).includes('make you an editor'));
  expect('Pat sees the same progress', (await overall(pat)) === (await overall(olive)), `${await overall(pat)} ${await overall(olive)}`);
  await update(olive, 'Tickets sold', 260);
  await pat.waitForFunction(() => [...document.querySelectorAll('.goal-kr-value')].some((e) => e.textContent.startsWith('260 of 400')), null, { timeout: 6000 });
  expect('An update shows live for Pat', true);
  await pat.waitForTimeout(400);
  await pat.screenshot({ path: `${SHOTS}/3-goals-pat-viewer.png` });

  // Home widget: not on by default; Olive turns it on.
  await olive.locator('#tab-home').click(); await olive.waitForSelector('.widgets-area');
  await olive.getByRole('button', { name: 'Customize' }).click();
  await olive.locator('.widget-picker label', { hasText: 'Goal progress' }).locator('input').check();
  await olive.getByRole('button', { name: 'Done', exact: true }).click();
  const w = olive.locator('.widget:has(h3:has-text("Goal progress"))');
  await w.locator('.widget-main').first().waitFor();
  const rows = await w.locator('.widget-main').allInnerTexts();
  out('widget rows:', rows.join(' | '));
  expect('Widget: both sets with their overall progress, most recently changed first', rows[0]?.startsWith('Festival goals 2027') && rows.some((r) => r === 'Board goals 33%'), rows.join(', '));
  await w.locator('.widget-row', { hasText: 'Board goals' }).click();
  await olive.waitForSelector('#tab-goals[aria-selected="true"]');
  await olive.waitForFunction(() => document.querySelector('#title-goalset')?.value === 'Board goals');
  expect('Widget: a row opens its set in Goals', true);
  await pat.locator('#tab-home').click(); await pat.waitForSelector('.widgets-area');
  await pat.getByRole('button', { name: 'Customize' }).click();
  await pat.locator('.widget-picker label', { hasText: 'Goal progress' }).locator('input').check();
  await pat.getByRole('button', { name: 'Done', exact: true }).click();
  const pwd = pat.locator('.widget:has(h3:has-text("Goal progress"))');
  await pwd.locator('.widget-main').first().waitFor();
  const pw = await pwd.locator('.widget-main').allInnerTexts();
  expect('Widget: Pat sees #festival sets only', pw.some((r) => r.startsWith('Festival goals 2027')) && !pw.some((r) => r.startsWith('Board goals')), pw.join(', '));

  expect('No page errors', errs.length === 0, errs.join('; '));
  out(failed ? `${failed} browser checks failed` : 'all browser checks passed');
  await b.close(); process.exit(failed ? 1 : 0);
})();
